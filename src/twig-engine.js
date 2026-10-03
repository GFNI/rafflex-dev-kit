import { createRequire } from 'node:module';
import { fixedZone, formatPlatformDate, platformZone, unparseableDateMessage, utcZone } from './platform-date.js';
import { platformJsonEncode } from './platform-json.js';
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
 * (published as rules.sandbox.refusals).
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
 * platform's renderer overrides it so a toggle's false survives
 * `options.show_x|default(true)`. Empty arrays and objects fall through,
 * as the platform's do.
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
 * The platform's rounding, half away from zero, step by step as it does
 * it: scale by 10^precision, take the whole part, and round away from
 * zero only when the value is at least that whole part plus a half,
 * scaled back. The comparison is made on the value itself, so 1.005
 * (stored as 1.00499999999999989) rounds to 1 and 2.01 / 1.2 to 1.67,
 * exactly as there. A value past the digits a float holds is returned
 * unchanged. A negative value that rounds to nothing stays negative zero.
 *
 * @param {number} value
 * @param {number} precision
 */
export function platformRound(value, precision) {
    if (!Number.isFinite(value) || value === 0) {
        return value;
    }

    const places = Math.trunc(precision);
    const exponent = 10 ** Math.abs(places);
    const scaled = places > 0 ? value * exponent : value / exponent;
    const unscale = (/** @type {number} */ number) => (places > 0 ? number / exponent : number * exponent);
    let integral = value >= 0 ? Math.floor(scaled) : Math.ceil(scaled);
    const next = value >= 0 ? integral + 1 : integral - 1;

    // A scaled value just under a whole number (0.285 * 100 is
    // 28.499999999999996) is taken as that number when it scales back exactly.
    if (unscale(next) === value) {
        integral = next;
    }

    if (Math.abs(integral) >= 1e16) {
        return value;
    }

    const sign = Object.is(integral, -0) || integral < 0 ? -1 : 1;
    const edge = Math.abs(unscale(integral + sign * 0.5));
    const rounded = Math.abs(value) >= edge ? integral + sign : integral;

    return unscale(rounded);
}

/**
 * A non negative number's exact decimal expansion at `decimals` places, as
 * the platform prints a float with that many: every digit of the binary
 * value, rounded half to even at the last place, then zeros. toFixed
 * rounds an exact tie up (2178974151611.328125 at 5 places), stops at 100
 * places, and turns to exponents from 1e21; this does none of those.
 *
 * @param {number} value
 * @param {number} decimals
 */
export function exactFixed(value, decimals) {
    const view = new DataView(new ArrayBuffer(8));

    view.setFloat64(0, value);

    const high = view.getUint32(0);
    const biasedExponent = (high >>> 20) & 0x7ff;
    let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4));

    if (biasedExponent !== 0) {
        mantissa |= 1n << 52n;
    }

    const exponent = (biasedExponent === 0 ? 1 : biasedExponent) - 1075;

    if (exponent >= 0) {
        const whole = (mantissa << BigInt(exponent)).toString();

        return decimals === 0 ? whole : `${whole}.${'0'.repeat(decimals)}`;
    }

    const places = -exponent;
    let digits = (mantissa * 5n ** BigInt(places)).toString().padStart(places + 1, '0');
    let fractionLength = places;

    if (places > decimals) {
        const scaled = BigInt(digits.slice(0, digits.length - (places - decimals)) || '0');
        const remainder = digits.slice(digits.length - (places - decimals));
        const half = `5${'0'.repeat(remainder.length - 1)}`;
        const roundUp = remainder > half || (remainder === half && scaled % 2n === 1n);

        digits = (scaled + (roundUp ? 1n : 0n)).toString().padStart(decimals + 1, '0');
        fractionLength = decimals;
    }

    const whole = digits.slice(0, digits.length - fractionLength);
    const fraction = digits.slice(digits.length - fractionLength).padEnd(decimals, '0');

    return decimals === 0 ? whole : `${whole}.${fraction}`;
}

/**
 * Twig's number_format with the platform's rounding and defaults (0 decimals, '.'
 * and ','). Negative decimals round to tens, hundreds, and so on. Past
 * the places a float holds there is nothing to round, so the exact
 * binary value is printed, as the platform prints it (3.14159 at 20
 * places is 3.14158999999999988262).
 *
 * @param {unknown} value
 * @param {unknown[]} [params]
 */
