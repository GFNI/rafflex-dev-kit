import { createRequire } from 'node:module';
import { phpJsonEncode } from './php-json.js';
import { lineAt, lintTemplate } from './twig-lint.js';

export { lineAt };

const require = createRequire(import.meta.url);

// The platform renders in UTC, so dates in templates read the same here.
process.env.TZ = 'UTC';

/** @type {any} */
const Twig = require('twig');

Twig.cache(false);

/**
 * A render failure, carrying the template line when one is known. Its
 * message mirrors the platform's ("... at line 3.") so the same line
 * parsing and sandbox classification apply to both.
 */
export class TemplateRenderError extends Error {
    /**
     * @param {string} message
     * @param {{line?: number|null, sandbox?: boolean}} [details]
     */
    constructor(message, details = {}) {
        super(message);
        this.name = 'TemplateRenderError';
        this.line = details.line ?? null;
        this.sandbox = details.sandbox ?? false;
    }
}

/**
 * @typedef {object} SandboxRules
 * @property {string[]} tags
 * @property {string[]} filters
 * @property {string[]} [tests]
 * @property {string[]} [functions]
 * @property {number} max_for_loops
 * @property {number} max_iterations
 * @property {number} [max_total_iterations]
 * @property {number} max_execution_ms
 * @property {Record<string, PreRenderRefusal>} [refusals]
 */

/**
 * A pattern the platform refuses before rendering, matched against the raw
 * template source, with the message the render fails with
 * (TwigRenderer::PreRenderRefusals, published as rules.sandbox.refusals).
 *
 * @typedef {{pattern: string, flags?: string, message: string}} PreRenderRefusal
 */

/**
 * The platform's range refusals, used only when cached rules predate
 * rules.sandbox.refusals.
 *
 * @type {Record<string, PreRenderRefusal>}
 */
const fallbackPreRenderRefusals = {
    range_operator: { pattern: '\\.\\.\\s*\\w', flags: '', message: 'Range operator (..) is not allowed in templates' },
    range_function: { pattern: '\\brange\\s*\\(', flags: '', message: 'The range() function is not allowed in templates' },
};

/** @type {any} */
let Markup = null;

/** @type {{budget: number, deadline: number, maxTotal: number, maxMs: number, position: number}|null} */
let guard = null;

/**
 * Twig's `default`, except that false is a value rather than empty, as the
 * platform's TwigRenderer overrides it so a toggle's false survives
 * `options.show_x|default(true)`. Empty arrays and objects fall through,
 * as PHP's empty arrays do.
 *
 * @param {unknown} value
 * @param {unknown[]} [params]
 */
function defaultKeepingFalse(value, params) {
    const fallback = params === undefined || params.length === 0 ? '' : params[0];

    if (value === false) {
        return false;
    }

    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (Array.isArray(value)) {
        return value.length === 0 ? fallback : value;
    }

    if (typeof value === 'object' && !(value instanceof String) && Object.keys(value).filter((key) => key !== '_keys').length === 0) {
        return fallback;
    }

    if (value instanceof String && String(value) === '') {
        return fallback;
    }

    return value;
}

/**
 * PHP's round(): half away from zero, after removing the representation
 * error that makes 1.005 * 100 read as 100.49999.
 *
 * @param {number} value
 * @param {number} precision
 */
function phpRound(value, precision) {
    const factor = 10 ** precision;
    const scaled = Number((Math.abs(value) * factor).toPrecision(15));

    return Math.sign(value) * Math.round(scaled) / factor;
}

/**
 * Twig's number_format with PHP's rounding and defaults (0 decimals, '.'
 * and ',').
 *
 * @param {unknown} value
 * @param {unknown[]} [params]
 */
