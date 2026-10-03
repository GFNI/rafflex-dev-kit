import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { playNextEntry, revealRecorder, settleMs } from './browser-test.js';
import { scenarioValues } from './checker.js';
import { startDevServer } from './dev-server.js';
import { imageDimensions } from './file-content.js';
import { hasPlaythroughHooks } from './game-rules.js';
import { imageRules, listingDirectoryName, readListingImages, screenshotsDirectoryName } from './listing-images.js';
import { readTemplate } from './workspace.js';

/**
 * Listing images from the browser run (PRD 45): review needs a cover and
 * at least one screenshot, and a product built in the workspace has
 * neither until the kit takes them from its own preview.
 *
 * - A game is shown ready to play, after a win, and after a loss (played
 *   through its data-rafflex-play and data-rafflex-result hooks when it
 *   has them, so the screenshot shows a revealed result), at a desktop and
 *   a phone width. A block is shown at both widths.
 * - The cover is the after a win scene (or the block) at 1200 by 600, the
 *   2:1 landscape shape the marketplace's product cards show.
 * - Each image is a PNG, or a JPEG at falling quality when a PNG is over
 *   the published size limit.
 *
 * It never overwrites a file the creator supplied unless forced: a folder
 * with a cover keeps it, and one with screenshots keeps them.
 */

/** The cover's size: the 2:1 shape of the marketplace's product cards. */
export const coverSize = Object.freeze({ width: 1200, height: 600 });

export const captureDevices = Object.freeze([
    Object.freeze({ name: 'desktop', width: 1280, height: 800 }),
    Object.freeze({ name: 'phone', width: 390, height: 844 }),
]);

/** Screenshots a product shows when the rules do not say. */
const defaultMaxScreenshots = 6;

/** Time for a reveal animation to finish before the screenshot. */
const revealSettleMs = 1200;

const jpegQualities = [90, 80, 70, 60, 50, 40];

/**
 * @typedef {{key: string, scenario: string|null, plays: number}} Scene
 * @typedef {{path: string, width: number, height: number, size: number}} CapturedImage
 * @typedef {{captured: CapturedImage[], kept: {cover: boolean, screenshots: boolean}}} CaptureResult
 */

/**
 * The scenes to show: for a game, ready to play, after a win, and after a
 * loss, from the scenarios the platform publishes; for a block, the block.
 *
 * @param {string} type
 * @param {string[]} scenarios
 * @param {boolean} hooked Whether the game has the playthrough hooks.
 * @returns {Scene[]}
 */
export function captureScenes(type, scenarios, hooked) {
    if (type === 'block') {
        return [{ key: 'block', scenario: null, plays: 0 }];
    }

    const first = (/** @type {string[]} */ candidates) => candidates.find((candidate) => scenarios.includes(candidate)) ?? null;
    const scenes = [
        { key: 'ready', scenario: first(['mixed', ...scenarios.filter((scenario) => scenario !== 'no_plays')]), plays: 0 },
        { key: 'win', scenario: first(['big_win', 'all_win']), plays: hooked ? 1 : 0 },
        { key: 'loss', scenario: first(['all_lose']), plays: hooked ? 1 : 0 },
    ];

    return scenes.filter((scene) => scene.scenario !== null);
}

/**
 * Take one image of a scene at a size, as a PNG or, when that is over
 * `maxBytes`, a JPEG at the highest quality that fits (or the lowest
 * tried).
 *
 * @param {object} options
 * @param {any} options.browser
 * @param {(scenario: string|null) => string} options.frameUrl
 * @param {Scene} options.scene
 * @param {{width: number, height: number}} options.size
 * @param {number|null} options.maxBytes
 * @param {string[]} options.extensions The extensions the purpose takes.
 * @returns {Promise<{buffer: Buffer, extension: string}>}
 */
async function shoot({ browser, frameUrl, scene, size, maxBytes, extensions }) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });

    try {
        await context.addInitScript(revealRecorder);

        const page = await context.newPage();

        await page.goto(frameUrl(scene.scenario), { waitUntil: 'load' });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(settleMs);

        for (let played = 0; played < scene.plays; played++) {
            const { problem } = await playNextEntry(page, played);

            if (problem !== null) {
                break;
            }

            await page.waitForTimeout(revealSettleMs);
        }

        const pngAllowed = extensions.includes('png');
        const jpegExtension = extensions.includes('jpg') ? 'jpg' : 'jpeg';

        if (pngAllowed) {
            const png = await page.screenshot({ type: 'png' });

            if (maxBytes === null || png.length <= maxBytes) {
                return { buffer: png, extension: 'png' };
            }
        }

        let smallest = null;

        for (const quality of jpegQualities) {
            const jpeg = await page.screenshot({ type: 'jpeg', quality });

            smallest = jpeg;

            if (maxBytes === null || jpeg.length <= maxBytes) {
                break;
            }
        }

        return { buffer: /** @type {Buffer} */ (smallest), extension: jpegExtension };
    } finally {
        await context.close();
    }
}

