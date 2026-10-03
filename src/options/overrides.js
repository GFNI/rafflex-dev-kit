import { compilePatterns, matchPatterns } from '../banned-patterns.js';
import { scriptViolations } from '../script-rules.js';
import { inferOptions, supportsChoices } from './infer.js';
import { phpNumber, phpTrim } from './php-values.js';

/**
 * options.json holds the creator's overrides for the options a template
 * declares: `{"heading": {"label": "Heading", "help": "Shown above the
 * grid", "choices": ["Small", "Large"]}}`. The marketplace normalises them
 * when they are pushed (text trimmed, empty parts dropped, choices split
 * on commas and new lines and de-duplicated, keys the template does not
 * read and choices on a field that cannot take them dropped) and refuses
 * the push, rolling back the template written with it, when a label, help,
 * or choice is too long or matches a banned pattern. The kit normalises
 * the same way, so the plan compares what the marketplace will store, and
 * reports everything the marketplace would refuse or silently drop.
 */

const overrideParts = ['label', 'help', 'choices'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Choices the marketplace accepts: a list (or map) of text.
 *
 * @param {unknown} choices
 * @returns {choices is string[]|Record<string, string>}
 */
function isTextList(choices) {
    return choices !== null && typeof choices === 'object' && Object.values(choices).every((choice) => typeof choice === 'string');
}

/**
 * The platform's loose sameness for choices: numeric strings compare as
 * numbers.
 *
 * @param {string} first
 * @param {string} second
 */
function sameChoice(first, second) {
    const firstNumber = phpNumber(first);
    const secondNumber = phpNumber(second);

    if (firstNumber !== null && secondNumber !== null) {
        return firstNumber === secondNumber;
    }

    return first === second;
}

/**
 * Choices as the platform stores them: joined, split on commas and new
 * lines, trimmed, without empties or repeats.
 *
 * @param {unknown} choices
 * @returns {string[]}
 */
export function normaliseChoices(choices) {
    if (!isTextList(choices)) {
        return [];
    }

    /** @type {string[]} */
    const normalised = [];

    for (const choice of Object.values(choices).join('\n').split(/[\n,]/)) {
        const trimmed = phpTrim(choice);

        if (trimmed !== '' && !normalised.some((existing) => sameChoice(existing, trimmed))) {
            normalised.push(trimmed);
        }
    }

    return normalised;
}

/**
 * options.json as the marketplace stores it once pushed with this
 * template's fields.
 *
 * @param {unknown} overrides
 * @param {import('./infer.js').OptionField[]} fields
 * @returns {Record<string, {label?: string, help?: string, choices?: string[]}>}
 */
export function normaliseOverrides(overrides, fields) {
    /** @type {Record<string, {label?: string, help?: string, choices?: string[]}>} */
    const normalised = {};

    if (!isObject(overrides)) {
        return normalised;
    }

    const types = new Map(fields.map((field) => [field.key, field.type]));

    for (const [key, override] of Object.entries(overrides)) {
        const type = types.get(key);

        if (type === undefined || !isObject(override)) {
            continue;
        }

        /** @type {{label?: string, help?: string, choices?: string[]}} */
        const entry = {};
        const label = typeof override.label === 'string' ? phpTrim(override.label) : '';
        const help = typeof override.help === 'string' ? phpTrim(override.help) : '';

        if (label !== '') {
            entry.label = label;
        }

        if (help !== '') {
            entry.help = help;
        }

        if (supportsChoices(type)) {
            const choices = normaliseChoices(override.choices);

            if (choices.length > 0) {
                entry.choices = choices;
            }
        }

        if (Object.keys(entry).length > 0) {
            normalised[key] = entry;
        }
    }

    return normalised;
}

/**
 * The part of the marketplace's normalisation that does not depend on the
 * template, for hashing both sides alike: in every entry that is an object,
 * label and help trimmed (dropped when empty), a list (not a map) of text
 * choices split, trimmed, and de-duplicated (dropped when empty), other parts
 * dropped, and the entry dropped when nothing is left. Anything the
 * marketplace would refuse instead (text of the wrong type, choices that
 * are not a list of text) is kept as written, and `check` reports it.
 *
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
export function normaliseOverrideText(overrides) {
    /** @type {Record<string, unknown>} */
    const normalised = {};

    for (const [key, override] of Object.entries(overrides)) {
        if (!isObject(override)) {
            normalised[key] = override;
            continue;
        }

        /** @type {Record<string, unknown>} */
        const entry = {};

        for (const part of ['label', 'help']) {
            const value = override[part];

            if (typeof value === 'string') {
                if (phpTrim(value) !== '') {
                    entry[part] = phpTrim(value);
                }
            } else if (value !== null && value !== undefined) {
                entry[part] = value;
            }
        }

        const choices = override.choices;

        // A map of choices is kept as written: sorted key JSON would lose
        // the order the marketplace reads its values in.
        if (Array.isArray(choices) && isTextList(choices)) {
            const split = normaliseChoices(choices);

            if (split.length > 0) {
                entry.choices = split;
            }
        } else if (choices !== null && choices !== undefined) {
            entry.choices = choices;
        }

        if (Object.keys(entry).length > 0) {
            normalised[key] = entry;
        }
    }

    return normalised;
}

/**
 * options.json normalised against a template, for hashing: what the
 * marketplace will store and send back after a push.
 *
 * @param {unknown} overrides
 * @param {string} template
 * @param {any} [contexts]
 */
export function storedOverrides(overrides, template, contexts) {
    return normaliseOverrides(overrides, inferOptions(template, contexts).fields);
}