function numberFormat(value, params = []) {
    const decimals = params[0] === undefined || params[0] === null ? 0 : Math.max(0, Math.trunc(Number(params[0])));
    const decimalPoint = params[1] === undefined || params[1] === null ? '.' : String(params[1]);
    const thousandsSeparator = params[2] === undefined || params[2] === null ? ',' : String(params[2]);
    const number = Number(value ?? 0);
    const rounded = phpRound(Number.isFinite(number) ? number : 0, decimals);
    const [whole, fraction] = Math.abs(rounded).toFixed(decimals).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);
    const sign = rounded < 0 && Number(`${whole}.${fraction ?? 0}`) !== 0 ? '-' : '';

    return `${sign}${grouped}${fraction === undefined ? '' : `${decimalPoint}${fraction}`}`;
}

/**
 * A number as PHP prints it with `echo` (precision 14): 0.1 + 0.2 prints
 * 0.3, and large or tiny floats use the 1.0E+25 form.
 *
 * @param {number} value
 */
export function phpNumberToString(value) {
    if (Number.isNaN(value)) {
        return 'NAN';
    }

    if (!Number.isFinite(value)) {
        return value > 0 ? 'INF' : '-INF';
    }

    if (Number.isSafeInteger(value)) {
        return String(value);
    }

    const [mantissa, exponentText] = value.toExponential(13).split('e');
    const exponent = Number(exponentText);
    const trimmedMantissa = mantissa.replace(/\.?0+$/, '');

    if (exponent < -4 || exponent >= 15) {
        const withFraction = trimmedMantissa.includes('.') ? trimmedMantissa : `${trimmedMantissa}.0`;

        return `${withFraction}E${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
    }

    return String(Number(value.toPrecision(14)));
}

/**
 * A printed value as PHP Twig prints it: true as 1, false and null as
 * nothing, numbers at PHP precision. Printing an array is an error on the
 * platform ("Array to string conversion"), so it is one here too.
 *
 * @param {unknown} value
 */
function phpPrintable(value) {
    if (value === true) {
        return '1';
    }

    if (value === false || value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'number') {
        return phpNumberToString(value);
    }

    if (typeof value === 'object' && !(value instanceof String)) {
        throw new Error('Array to string conversion');
    }

    return value;
}

/**
 * Twig's trim: PHP's trim, ltrim, or rtrim with PHP's default whitespace
 * (space, tab, newlines, vertical tab, NUL) or the given characters, and a
 * side (both, left, right), which twig.js ignores.
 *
 * @param {unknown} value
 * @param {unknown[]} [params]
 */
function phpTrim(value, params = []) {
    if (value === undefined || value === null) {
        return '';
    }

    const characters = params[0] === undefined || params[0] === null ? ' \t\n\r\v\0' : String(params[0]);
    const side = params[1] === undefined || params[1] === null ? 'both' : String(params[1]);
    let text = String(value);

    if (side === 'both' || side === 'left') {
        let start = 0;

        while (start < text.length && characters.includes(text[start])) {
            start++;
        }

        text = text.slice(start);
    }

    if (side === 'both' || side === 'right') {
        let end = text.length;

        while (end > 0 && characters.includes(text[end - 1])) {
            end--;
        }

        text = text.slice(0, end);
    }

    return text;
}

/**
 * The ordered keys of an object, honouring twig.js hash literal order.
 *
 * @param {any} value
 * @returns {string[]}
 */
function orderedKeys(value) {
    return Array.isArray(value._keys) ? value._keys : Object.keys(value).filter((key) => key !== '_keys');
}

/**
 * Twig's first and last: nothing for null, the first or last character of
 * a string, the first or last value of an array or mapping.
 *
 * @param {'first'|'last'} end
 */
function endOf(end) {
    return (/** @type {any} */ value) => {
        if (value === undefined || value === null) {
            return undefined;
        }

        if (typeof value === 'string' || value instanceof String || typeof value === 'number') {
            const text = String(value);

            return end === 'first' ? text.slice(0, 1) : text.slice(-1);
        }

        if (Array.isArray(value)) {
            return end === 'first' ? value[0] : value[value.length - 1];
        }

        if (typeof value === 'object') {
            const keys = orderedKeys(value);

            return keys.length === 0 ? undefined : value[end === 'first' ? keys[0] : keys[keys.length - 1]];
        }

        return undefined;
    };
}

const originalSlice = Twig.filters.slice;

/**
 * Twig's slice also works on mappings (twig.js throws); null slices to
 * nothing.
 *
 * @param {any} value
 * @param {unknown[]} params
 */
function phpSlice(value, params) {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof String)) {
        const keys = orderedKeys(value);
        const values = originalSlice(keys, params);
        /** @type {Record<string, unknown>} */
        const sliced = {};

        for (const key of values) {
            sliced[key] = value[key];
        }

        return sliced;
    }

    if (typeof value === 'number') {
        return originalSlice(String(value), params);
    }

    return originalSlice(value, params);
}

Twig.extendFilter('json', (value) => {
    const encoded = phpJsonEncode(value);

    return encoded === false ? '' : new Markup(encoded, 'html');
});
Twig.extendFilter('default', defaultKeepingFalse);
Twig.extendFilter('number_format', numberFormat);
Twig.extendFilter('trim', phpTrim);
Twig.extendFilter('first', endOf('first'));
Twig.extendFilter('last', endOf('last'));
Twig.extendFilter('slice', phpSlice);
// PHP Twig: an undefined variable or missing key is null.
Twig.extendTest('null', (value) => value === null || value === undefined);
Twig.extendTest('none', (value) => value === null || value === undefined);

/**
 * PHP Twig's lexer unescaping of a string literal's body (Lexer
 * stripcslashes): \\n \\t and friends, \\\\, an escaped quote of either
 * kind, \\x hex and octal escapes; any other escaped character stands for
 * itself. twig.js only unescapes the first escaped quote and \\n \\r.
 *
 * @param {string} body
 */
export function phpStringLiteral(body) {
    const special = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    let result = '';

    for (let index = 0; index < body.length; index++) {
        const character = body[index];

        if (character !== '\\') {
            result += character;
            continue;
        }

        index++;

        if (index >= body.length) {
            result += '\\';
            break;
        }

        const next = body[index];

        if (special[next] !== undefined) {
            result += special[next];
            continue;
        }

        if (next === 'x' && /[0-9a-fA-F]/.test(body[index + 1] ?? '')) {
            let hex = body[++index];

            if (/[0-9a-fA-F]/.test(body[index + 1] ?? '')) {
                hex += body[++index];
            }

            result += String.fromCharCode(Number.parseInt(hex, 16));
            continue;
        }

        if (/[0-7]/.test(next)) {
            let octal = next;

            while (octal.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) {
                octal += body[++index];
            }

            result += String.fromCharCode(Number.parseInt(octal, 8) % 256);
            continue;
        }

        if (next === '#' && body[index + 1] === '{') {
            result += '#{';
            index++;
            continue;
        }

        result += next;
    }

    return result;
}

Twig.extend((internal) => {
    Markup = internal.Markup;

    internal.expression.handler['Twig.expression.type.string'].compile = function phpStringCompile(token, stack, output) {
        const { value } = token;

        delete token.match;
        token.value = phpStringLiteral(value.slice(1, -1).replace(/\r\n?/g, '\n'));
        output.push(token);
    };

    const originalOutput = internal.output;

    internal.output = function phpOutput(output) {
        return originalOutput.call(this, output.map(phpPrintable));
    };

    // twig.js reads a missing key in brackets (files['missing']) as null,
    // which `is defined` then accepts; PHP Twig treats it as undefined.
    const bracketHandler = internal.expression.handler['Twig.expression.type.key.brackets'];
    const originalBracketParse = bracketHandler.parse;

    bracketHandler.parse = function definedAwareBracketParse(token, stack, context, nextToken) {
        const object = stack[stack.length - 1];
        const state = this;

        return originalBracketParse.call(state, token, stack, context, nextToken).then(() => {
            if (stack[stack.length - 1] !== null) {
                return;
            }

            if (object === null || object === undefined || typeof object !== 'object') {
                stack[stack.length - 1] = undefined;

                return;
            }

            const key = internal.expression.parse.call(state, token.stack, context);

            if (!(key in object)) {
                stack[stack.length - 1] = undefined;
            }
        });
    };

    const originalLogicParse = internal.logic.parse;

    internal.logic.parse = function trackedLogicParse(token, ...rest) {
        if (guard !== null && token?.position?.start !== undefined) {
            guard.position = token.position.start;
        }

        return originalLogicParse.call(this, token, ...rest);
    };

    const originalExpressionParse = internal.expression.parse;

    internal.expression.parse = function trackedExpressionParse(tokens, ...rest) {
        const start = Array.isArray(tokens) ? tokens[0]?.position?.start : undefined;

        if (guard !== null && start !== undefined) {
            guard.position = start;
        }

        return originalExpressionParse.call(this, tokens, ...rest);
    };

    // Every loop body ticks against the total iteration budget and the
    // wall clock deadline, as the platform's compiled loop guard does.
    const forHandler = internal.logic.handler['Twig.logic.type.for'];
    const originalForParse = forHandler.parse;

    forHandler.parse = function guardedForParse(token, context, chain) {
        const state = this;
        const hadOwnParseAsync = Object.prototype.hasOwnProperty.call(state, 'parseAsync');
        const previousParseAsync = state.parseAsync;

        state.parseAsync = function tickingParseAsync(tokens, innerContext) {
            if (guard !== null && tokens === token.output) {
                tick();
            }

            return previousParseAsync.call(this, tokens, innerContext);
        };

        const restore = () => {
            if (hadOwnParseAsync) {
                state.parseAsync = previousParseAsync;

                return;
            }

            delete state.parseAsync;
        };

        try {
            const result = originalForParse.call(state, token, context, chain);

            if (result && typeof result.then === 'function') {
                return result.then((value) => {
                    restore();

                    return value;
                }, (error) => {
                    restore();

                    throw error;
                });
            }

            restore();

            return result;
        } catch (error) {
            restore();

            throw error;
        }
    };
});

function tick() {
    guard.budget--;

    if (guard.budget < 0) {
        throw new TemplateRenderError(`Template rendering exceeded the iteration budget (maximum: ${guard.maxTotal})`, { sandbox: true });
    }

    if (Date.now() > guard.deadline) {
        throw new TemplateRenderError(`Template rendering exceeded maximum time (${guard.maxMs}ms)`, { sandbox: true });
    }
}

/**
 * Arrays (and objects) in the context are capped per collection, as the
 * platform wraps them before rendering.
 *
 * @param {unknown} value
 * @param {number} maxIterations
 * @returns {unknown}
 */
function limitCollections(value, maxIterations) {
    if (Array.isArray(value)) {
        return value.slice(0, maxIterations).map((item) => limitCollections(item, maxIterations));
    }

    if (value !== null && typeof value === 'object' && !(value instanceof String)) {
        const limited = {};

        for (const key of Object.keys(value).slice(0, maxIterations)) {
            limited[key] = limitCollections(value[key], maxIterations);
        }

        return limited;
    }

    return value;
}

/**
 * The platform's own pre render checks, run on the raw template text.
 *
 * @param {string} template
 * @param {SandboxRules} sandbox
 */
function validateTemplate(template, sandbox) {
    for (const refusal of Object.values(sandbox.refusals ?? fallbackPreRenderRefusals)) {
        if (new RegExp(refusal.pattern, (refusal.flags ?? '').replace('g', '')).test(template)) {
            throw new TemplateRenderError(refusal.message, { sandbox: true });
        }
    }

    const forLoopCount = (template.match(/\{%-?~?\s*for\b/g) ?? []).length;

    if (forLoopCount > sandbox.max_for_loops) {
        throw new TemplateRenderError(`Too many nested for loops (maximum: ${sandbox.max_for_loops}, found: ${forLoopCount})`, { sandbox: true });
    }
}

/**
 * Two token level fixes so twig.js output matches PHP Twig. Twig prints a
 * constant string literal as written (the escaper treats literals as
 * safe), while twig.js escapes it, so a print tag whose whole expression
 * is one string literal becomes raw text. And Twig drops the newline
 * after a comment's closing `#}` as it does after `%}`, which twig.js
 * keeps.
 *
 * @param {any[]} tokens
 */
function markLiteralPrintsSafe(tokens, template) {
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token?.type === 'raw' && typeof token.position?.start === 'number' && template.slice(token.position.start - 2, token.position.start) === '#}' && token.value.startsWith('\n')) {
            token.value = token.value.slice(1);
        }

        if (token?.type === 'output' && Array.isArray(token.stack) && token.stack.length === 1 && token.stack[0].type === 'Twig.expression.type.string') {
            tokens[index] = { type: 'raw', value: token.stack[0].value, position: token.position };
            continue;
        }

        if (token?.type === 'logic' && token.token) {
            for (const key of ['output', 'body']) {
                if (Array.isArray(token.token[key])) {
                    markLiteralPrintsSafe(token.token[key], template);
                }
            }
        }
    }
}

