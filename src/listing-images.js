import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * A product's listing images: `listing/cover.<ext>` and
 * `listing/screenshots/*` inside the product folder, committed with the
 * product and shown on its marketplace page in filename order. Review
 * needs a cover and at least one screenshot.
 *
 * The marketplace reports each image's SHA-256, recorded by `synced` and
 * `import` in product.json's remote state, so `plan` tells a new or
 * changed image from one already there without downloading anything.
 */

export const listingDirectoryName = 'listing';
export const screenshotsDirectoryName = 'screenshots';
export const coverStem = 'cover';

/** The extensions the kit looks for when the rules do not publish them. */
export const defaultImageExtensions = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);

/** @type {Record<string, string>} */
const imageMimeTypes = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
};

/**
 * @typedef {{path: string, filename: string, extension: string, size: number, sha256: string, mime_type: string}} LocalListingImage
 * @typedef {{covers: LocalListingImage[], cover: LocalListingImage|null, screenshots: LocalListingImage[]}} LocalListingImages
 * @typedef {{url: string|null, sha256: string|null}} RemoteListingImage
 * @typedef {{cover: RemoteListingImage|null, screenshots: RemoteListingImage[]}} RemoteListingImages
 */

/**
 * The rules for one purpose ("cover" or "screenshot"), each key optional.
 *
 * @param {any} rules
 * @param {'cover'|'screenshot'} purpose
 * @returns {{max_bytes?: number, max_count?: number, extensions?: string[], mime_types?: string[]}}
 */
export function imageRules(rules, purpose) {
    const entry = rules?.listing?.images?.[purpose];

    return entry !== null && typeof entry === 'object' ? entry : {};
}

/**
 * @param {string} filename
 */
