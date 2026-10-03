import * as prettier from 'prettier';
import { scenarioValues } from './checker.js';
import { blockContext, gameContext } from './context.js';
import { renderTemplate } from './twig-engine.js';

/**
 * The house style (PRD 41): Prettier over the template's HTML, inline CSS,
 * and inline JavaScript with one fixed configuration that ships pinned
 * with the kit, so every creator's templates look alike and a version
 * diff shows real changes. There are no options.
 *
 * Twig is never formatted. Every Twig region ({{ }}, {% %}, {# #}) is
 * masked with a placeholder before Prettier runs and restored byte for
 * byte after. Two checks then make sure formatting changed nothing that
 * matters: the Twig regions must come back identical and in order, and
 * the formatted template must render to the same page as the original in
 * every scenario (both renders compared after Prettier, so only layout
 * whitespace may differ). A template that fails either check is left
 * untouched and the reason is reported.
 */

/** @type {import('prettier').Options} */
export const houseStyle = Object.freeze({
    parser: 'html',
    printWidth: 120,
    tabWidth: 4,
    useTabs: false,
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    bracketSameLine: false,
    htmlWhitespaceSensitivity: 'css',
    embeddedLanguageFormatting: 'auto',
    endOfLine: 'lf',
});

/** The platform's Twig region pattern (SubmissionSafetyChecker, GameTemplateRules). */
export const twigRegionPattern = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;

const placeholderPrefix = 'rfxtw';

export class FormatError extends Error {}

/**
 * @param {string} template
 * @returns {{text: string, offset: number}[]}
 */
export function twigRegions(template) {
    return [...template.matchAll(twigRegionPattern)].map((match) => ({ text: match[0], offset: match.index }));
}

/**
 * Which regions sit inside a single quoted attribute value, read the way
 * an HTML tokenizer reads the template with its Twig blanked out. Their
 * placeholders carry a double quote so Prettier keeps the single quotes:
 * Twig such as {{ plays|json }} prints double quotes, which only a single
 * quoted attribute can hold.
 *
 * @param {string} template
 * @param {{text: string, offset: number}[]} regions
 * @returns {boolean[]}
 */
function singleQuotedRegions(template, regions) {
    let blanked = template;

    for (const region of regions) {
        blanked = `${blanked.slice(0, region.offset)}${'a'.repeat(region.text.length)}${blanked.slice(region.offset + region.text.length)}`;
    }

    /** @type {('text'|'tag'|'single'|'double'|'unquoted')[]} */
    const states = new Array(blanked.length);
    let state = /** @type {'text'|'tag'|'single'|'double'|'unquoted'} */ ('text');
    let rawTextEnd = /** @type {string|null} */ (null);
    let index = 0;

    while (index < blanked.length) {
        const character = blanked[index];

        if (state === 'text') {
            if (rawTextEnd !== null) {
                const end = blanked.toLowerCase().indexOf(rawTextEnd, index);
                const stop = end === -1 ? blanked.length : end;

                states.fill('text', index, stop);
                index = stop;
                rawTextEnd = null;
                continue;
            }

            if (blanked.startsWith('<!--', index)) {
                const end = blanked.indexOf('-->', index + 4);
                const stop = end === -1 ? blanked.length : end + 3;

                states.fill('text', index, stop);
                index = stop;
                continue;
            }

            if (character === '<' && /[A-Za-z]/.test(blanked[index + 1] ?? '')) {
                const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(blanked.slice(index + 1))?.[0].toLowerCase() ?? '';

                if (name === 'script' || name === 'style' || name === 'textarea' || name === 'title') {
                    rawTextEnd = `</${name}`;
                }

                state = 'tag';
            }

            states[index++] = 'text';
            continue;
        }

        if (state === 'tag') {
            if (character === '>') {
                state = 'text';
            } else if (character === '=') {
                let next = index + 1;

                while (/\s/.test(blanked[next] ?? '')) {
                    next++;
                }

                states.fill('tag', index, next);
                index = next;

                if (blanked[index] === "'") {
                    state = 'single';
                    states[index++] = 'tag';
                } else if (blanked[index] === '"') {
                    state = 'double';
                    states[index++] = 'tag';
                } else {
                    state = 'unquoted';
                }

                continue;
            }

            states[index++] = 'tag';
            continue;
        }

        if ((state === 'single' && character === "'") || (state === 'double' && character === '"')) {
            states[index++] = 'tag';
            state = 'tag';
            continue;
        }

        if (state === 'unquoted' && (/\s/.test(character) || character === '>')) {
            state = 'tag';
            continue;
        }

        states[index++] = state;
    }

    return regions.map((region) => states[region.offset] === 'single');
}

/**
 * Replace every Twig region with a unique placeholder that is a valid
 * identifier in HTML, CSS, and JavaScript, padded towards the region's
 * length so line wrapping stays close to the real template.
 *
 * @param {string} template
 * @returns {{masked: string, placeholders: {placeholder: string, text: string}[]}}
 */