function numberFormat(value, params = []) {
    const requested = params[0] === undefined || params[0] === null ? 0 : Math.trunc(Number(params[0]));
    const decimals = Number.isFinite(requested) ? Math.max(0, requested) : 0;
    const decimalPoint = params[1] === undefined || params[1] === null ? '.' : String(params[1]);
    const thousandsSeparator = params[2] === undefined || params[2] === null ? ',' : String(params[2]);
    const number = Number(value ?? 0);
    const finite = Number.isFinite(number) ? number : 0;
    const roundTo = Number.isFinite(requested) ? requested : 0;
    const rounded = platformRound(finite, roundTo);
    const [whole, fraction] = exactFixed(Math.abs(rounded), decimals).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);
    const sign = rounded < 0 && /[1-9]/.test(`${whole}${fraction ?? ''}`) ? '-' : '';

    return `${sign}${grouped}${fraction === undefined ? '' : `${decimalPoint}${fraction}`}`;
}

/**
 * A number as the platform prints it (14 significant digits): 0.1 + 0.2 prints
 * 0.3, and large or tiny floats use the 1.0E+25 form.
 *
 * @param {number} value
 */
export function platformNumberToString(value) {
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
 * A printed value as the platform prints it: true as 1, false and null as
 * nothing, numbers at the platform's precision. Printing an array is an error on the
 * platform ("Array to string conversion"), so it is one here too.
 *
 * @param {unknown} value
 */
function platformPrintable(value) {
    if (value === true) {
        return '1';
    }

    if (value === false || value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'number') {
        return platformNumberToString(value);
    }

    if (typeof value === 'object' && !(value instanceof String)) {
        throw new Error('Array to string conversion');
    }

    return value;
}

/**
 * Twig's trim as the platform does it, with its default whitespace
 * (space, tab, newlines, vertical tab, NUL) or the given characters, and a
 * side (both, left, right), which twig.js ignores.
 *
 * @param {unknown} value
 * @param {unknown[]} [params]
 */
function platformTrim(value, params = []) {
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
function platformSlice(value, params) {
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

const originalLength = Twig.filters.length;
const originalJoin = Twig.filters.join;
const originalRound = Twig.filters.round;

/**
 * A scalar as the platform turns it into text: true as 1, false and null
 * as nothing, numbers at the platform's precision.
 *
 * @param {unknown} value
 */
function scalarText(value) {
    if (value === true) {
        return '1';
    }

    if (value === false || value === null || value === undefined) {
        return '';
    }

    return typeof value === 'number' ? platformNumberToString(value) : String(value);
}

/**
 * Twig's length: a number or a boolean counts the characters it prints
 * as (12.5 is 4), where twig.js counts nothing.
 *
 * @param {unknown} value
 */
function platformLength(value) {
    if (typeof value === 'number' || typeof value === 'boolean') {
        return [...scalarText(value)].length;
    }

    return originalLength(value);
}

/**
 * Twig's join: a scalar joins to itself as text (true is 1, 1.5 is 1.5,
 * "abc" is abc), where twig.js prints nothing or splits the text.
 *
 * @param {unknown} value
 * @param {unknown[]} [params]
 */
function platformJoin(value, params) {
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' || value instanceof String) {
        return scalarText(value);
    }

    return originalJoin(value, params);
}

/**
 * A value as the platform reads it for a number: null and false are 0,
 * true is 1, text is its leading number (0 when it has none).
 *
 * @param {unknown} value
 */
function looseNumber(value) {
    if (value === null || value === undefined || value === false) {
        return 0;
    }

    if (value === true) {
        return 1;
    }

    const number = typeof value === 'number' ? value : parseFloat(String(value));

    return Number.isNaN(number) ? 0 : number;
}

/**
 * Twig's round, reading null, booleans, and text as the platform does
 * (null|round is 0), where twig.js prints NAN.
 *
 * @param {unknown} value
 * @param {unknown[]} [params]
 */
function platformRoundFilter(value, params = []) {
    const method = params[1] === undefined ? 'common' : params[1];

    if (method !== 'common') {
        return originalRound(looseNumber(value), params);
    }

    const precision = params[0] === undefined || params[0] === null ? 0 : Math.trunc(looseNumber(params[0]));

    return platformRound(looseNumber(value), precision);
}

/** @type {((text: string) => number|false)|null} */
let parseTime = null;

/**
 * Twig's date filter as the platform prints it: every format character
 * in UTC (e prints UTC), or in the zone given as its second argument
 * (false keeps the date's own zone: +00:00 for a timestamp). Text it
 * cannot read as a time is a render error, as it is there ("23 hours
 * from now" reads as 1970 in twig.js).
 *
 * The value is read as the platform reads it: nothing, false, and empty
 * text are now; true is the timestamp 1; whole numbers (and text of
 * digits, with an optional minus) are timestamps; any other number is
 * read as the text it prints as (1790000000.5 is a time of day there).
 *
 * @param {unknown} value
 * @param {unknown[]} [params]
 */
function platformDate(value, params = []) {
    const format = params[0] === undefined || params[0] === null ? 'F j, Y H:i' : String(params[0]);
    const zoneArgument = params[1];
    const zone = zoneArgument === undefined || zoneArgument === null || zoneArgument === false ? utcZone : platformZone(zoneArgument);
    const text = value === true ? '1' : (typeof value === 'number' ? platformNumberToString(value) : String(value ?? ''));
    /** @type {Date} */
    let date;

    if (value instanceof Date) {
        date = value;
    } else if (value === undefined || value === null || value === false || text === '') {
        date = new Date();
    } else if (/^-?\d+$/.test(text)) {
        date = new Date(Number(text) * 1000);

        return formatPlatformDate(format, date, zoneArgument === false ? fixedZone(0) : zone);
    } else {
        const seconds = parseTime === null ? false : parseTime(text);

        if (seconds === false || !Number.isFinite(seconds)) {
            // A number is never a word the platform may read as a zone:
            // printed as text it is a time there, or it fails there too.
            const refusal = typeof value === 'number'
                ? `Failed to parse time string (${text}) at position 0 (${text[0]}): Unexpected character`
                : unparseableDateMessage(text);

            if (refusal !== null) {
                throw new Error(refusal);
            }
        }

        date = new Date((seconds === false || !Number.isFinite(seconds) ? 0 : seconds) * 1000);
    }

    return formatPlatformDate(format, date, zone);
}

/** The operators the platform does arithmetic with. */
const arithmeticOperators = ['+', '-', '*', '/', '//', '%', '**'];

/**
 * The type name the platform's refusal message gives an operand.
 *
 * @param {unknown} value
 */
function operandType(value) {
    if (value === null || value === undefined) {
        return 'null';
    }

    if (typeof value === 'boolean') {
        return 'bool';
    }

    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'int' : 'float';
    }

    return 'string';
}

/**
 * An arithmetic operand as the platform reads it: null and false are 0,
 * true is 1, text that is a number its value. Text with a number and
 * more after it ("5 apples", "1,000") fails there ("A non-numeric value
 * encountered"); other text, a list or mapping, and captured text
 * ({% set %} ... {% endset %}) are refused ("Unsupported operand types").
 * A list beside a list is left to twig.js.
 *
 * @param {unknown} value
 * @returns {{number: number}|{refused: string}|{nonNumeric: true}|null}
 */
function arithmeticOperand(value) {
    if (value === null || value === undefined || typeof value === 'boolean') {
        return { number: looseNumber(value) };
    }

    if (typeof value === 'number') {
        return { number: value };
    }

    if (value instanceof String && /** @type {any} */ (value).twigMarkup === true) {
        return { refused: 'markup' };
    }

    if (typeof value === 'string' || value instanceof String) {
        const text = String(value);

        if (numericText.test(text)) {
            return { number: Number(text) };
        }

        return /^[ \t\n\r\v\f]*[+-]?(?:\d|\.\d)/.test(text) ? { nonNumeric: true } : { refused: 'string' };
    }

    if (Array.isArray(value) || (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)) {
        return { refused: 'array' };
    }

    return null;
}

/** The comparison operators the platform compares loosely, as its language does. */
const comparisonOperators = ['==', '!=', '<', '>', '<=', '>=', '<=>'];

/**
 * Whether a value is one the platform compares as a scalar: nothing, a
 * boolean, a number, or text (captured text included).
 *
 * @param {unknown} value
 * @returns {value is null|undefined|boolean|number|string|String}
 */
function isScalar(value) {
    return value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' || value instanceof String;
}

/** Text the platform reads as a number when comparing: surrounding whitespace allowed, nothing else. */
const numericText = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;

/**
 * A scalar as the platform reads it for true or false.
 *
 * @param {null|undefined|boolean|number|string|String} value
 */
function scalarTruth(value) {
    if (value === null || value === undefined) {
        return false;
    }

    if (typeof value === 'boolean' || typeof value === 'number') {
        return Boolean(value);
    }

    const text = String(value);

    return text !== '' && text !== '0';
}

/**
 * @param {number} left
 * @param {number} right
 */
function numberOrder(left, right) {
    return left === right ? 0 : (left < right ? -1 : 1);
}

/**
 * Text compared byte by byte, as the platform compares it.
 *
 * @param {string} left
 * @param {string} right
 */
function textOrder(left, right) {
    return Math.sign(Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

/**
 * Two scalars ordered as the platform's language orders them (its loose
 * comparison): nothing beside text is empty text; nothing or a boolean
 * beside anything else compares as true or false; a number beside text
 * that reads as a number compares as numbers, else as text; two texts
 * that both read as numbers compare as numbers, else byte by byte. So an
 * unset option equals 0 and is below 1, and 0 does not equal ''.
 *
 * @param {null|undefined|boolean|number|string|String} left
 * @param {null|undefined|boolean|number|string|String} right
 * @returns {number} -1, 0, or 1.
 */
export function platformCompare(left, right) {
    const leftText = typeof left === 'string' || left instanceof String ? String(left) : null;
    const rightText = typeof right === 'string' || right instanceof String ? String(right) : null;

    if ((left === null || left === undefined) && rightText !== null) {
        return textOrder('', rightText);
    }

    if ((right === null || right === undefined) && leftText !== null) {
        return textOrder(leftText, '');
    }

    if (left === null || left === undefined || right === null || right === undefined || typeof left === 'boolean' || typeof right === 'boolean') {
        return numberOrder(Number(scalarTruth(left)), Number(scalarTruth(right)));
    }

    if (leftText !== null && rightText !== null) {
        return numericText.test(leftText) && numericText.test(rightText) ? numberOrder(Number(leftText), Number(rightText)) : textOrder(leftText, rightText);
    }

    if (leftText !== null) {
        return numericText.test(leftText) ? numberOrder(Number(leftText), Number(right)) : textOrder(leftText, platformNumberToString(Number(right)));
    }

    if (rightText !== null) {
        return numericText.test(rightText) ? numberOrder(Number(left), Number(rightText)) : textOrder(platformNumberToString(Number(left)), rightText);
    }

    return numberOrder(Number(left), Number(right));
}

/**
 * The result of a comparison operator between two scalars.
 *
 * @param {string} operator
 * @param {number} order
 */
function comparisonResult(operator, order) {
    switch (operator) {
        case '==': return order === 0;
        case '!=': return order !== 0;
        case '<': return order < 0;
        case '>': return order > 0;
        case '<=': return order <= 0;
        case '>=': return order >= 0;
        default: return order;
    }
}

/**
 * The platform's `in` for a scalar: in text, whether the text holds it
 * (any text holds ''; nothing and booleans are never in text); in a list
 * or mapping, whether an item compares equal to it loosely. Null when
 * twig.js decides (anything else).
 *
 * @param {unknown} value
 * @param {unknown} haystack
 * @returns {boolean|null}
 */
function platformContains(value, haystack) {
    if (!isScalar(value)) {
        return null;
    }

    if (typeof haystack === 'string' || haystack instanceof String) {
        if (typeof value === 'string' || value instanceof String) {
            return String(value) === '' || String(haystack).includes(String(value));
        }

        return typeof value === 'number' ? String(haystack).includes(platformNumberToString(value)) : false;
    }

    if (Array.isArray(haystack) || (haystack !== null && typeof haystack === 'object' && Object.getPrototypeOf(haystack) === Object.prototype)) {
        return Object.values(/** @type {object} */ (haystack)).some((item) => isScalar(item) && platformCompare(value, item) === 0);
    }

    return null;
}

Twig.extendFilter('json', (value) => {
    const encoded = platformJsonEncode(value);

    return encoded === false ? '' : new Markup(encoded, 'html');
});
Twig.extendFilter('default', defaultKeepingFalse);
Twig.extendFilter('number_format', numberFormat);
Twig.extendFilter('trim', platformTrim);
Twig.extendFilter('first', endOf('first'));
Twig.extendFilter('last', endOf('last'));
Twig.extendFilter('slice', platformSlice);
Twig.extendFilter('length', platformLength);
Twig.extendFilter('join', platformJoin);
Twig.extendFilter('round', platformRoundFilter);
Twig.extendFilter('date', platformDate);
// On the platform an undefined variable or missing key is null.
Twig.extendTest('null', (value) => value === null || value === undefined);
Twig.extendTest('none', (value) => value === null || value === undefined);

/**
 * The platform's unescaping of a string literal's body: \\n \\t and friends, \\\\, an escaped quote of either
 * kind, \\x hex and octal escapes; any other escaped character stands for
 * itself. twig.js only unescapes the first escaped quote and \\n \\r.
 *
 * @param {string} body
 */
export function platformStringLiteral(body) {
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

    internal.expression.handler['Twig.expression.type.string'].compile = function platformStringCompile(token, stack, output) {
        const { value } = token;

        delete token.match;
        token.value = platformStringLiteral(value.slice(1, -1).replace(/\r\n?/g, '\n'));
        output.push(token);
    };

    const originalOutput = internal.output;

    internal.output = function platformOutput(output) {
        return originalOutput.call(this, output.map(platformPrintable));
    };

    // twig.js reads a missing key in brackets (files['missing']) as null,
    // which `is defined` then accepts; the platform treats it as undefined.
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

    parseTime = (text) => {
        const seconds = internal.lib.strtotime(text);

        return typeof seconds === 'number' ? seconds : false;
    };

    // Arithmetic as the platform does it: null and booleans are numbers,
    // text without a leading number is refused, a division or modulo by
    // zero is an error (twig.js prints NAN or INF), and modulo works on
    // whole numbers.
    const originalOperatorParse = internal.expression.operator.parse;

    internal.expression.operator.parse = function platformOperatorParse(operator, stack) {
        if (stack.length >= 2 && comparisonOperators.includes(operator) && isScalar(stack[stack.length - 1]) && isScalar(stack[stack.length - 2])) {
            const right = stack.pop();
            const left = stack.pop();

            stack.push(comparisonResult(operator, platformCompare(left, right)));

            return stack;
        }

        if (stack.length >= 2 && (operator === 'in' || operator === 'not in')) {
            const contained = platformContains(stack[stack.length - 2], stack[stack.length - 1]);

            if (contained !== null) {
                stack.splice(stack.length - 2, 2);
                stack.push(operator === 'in' ? contained : !contained);

                return stack;
            }
        }

        if (!arithmeticOperators.includes(operator) || stack.length < 2) {
            return originalOperatorParse.call(this, operator, stack);
        }

        const right = stack[stack.length - 1];
        const left = stack[stack.length - 2];
        const first = arithmeticOperand(left);
        const second = arithmeticOperand(right);

        if (first === null || second === null || ('refused' in first && first.refused === 'array' && 'refused' in second && second.refused === 'array')) {
            return originalOperatorParse.call(this, operator, stack);
        }

        // The left operand is read first: its failure is the one reported.
        for (const operand of [first, second]) {
            if ('refused' in operand) {
                const typeOf = (/** @type {unknown} */ value, /** @type {typeof first} */ read) => ('refused' in read ? read.refused : operandType(value));

                throw new Error(`Unsupported operand types: ${typeOf(left, first)} ${operator} ${typeOf(right, second)}`);
            }

            if ('nonNumeric' in operand) {
                throw new Error('A non-numeric value encountered');
            }
        }

        if ((operator === '/' || operator === '//') && second.number === 0) {
            throw new Error('Division by zero');
        }

        stack.splice(stack.length - 2, 2);

        if (operator === '%') {
            const divisor = Math.trunc(second.number);

            if (divisor === 0) {
                throw new Error('Modulo by zero');
            }

            stack.push(Math.trunc(first.number) % divisor);

            return stack;
        }

        stack.push(first.number, second.number);

        return originalOperatorParse.call(this, operator, stack);
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
 * Two token level fixes so twig.js output matches the platform. Twig prints a
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
 * Render a template the way the platform's renderer does: the
 * platform's pre render checks, the sandbox whitelist (as a lint over the
 * parsed tokens, since twig.js has no sandbox), autoescaped HTML, the
 * platform's printing of scalars, capped collections, and the iteration and time
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
