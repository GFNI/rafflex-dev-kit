import { isPlatformArray, isPlatformList, isScalar, platformBoolean, platformNumber, platformString, platformTrim } from './platform-values.js';

/**
 * Option values a site owner (or the app's options form) sets, turned into
 * the `options` a template renders with, exactly as the platform does:
 * values are coerced to their field's type, empty values stay unset so
 * the template's own `|default(...)` applies, and every toggle arrives as
 * an explicit boolean, its default when unset. The Categories filter never
 * reaches `options`; it narrows the competition data instead.
 *
 * The caps below are the platform's. `max_repeater_items` is published in
 * contexts.json; the text and query caps are not yet, so the kit holds
 * them and the recorded parity fixtures prove them.
 */

export const defaultLimits = {
    max_repeater_items: 20,
    max_query_bytes: 10000,
    max_text_length: 500,
    max_long_text_length: 5000,
    toggle_unset: false,
};

/**
 * @typedef {typeof defaultLimits} ValueLimits
 */

/**
 * The value caps, from contexts.json's `block.options_defaults` where
 * published.
 *
 * @param {any} [contexts]
 * @returns {ValueLimits}
 */
export function valueLimits(contexts) {
    const published = contexts?.block?.options_defaults ?? {};
    /** @type {any} */
    const limits = { ...defaultLimits };

    for (const key of Object.keys(defaultLimits)) {
        if (Number.isInteger(published[key]) && published[key] > 0) {
            limits[key] = published[key];
        }
    }

    if (typeof published.toggle_unset === 'boolean') {
        limits.toggle_unset = published.toggle_unset;
    }

    return limits;
}

/**
 * How many arrays deep a decoded value nests.
 *
 * @param {unknown} value
 * @returns {number}
 */
function depthOf(value) {
    if (value === null || typeof value !== 'object') {
        return 0;
    }

    const children = Object.values(value);

    return 1 + (children.length === 0 ? 0 : Math.max(...children.map(depthOf)));
}

/**
 * Decode an `options` query parameter, or nothing when it is missing,
 * oversized, too deep, or not a JSON object.
 *
 * @param {unknown} query
 * @param {ValueLimits} [limits]
 * @returns {Record<string, unknown>}
 */
export function valuesFromQuery(query, limits = defaultLimits) {
    if (typeof query !== 'string' || query === '' || Buffer.byteLength(query, 'utf8') > limits.max_query_bytes) {
        return {};
    }

    let decoded;

    try {
        decoded = JSON.parse(query);
    } catch {
        return {};
    }

    // The platform decodes at most 6 levels, the value inside the deepest
    // array counting as one.
    if (!isPlatformArray(decoded) || isPlatformList(decoded) || depthOf(decoded) > 5) {
        return {};
    }

    return /** @type {Record<string, unknown>} */ (decoded);
}

/**
 * An unset toggle resolves to its default rather than staying missing; a
 * toggle without a literal default to the published `toggle_unset`.
 *
 * @param {import('./infer.js').InferredField} field
 * @param {ValueLimits} limits
 * @returns {boolean|null}
 */
export function startingToggle(field, limits) {
    if (field.type !== 'toggle') {
        return null;
    }

    if (!isScalar(field.default)) {
        return limits.toggle_unset;
    }

    return platformBoolean(field.default) ?? false;
}

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @param {string[]} choices
 * @returns {string|null}
 */
function text(value, maxLength, choices) {
    if (!isScalar(value)) {
        return null;
    }

    const trimmed = Array.from(platformTrim(platformString(value))).slice(0, maxLength).join('');

    if (trimmed === '') {
        return null;
    }

    if (choices.length > 0 && !choices.includes(trimmed)) {
        return null;
    }

    return trimmed;
}

/**
 * @param {import('./infer.js').InferredField} field
 * @param {unknown} value
 * @param {string[]} allowedImageUrls
 * @param {ValueLimits} limits
 * @returns {unknown}
 */
function coerce(field, value, allowedImageUrls, limits) {
    switch (field.type) {
        case 'toggle':
            return platformBoolean(value);
        case 'number':
            return platformNumber(value);
        case 'repeater':
            return items(field, value, allowedImageUrls, limits);
        case 'image':
            return typeof value === 'string' && allowedImageUrls.includes(value) ? value : null;
        case 'categories':
            return null;
        case 'textarea':
            return text(value, limits.max_long_text_length, []);
        default:
            return text(value, limits.max_text_length, field.choices);
    }
}