/**
 * Compile a template, turning twig.js parse errors into render errors that
 * name a line where one can be found.
 *
 * @param {string} template
 * @param {string} name
 */
export function compileTemplate(template, name = 'template.twig') {
    try {
        return Twig.twig({ data: template, rethrow: true, autoescape: 'html', strict_variables: false, allowInlineIncludes: false });
    } catch (error) {
        // twig.js throws undefined for a few inputs it cannot tokenise, such
        // as a string literal ending in an escaped backslash ('\\').
        const message = error === undefined || error === null ? 'twig.js could not parse the template' : String(error.message ?? error);
        const line = lineFromTwigJsMessage(template, message);

        throw new TemplateRenderError(line === null ? `${message} in "${name}".` : `${message} in "${name}" at line ${line}.`, { line });
    }
}

/**
 * twig.js parse errors rarely carry a position; when they quote the
 * offending token, find it in the template.
 *
 * @param {string} template
 * @param {string} message
 * @returns {number|null}
 */
function lineFromTwigJsMessage(template, message) {
    const quoted = message.match(/(?:token|tag|filter|parse) ['"]?([^'"]{2,})['"]/i);

    if (quoted === null) {
        return null;
    }

    const offset = template.indexOf(quoted[1].trim());

    return offset === -1 ? null : lineAt(template, offset);
}