export function listingImageMimeType(filename) {
    return imageMimeTypes[extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * @param {string} directory
 * @param {string} relativePrefix
 * @param {string} name
 * @returns {LocalListingImage}
 */
function readImage(directory, relativePrefix, name) {
    const path = join(directory, name);
    const contents = readFileSync(path);

    return {
        path: `${relativePrefix}${name}`,
        filename: name,
        extension: extname(name).slice(1).toLowerCase(),
        size: contents.length,
        sha256: createHash('sha256').update(contents).digest('hex'),
        mime_type: listingImageMimeType(name),
    };
}

/**
 * The visible files in a folder, by name.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function visibleFiles(directory) {
    try {
        return readdirSync(directory)
            .filter((name) => !name.startsWith('.') && statSync(join(directory, name)).isFile())
            .sort();
    } catch {
        return [];
    }
}

/**
 * Read a product's listing images. Every `cover.*` file is listed in
 * `covers` (more than one is a problem the check reports); `cover` is the
 * first. Screenshots are every file in listing/screenshots/, in filename
 * order.
 *
 * @param {string} productDirectory
 * @returns {LocalListingImages}
 */
export function readListingImages(productDirectory) {
    const directory = join(productDirectory, listingDirectoryName);

    if (!existsSync(directory)) {
        return { covers: [], cover: null, screenshots: [] };
    }

    const covers = visibleFiles(directory)
        .filter((name) => name.slice(0, name.length - extname(name).length).toLowerCase() === coverStem)
        .map((name) => readImage(directory, `${listingDirectoryName}/`, name));
    const screenshots = visibleFiles(join(directory, screenshotsDirectoryName))
        .map((name) => readImage(join(directory, screenshotsDirectoryName), `${listingDirectoryName}/${screenshotsDirectoryName}/`, name));

    return { covers, cover: covers[0] ?? null, screenshots };
}

/**
 * @param {unknown} value
 */
function hashOrNull(value) {
    return typeof value === 'string' && value !== '' ? value.toLowerCase() : null;
}

/**
 * The listing images of a get_product result (or an export bundle's
 * product), for product.json's remote state. Newer marketplaces send
 * `cover_image_sha256` and `screenshots: [{url, sha256}]`; older ones
 * only `cover_image_url` and `screenshot_urls`, recorded with null hashes.
 * Returns undefined when the payload carries neither, so the remote state
 * records nothing rather than claiming there are no images.
 *
 * @param {Record<string, any>} product
 * @returns {RemoteListingImages|undefined}
 */
export function remoteListingImagesFrom(product) {
    const hasCover = Object.hasOwn(product, 'cover_image_url') || Object.hasOwn(product, 'cover_image_sha256');
    const hasScreenshots = Array.isArray(product.screenshots) || Array.isArray(product.screenshot_urls);

    if (!hasCover && !hasScreenshots) {
        return undefined;
    }

    const coverUrl = typeof product.cover_image_url === 'string' && product.cover_image_url !== '' ? product.cover_image_url : null;
    const coverHash = hashOrNull(product.cover_image_sha256);
    /** @type {RemoteListingImage[]} */
    const screenshots = Array.isArray(product.screenshots)
        ? product.screenshots
            .filter((/** @type {any} */ entry) => entry !== null && typeof entry === 'object')
            .map((/** @type {any} */ entry) => ({ url: typeof entry.url === 'string' ? entry.url : null, sha256: hashOrNull(entry.sha256) }))
        : (Array.isArray(product.screenshot_urls) ? product.screenshot_urls : [])
            .filter((/** @type {unknown} */ url) => typeof url === 'string')
            .map((/** @type {string} */ url) => ({ url, sha256: null }));

    return {
        cover: coverUrl === null && coverHash === null ? null : { url: coverUrl, sha256: coverHash },
        screenshots,
    };
}

/**
 * The listing images product.json recorded, or null when the last sync
 * did not record any (never synced, or an older marketplace).
 *
 * @param {import('./workspace.js').ProductRemote|null|undefined} remote
 * @returns {RemoteListingImages|null}
 */
export function recordedListingImages(remote) {
    const recorded = /** @type {any} */ (remote)?.listing_images;

    if (recorded === null || typeof recorded !== 'object') {
        return null;
    }

    return {
        cover: recorded.cover !== null && typeof recorded.cover === 'object' ? { url: recorded.cover.url ?? null, sha256: hashOrNull(recorded.cover.sha256) } : null,
        screenshots: Array.isArray(recorded.screenshots)
            ? recorded.screenshots.map((/** @type {any} */ entry) => ({ url: entry?.url ?? null, sha256: hashOrNull(entry?.sha256) }))
            : [],
    };
}

/**
 * @typedef {object} ListingImagesPlan
 * @property {{path: string, sha256: string, size: number, mime_type: string, change: 'new'|'changed'}|null} cover
 * @property {{path: string, sha256: string, size: number, mime_type: string, change: 'new'}[]} screenshots
 * @property {string[]} removed_screenshots
 */

/**
 * What to upload, compared by SHA-256 with what the marketplace has:
 *
 * - the cover when there is a local one and the marketplace has none
 *   (`new`) or a different one, or one whose hash it did not report
 *   (`changed`: replacing a cover is harmless);
 * - each local screenshot whose hash the marketplace does not report;
 * - `removed_screenshots`, the marketplace's screenshot hashes with no
 *   local file, only when the folder holds any (the folder is then the
 *   creator's stated set; an empty folder leaves the marketplace's alone).
 *
 * @param {LocalListingImages} local
 * @param {RemoteListingImages|null} remote
 * @returns {ListingImagesPlan}
 */
export function planListingImages(local, remote) {
    const remoteCover = remote?.cover ?? null;
    const remoteHashes = new Set((remote?.screenshots ?? []).map((entry) => entry.sha256).filter((hash) => hash !== null));
    const localHashes = new Set(local.screenshots.map((image) => image.sha256));
    const entry = (/** @type {LocalListingImage} */ image) => ({ path: image.path, sha256: image.sha256, size: image.size, mime_type: image.mime_type });
    /** @type {ListingImagesPlan['cover']} */
    let cover = null;

    if (local.cover !== null && remoteCover === null) {
        cover = { ...entry(local.cover), change: 'new' };
    }

    if (local.cover !== null && remoteCover !== null && remoteCover.sha256 !== local.cover.sha256) {
        cover = { ...entry(local.cover), change: 'changed' };
    }

    const seen = new Set();
    const screenshots = local.screenshots
        .filter((image) => {
            if (remoteHashes.has(image.sha256) || seen.has(image.sha256)) {
                return false;
            }

            seen.add(image.sha256);

            return true;
        })
        .map((image) => ({ ...entry(image), change: /** @type {'new'} */ ('new') }));
    const removed = local.screenshots.length === 0 ? [] : [...remoteHashes].filter((hash) => !localHashes.has(hash));

    return { cover, screenshots, removed_screenshots: removed };
}

/**
 * Whether the product has a cover and a screenshot, here or on the
 * marketplace (a product imported before listing images were exported, or
 * given its images in the browser, still has them there).
 *
 * @param {LocalListingImages} local
 * @param {RemoteListingImages|null} remote
 */
export function listingImagesPresent(local, remote) {
    return {
        cover: local.cover !== null || (remote?.cover ?? null) !== null,
        screenshots: local.screenshots.length > 0 || (remote?.screenshots.length ?? 0) > 0,
    };
}