/**
 * @param {import('./infer.js').InferredField} field
 * @param {unknown} value
 * @param {string[]} allowedImageUrls
 * @param {ValueLimits} limits
 * @returns {(Record<string, unknown>|unknown[])[]|null}
 */
function items(field, value, allowedImageUrls, limits) {
    if (!isPlatformArray(value) || !isPlatformList(value)) {
        return null;
    }

    /** @type {(Record<string, unknown>|unknown[])[]} */
    const resolved = [];

    for (const item of Object.values(value).slice(0, limits.max_repeater_items)) {
        if (!isPlatformArray(item)) {
            continue;
        }

        /** @type {Record<string, unknown>} */
        const resolvedItem = {};

        for (const child of field.fields) {
            let childValue = Object.hasOwn(item, child.key) ? coerce(child, /** @type {any} */ (item)[child.key], allowedImageUrls, limits) : null;

            childValue ??= startingToggle(child, limits);

            if (childValue !== null) {
                resolvedItem[child.key] = childValue;
            }
        }

        resolved.push(Object.keys(resolvedItem).length === 0 ? [] : resolvedItem);
    }

    return resolved.length === 0 ? null : resolved;
}

/**
 * The options a template renders with, from the fields it declares and the
 * values set (none: only toggles resolve, to their defaults).
 *
 * @param {import('./infer.js').InferredField[]} fields
 * @param {Record<string, unknown>} [values]
 * @param {string[]|null} [allowedImageUrls] Image values must be one of these (the product's own files); null allows none.
 * @param {ValueLimits} [limits]
 * @returns {Record<string, unknown>}
 */
export function resolveOptions(fields, values = {}, allowedImageUrls = null, limits = defaultLimits) {
    /** @type {Record<string, unknown>} */
    const options = {};

    for (const field of fields) {
        if (field.type === 'categories') {
            continue;
        }

        let value = Object.hasOwn(values, field.key) ? coerce(field, values[field.key], allowedImageUrls ?? [], limits) : null;

        value ??= startingToggle(field, limits);

        if (value !== null) {
            options[field.key] = value;
        }
    }

    return options;
}

/**
 * The sample category slugs the Categories filter ticked, in sample order,
 * or none when the template has no filter field or nothing valid was
 * ticked (which filters nothing).
 *
 * @param {import('./infer.js').InferredField[]} fields
 * @param {Record<string, unknown>} values
 * @param {{slug: string}[]} sampleCategories
 * @returns {string[]}
 */
export function tickedCategorySlugs(fields, values, sampleCategories) {
    if (!fields.some((field) => field.type === 'categories')) {
        return [];
    }

    const ticked = values.categories;

    if (!isPlatformArray(ticked)) {
        return [];
    }

    const tickedValues = Object.values(ticked);

    return sampleCategories.map((category) => category.slug).filter((slug) => tickedValues.includes(slug));
}

/**
 * The shared sample catalogue narrowed to the ticked categories, as the
 * platform narrows it before any list is built: every competitions list,
 * the categories (renumbered in order of first appearance), and products.
 *
 * @param {Record<string, any>} shared
 * @param {string[]} slugs
 * @returns {Record<string, any>}
 */
export function narrowCatalogue(shared, slugs) {
    if (slugs.length === 0 || shared?.competitions?.all === undefined) {
        return shared;
    }

    const inCategories = (/** @type {any} */ competition) => slugs.includes(String(competition?.category ?? '').toLowerCase());
    /** @type {Record<string, any[]>} */
    const competitions = {};

    for (const [list, entries] of Object.entries(shared.competitions)) {
        competitions[list] = Array.isArray(entries) ? entries.filter(inCategories) : entries;
    }

    /** @type {Map<string, any>} */
    const categories = new Map();

    for (const competition of competitions.all) {
        const name = String(competition.category);
        const slug = name.toLowerCase();

        if (!categories.has(slug)) {
            categories.set(slug, { id: categories.size + 1, name, slug, url: `#category-${slug}`, competitions: [] });
        }

        categories.get(slug).competitions.push(competition);
    }

    return { ...shared, competitions, categories: [...categories.values()], products: competitions.all };
}
