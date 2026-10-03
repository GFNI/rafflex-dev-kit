import { gameContext } from '../context.js';
import { renderTemplate } from '../twig-engine.js';
import { inferOptions, valueKeys } from './infer.js';
import { overrideProblems } from './overrides.js';
import { formFields } from './render-options.js';
import { toggleDefault, valueLimits } from './values.js';

/**
 * The option checks `check` adds to the platform's rules:
 *
 * - `option_warning` for every warning the platform's options inferrer
 *   reports, and when the draft stops reading an option the live version
 *   reads (sites that set it lose the value);
 * - `option_override_invalid` (blocking) for everything in options.json
 *   the marketplace would refuse on a push, rolling the push back, and
 *   `option_warning` for what it would silently drop;
 * - `option_render_error` (blocking) when a scenario fails to render once
 *   every option is set to a sample value of its type, as a buyer may set
 *   it: long text, a large number, toggles flipped from their default, each
 *   choice in turn, a full repeater, and a ticked category.
 */

export const optionFixes = Object.freeze({
    option_override_invalid: 'Fix options.json as the message says. The marketplace refuses the push, or drops the entry, otherwise.',
    option_render_error: 'Make the template render with any value a buyer may set: check the option before using it, and keep loops and lengths within limits.',
});

/**
 * @typedef {import('../checker.js').Issue} Issue
 * @typedef {import('./infer.js').OptionField} OptionField
 */

/**
 * @param {string} code
 * @param {string} message
 * @param {any} rules
 * @param {{scenario?: string, file?: string}} [where]
 * @returns {Issue}
 */
function optionIssue(code, message, rules, where = {}) {
    const published = rules?.issue_codes?.[code];
    const fix = typeof published === 'string' ? published : (published?.fix ?? /** @type {Record<string, string>} */ (optionFixes)[code] ?? '');

    return { code, message, fix, ...where };
}

/**
 * The platform's option warnings for a template, as check issues.
 *
 * @param {string} template
 * @param {any} documents
 * @returns {Issue[]}
 */
export function optionWarningIssues(template, documents) {
    return inferOptions(template, documents.contexts).warnings.map((warning) => optionIssue('option_warning', warning, documents.rules));
}

/**
 * The option keys to compare with a live version's: flattened item keys
 * (`slides.title`) only when the live keys carry them.
 *
 * @param {OptionField[]} fields
 * @param {string[]} liveKeys
 */
export function comparableKeys(fields, liveKeys) {
    return liveKeys.some((key) => key.includes('.')) ? [...valueKeys(fields).keys()] : fields.map((field) => field.key);
}

/**
 * Options the live version reads that the local template no longer does.
 *
 * @param {OptionField[]} fields
 * @param {unknown} liveKeys
 * @returns {string[]}
 */
export function droppedOptionKeys(fields, liveKeys) {
    if (!Array.isArray(liveKeys)) {
        return [];
    }

    const keys = liveKeys.filter((key) => typeof key === 'string');
    const local = new Set(comparableKeys(fields, keys));

    return keys.filter((key) => !local.has(key));
}

/**
 * A sample value of a field's type, the way a buyer may set it.
 *
 * @param {OptionField} field
 * @param {number} round Which choice to use.
 * @param {{images: string[], categories: string[], limits: import('./values.js').ValueLimits, toggleDefault: (field: OptionField) => boolean}} samples
 * @returns {unknown}
 */
function sampleValue(field, round, samples) {
    const longText = (/** @type {number} */ length) => 'A much longer value than the template was written for. '.repeat(Math.ceil(length / 56)).slice(0, length);

    switch (field.type) {
        case 'toggle':
            return !samples.toggleDefault(field);
        case 'number':
            return 1000000;
        case 'textarea':
            return longText(samples.limits.max_long_text_length);
        case 'colour':
            return '#ff00ff';
        case 'image':
            return samples.images[round % Math.max(1, samples.images.length)];
        case 'url':
            return `https://example.com/${'path/'.repeat(40)}?campaign=${'x'.repeat(200)}`;
        case 'categories':
            return samples.categories.slice(0, 1);
        case 'repeater':
            return Array.from({ length: samples.limits.max_repeater_items }, (_, index) => Object.fromEntries(field.fields.map((child) => [child.key, sampleValue(child, round + index, samples)])));
        default:
            return field.choices.length > 0 ? field.choices[round % field.choices.length] : longText(samples.limits.max_text_length);
    }
}