export function maskTwig(template) {
    if (template.includes(placeholderPrefix)) {
        throw new FormatError(`The template contains "${placeholderPrefix}", which the formatter uses for its own placeholders, so it is left as it is.`);
    }

    const regions = twigRegions(template);
    const singleQuoted = singleQuotedRegions(template, regions);
    /** @type {{placeholder: string, text: string}[]} */
    const placeholders = [];
    let masked = '';
    let cursor = 0;

    for (const [index, region] of regions.entries()) {
        const head = `${placeholderPrefix}${index}${singleQuoted[index] ? '"' : 'x'}`;
        const longestLine = Math.max(...region.text.split('\n').map((line) => line.length));
        const placeholder = head.padEnd(Math.max(head.length, longestLine), 'x');

        placeholders.push({ placeholder, text: region.text });
        masked += template.slice(cursor, region.offset) + placeholder;
        cursor = region.offset + region.text.length;
    }

    return { masked: masked + template.slice(cursor), placeholders };
}

/**
 * Put the Twig back. Every placeholder must survive exactly once, in its
 * original order, or the result is refused.
 *
 * @param {string} formatted
 * @param {{placeholder: string, text: string}[]} placeholders
 */
export function restoreTwig(formatted, placeholders) {
    let restored = '';
    let cursor = 0;

    for (const { placeholder, text } of placeholders) {
        const at = formatted.indexOf(placeholder, cursor);

        if (at === -1 || formatted.indexOf(placeholder, at + placeholder.length) !== -1) {
            throw new FormatError('Formatting would move or change Twig, so the template is left as it is.');
        }

        restored += formatted.slice(cursor, at) + text;
        cursor = at + placeholder.length;
    }

    if (formatted.slice(cursor).includes(placeholderPrefix)) {
        throw new FormatError('Formatting would move or change Twig, so the template is left as it is.');
    }

    return restored + formatted.slice(cursor);
}

/**
 * @param {string} html
 */
async function canonical(html) {
    try {
        return await prettier.format(html, houseStyle);
    } catch {
        return html.replace(/\s+/g, ' ').trim();
    }
}

/**
 * @param {string} template
 * @param {Record<string, any>} context
 * @param {any} sandbox
 */
function renderOrError(template, context, sandbox) {
    try {
        return { html: renderTemplate(template, context, sandbox), error: null };
    } catch (error) {
        return { html: null, error: String(/** @type {Error} */ (error).message) };
    }
}

/**
 * The contexts a template is rendered with to prove formatting kept the
 * page the same: every game scenario at the default play count, or the
 * block context.
 *
 * @param {{type: string, documents: {contexts: any, rules: any}, files?: Record<string, string>}} product
 * @param {string} template
 * @returns {Record<string, any>[]}
 */
function proofContexts({ type, documents, files = {} }, template) {
    if (type === 'block') {
        return [blockContext(documents.contexts, { files, template })];
    }

    const playCount = documents.contexts.play_count?.default ?? 5;

    return scenarioValues(documents).map((/** @type {string} */ scenario) => gameContext(documents.contexts, { scenario, playCount, files, template }));
}

/**
 * Whether two templates render to the same page in every proof context.
 *
 * @param {string} original
 * @param {string} formatted
 * @param {{type: string, documents: {contexts: any, rules: any}, files?: Record<string, string>}} product
 * @returns {Promise<string|null>} null when they match, else the reason.
 */
export async function renderingDifference(original, formatted, product) {
    for (const context of proofContexts(product, original)) {
        const before = renderOrError(original, context, product.documents.rules.sandbox);
        const after = renderOrError(formatted, context, product.documents.rules.sandbox);

        if (before.error !== null || after.error !== null) {
            if (before.error !== after.error) {
                return 'Formatting would change how the template renders, so it is left as it is.';
            }

            continue;
        }

        if (await canonical(/** @type {string} */ (before.html)) !== await canonical(/** @type {string} */ (after.html))) {
            return 'Formatting would change the rendered page, so the template is left as it is.';
        }
    }

    return null;
}

/**
 * Format a template in the house style.
 *
 * @param {string} template
 * @param {{type: string, documents: {contexts: any, rules: any}, files?: Record<string, string>}|null} [product] When given, the result must render the same as the original.
 * @returns {Promise<{formatted: string, changed: boolean}>}
 */
export async function formatTemplate(template, product = null) {
    const { masked, placeholders } = maskTwig(template);
    let output;

    try {
        output = await prettier.format(masked, houseStyle);
    } catch (error) {
        const message = String(/** @type {Error} */ (error).message).split('\n')[0];

        throw new FormatError(`Prettier could not read the template: ${message}`);
    }

    const formatted = restoreTwig(output, placeholders);

    if (formatted === template) {
        return { formatted, changed: false };
    }

    const original = twigRegions(template).map((region) => region.text);
    const kept = twigRegions(formatted).map((region) => region.text);

    if (original.length !== kept.length || original.some((text, index) => text !== kept[index])) {
        throw new FormatError('Formatting would move or change Twig, so the template is left as it is.');
    }

    if (product !== null) {
        const difference = await renderingDifference(template, formatted, product);

        if (difference !== null) {
            throw new FormatError(difference);
        }
    }

    return { formatted, changed: true };
}
