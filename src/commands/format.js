import { renameSync, writeFileSync } from 'node:fs';
import { recordedMedia, scanAssets } from '../assets.js';
import { assetUrl } from '../dev-server.js';
import { FormatError, formatTemplate } from '../format.js';
import { loadDocuments } from '../remote.js';
import { loadWorkspace, readTemplate, selectProducts, withManifest } from '../workspace.js';
import { messageOf, writeJson } from './output.js';

/**
 * @typedef {{product: string, formatted: boolean, changed: boolean, written: boolean, error: string|null}} FormatResult
 */

/**
 * Format one product's template in the house style. With `check` nothing
 * is written. `formatted` is true when the template is (now) in the house
 * style; `changed` when formatting changed, or would change, it.
 *
 * @param {import('../workspace.js').Product} product
 * @param {{contexts: any, rules: any, libraries?: any}|null} documents Null skips the rendering proof (offline with no cache).
 * @param {{check?: boolean}} [options]
 * @returns {Promise<FormatResult>}
 */
export async function formatProduct(product, documents, { check = false } = {}) {
    let template;

    try {
        template = readTemplate(product);
    } catch (error) {
        return { product: product.path, formatted: false, changed: false, written: false, error: messageOf(error) };
    }

    const proof = documents === null
        ? null
        : { type: product.type, documents, files: scanAssets(product.assetsDirectory, documents.rules, documents.libraries?.libraries ?? [], assetUrl, recordedMedia(product)).files };

    try {
        const { formatted, changed } = await formatTemplate(template, proof);

        if (changed && !check) {
            const temporary = `${product.templatePath}.${process.pid}.tmp`;

            writeFileSync(temporary, formatted);
            renameSync(temporary, product.templatePath);
        }

        return { product: product.path, formatted: !changed || !check, changed, written: changed && !check, error: null };
    } catch (error) {
        if (error instanceof FormatError) {
            return { product: product.path, formatted: false, changed: false, written: false, error: error.message };
        }

        throw error;
    }
}

/**
 * Load the workspace, the documents (null when unavailable), and the
 * selected products, as format, test, and verify all do.
 *
 * @param {import('../cli.js').CommandContext} context
 * @param {{requireDocuments: boolean}} options
 */
export async function loadSelection({ cwd, options }, { requireDocuments }) {
    let workspace = loadWorkspace(cwd);
    /** @type {import('../remote.js').LoadedDocuments|null} */
    let loaded = null;

    try {
        loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl });
        workspace = withManifest(workspace, loaded.manifest);
    } catch (error) {
        if (requireDocuments) {
            throw error;
        }
    }

    const products = selectProducts(workspace, { names: options.positionals, all: options.all, cwd, fallback: 'all' });

    if (products.length === 0) {
        throw new Error('There are no products in this workspace yet. Add one with npx @rafflex/dev new <game|block> "<title>".');
    }

    return { workspace, loaded, products };
}

/**
 * `format [<product>...|--all] [--check]`: format templates in the house
 * style (Prettier with a fixed configuration, Twig masked and restored
 * byte for byte, and the rendered page proven unchanged).
 *
 * JSON: one product prints `{product, formatted, changed, written, error}`;
 * several print `{passed, products: [that shape...]}`. Exits 1 when
 * --check finds a template to format or a template cannot be formatted.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runFormatCommand(context) {
    const { stdout, stderr, options } = context;
    let selection;

    try {
        selection = await loadSelection(context, { requireDocuments: false });
    } catch (error) {
        const message = messageOf(error);

        if (options.json) {
            writeJson(stdout, { passed: false, error: message });
        } else {
            stderr.write(`${message}\n`);
        }

        return 2;
    }

    const documents = selection.loaded?.documents ?? null;
    /** @type {FormatResult[]} */
    const results = [];

    for (const product of selection.products) {
        results.push(await formatProduct(product, documents, { check: options.check }));
    }

    const passed = results.every((result) => result.error === null && result.formatted);

    if (options.json) {
        writeJson(stdout, results.length === 1 ? results[0] : { passed, products: results });

        return passed ? 0 : 1;
    }

    if (documents === null) {
        stderr.write('note: the platform\'s documents are unavailable, so only the Twig was proven unchanged, not the rendered page.\n');
    }

    for (const result of results) {
        if (result.error !== null) {
            stdout.write(`${result.product}: not formatted. ${result.error}\n`);
        } else if (!result.changed) {
            stdout.write(`${result.product}: already in the house style.\n`);
        } else {
            stdout.write(options.check ? `${result.product}: not in the house style. Run npx @rafflex/dev format ${result.product}\n` : `${result.product}: formatted template.twig.\n`);
        }
    }

    return passed ? 0 : 1;
}