/**
 * The value sets a check renders with: one per choice of the field with
 * the most choices (at least one).
 *
 * @param {OptionField[]} fields
 * @param {{images: string[], categories: string[], limits: import('./values.js').ValueLimits}} samples
 * @returns {Record<string, unknown>[]}
 */
export function sampleValueSets(fields, samples) {
    const flipFrom = (/** @type {OptionField} */ field) => toggleDefault(field, samples.limits) === true;
    const rounds = Math.max(1, ...fields.map((field) => field.choices.length), ...fields.flatMap((field) => field.fields.map((child) => child.choices.length)));

    return Array.from({ length: rounds }, (_, round) => Object.fromEntries(fields.map((field) => [field.key, sampleValue(field, round, { ...samples, toggleDefault: flipFrom })])));
}

/**
 * @param {string} template
 * @param {Record<string, unknown>} context
 * @param {any} rules
 * @returns {string|null}
 */
function renderError(template, context, rules) {
    try {
        renderTemplate(template, context, rules.sandbox);

        return null;
    } catch (error) {
        return String(/** @type {Error} */ (error).message);
    }
}

/**
 * @typedef {object} OptionCheckInput
 * @property {string} template
 * @property {Record<string, string>} files Tag to URL.
 * @property {unknown} overrides options.json's content (null when absent).
 * @property {string|null} [overridesError] Why options.json could not be read.
 * @property {{images: string[]}} [assets] The product's image URLs, for image options.
 * @property {{live_version?: string|null, live_option_keys?: unknown}|null} [remote]
 * @property {{rules: any, contexts: any}} documents
 * @property {number} playCount
 * @property {string[]} scenarios
 */

/**
 * The option checks for one product (the warnings from the inferrer come
 * from runChecks, beside the platform's other issues).
 *
 * @param {OptionCheckInput} input
 * @returns {Issue[]}
 */
export function optionIssues({ template, files, overrides, overridesError = null, assets, remote, documents, playCount, scenarios }) {
    const { rules, contexts } = documents;
    /** @type {Issue[]} */
    const issues = [];
    const inferred = inferOptions(template, contexts);

    if (overridesError !== null) {
        issues.push(optionIssue('option_override_invalid', overridesError, rules, { file: 'options.json' }));
    }

    for (const problem of overrideProblems(overrides, inferred.fields, rules)) {
        issues.push(optionIssue(problem.refused ? 'option_override_invalid' : 'option_warning', problem.message, rules, { file: 'options.json' }));
    }

    for (const key of droppedOptionKeys(inferred.fields, remote?.live_option_keys)) {
        const live = typeof remote?.live_version === 'string' ? `The live version ${remote.live_version}` : 'The live version';

        issues.push(optionIssue('option_warning', `${live} reads options.${key}, which this version no longer reads. Sites that set it lose the value, so this is a major release.`, rules));
    }

    const { fields } = formFields(template, overrides, contexts);

    if (fields.length === 0) {
        return issues;
    }

    const images = assets?.images ?? Object.values(files);
    const categories = (contexts.shared?.categories ?? []).map((/** @type {{slug: string}} */ category) => category.slug);
    const valueSets = sampleValueSets(fields, { images, categories, limits: valueLimits(contexts) });
    // A scenario that fails with nothing set is already a render error.
    const seen = new Set(scenarios.map((scenario) => renderError(template, gameContext(contexts, { scenario, playCount, files, template, overrides }), rules)));

    for (const [round, values] of valueSets.entries()) {
        for (const scenario of scenarios) {
            try {
                renderTemplate(template, gameContext(contexts, { scenario, playCount, files, template, options: values, overrides }), rules.sandbox);
            } catch (error) {
                const message = String(/** @type {Error} */ (error).message);

                if (!seen.has(message)) {
                    seen.add(message);
                    issues.push(optionIssue('option_render_error', `With every option set as a buyer may set it${valueSets.length > 1 ? ` (choice ${round + 1})` : ''}: ${message}`, rules, { scenario }));
                }
            }
        }
    }

    return issues;
}
