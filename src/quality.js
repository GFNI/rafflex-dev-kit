import { Linter } from 'eslint';
import browserGlobals from 'globals';
import { HtmlValidate } from 'html-validate';
import { scenarioValues } from './checker.js';
import { blockContext, gameContext } from './context.js';
import { FormatError, formatTemplate, twigRegionPattern } from './format.js';
import { scanScripts } from './script-rules.js';
import { renderTemplate } from './twig-engine.js';

/**
 * The kit's own quality warnings (PRD 41), added to check: ESLint on every
 * inline script, an Alpine pass for attributes that read undeclared state,
 * an HTML validator for unclosed or misnested elements, duplicate ids and
 * images without alt, and the house style. They judge code quality, not
 * platform safety, so they live in the kit only and never block.
 *
 * Scripts and markup are linted as the browser gets them: rendered in one
 * scenario (mixed for a game), with each finding mapped back to its
 * template line where that line can be told apart.
 */

/** Fix hints for the kit's own codes; the platform's come from rules.issue_codes. */
export const kitFixes = Object.freeze({
    unformatted: 'Run npx @rafflex/dev format on the product. It only changes layout, never Twig.',
    script_lint: 'Fix the script at the reported line. The message names the ESLint rule.',
    alpine_state: 'Declare the name in the nearest x-data, or correct the spelling.',
    markup: 'Close and nest elements in order, keep ids unique, and give every img an alt.',
    console_error: 'Open the screenshot and the scenario in the preview, and fix what logs the error.',
    request_failed: 'Load media only through the files map, and check the file exists in assets/.',
    uncaught_exception: 'Fix the script error. It stops the game working on the live site.',
    csp_violation: 'The live site blocks this too. Load media only through the files map and keep code inline.',
    playthrough_mismatch: 'Reveal exactly the predetermined result of each play, in order. Read won from plays and never decide outcomes in the game.',
    creator_test_failed: 'Fix the product, or the spec in tests/ if it is wrong.',
});

const eslintRules = Object.freeze({
    'no-undef': 'warn',
    'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
    'no-unreachable': 'warn',
    eqeqeq: ['warn', 'smart'],
});

const htmlRules = Object.freeze({
    'close-order': 'error',
    'close-attr': 'error',
    'no-dup-id': 'error',
    'wcag/h37': 'error',
});

const nonJavaScriptTypes = /^(?:application\/(?:ld\+)?json|importmap|text\/(?:plain|template|html|x-template))$/i;

const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const alpineSkipped = new Set(['x-data', 'x-ref', 'x-cloak', 'x-ignore', 'x-teleport', 'x-id', 'x-transition']);

const handlerDirective = /^(?:@|x-on:|x-init$|x-effect$)/;

/**
 * @typedef {import('./checker.js').Issue} Issue
 */

/**
 * @param {string} code
 * @param {string} message
 * @param {{line?: number, scenario?: string}} [where]
 * @returns {Issue}
 */
export function kitIssue(code, message, where = {}) {
    /** @type {Issue} */
    const issue = { code, message, fix: /** @type {Record<string, string>} */ (kitFixes)[code] ?? '' };

    if (where.scenario !== undefined) {
        issue.scenario = where.scenario;
    }

    if (where.line !== undefined) {
        issue.line = where.line;
    }

    return issue;
}

/**
 * Maps a line of rendered output back to the template line it came from,
 * when exactly one template line could have produced it.
 *
 * @param {string} template
 * @returns {(renderedLine: string) => number|undefined}
 */
