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
 * Whether the marketplace's listing images are unknown: the product has a
 * recorded marketplace state, but that state holds no record of listing
 * images at all (it was last synced by kit 0.3.0, or from a marketplace
 * that did not report them). A record saying there are none is known.
 * A product never synced has no state, so its images are known to be
 * only what listing/ holds.
 *
 * @param {import('./workspace.js').ProductRemote|null|undefined} remote
 */
export function listingImagesUnknown(remote) {
    return remote !== null && remote !== undefined && typeof remote === 'object' && !Object.hasOwn(remote, 'listing_images');
}

/**
 * What to tell the creator's AI when the listing images are unknown: read
 * the product again so the kit knows what the marketplace holds.
 *
 * @param {string} name The product's slug or folder.
 */
export function refreshListingImagesMessage(name) {
    return `The marketplace may already have a cover and screenshots: this product's state was recorded without them (by an older kit). Refresh it first: call request_sync with slug ${name}, then run npx @rafflex/dev synced ${name} "<sync_url>".`;
}

/**
 * The name a listing image is uploaded under: `cover.<ext>`, or
 * `screenshot-<nn>.<ext>` by its place in listing/screenshots/ (filename
 * order), with the file's own extension in lower case. The creator's
 * filename never leaves the folder, so a screenshot saved with the
 * system's default name (spaces and all) uploads without a rename; the
 * marketplace's upload filename rule applies to media library files, whose
 * names it stores and tags.
 *
 * @param {'cover'|'screenshot'} purpose
 * @param {LocalListingImage} image
 * @param {number} [position] The screenshot's place, from 1.
 */
export function listingImageUploadName(purpose, image, position = 1) {
    const extension = image.extension === '' ? '' : `.${image.extension}`;

    return purpose === 'cover' ? `${coverStem}${extension}` : `screenshot-${String(position).padStart(2, '0')}${extension}`;
}

/**
 * @typedef {{path: string, upload_filename: string, sha256: string, size: number, mime_type: string}} PlannedListingImage
 *
 * @typedef {object} ListingImagesPlan
 * @property {(PlannedListingImage & {change: 'new'|'changed'})|null} cover
 * @property {(PlannedListingImage & {change: 'new'|'moved'})[]} screenshots
 * @property {string[]} removed_screenshots
 * @property {true} [remote_unknown] Present when nothing is planned because the marketplace's images are unknown.
 */

/**
 * What to upload, compared by SHA-256 with what the marketplace has:
 *
 * - the cover when there is a local one and the marketplace has none
 *   (`new`) or a different one, or one whose hash it did not report
 *   (`changed`: replacing a cover is harmless);
 * - each local screenshot whose hash the marketplace does not report
 *   (`new`), and each one it has in another place than the folder's
 *   filename order (`moved`: removed there and uploaded again after the
 *   ones before it, because the marketplace adds every upload at the end);
 * - `removed_screenshots`, the marketplace's screenshot hashes with no
 *   local file, only when the folder holds any (the folder is then the
 *   creator's stated set; an empty folder leaves the marketplace's alone);
 *
 * push keeps (`screenshots_keep`) the folder's screenshots except the moved
 * ones. The marketplace removes nothing for an empty keep list, so the
 * order is left as it is when keeping nothing would be the only way to fix
 * it, and also while the marketplace holds a screenshot without a hash (it
 * always keeps those).
 *
 * @param {LocalListingImages} local
 * @param {RemoteListingImages|null} remote
 * @returns {ListingImagesPlan}
 */
export function planListingImages(local, remote) {
    const remoteCover = remote?.cover ?? null;
    const remoteScreenshots = remote?.screenshots ?? [];
    const remoteHashes = new Set(remoteScreenshots.map((entry) => entry.sha256).filter((hash) => hash !== null));
    const entry = (/** @type {LocalListingImage} */ image, /** @type {string} */ uploadName) => ({ path: image.path, upload_filename: uploadName, sha256: image.sha256, size: image.size, mime_type: image.mime_type });
    /** @type {ListingImagesPlan['cover']} */
    let cover = null;

    if (local.cover !== null && remoteCover === null) {
        cover = { ...entry(local.cover, listingImageUploadName('cover', local.cover)), change: 'new' };
    }

    if (local.cover !== null && remoteCover !== null && remoteCover.sha256 !== local.cover.sha256) {
        cover = { ...entry(local.cover, listingImageUploadName('cover', local.cover)), change: 'changed' };
    }

    /** @type {{image: LocalListingImage, position: number}[]} */
    const unique = [];

    for (const [index, image] of local.screenshots.entries()) {
        if (!unique.some((candidate) => candidate.image.sha256 === image.sha256)) {
            unique.push({ image, position: index + 1 });
        }
    }

    const localHashes = new Set(unique.map(({ image }) => image.sha256));
    const removed = local.screenshots.length === 0 ? [] : [...remoteHashes].filter((hash) => !localHashes.has(hash));
    // What the marketplace shows once the keep list removed the rest, in its order.
    const kept = [...new Set(remoteScreenshots.map((candidate) => candidate.sha256).filter((hash) => hash !== null && localHashes.has(hash)))];
    let inPlace = 0;

    while (inPlace < kept.length && inPlace < unique.length && kept[inPlace] === unique[inPlace].image.sha256) {
        inPlace++;
    }

    const brandNew = unique.filter(({ image }) => !remoteHashes.has(image.sha256));
    const reorderable = remoteScreenshots.every((candidate) => candidate.sha256 !== null) && inPlace + brandNew.length > 0;
    const toUpload = reorderable ? unique.slice(inPlace) : brandNew;
    const screenshots = toUpload.map(({ image, position }) => ({
        ...entry(image, listingImageUploadName('screenshot', image, position)),
        change: /** @type {'new'|'moved'} */ (remoteHashes.has(image.sha256) ? 'moved' : 'new'),
    }));

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
