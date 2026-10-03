import { buyerImagePath, buyerImages, placeholderPng, withBuyerImages } from './buyer-images.js';
import { formFields } from './render-options.js';
import { readOptionOverrides } from './product-options.js';
import { resolveOptions, valueLimits, valuesFromQuery } from './values.js';

/**
 * The app's side of options (served by the dev server under a product's
 * path): what the preview frame renders with, the form the Options panel
 * shows, and the buyer image placeholders.
 *
 * - `frame?options=<json>` renders with those values, coerced as the
 *   platform coerces a site owner's, and with options.json applied as the
 *   marketplace stores it; `frame?buyer_images=1` (games) swaps every image
 *   a buyer may replace for a placeholder of a different shape.
 * - `__rafflex/options` is the form: the inferred fields with the label,
 *   help, and choices from options.json, each toggle's starting value, the
 *   product's images (an image option may only hold one), the sample
 *   categories, the warnings, and the images a buyer may replace.
 * - `assets/.rafflex/buyer-image/<tag>.png?w=&h=` is a placeholder.
 */

/**
 * @typedef {{files: Record<string, string>, assets: {tag: string, kind: string, url: string, path: string}[]}} AssetScan
 * @typedef {import('../workspace.js').Product} Product
 */

/**
 * @param {Product} product
 * @param {string} template
 * @param {AssetScan} scan
 * @param {string} basePath
 */
function replaceableImages(product, template, scan, basePath) {
    return product.type === 'game' ? buyerImages(template, scan.assets, product.assetsDirectory, `${basePath}assets/`) : [];
}

/**
 * What a frame request renders with: its option values, options.json, and
 * the files map (with buyer image placeholders when asked).
 *
 * @param {object} input
 * @param {Product} input.product
 * @param {URL} input.url
 * @param {string} input.template
 * @param {AssetScan} input.scan
 * @param {any} input.contexts
 * @param {string} input.basePath
 * @returns {{files: Record<string, string>, options: Record<string, unknown>, overrides: unknown}}
 */
export function frameSelection({ product, url, template, scan, contexts, basePath }) {
    const options = valuesFromQuery(url.searchParams.get('options') ?? '', valueLimits(contexts));
    const { overrides } = readOptionOverrides(product);
    const files = url.searchParams.get('buyer_images') === '1'
        ? withBuyerImages(scan.files, replaceableImages(product, template, scan, basePath))
        : scan.files;

    return { files, options, overrides };
}

/**
 * The Options panel's form for a product.
 *
 * @param {Product} product
 * @param {string} template
 * @param {AssetScan} scan
 * @param {any} contexts
 * @param {string} basePath
 */
export function optionsForm(product, template, scan, contexts, basePath) {
    const { overrides, error } = readOptionOverrides(product);
    const { fields, warnings } = formFields(template, overrides, contexts);
    const limits = valueLimits(contexts);
    const toggles = resolveOptions(fields.filter((field) => field.type === 'toggle'), {}, null, limits);

    return {
        fields: fields.map((field) => ({
            ...field,
            starts: field.type === 'toggle' ? toggles[field.key] === true : null,
            fields: field.fields.map((child) => ({ ...child, starts: child.type === 'toggle' ? resolveOptions([child], {}, null, limits)[child.key] === true : null })),
        })),
        warnings,
        overrides_error: error,
        images: scan.assets.filter((asset) => asset.kind === 'image').map((asset) => ({ tag: asset.tag, url: asset.url })),
        categories: (contexts.shared?.categories ?? []).map((/** @type {{slug: string, name: string}} */ category) => ({ slug: category.slug, name: category.name })),
        max_repeater_items: limits.max_repeater_items,
        buyer_images: replaceableImages(product, template, scan, basePath),
    };
}

/** @type {Map<string, Buffer>} */
const placeholders = new Map();

/**
 * Answer the options routes under a product's path; false when the path
 * is not one of them.
 *
 * @param {object} input
 * @param {Product} input.product
 * @param {string} input.rest The path below the product's base path.
 * @param {URL} input.url
 * @param {import('node:http').ServerResponse} input.response
 * @param {any} input.contexts
 * @param {string} input.basePath
 * @param {() => {template: string, scan: AssetScan}} input.productFiles
 * @param {(response: import('node:http').ServerResponse, payload: unknown) => void} input.sendJson
 * @param {(response: import('node:http').ServerResponse, status: number, body: string) => void} input.send
 * @returns {boolean}
 */
export function serveOptionsRoute({ product, rest, url, response, contexts, basePath, productFiles, sendJson, send }) {
    if (rest === '__rafflex/options') {
        try {
            const { template, scan } = productFiles();

            sendJson(response, optionsForm(product, template, scan, contexts, basePath));
        } catch (error) {
            sendJson(response, { fields: [], warnings: [], images: [], categories: [], buyer_images: [], error: String(/** @type {Error} */ (error).message) });
        }

        return true;
    }

    if (!rest.startsWith(`assets/${buyerImagePath}`)) {
        return false;
    }

    if (!/^[^/]+\.png$/.test(rest.slice(`assets/${buyerImagePath}`.length))) {
        send(response, 404, 'Not found');

        return true;
    }

    const size = (/** @type {string} */ name, /** @type {number} */ fallback) => Math.max(8, Math.min(2000, Number.parseInt(url.searchParams.get(name) ?? '', 10) || fallback));
    const width = size('w', 960);
    const height = size('h', 320);
    const key = `${width}x${height}`;
    const png = placeholders.get(key) ?? placeholderPng(width, height);

    if (placeholders.size < 16) {
        placeholders.set(key, png);
    }

    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
    response.end(png);

    return true;
}
