import { applyOverrides, inferOptions } from './infer.js';
import { normaliseOverrides } from './overrides.js';
import { tickedCategorySlugs, narrowCatalogue, resolveOptions, valueLimits } from './values.js';

/**
 * What a render receives from a template's options: the resolved
 * `options` and the sample catalogue narrowed by the Categories filter,
 * from the values set (the app's options form, a spec, or none) and the
 * creator's option overrides as the platform would store them (choices
 * narrow what a text option accepts; labels and help never reach the
 * render). Image values must be one of the product's own files.
 */

/**
 * The fields a buyer's form shows: the inferred fields with options.json
 * applied as the platform stores and applies it.
 *
 * @param {string} template
 * @param {unknown} overrides options.json's content
 * @param {any} [contexts]
 * @returns {{fields: import('./infer.js').InferredField[], warnings: string[]}}
 */
export function formFields(template, overrides, contexts) {
    const inferred = inferOptions(template, contexts);

    return { fields: applyOverrides(inferred.fields, normaliseOverrides(overrides, inferred.fields)), warnings: inferred.warnings };
}

/**
 * @param {object} input
 * @param {any} input.contexts
 * @param {string} input.template
 * @param {Record<string, string>|unknown[]} input.files
 * @param {Record<string, any>} input.shared The sample catalogue.
 * @param {Record<string, unknown>} [input.values]
 * @param {unknown} [input.overrides]
 * @returns {{options: Record<string, unknown>, shared: Record<string, any>}}
 */
export function renderOptions({ contexts, template, files, shared, values = {}, overrides = null }) {
    const { fields } = formFields(template, overrides, contexts);
    const allowedImageUrls = Array.isArray(files) ? [] : Object.values(files);
    const options = resolveOptions(fields, values, allowedImageUrls, valueLimits(contexts));
    const slugs = tickedCategorySlugs(fields, values, Array.isArray(shared?.categories) ? shared.categories : []);

    return { options, shared: narrowCatalogue(shared, slugs) };
}