/**
 * Write a product's missing listing images from its preview.
 *
 * @param {object} options
 * @param {any} options.browser A launched Playwright browser.
 * @param {import('./workspace.js').Workspace} options.workspace
 * @param {import('./remote.js').LoadedDocuments} options.loaded
 * @param {import('./workspace.js').Product} options.product
 * @param {boolean} [options.force] Replace the cover and screenshots already there.
 * @returns {Promise<CaptureResult>}
 */
export async function captureListingImages({ browser, workspace, loaded, product, force = false }) {
    const { documents } = loaded;
    const existing = readListingImages(product.directory);
    const wantCover = force || existing.covers.length === 0;
    const wantScreenshots = force || existing.screenshots.length === 0;
    /** @type {CapturedImage[]} */
    const captured = [];

    if (!wantCover && !wantScreenshots) {
        return { captured, kept: { cover: true, screenshots: true } };
    }

    const template = readTemplate(product);
    const scenes = captureScenes(product.type, scenarioValues(documents), product.type !== 'block' && hasPlaythroughHooks(template));
    const coverRules = imageRules(documents.rules, 'cover');
    const screenshotRules = imageRules(documents.rules, 'screenshot');
    const extensionsOf = (/** @type {{extensions?: string[]}} */ purpose) => (Array.isArray(purpose.extensions) && purpose.extensions.length > 0 ? purpose.extensions : ['png', 'jpg']);
    const maxBytesOf = (/** @type {{max_bytes?: number}} */ purpose) => (typeof purpose.max_bytes === 'number' ? purpose.max_bytes : null);
    const maxScreenshots = typeof screenshotRules.max_count === 'number' ? screenshotRules.max_count : defaultMaxScreenshots;
    const listingDirectory = join(product.directory, listingDirectoryName);
    const screenshotsDirectory = join(listingDirectory, screenshotsDirectoryName);
    const playCount = documents.contexts.play_count?.default ?? 5;
    const server = await startDevServer({ workspace, loaded, port: 0, watchFiles: false });
    const frameUrl = (/** @type {string|null} */ scenario) => `${server.urlFor(product)}frame${scenario === null ? '' : `?scenario=${encodeURIComponent(scenario)}&play_count=${playCount}`}`;
    const write = (/** @type {string} */ directory, /** @type {string} */ name, /** @type {{buffer: Buffer, extension: string}} */ image) => {
        const filename = `${name}.${image.extension}`;
        const dimensions = imageDimensions(image.buffer);

        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, filename), image.buffer);
        captured.push({
            path: `${directory === listingDirectory ? listingDirectoryName : `${listingDirectoryName}/${screenshotsDirectoryName}`}/${filename}`,
            width: dimensions?.width ?? 0,
            height: dimensions?.height ?? 0,
            size: image.buffer.length,
        });
    };

    try {
        if (wantCover) {
            const scene = scenes.find((candidate) => candidate.key === 'win') ?? scenes[0];
            const image = await shoot({ browser, frameUrl, scene, size: coverSize, maxBytes: maxBytesOf(coverRules), extensions: extensionsOf(coverRules) });

            for (const cover of existing.covers) {
                rmSync(join(product.directory, cover.path), { force: true });
            }

            write(listingDirectory, 'cover', image);
        }

        if (wantScreenshots) {
            const shots = captureDevices.flatMap((device) => scenes.map((scene) => ({ device, scene }))).slice(0, maxScreenshots);
            /** @type {{name: string, image: {buffer: Buffer, extension: string}}[]} */
            const images = [];

            for (const [index, { device, scene }] of shots.entries()) {
                const image = await shoot({ browser, frameUrl, scene, size: device, maxBytes: maxBytesOf(screenshotRules), extensions: extensionsOf(screenshotRules) });

                images.push({ name: `${String(index + 1).padStart(2, '0')}-${scene.key}-${device.name}`, image });
            }

            for (const screenshot of existing.screenshots) {
                rmSync(join(product.directory, screenshot.path), { force: true });
            }

            for (const { name, image } of images) {
                write(screenshotsDirectory, name, image);
            }
        }
    } finally {
        await server.close();
    }

    return { captured, kept: { cover: !wantCover, screenshots: !wantScreenshots } };
}
