import { captureListingImages } from '../capture.js';
import { ensureIgnored } from '../git.js';
import { installCommand, launchChromium, loadPlaywright } from '../playwright.js';
import { loadDocuments } from '../remote.js';
import { loadWorkspace, selectProduct, withManifest } from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

/**
 * @typedef {object} CaptureOutput
 * @property {string} product
 * @property {import('../capture.js').CapturedImage[]} captured
 * @property {boolean} skipped   Nothing was captured: Playwright is missing, or listing/ already has its images.
 * @property {string|null} reason
 * @property {string|null} install The command that installs Playwright, when it is missing.
 */

/**
 * @param {CaptureOutput} result
 * @param {string} name
 * @returns {string[]}
 */
function captureLines(result, name) {
    if (result.skipped) {
        return [`${result.product}: ${result.reason}${result.install === null ? '' : ` Install it (a large download, ask first) with: ${result.install}`}`];
    }

    return [
        `${result.product}: captured ${result.captured.length} listing ${result.captured.length === 1 ? 'image' : 'images'} from the preview.`,
        ...result.captured.map((image) => `  ${result.product}/${image.path} (${image.width}x${image.height}, ${image.size} bytes)`),
        ...(result.reason === null ? [] : [`  ${result.reason}`]),
        `Look at them before pushing; replace any with your own and keep the names in order. npx @rafflex/dev plan ${name} lists them as uploads.`,
    ];
}

/**
 * `capture <product> [--force]`: write a cover image and screenshots into
 * the product's listing/ folder from the browser run, when it has none.
 * Without --force a cover or screenshots already there are kept. Without
 * Playwright it says how to install it and exits 0, as `test` does.
 *
 * JSON: `{product, captured: [{path, width, height, size}], skipped, reason, install}`.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runCaptureCommand(context) {
    const { cwd, stdout, options } = context;
    let workspace;
    let loaded;
    let product;

    try {
        workspace = loadWorkspace(cwd);
        loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl });
        workspace = withManifest(workspace, loaded.manifest);
        product = selectProduct(workspace, options.positionals[0], cwd);
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    const name = product.slug ?? product.path;
    const report = (/** @type {CaptureOutput} */ result, /** @type {number} */ code) => {
        if (options.json) {
            writeJson(stdout, result);
        } else {
            stdout.write(`${captureLines(result, name).join('\n')}\n`);
        }

        return code;
    };
    const playwright = await loadPlaywright(workspace.root);

    if (playwright === null) {
        return report({ product: product.path, captured: [], skipped: true, reason: 'Playwright is not installed, so no listing images were captured.', install: installCommand }, 0);
    }

    const { browser, error } = await launchChromium(playwright);

    if (browser === null) {
        return report({ product: product.path, captured: [], skipped: true, reason: `Chromium did not start (${error}), so no listing images were captured.`, install: installCommand }, 0);
    }

    ensureIgnored(workspace.root);

    let result;

    try {
        result = await captureListingImages({ browser, workspace, loaded, product, force: options.force });
    } catch (captureError) {
        return fail(context, `Could not capture listing images: ${messageOf(captureError)}`, 2);
    } finally {
        await browser.close();
    }

    if (result.captured.length === 0) {
        return report({ product: product.path, captured: [], skipped: true, reason: `listing/ already has a cover and screenshots, so nothing was captured. Run npx @rafflex/dev capture ${name} --force to replace them.`, install: null }, 0);
    }

    const kept = [result.kept.cover && 'the cover', result.kept.screenshots && 'the screenshots'].filter(Boolean);

    return report({
        product: product.path,
        captured: result.captured,
        skipped: false,
        reason: kept.length === 0 ? null : `Kept ${kept.join(' and ')} already in listing/ (--force replaces ${kept.length === 1 ? 'it' : 'them'}).`,
        install: null,
    }, 0);
}