/**
 * @typedef {{key: string, message: string, refused: boolean}} OverrideProblem
 * @typedef {{max_label_length?: number, max_help_length?: number, max_choices?: number}} OverrideLimits
 */

/**
 * @param {unknown} value
 */
function characters(value) {
    return Array.from(String(value)).length;
}

/**
 * Everything in options.json the marketplace would refuse (`refused`: the
 * whole push is rolled back) or silently drop. Refused: an entry that is
 * not an object, a label or help that is not text or is over the published
 * limit, choices that are not a list of text, too many or too long choices
 * on a text option, and text the banned patterns match. Dropped: keys the
 * template does not read, the Categories filter, parts other than label,
 * help, and choices, choices on an option that is not text, and a choice
 * with a comma (split in two). Limits are checked only when rules.json
 * publishes them.
 *
 * @param {unknown} overrides
 * @param {import('./infer.js').OptionField[]} fields
 * @param {any} rules rules.json
 * @returns {OverrideProblem[]}
 */
export function overrideProblems(overrides, fields, rules) {
    /** @type {OverrideProblem[]} */
    const problems = [];

    if (overrides === null || overrides === undefined || (Array.isArray(overrides) && overrides.length === 0)) {
        return problems;
    }

    if (!isObject(overrides)) {
        return [{ key: '', message: 'options.json must be a JSON object keyed by option name, such as {"heading": {"label": "Heading"}}.', refused: true }];
    }

    /** @type {OverrideLimits} */
    const limits = isObject(rules?.option_overrides) ? rules.option_overrides : {};
    const types = new Map(fields.map((field) => [field.key, field.type]));
    const refuse = (/** @type {string} */ key, /** @type {string} */ message) => problems.push({ key, message, refused: true });
    const drop = (/** @type {string} */ key, /** @type {string} */ message) => problems.push({ key, message, refused: false });

    for (const [key, override] of Object.entries(overrides)) {
        const type = types.get(key);

        if (override === null || typeof override !== 'object') {
            refuse(key, `options.json "${key}" must be an object with label, help, or choices.`);
            continue;
        }

        const entry = /** @type {Record<string, unknown>} */ (override);

        for (const part of ['label', 'help']) {
            const value = entry[part];
            const maximum = part === 'label' ? limits.max_label_length : limits.max_help_length;

            if (value === null || value === undefined) {
                continue;
            }

            if (typeof value !== 'string') {
                refuse(key, `options.json "${key}" ${part} must be text.`);
                continue;
            }

            if (Number.isInteger(maximum) && characters(value) > /** @type {number} */ (maximum)) {
                refuse(key, `options.json "${key}" ${part} is ${characters(value)} characters; the marketplace allows ${maximum}.`);
            }
        }

        const hasChoices = entry.choices !== null && entry.choices !== undefined;

        if (hasChoices && !isTextList(entry.choices)) {
            refuse(key, `options.json "${key}" choices must be a list of text, such as ["Small", "Large"].`);
        }

        if (type === undefined) {
            drop(key, `options.json sets "${key}", but the template never reads options.${key}, so the marketplace ignores it. Remove it, or read options.${key} in the template.`);
            continue;
        }

        if (type === 'categories') {
            drop(key, 'options.json sets "categories", the platform\'s own category filter, which always reads the same. Remove it.');
            continue;
        }

        for (const part of Object.keys(entry).filter((name) => !overrideParts.includes(name))) {
            drop(key, `options.json "${key}" has "${part}", which the marketplace ignores. Use label, help, or choices.`);
        }

        if (!hasChoices || !isTextList(entry.choices)) {
            continue;
        }

        if (!supportsChoices(type)) {
            drop(key, `options.json "${key}" has choices, but options.${key} is a ${type} option and only text options take choices, so the marketplace ignores them. Remove them, or rename the option so it is a text option.`);
            continue;
        }

        if (Object.values(entry.choices).some((choice) => /[,\n]/.test(choice))) {
            drop(key, `options.json "${key}" has a choice with a comma or a new line, which the marketplace splits into separate choices.`);
        }

        const choices = normaliseChoices(entry.choices);

        if (Number.isInteger(limits.max_choices) && choices.length > /** @type {number} */ (limits.max_choices)) {
            refuse(key, `options.json "${key}" has ${choices.length} choices; the marketplace allows ${limits.max_choices}.`);
        }

        if (Number.isInteger(limits.max_label_length) && choices.some((choice) => characters(choice) > /** @type {number} */ (limits.max_label_length))) {
            refuse(key, `options.json "${key}" has a choice over ${limits.max_label_length} characters, the most the marketplace allows.`);
        }
    }

    for (const message of bannedTextMessages(normaliseOverrides(overrides, fields), rules)) {
        refuse('', `options.json: ${message}`);
    }

    return problems;
}

/**
 * The banned patterns and script rules over the override text, as the
 * marketplace checks it: every label, help, and choice joined by new lines.
 *
 * @param {Record<string, {label?: string, help?: string, choices?: string[]}>} normalised
 * @param {any} rules
 * @returns {string[]}
 */
function bannedTextMessages(normalised, rules) {
    const text = Object.values(normalised).flatMap((override) => [override.label ?? '', override.help ?? '', ...(override.choices ?? [])]).join('\n');

    if (text.replace(/\n/g, '') === '') {
        return [];
    }

    const { patterns } = compilePatterns(rules?.banned_patterns ?? []);
    const messages = matchPatterns(text, patterns, { includeSourceOnly: true }).map((match) => match.message);

    if (rules?.script_rules?.messages !== undefined) {
        messages.push(...scriptViolations(text, () => false, rules.script_rules).map((violation) => violation.message));
    }

    return [...new Set(messages)];
}
