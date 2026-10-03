import { literalSignature, phpArrayKey, PhpFloat, phpFloatString, phpTrim, plainLiteral } from './php-values.js';
import { tokenizeTemplate, TemplateTokenError } from './twig-tokens.js';

/**
 * The options a template declares, inferred exactly as the platform infers
 * them (the block data contract): every `options.<key>` or
 * `options['<key>']` read is a field, the first literal `|default(...)` on
 * it is its default, a loop over it makes it a repeater whose item fields
 * are the loop variable's reads, and the key's naming convention types it.
 * A template that reads competition data (`competitions`, `categories`, or
 * `products`) also gets the platform's Categories filter field.
 *
 * The conventions, the Categories field, and the inferrer's warnings are
 * read from contexts.json (`block.options_defaults`) when the platform
 * publishes them, and otherwise use the values below, which the recorded
 * parity fixtures hold to the platform's.
 */

/**
 * @typedef {{key: string, type: string, label: string, help: string|null, default: unknown, default_expression: string|null, choices: string[], fields: OptionField[]}} OptionField
 * @typedef {{fields: OptionField[], warnings: string[]}} InferredOptions
 * @typedef {{names?: string[], prefixes?: string[], suffixes?: string[]}} Convention
 * @typedef {{order: string[], types: Record<string, Convention>}} Conventions
 */

export const categoriesKey = 'categories';

/** @type {Conventions} */
export const defaultConventions = {
    order: ['toggle', 'colour', 'image', 'url', 'textarea', 'number'],
    types: {
        textarea: { names: ['body', 'description', 'intro', 'content'], suffixes: ['_body', '_description', '_intro', '_content'] },
        colour: { names: ['colour', 'color'], suffixes: ['_colour', '_color'] },
        image: { names: ['image'], suffixes: ['_image'] },
        url: { names: ['url', 'link'], suffixes: ['_url', '_link'] },
        toggle: { prefixes: ['show_', 'hide_', 'enable_', 'is_', 'has_'], suffixes: ['_enabled'] },
        number: { names: ['count', 'limit', 'columns'], suffixes: ['_count', '_limit', '_columns', '_number'] },
    },
};

export const defaultCategoriesField = {
    label: 'Categories',
    help: 'Show only competitions in these categories. Leave all unticked to show every competition.',
};

export const defaultWarnings = {
    categories_read: 'options.categories is the platform\'s category filter, which narrows competitions and categories before the template renders. Read those lists instead of options.categories.',
    different_defaults: 'options.:key has different defaults in different places; the first one is used.',
};

const optionsVariable = 'options';
const catalogueVariables = ['competitions', 'categories', 'products'];
// The platform's key pattern allows one trailing newline: its `$` matches before it.
const keyPattern = /^[a-zA-Z_][a-zA-Z0-9_]*\n?$/;

/**
 * @typedef {object} InferenceRules
 * @property {Conventions} conventions
 * @property {{label: string, help: string}} categoriesField
 * @property {{categories_read: string, different_defaults: string}} warnings
 */

/**
 * The inference rules from contexts.json's `block.options_defaults`, each
 * part falling back to the kit's copy when it is not published.
 *
 * @param {any} [contexts]
 * @returns {InferenceRules}
 */
export function inferenceRules(contexts) {
    const published = contexts?.block?.options_defaults ?? {};
    const conventions = published.conventions;
    const validConventions = Array.isArray(conventions?.order) && conventions.types !== null && typeof conventions?.types === 'object';

    return {
        conventions: validConventions ? conventions : defaultConventions,
        categoriesField: typeof published.categories_field?.label === 'string' ? published.categories_field : defaultCategoriesField,
        warnings: { ...defaultWarnings, ...(published.warnings ?? {}) },
    };
}

/**
 * The label a key reads as when the creator has not set one:
 * `accent_colour` becomes "Accent colour".
 *
 * @param {string} key
 */