/**
 * Render a template the way the platform's TwigRenderer does: the
 * platform's pre render checks, the sandbox whitelist (as a lint over the
 * parsed tokens, since twig.js has no sandbox), autoescaped HTML, PHP
 * printing of scalars, capped collections, and the iteration and time
 * guard. Failures throw a TemplateRenderError.
 *
 * @param {string} template
 * @param {Record<string, unknown>} context
 * @param {SandboxRules} sandbox
 * @param {{name?: string}} [options]
 * @returns {string}
 */
export function renderTemplate(template, context, sandbox, options = {}) {
    const name = options.name ?? 'template.twig';

    if (!template.includes('{{') && !template.includes('{%')) {
        return template;
    }

    validateTemplate(template, sandbox);

    const compiled = compileTemplate(template, name);
    const violations = lintTemplate(compiled.tokens, template, sandbox);

    if (violations.length > 0) {
        const [first] = violations;

        throw new TemplateRenderError(`${first.message} in "${name}" at line ${first.line}.`, { line: first.line, sandbox: true });
    }

    markLiteralPrintsSafe(compiled.tokens, template);

    const maxTotal = sandbox.max_total_iterations ?? 25000;
    const maxMs = sandbox.max_execution_ms;

    guard = { budget: maxTotal, deadline: Date.now() + maxMs, maxTotal, maxMs, position: 0 };

    try {
        return String(compiled.render(limitCollections(context, sandbox.max_iterations)));
    } catch (error) {
        if (error instanceof TemplateRenderError) {
            throw error;
        }

        const message = error === undefined || error === null ? 'twig.js failed to render the template' : String(error.message ?? error);
        const line = lineAt(template, guard.position);

        throw new TemplateRenderError(`${message} in "${name}" at line ${line}.`, { line });
    } finally {
        guard = null;
    }
}

export { Twig };