export function lineMapper(template) {
    const sentinel = '\u0000';
    const blanked = template.replace(twigRegionPattern, (region) => region.replace(/[^\n]/g, sentinel));
    const candidates = blanked.split('\n').map((line, index) => {
        const trimmed = line.trim();

        if (trimmed.replaceAll(sentinel, '').trim() === '') {
            return null;
        }

        const source = trimmed.split(/\u0000+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?');

        return { line: index + 1, text: trimmed, pattern: new RegExp(`^${source}$`) };
    }).filter((candidate) => candidate !== null);

    return (renderedLine) => {
        const trimmed = renderedLine.trim();

        if (trimmed === '') {
            return undefined;
        }

        const exact = candidates.filter((candidate) => candidate.text === trimmed);

        if (exact.length > 0) {
            return exact.length === 1 ? exact[0].line : undefined;
        }

        const matches = candidates.filter((candidate) => candidate.pattern.test(trimmed));

        return matches.length === 1 ? matches[0].line : undefined;
    };
}

/**
 * The rendered page lint runs on: the mixed scenario (or the first one)
 * for a game, the block context for a block.
 *
 * @param {{type: string, template: string, files: Record<string, string>, documents: {contexts: any, rules: any}}} input
 * @returns {{html: string, scenario: string|undefined}|null}
 */
function lintRender({ type, template, files, documents }) {
    const scenarios = scenarioValues(documents);
    const scenario = type === 'block' ? undefined : (scenarios.includes('mixed') ? 'mixed' : scenarios[0]);
    const context = type === 'block'
        ? blockContext(documents.contexts, { files, template })
        : gameContext(documents.contexts, { scenario, playCount: documents.contexts.play_count?.default ?? 5, files, template });

    try {
        return { html: renderTemplate(template, context, documents.rules.sandbox), scenario };
    } catch {
        return null;
    }
}

/**
 * @param {{name: string, value: string}[]} attributes
 * @param {string} name
 */
function attributeValue(attributes, name) {
    return attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

/**
 * The inline scripts ESLint can read, with where their content starts.
 *
 * @param {string} html
 * @returns {{content: string, module: boolean, startLine: number}[]}
 */
function inlineScripts(html) {
    return scanScripts(html)
        .filter((script) => attributeValue(script.attributes, 'src') === undefined && !nonJavaScriptTypes.test((attributeValue(script.attributes, 'type') ?? '').trim()))
        .map((script) => {
            const contentStart = html.indexOf(script.content, script.offset);

            return {
                content: script.content,
                module: (attributeValue(script.attributes, 'type') ?? '').trim().toLowerCase() === 'module',
                startLine: html.slice(0, contentStart === -1 ? script.offset : contentStart).split('\n').length,
            };
        });
}

/**
 * Names the page's classic scripts declare at the top level, which every
 * other script and Alpine expression can read as globals.
 *
 * @param {{content: string, module: boolean}[]} scripts
 * @returns {Record<string, 'writable'>}
 */
function pageGlobals(scripts) {
    /** @type {Record<string, 'writable'>} */
    const names = {};
    const linter = new Linter({ configType: 'flat' });

    for (const script of scripts.filter((entry) => !entry.module)) {
        linter.verify(script.content, [{ languageOptions: { ecmaVersion: 'latest', sourceType: 'script' }, rules: {} }]);

        const program = linter.getSourceCode()?.ast;

        for (const node of program?.body ?? []) {
            if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
                if (node.id) {
                    names[node.id.name] = 'writable';
                }
            } else if (node.type === 'VariableDeclaration') {
                for (const declaration of node.declarations) {
                    if (declaration.id.type === 'Identifier') {
                        names[declaration.id.name] = 'writable';
                    }
                }
            }
        }
    }

    return names;
}

/**
 * @param {string} html
 * @param {string} template
 * @param {string|undefined} scenario
 * @returns {Issue[]}
 */
export function scriptIssues(html, template, scenario) {
    const scripts = inlineScripts(html);
    const templateScripts = inlineScripts(template.replace(twigRegionPattern, (region) => region.replace(/[^\n]/g, ' ')));
    const sameScripts = templateScripts.length === scripts.length;
    const mapLine = lineMapper(template);
    const renderedLines = html.split('\n');
    const globals = { ...browserGlobals.browser, Alpine: 'readonly', ...pageGlobals(scripts) };
    const linter = new Linter({ configType: 'flat' });
    /** @type {Issue[]} */
    const issues = [];

    for (const [index, script] of scripts.entries()) {
        const messages = linter.verify(script.content, [{
            languageOptions: { ecmaVersion: 'latest', sourceType: script.module ? 'module' : 'script', globals },
            rules: eslintRules,
        }]);

        for (const message of messages) {
            const renderedLine = script.startLine + message.line - 1;
            const line = sameScripts ? templateScripts[index].startLine + message.line - 1 : mapLine(renderedLines[renderedLine - 1] ?? '');
            const rule = message.fatal ? 'syntax error' : message.ruleId;

            issues.push(kitIssue('script_lint', `${message.message} (${rule})`, { line, scenario }));
        }
    }

    return issues;
}

/**
 * @param {string} html
 * @param {string} template
 * @param {string|undefined} scenario
 * @returns {Promise<Issue[]>}
 */
export async function markupIssues(html, template, scenario) {
    const validator = new HtmlValidate({ root: true, extends: [], elements: ['html5'], rules: htmlRules });
    const report = await validator.validateString(html);
    const mapLine = lineMapper(template);
    const lines = html.split('\n');

    return report.results.flatMap((result) => result.messages).map((message) => kitIssue('markup', message.message, { line: mapLine(lines[message.line - 1] ?? ''), scenario }));
}

/**
 * Every start and end tag outside raw text, with its attributes.
 *
 * @param {string} html
 * @returns {{type: 'open'|'close', name: string, attributes: {name: string, value: string|null}[], offset: number, selfClosing: boolean}[]}
 */
function tags(html) {
    const found = [];
    const pattern = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
    let match;

    while ((match = pattern.exec(html)) !== null) {
        if (match[0].startsWith('<!--')) {
            continue;
        }

        if (match[1] !== undefined) {
            found.push({ type: /** @type {const} */ ('close'), name: match[1].toLowerCase(), attributes: [], offset: match.index, selfClosing: false });
            continue;
        }

        const name = match[2].toLowerCase();
        const attributes = [...match[3].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
            .map((attribute) => ({ name: attribute[1], value: attribute[2] ?? attribute[3] ?? attribute[4] ?? null }));

        found.push({ type: /** @type {const} */ ('open'), name, attributes, offset: match.index, selfClosing: match[4] === '/' });

        if (name === 'script' || name === 'style' || name === 'textarea') {
            const end = html.toLowerCase().indexOf(`</${name}`, pattern.lastIndex);

            pattern.lastIndex = end === -1 ? html.length : end;
        }
    }

    return found;
}

/**
 * @param {string} text
 */
function decodeEntities(text) {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
        .replace(/&amp;/g, '&');
}

/**
 * The keys an x-data value declares, or null when they cannot be known
 * statically (a component function, a spread).
 *
 * @param {Linter} linter
 * @param {string|null} value
 * @returns {string[]|null}
 */
function declaredKeys(linter, value) {
    if (value === null || value.trim() === '') {
        return [];
    }

    linter.verify(`(${value}\n);`, [{ languageOptions: { ecmaVersion: 'latest', sourceType: 'script' }, rules: {} }]);

    const expression = linter.getSourceCode()?.ast?.body?.[0]?.expression;

    if (expression?.type !== 'ObjectExpression') {
        return null;
    }

    const keys = [];

    for (const property of expression.properties) {
        if (property.type !== 'Property' || property.computed) {
            return null;
        }

        keys.push(property.key.type === 'Identifier' ? property.key.name : String(property.key.value));
    }

    return keys;
}

/**
 * The loop variables an x-for declares and the expression it iterates.
 *
 * @param {string} value
 * @returns {{names: string[], iterable: string}|null}
 */
function forLoop(value) {
    const match = /^\s*\(?\s*([\w$]+)(?:\s*,\s*([\w$]+))?(?:\s*,\s*([\w$]+))?\s*\)?\s+(?:in|of)\s+([\s\S]+)$/.exec(value);

    return match === null ? null : { names: [match[1], match[2], match[3]].filter((name) => name !== undefined), iterable: match[4] };
}

/**
 * Names an Alpine expression reads that nothing declares.
 *
 * @param {Linter} linter
 * @param {string} expression
 * @param {boolean} handler
 * @param {Record<string, string>} globals
 * @returns {string[]}
 */
function undeclaredNames(linter, expression, handler, globals) {
    const config = [{ languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals }, rules: { 'no-undef': 'error' } }];
    const attempts = handler
        ? [`(async function () {\n${expression}\n});`, `(${expression}\n);`]
        : [`(${expression}\n);`, `(async function () {\n${expression}\n});`];

    for (const code of attempts) {
        const messages = linter.verify(code, config);

        if (messages.some((message) => message.fatal)) {
            continue;
        }

        return [...new Set(messages.map((message) => /'([^']+)'/.exec(message.message)?.[1]).filter((name) => name !== undefined && !name.startsWith('$')))];
    }

    return [];
}

/**
 * Alpine attributes that read state no enclosing x-data declares. A
 * subtree whose x-data is a component function is skipped, since its
 * state cannot be known without running it.
 *
 * @param {string} html
 * @param {string} template
 * @param {string|undefined} scenario
 * @returns {Issue[]}
 */
export function alpineIssues(html, template, scenario) {
    const linter = new Linter({ configType: 'flat' });
    const scripts = inlineScripts(html);
    const baseGlobals = { ...browserGlobals.browser, Alpine: 'readonly', ...pageGlobals(scripts) };
    const mapLine = lineMapper(template);
    const lines = html.split('\n');
    /** @type {{name: string, keys: string[]|null, component: boolean}[]} */
    const stack = [];
    /** @type {Issue[]} */
    const issues = [];
    const seen = new Set();

    for (const tag of tags(html)) {
        if (tag.type === 'close') {
            const at = stack.map((frame) => frame.name).lastIndexOf(tag.name);

            if (at !== -1) {
                stack.length = at;
            }

            continue;
        }

        const data = tag.attributes.find((attribute) => attribute.name === 'x-data');
        const loop = tag.attributes.find((attribute) => attribute.name === 'x-for');
        const loopParts = loop?.value ? forLoop(decodeEntities(loop.value)) : null;
        /** @type {string[]|null} */
        let ownKeys = [];

        if (data !== undefined) {
            ownKeys = declaredKeys(linter, data.value === null ? null : decodeEntities(data.value));
        }

        const scopeKeys = [...stack, { name: tag.name, keys: ownKeys, component: data !== undefined }];
        const inComponent = scopeKeys.some((frame) => frame.component);
        const knowable = scopeKeys.every((frame) => frame.keys !== null);

        if (inComponent && knowable) {
            /** @type {Record<string, string>} */
            const globals = { ...baseGlobals };

            for (const frame of stack) {
                for (const key of frame.keys ?? []) {
                    globals[key] = 'writable';
                }
            }

            for (const key of ownKeys ?? []) {
                globals[key] = 'writable';
            }

            for (const attribute of tag.attributes) {
                const name = attribute.name;
                const isDirective = name.startsWith('@') || name.startsWith(':') || name.startsWith('x-');

                if (!isDirective || attribute.value === null || alpineSkipped.has(name.split(/[.:]/)[0]) || name.startsWith('x-transition')) {
                    continue;
                }

                const value = decodeEntities(attribute.value);
                const expression = name === 'x-for' ? (loopParts?.iterable ?? '') : value;

                if (expression.trim() === '') {
                    continue;
                }

                for (const undeclared of undeclaredNames(linter, expression, handlerDirective.test(name), globals)) {
                    const key = `${undeclared}|${name}|${value}`;

                    if (seen.has(key)) {
                        continue;
                    }

                    seen.add(key);
                    issues.push(kitIssue('alpine_state', `${name}="${value.length > 60 ? `${value.slice(0, 57)}...` : value}" reads ${undeclared}, which no enclosing x-data declares.`, {
                        line: mapLine(lines[html.slice(0, tag.offset).split('\n').length - 1] ?? ''),
                        scenario,
                    }));
                }
            }
        }

        if (!voidElements.has(tag.name) && !tag.selfClosing) {
            const keys = ownKeys === null ? null : [...(ownKeys ?? []), ...(loopParts?.names ?? [])];

            stack.push({ name: tag.name, keys, component: data !== undefined });
        }
    }

    return issues;
}

/**
 * The unformatted warning: present when the house style would change the
 * template. A template the formatter cannot safely touch gets no warning
 * (format reports why).
 *
 * @param {{type: string, template: string, files: Record<string, string>, documents: {contexts: any, rules: any}}} input
 * @returns {Promise<Issue[]>}
 */
export async function formatIssues(input) {
    try {
        const { changed } = await formatTemplate(input.template, input);

        return changed ? [kitIssue('unformatted', 'template.twig is not in the house style.')] : [];
    } catch (error) {
        if (error instanceof FormatError) {
            return [];
        }

        throw error;
    }
}

/**
 * Every kit quality warning for a template.
 *
 * @param {{type: string, template: string, files: Record<string, string>, documents: {contexts: any, rules: any}}} input
 * @returns {Promise<Issue[]>}
 */
export async function qualityIssues(input) {
    const rendered = lintRender(input);
    /** @type {Issue[]} */
    const issues = [];

    if (rendered !== null) {
        issues.push(
            ...scriptIssues(rendered.html, input.template, rendered.scenario),
            ...alpineIssues(rendered.html, input.template, rendered.scenario),
            ...await markupIssues(rendered.html, input.template, rendered.scenario),
        );
    }

    issues.push(...await formatIssues(input));

    return issues;
}