export function labelFor(key) {
    const label = phpTrim(key.replace(/_/g, ' '));

    return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The type a key's name implies, or null.
 *
 * @param {string} key
 * @param {Conventions} conventions
 * @returns {string|null}
 */
export function typeFromConvention(key, conventions = defaultConventions) {
    const name = key.toLowerCase();

    for (const type of conventions.order) {
        const convention = conventions.types[type] ?? {};

        if ((convention.names ?? []).includes(name)
            || (convention.prefixes ?? []).some((prefix) => name.startsWith(prefix))
            || (convention.suffixes ?? []).some((suffix) => name.endsWith(suffix))) {
            return type;
        }
    }

    return null;
}

/**
 * Convention, then literal default (a boolean is a toggle, a number a
 * number), then text.
 *
 * @param {string} key
 * @param {unknown} defaultValue
 * @param {Conventions} conventions
 */
export function inferType(key, defaultValue, conventions = defaultConventions) {
    const fromConvention = typeFromConvention(key, conventions);

    if (fromConvention !== null) {
        return fromConvention;
    }

    if (typeof defaultValue === 'boolean') {
        return 'toggle';
    }

    if (typeof defaultValue === 'number' || defaultValue instanceof PhpFloat) {
        return 'number';
    }

    return 'text';
}

/**
 * @param {string} type
 */
export function supportsChoices(type) {
    return type === 'text';
}

/**
 * @param {string} type
 */
export function isDeclaredByTemplate(type) {
    return type !== 'categories';
}

/**
 * @typedef {{value: unknown, expression: string|null}} FoundDefault
 * @typedef {{defaults: FoundDefault[], looped: boolean, children: Map<string, FoundDefault[]>, itemKeys: Map<string, unknown>}} FoundField
 */

/**
 * One pass over a template's tokens.
 *
 * @param {import('./twig-tokens.js').TemplateToken[]} tokens
 */
function scanTokens(tokens) {
    /** @type {Map<string, FoundField>} */
    const found = new Map();
    let readsCatalogue = false;

    const isType = (/** @type {number} */ index, /** @type {string} */ type) => tokens[index]?.type === type;
    const isName = (/** @type {number} */ index, /** @type {string} */ name) => isType(index, 'name') && tokens[index].value === name;
    const isSymbol = (/** @type {number} */ index, /** @type {string} */ symbol) => (isType(index, 'operator') || isType(index, 'punctuation')) && tokens[index].value === symbol;

    const field = (/** @type {string} */ key) => {
        if (!found.has(key)) {
            found.set(key, { defaults: [], looped: false, children: new Map(), itemKeys: new Map() });
        }

        return /** @type {FoundField} */ (found.get(key));
    };

    /**
     * @param {number} index
     * @returns {{key: string, next: number}|null}
     */
    const attributeAt = (index) => {
        let access = null;

        if (isSymbol(index, '.') && isType(index + 1, 'name')) {
            access = { key: String(tokens[index + 1].value), next: index + 2 };
        } else if (isSymbol(index, '[') && isType(index + 1, 'string') && isSymbol(index + 2, ']')) {
            access = { key: String(tokens[index + 1].value), next: index + 3 };
        }

        if (access === null || !keyPattern.test(access.key)) {
            return null;
        }

        return access;
    };

    /**
     * @param {number} index
     * @returns {{value: unknown, next: number}|null}
     */
    const literalAt = (index) => {
        const token = tokens[index];

        if (token === undefined) {
            return null;
        }

        if (token.type === 'string') {
            return isType(index + 1, 'interpolation_start') ? null : { value: String(token.value), next: index + 1 };
        }

        if (token.type === 'number') {
            return { value: token.float ? new PhpFloat(token.value) : token.value, next: index + 1 };
        }

        if (isSymbol(index, '-') && isType(index + 1, 'number')) {
            const number = tokens[index + 1];

            return { value: number.float ? new PhpFloat(-number.value) : -number.value, next: index + 2 };
        }

        if (token.type === 'name') {
            const name = String(token.value).toLowerCase();

            if (name === 'true' || name === 'false') {
                return { value: name === 'true', next: index + 1 };
            }

            return name === 'null' || name === 'none' ? { value: null, next: index + 1 } : null;
        }

        if (isSymbol(index, '[')) {
            return listAt(index + 1);
        }

        if (isSymbol(index, '{')) {
            return hashAt(index + 1);
        }

        return null;
    };

    /**
     * @param {number} index
     * @returns {{value: unknown[], next: number}|null}
     */
    const listAt = (index) => {
        /** @type {unknown[]} */
        const items = [];

        while (!isSymbol(index, ']')) {
            const item = literalAt(index);

            if (item === null) {
                return null;
            }

            items.push(item.value);
            index = item.next;

            if (isSymbol(index, ',')) {
                index++;
            }
        }

        return { value: items, next: index + 1 };
    };

    /**
     * @param {number} index
     * @returns {{value: Map<string, unknown>, next: number}|null}
     */
    const hashAt = (index) => {
        /** @type {Map<string, unknown>} */
        const hash = new Map();

        while (!isSymbol(index, '}')) {
            if (!isType(index, 'name') && !isType(index, 'string')) {
                return null;
            }

            const key = String(tokens[index].value);

            if (!isSymbol(index + 1, ':')) {
                return null;
            }

            const value = literalAt(index + 2);

            if (value === null) {
                return null;
            }

            // The platform's array keys: "1" and 1 are one key.
            const existing = [...hash.keys()].find((candidate) => phpArrayKey(candidate) === phpArrayKey(key));

            hash.set(existing ?? key, value.value);
            index = value.next;

            if (isSymbol(index, ',')) {
                index++;
            }
        }

        return { value: hash, next: index + 1 };
    };

    /**
     * @param {import('./twig-tokens.js').TemplateToken} token
     */
    const sourceOf = (token) => {
        if (token.type === 'string') {
            return `'${String(token.value).replace(/'/g, "\\'")}'`;
        }

        // The platform reads punctuation as an operator here too, so a comma
        // or a colon is spaced like one.
        if ((token.type === 'operator' || token.type === 'punctuation') && !['.', '[', ']', '(', ')', '|'].includes(token.value)) {
            return ` ${token.value} `;
        }

        if (token.type === 'number') {
            return token.float ? phpFloatString(token.value) : String(token.value);
        }

        return String(token.value);
    };

    /**
     * @param {number} index
     */
    const expressionUntilClose = (index) => {
        let depth = 0;
        let source = '';

        while (tokens[index] !== undefined) {
            if (isSymbol(index, '(') || isSymbol(index, '[') || isSymbol(index, '{')) {
                depth++;
            }

            if (isSymbol(index, ')') || isSymbol(index, ']') || isSymbol(index, '}')) {
                if (depth === 0) {
                    break;
                }

                depth--;
            }

            if (isType(index, 'block_end') || isType(index, 'var_end')) {
                break;
            }

            source += sourceOf(tokens[index]);
            index++;
        }

        return source;
    };

    /**
     * @param {number} index
     * @returns {FoundDefault|null}
     */
    const defaultAt = (index) => {
        if (!isSymbol(index, '|') || !isName(index + 1, 'default') || !isSymbol(index + 2, '(')) {
            return null;
        }

        const start = index + 3;
        const literal = literalAt(start);

        if (literal !== null && isSymbol(literal.next, ')')) {
            return { value: literal.value, expression: null };
        }

        return { value: null, expression: expressionUntilClose(start) };
    };

    /**
     * @param {number} index
     * @returns {{variable: string|null, repeater: string|null}}
     */
    const loopAt = (index) => {
        /** @type {string|null} */
        let variable = null;

        while (isType(index, 'name') || isSymbol(index, ',')) {
            if (isType(index, 'name')) {
                variable = String(tokens[index].value);
            }

            index++;
        }

        if (!isSymbol(index, 'in') || !isName(index + 1, optionsVariable)) {
            return { variable, repeater: null };
        }

        const access = attributeAt(index + 2);

        // A deeper read (options.promo.items) loops over the option's value.
        if (access === null || isSymbol(access.next, '.') || isSymbol(access.next, '[')) {
            return { variable, repeater: null };
        }

        field(access.key).looped = true;

        return { variable, repeater: access.key };
    };

    const recordOptionRead = (/** @type {number} */ index) => {
        const access = attributeAt(index + 1);

        if (access === null) {
            return;
        }

        const found = field(access.key);
        const defaultValue = defaultAt(access.next);

        if (defaultValue === null) {
            return;
        }

        found.defaults.push(defaultValue);

        const value = defaultValue.value;

        if (!Array.isArray(value) && !(value instanceof Map)) {
            return;
        }

        for (const item of value instanceof Map ? value.values() : value) {
            if (!(item instanceof Map) || isListLiteral(item)) {
                continue;
            }

            for (const [itemKey, itemValue] of item) {
                if (typeof phpArrayKey(itemKey) === 'string' && keyPattern.test(itemKey) && (found.itemKeys.get(itemKey) ?? null) === null) {
                    found.itemKeys.set(itemKey, itemValue);
                }
            }
        }
    };

    const recordItemRead = (/** @type {string} */ repeater, /** @type {number} */ index) => {
        const access = attributeAt(index + 1);

        if (access === null) {
            return;
        }

        const found = field(repeater);

        if (!found.children.has(access.key)) {
            found.children.set(access.key, []);
        }

        const defaultValue = defaultAt(access.next);

        if (defaultValue !== null) {
            /** @type {FoundDefault[]} */ (found.children.get(access.key)).push(defaultValue);
        }
    };

    /** @type {{variable: string|null, repeater: string|null}[]} */
    const loops = [];

    for (let index = 0; index < tokens.length; index++) {
        if (isType(index, 'block_start')) {
            if (isName(index + 1, 'for')) {
                loops.push(loopAt(index + 2));
            }

            if (isName(index + 1, 'endfor')) {
                loops.pop();
            }

            continue;
        }

        if (!isType(index, 'name') || isSymbol(index - 1, '.')) {
            continue;
        }

        const name = String(tokens[index].value);

        if (catalogueVariables.includes(name)) {
            readsCatalogue = true;
        }

        if (name === optionsVariable) {
            recordOptionRead(index);
            continue;
        }

        for (const loop of [...loops].reverse()) {
            if (loop.variable === name && loop.repeater !== null) {
                recordItemRead(loop.repeater, index);
                break;
            }
        }
    }

    return { found, readsCatalogue };
}

/**
 * @param {Map<string, unknown>} map
 */
function isListLiteral(map) {
    let expected = 0;

    for (const key of map.keys()) {
        if (phpArrayKey(key) !== expected) {
            return false;
        }

        expected++;
    }

    return true;
}

/**
 * @param {string} key
 * @param {FoundDefault[]} defaults
 * @param {InferenceRules} rules
 * @returns {string[]}
 */
function warningsFor(key, defaults, rules) {
    const distinct = new Set(defaults.map((found) => `${literalSignature(found.value)}|${JSON.stringify(found.expression)}`));

    return distinct.size > 1 ? [rules.warnings.different_defaults.replace(':key', key)] : [];
}

/**
 * @param {{key: string, type: string, label: string, help?: string|null, defaultValue?: unknown, expression?: string|null, choices?: string[], fields?: OptionField[]}} parts
 * @returns {OptionField}
 */
function makeField({ key, type, label, help = null, defaultValue = null, expression = null, choices = [], fields = [] }) {
    return { key, type, label, help, default: plainLiteral(defaultValue), default_expression: expression, choices, fields };
}

/**
 * The platform's Categories filter field.
 *
 * @param {InferenceRules} rules
 * @returns {OptionField}
 */
export function categoriesFilterField(rules) {
    return { key: categoriesKey, type: 'categories', label: rules.categoriesField.label, help: rules.categoriesField.help, default: [], default_expression: null, choices: [], fields: [] };
}

/**
 * Infer the options a template declares, with the authoring warnings the
 * platform reports. A template that does not tokenize declares nothing.
 *
 * @param {string} template
 * @param {any} [contexts] contexts.json, for the published inference rules.
 * @returns {InferredOptions}
 */
export function inferOptions(template, contexts) {
    const rules = inferenceRules(contexts);

    if (![optionsVariable, ...catalogueVariables].some((variable) => template.includes(variable))) {
        return { fields: [], warnings: [] };
    }

    let tokens;

    try {
        tokens = tokenizeTemplate(template);
    } catch (error) {
        if (error instanceof TemplateTokenError) {
            return { fields: [], warnings: [] };
        }

        throw error;
    }

    const { found, readsCatalogue } = scanTokens(tokens);
    /** @type {OptionField[]} */
    const fields = [];
    /** @type {string[]} */
    const warnings = [];

    for (const [key, entry] of found) {
        if (key === categoriesKey) {
            warnings.push(rules.warnings.categories_read);
            continue;
        }

        const first = entry.defaults[0] ?? { value: null, expression: null };
        const type = entry.looped ? 'repeater' : inferType(key, first.value, rules.conventions);

        warnings.push(...warningsFor(key, entry.defaults, rules));

        fields.push(makeField({
            key,
            type,
            label: labelFor(key),
            defaultValue: first.value,
            expression: first.expression,
            fields: type === 'repeater' ? childrenOf(key, entry, warnings, rules) : [],
        }));
    }

    if (readsCatalogue) {
        fields.push(categoriesFilterField(rules));
    }

    return { fields, warnings };
}

/**
 * Item fields from the loop variable's reads, then from keys in the
 * default items that the loop body never reads.
 *
 * @param {string} repeater
 * @param {FoundField} entry
 * @param {string[]} warnings
 * @param {InferenceRules} rules
 * @returns {OptionField[]}
 */
function childrenOf(repeater, entry, warnings, rules) {
    /** @type {Map<string, OptionField>} */
    const children = new Map();

    for (const [childKey, defaults] of entry.children) {
        const first = defaults[0] ?? { value: null, expression: null };
        const typeSource = first.value ?? entry.itemKeys.get(childKey) ?? null;

        warnings.push(...warningsFor(`${repeater}.${childKey}`, defaults, rules));
        children.set(childKey, makeField({
            key: childKey,
            type: inferType(childKey, typeSource, rules.conventions),
            label: labelFor(childKey),
            defaultValue: first.value,
            expression: first.expression,
        }));
    }

    for (const [childKey, itemValue] of entry.itemKeys) {
        if (children.has(childKey)) {
            continue;
        }

        children.set(childKey, makeField({ key: childKey, type: inferType(childKey, itemValue, rules.conventions), label: labelFor(childKey) }));
    }

    return [...children.values()];
}

/**
 * The creator's overrides from options.json applied as the platform applies
 * them: label and help on any declared field, choices only where the type
 * supports a select. Overrides for keys the template does not read are
 * ignored.
 *
 * @param {OptionField[]} fields
 * @param {unknown} overrides
 * @returns {OptionField[]}
 */
export function fieldsWithOverrides(fields, overrides) {
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return fields;
    }

    return fields.map((field) => {
        const override = /** @type {Record<string, any>} */ (overrides)[field.key];

        if (override === null || typeof override !== 'object' || !isDeclaredByTemplate(field.type)) {
            return field;
        }

        const label = typeof override.label === 'string' ? phpTrim(override.label) : '';
        const help = typeof override.help === 'string' ? phpTrim(override.help) : '';
        const choices = supportsChoices(field.type) && Array.isArray(override.choices) ? override.choices.filter((/** @type {unknown} */ choice) => typeof choice === 'string') : [];

        return {
            ...field,
            label: label !== '' ? label : field.label,
            help: help !== '' ? help : field.help,
            choices: choices.length > 0 ? choices : field.choices,
        };
    });
}

/**
 * The flattened keys a site can hold values under: top level keys, plus
 * `repeater.child` for repeater item fields, each with its label.
 *
 * @param {OptionField[]} fields
 * @returns {Map<string, string>}
 */
export function valueKeys(fields) {
    /** @type {Map<string, string>} */
    const keys = new Map();

    for (const field of fields) {
        keys.set(field.key, field.label);

        for (const child of field.fields) {
            keys.set(`${field.key}.${child.key}`, `${field.label}: ${child.label}`);
        }
    }

    return keys;
}
