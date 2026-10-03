import { join } from 'node:path';
import { scanAssets } from '../assets.js';
import { assetUrl } from '../dev-server.js';
import { buyerImages } from './buyer-images.js';

/**
 * The browser run's buyer images pass: a game whose template uses images
 * is opened with every image a buyer may replace swapped for a placeholder
 * of another shape, at one phone and one desktop width, with a screenshot
 * of each (`.results/screenshots/buyer-images-<device>.png`) and the same
 * problems a run through reports (uncaught exceptions and CSP violations
 * block). Null for a block or a game that uses no images.
 */

/** The widths the pass runs at. */
export const buyerImageDevices = ['phone', 'desktop'];

/**
 * @param {object} input
 * @param {any} input.browser
 * @param {import('../workspace.js').Workspace} input.workspace
 * @param {import('../workspace.js').Product} input.product
 * @param {string} input.template
 * @param {{rules: any, libraries?: any}} input.documents
 * @param {(scenario: string|null, count?: number, extra?: {buyerImages?: boolean}) => string} input.frameUrl
 * @param {string|null} input.scenario
 * @param {string} input.screenshots
 * @param {readonly {name: string, width: number, height: number}[]} input.devices
 * @param {(page: any) => {code: string, message: string}[]} input.watchPage
 * @param {(page: any) => Promise<{code: string, message: string}[]>} input.cspViolations
 * @param {(page: any) => Promise<void>} input.settle
 * @param {(root: string, path: string) => string} input.relativeToWorkspace
 * @returns {Promise<{runs: {scenario: string, device: string, width: number, screenshot: string}[], problems: {code: string, message: string, screenshot: string}[]}|null>}
 */
export async function buyerImageRuns({ browser, workspace, product, template, documents, frameUrl, scenario, screenshots, devices, watchPage, cspViolations, settle, relativeToWorkspace }) {
    if (product.type !== 'game') {
        return null;
    }

    const scan = scanAssets(product.assetsDirectory, documents.rules, documents.libraries?.libraries ?? [], assetUrl);

    if (buyerImages(template, scan.assets, product.assetsDirectory, '/assets/').length === 0) {
        return null;
    }

    const runs = [];
    const problems = [];

    for (const device of devices.filter((candidate) => buyerImageDevices.includes(candidate.name))) {
        const context = await browser.newContext({ viewport: { width: device.width, height: device.height } });

        try {
            const page = await context.newPage();
            const found = watchPage(page);
            const path = join(screenshots, `buyer-images-${device.name}.png`);

            await page.goto(frameUrl(scenario, undefined, { buyerImages: true }), { waitUntil: 'load' });
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            await settle(page);
            await page.screenshot({ path, fullPage: true });

            const screenshot = relativeToWorkspace(workspace.root, path);

            runs.push({ scenario: 'buyer_images', device: device.name, width: device.width, screenshot });
            problems.push(...[...found, ...await cspViolations(page)].map((problem) => ({ ...problem, message: `With a buyer's own images: ${problem.message}`, screenshot })));
        } finally {
            await context.close();
        }
    }

    return { runs, problems };
}
