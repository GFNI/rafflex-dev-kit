import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { defaultTagFor } from '../assets.js';
import { readAll } from '../cli.js';
import { commitProduct } from '../git.js';
import { extensionFor, sniffContent } from '../file-content.js';
import { listingDirectoryName, remoteListingImagesFrom, screenshotsDirectoryName } from '../listing-images.js';
import { formatListing } from '../listing.js';
import { planListingImagesFor } from '../push-plan.js';
import { loadDocuments, readCachedDocuments } from '../remote.js';
import { confinedWritePath, isPlainFilename, isSlug, resolvesInside } from '../safe-paths.js';
import { bumpVersion, isVersion } from '../semver.js';
import { compareWithRemote, latestReleasedVersion, readLocalState, remoteFromProduct, sha256 } from '../sync-state.js';
import {
    assetsDirectoryName,
    assetTypeNamed,
    changelogFilename,
    listingFilename,
    listProducts,
    loadWorkspace,
    optionsFilename,
    templateFilename,
    testsDirectoryName,
    withManifest,
    writeProductJson,
} from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

/** The export bundle format this kit reads. */
export const BundleFormat = 1;

/** How long the bundle download may take, like a sync link request. */
export const bundleTimeoutMs = 30000;

/** How long each media file or listing image download may take, like an upload. */
export const mediaTimeoutMs = 120000;

const bundleFiles = [templateFilename, optionsFilename, listingFilename, changelogFilename];

export class ImportError extends Error {}

/**
 * @typedef {{format: number, product: Record<string, any>, template_source?: string, files: Record<string, string>, media: {tag: string|null, filename: string, url: string, sha256: string|null, kind: string, library: any}[]}} ExportBundle
 */

/**
 * Read the bundle argument: a file path, `-` for standard input, or an
 * http(s) URL (export_product's signed link).
 *
 * @param {string} source
 * @param {string} cwd
 * @param {NodeJS.ReadableStream} stdin
 * @returns {Promise<string>}
 */
async function readBundleText(source, cwd, stdin) {
    if (source === '-') {
        return readAll(stdin);
    }

    if (/^https?:\/\//i.test(source)) {
        return fetchBundleText(source);
    }

    const path = resolve(cwd, source);

    if (!existsSync(path)) {
        throw new ImportError(`${source} does not exist. Pass the bundle file export_product's link downloads, its URL, or - for standard input.`);
    }

    return readFileSync(path, 'utf8');
}

/**
 * Download a bundle from its URL (export_product's signed link), giving
 * up after `timeoutMs`.
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
export async function fetchBundleText(url, timeoutMs = bundleTimeoutMs) {
    let response;

    try {
        response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        throw new ImportError(`Could not download the bundle: ${downloadFailure(error, timeoutMs)}.`);
    }

    if (response.status === 403 || response.status === 401) {
        throw new ImportError('The bundle link was refused (it is valid for 10 minutes). Call export_product again for a fresh link.');
    }

    if (!response.ok) {
        throw new ImportError(`Could not download the bundle: the marketplace answered ${response.status}.`);
    }

    try {
        return await response.text();
    } catch (error) {
        throw new ImportError(`Could not download the bundle: ${downloadFailure(error, timeoutMs)}.`);
    }
}

/**
 * Why a download failed, saying so plainly when it timed out.
 *
 * @param {unknown} error
 * @param {number} timeoutMs
 */
function downloadFailure(error, timeoutMs) {
    const name = /** @type {any} */ (error)?.name;

    if (name === 'TimeoutError' || name === 'AbortError') {
        const seconds = Math.max(1, Math.round(timeoutMs / 1000));

        return `it took longer than ${seconds} ${seconds === 1 ? 'second' : 'seconds'}, so the import stopped and nothing was written. Check the connection and run import again (call export_product for a fresh link if this one is over 10 minutes old)`;
    }

    return messageOf(/** @type {any} */ (error)?.cause ?? error);
}

/**
 * Refuse a bundle whose names would leave the product folder: every name
 * that becomes a path (the slug, the type, each media tag and file name)
 * must be plain.
 *
 * @param {Record<string, any>} product
 * @param {unknown[]} media
 */
function checkBundlePaths(product, media) {
    if (!isSlug(product.slug)) {
        throw new ImportError(`The bundle's slug "${product.slug}" is not a valid slug, so nothing was written. Export the product again; if it persists, contact support@rafflex.io.`);
    }

    if (!/^[a-z][a-z0-9_-]*$/.test(product.type)) {
        throw new ImportError(`The bundle's product type "${product.type}" is not a valid type, so nothing was written.`);
    }

    for (const [index, entry] of media.entries()) {
        if (entry === null || typeof entry !== 'object') {
            throw new ImportError(`The bundle's media ${index + 1} is not an object, so nothing was written.`);
        }

        const { tag, filename } = /** @type {Record<string, any>} */ (entry);

        if (tag !== null && tag !== undefined && tag !== '' && !isSlug(tag)) {
            throw new ImportError(`The bundle's media ${index + 1} has the tag "${tag}", which is not a valid tag (lower case words joined by hyphens), so nothing was written. Export the product again; if it persists, contact support@rafflex.io.`);
        }

        if (filename !== null && filename !== undefined && filename !== '' && !isPlainFilename(filename)) {
            throw new ImportError(`The bundle's media ${index + 1} has the file name "${filename}", which is not a plain file name, so nothing was written. Export the product again; if it persists, contact support@rafflex.io.`);
        }
    }
}

/**
 * @param {string} text
 * @returns {ExportBundle}
 */
export function parseBundle(text) {
    /** @type {any} */
    let bundle;

    try {
        bundle = JSON.parse(text);
    } catch {
        throw new ImportError('The bundle is not JSON. Download it again from export_product\'s link.');
    }

    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
        throw new ImportError('The bundle must be a JSON object.');
    }

    if (typeof bundle.format === 'number' && bundle.format > BundleFormat) {
        throw new ImportError(`The bundle is format ${bundle.format}, newer than this kit reads (${BundleFormat}). Run npx @rafflex/dev@latest import.`);
    }

    if (bundle.format !== BundleFormat) {
        throw new ImportError(`This is not a product export bundle (it needs "format": ${BundleFormat}).`);
    }

    const product = bundle.product;

    if (product === null || typeof product !== 'object' || typeof product.slug !== 'string' || typeof product.type !== 'string') {
        throw new ImportError('The bundle has no product with a slug and type.');
    }


    if (bundle.files === null || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) {
        throw new ImportError('The bundle has no files.');
    }

    for (const name of bundleFiles) {
        if (bundle.files[name] !== undefined && typeof bundle.files[name] !== 'string') {
            throw new ImportError(`The bundle's ${name} must be text.`);
        }
    }

    if (bundle.media !== undefined && !Array.isArray(bundle.media)) {
        throw new ImportError('The bundle\'s media must be a list.');
    }

    checkBundlePaths(product, bundle.media ?? []);

    return { ...bundle, media: bundle.media ?? [] };
}

/**
 * The file name a media entry is written under: its own name when the kit
 * derives the same tag from it, else `<tag><extension>`, because the kit
 * tags a file by its name (an approved library by its default tag). A
 * name is never allowed to leave the assets folder.
 *
 * @param {{tag: string, filename: string, library: any}} entry
 */
export function localFilenameFor(entry) {
    const filename = String(entry.filename ?? '').split(/[\\/]/).pop() ?? '';
    const safe = filename !== '' && filename !== '.' && filename !== '..' && !filename.startsWith('.') ? filename : '';

    if (entry.library !== null && entry.library !== undefined && safe !== '') {
        return safe;
    }

    if (safe !== '' && defaultTagFor(safe) === entry.tag) {
        return safe;
    }

    return `${entry.tag}${extname(safe).toLowerCase()}`;
}

/**
 * The version to work on in a freshly imported product: the draft's,
 * else the next minor after the latest release, else the platform's
 * starting version.
 *
 * @param {Record<string, any>} product
 */
export function importedVersion(product) {
    if (typeof product.draft?.version === 'string' && product.draft.version !== '') {
        return product.draft.version;
    }

    const latest = latestReleasedVersion(product)?.version;

    return typeof latest === 'string' && isVersion(latest) ? bumpVersion(latest, 'minor') : '1.0.0';
}

/**
 * Download one file, giving up after `timeoutMs`.
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<Buffer>}
 */
export async function download(url, timeoutMs = mediaTimeoutMs) {
    let response;

    try {
        response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        throw new ImportError(`Could not download ${url}: ${downloadFailure(error, timeoutMs)}.`);
    }

    if (!response.ok) {
        throw new ImportError(`Could not download ${url}: the server answered ${response.status}.`);
    }

    try {
        return Buffer.from(await response.arrayBuffer());
    } catch (error) {
        throw new ImportError(`Could not download ${url}: ${downloadFailure(error, timeoutMs)}.`);
    }
}

/**
 * Write the product folder into `directory` (which must not exist).
 *
 * @param {string} directory
 * @param {ExportBundle} bundle
 * @param {string} type
 * @returns {Promise<{version: string, files: string[], assets: {path: string, tag: string, sha256: string}[], skipped: {filename: string, reason: string}[]}>}
 */
async function writeProductFolder(directory, bundle, type) {
    const product = bundle.product;
    const version = importedVersion(product);
    const assetsDirectory = join(directory, assetsDirectoryName);
    /** @type {Record<string, string>} */
    const defaults = {
        [templateFilename]: '',
        [optionsFilename]: '{}\n',
        [listingFilename]: formatListing(),
        [changelogFilename]: '# Changelog\n\n## Unreleased\n',
    };

    mkdirSync(assetsDirectory, { recursive: true });
    writeFileSync(join(assetsDirectory, '.gitkeep'), '');

    for (const name of bundleFiles) {
        writeFileSync(confinedWritePath(directory, name), bundle.files[name] ?? defaults[name]);
    }

    writeProductJson(directory, {
        type,
        slug: product.slug,
        title: typeof product.title === 'string' && product.title !== '' ? product.title : product.slug,
        version,
        remote: remoteFromProduct(product),
    });

    /** @type {{path: string, tag: string, sha256: string}[]} */
    const assets = [];
    /** @type {{filename: string, reason: string}[]} */
    const skipped = [];
    const taken = new Set();

    for (const entry of bundle.media) {
        if (typeof entry?.tag !== 'string' || entry.tag === '') {
            skipped.push({ filename: String(entry?.filename ?? ''), reason: 'It has no tag, so no template can use it.' });
            continue;
        }

        if (typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url)) {
            throw new ImportError(`The bundle's media ${entry.tag} has no download URL.`);
        }

        const filename = localFilenameFor(entry);

        if (taken.has(filename.toLowerCase())) {
            throw new ImportError(`Two media files would both be written as assets/${filename}. Rename one in the studio and export again.`);
        }

        taken.add(filename.toLowerCase());

        const contents = await download(entry.url);
        const hash = sha256(contents);

        if (typeof entry.sha256 === 'string' && entry.sha256 !== '' && entry.sha256.toLowerCase() !== hash) {
            throw new ImportError(`${entry.filename} (${entry.tag}) does not match the bundle's hash: the download was ${hash}, the marketplace recorded ${entry.sha256}. Export again; if it persists, contact support@rafflex.io.`);
        }

        writeFileSync(confinedWritePath(directory, join(assetsDirectoryName, filename)), contents);
        assets.push({ path: `${assetsDirectoryName}/${filename}`, tag: entry.tag, sha256: hash });
    }

    const listingImages = await writeListingImages(directory, product);

    return { version, files: [...bundleFiles, ...listingImages], assets, skipped };
}

/**
 * The extension a downloaded listing image is saved with: what its
 * content is, else what its URL says, else png.
 *
 * @param {Buffer} contents
 * @param {string} url
 */
function listingImageExtension(contents, url) {
    const sniffed = sniffContent(contents);

    if (sniffed !== null) {
        return extensionFor[sniffed];
    }

    const fromUrl = extname(new URL(url).pathname).slice(1).toLowerCase();

    return /^[a-z0-9]{2,5}$/.test(fromUrl) ? fromUrl : 'png';
}

/**
 * Download the product's cover and screenshots into listing/, checking
 * each against the hash the marketplace reported. Screenshots are named
 * 01, 02, ... so filename order keeps the marketplace's order.
 *
 * @param {string} directory
 * @param {Record<string, any>} product
 * @returns {Promise<string[]>} The files written, relative to the product folder.
 */
async function writeListingImages(directory, product) {
    const images = remoteListingImagesFrom(product);
    /** @type {string[]} */
    const written = [];
    const fetchChecked = async (/** @type {{url: string|null, sha256: string|null}} */ image, /** @type {string} */ label) => {
        const contents = await download(/** @type {string} */ (image.url));
        const hash = sha256(contents);

        if (image.sha256 !== null && image.sha256 !== hash) {
            throw new ImportError(`The ${label} does not match the bundle's hash: the download was ${hash}, the marketplace recorded ${image.sha256}. Export again; if it persists, contact support@rafflex.io.`);
        }

        return contents;
    };
    const isDownloadable = (/** @type {{url: string|null}} */ image) => typeof image.url === 'string' && /^https?:\/\//i.test(image.url);

    if (images === undefined) {
        return written;
    }

    if (images.cover !== null && isDownloadable(images.cover)) {
        const contents = await fetchChecked(images.cover, 'cover image');
        const name = `cover.${listingImageExtension(contents, /** @type {string} */ (images.cover.url))}`;

        mkdirSync(join(directory, listingDirectoryName), { recursive: true });
        writeFileSync(confinedWritePath(directory, join(listingDirectoryName, name)), contents);
        written.push(`${listingDirectoryName}/${name}`);
    }

    for (const [index, screenshot] of images.screenshots.filter(isDownloadable).entries()) {
        const contents = await fetchChecked(screenshot, `screenshot ${index + 1}`);
        const name = `${String(index + 1).padStart(2, '0')}.${listingImageExtension(contents, /** @type {string} */ (screenshot.url))}`;

        mkdirSync(join(directory, listingDirectoryName, screenshotsDirectoryName), { recursive: true });
        writeFileSync(confinedWritePath(directory, join(listingDirectoryName, screenshotsDirectoryName, name)), contents);
        written.push(`${listingDirectoryName}/${screenshotsDirectoryName}/${name}`);
    }

    return written;
}

/**
 * @param {import('../sync-state.js').LocalChanges} changes
 * @param {import('../listing-images.js').ListingImagesPlan} [listingImages]
 */
function describeChanges(changes, listingImages) {
    return [
        changes.template && 'template.twig',
        changes.options && 'options.json',
        changes.listing && 'listing.md',
        ...changes.assets.new.map((asset) => `${asset.path} (new)`),
        ...changes.assets.changed.map((asset) => `${asset.path} (changed)`),
        ...changes.assets.removed.map((entry) => `${entry.filename} (removed)`),
        ...(listingImages?.cover ? [`${listingImages.cover.path} (${listingImages.cover.change})`] : []),
        ...(listingImages?.screenshots ?? []).map((screenshot) => `${screenshot.path} (new)`),
    ].filter((entry) => typeof entry === 'string');
}

/**
 * `import <bundle> [--force]`: write a product export bundle (from
 * export_product) as a product folder under its type folder, named after
 * its slug: the files verbatim, product.json with the server state, and
 * each media file downloaded into assets/ and checked against its hash.
 *
 * An existing folder for the product is only replaced with --force; the
 * refusal lists its local changes since the last sync. The folder is built
 * beside the target and swapped in only once everything downloaded.
 *
 * With git, the product folder is committed as "Import <slug> from the
 * marketplace", or "Revert <slug> to <x.y.z> as <version>" when the draft
 * was started by revert_to_version. A replaced folder keeps its tests/.
 *
 * JSON: `{product, slug, type, title, version, template_source, replaced, files, assets, skipped, git}`.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runImportCommand(context) {
    const { cwd, stdout, stderr, stdin, options } = context;
    let workspace;
    let bundle;
    /** @type {string[]} */
    let warnings = [];

    try {
        workspace = loadWorkspace(cwd);
        bundle = parseBundle(await readBundleText(options.positionals[0], cwd, stdin));
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    try {
        const loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl, names: [] });

        workspace = withManifest(workspace, loaded.manifest ?? null);
        warnings = loaded.warnings;
    } catch {
        // Offline with no cache: the cached or default asset types still apply.
    }

    const assetType = assetTypeNamed(workspace, bundle.product.type);

    if (assetType === undefined) {
        return fail(context, `The bundle is a ${bundle.product.type}, which this kit does not know. Run npx @rafflex/dev@latest import.`, 2);
    }

    const slug = bundle.product.slug;
    const typeDirectory = join(workspace.root, assetType.folder);
    const target = join(typeDirectory, slug);

    if (!resolvesInside(workspace.root, typeDirectory) || !resolvesInside(typeDirectory, target)) {
        return fail(context, `The bundle's product would be written outside the workspace (${assetType.folder}/${slug}), so nothing was written.`, 2);
    }
    const path = `${assetType.folder}/${slug}`;
    const products = listProducts(workspace);
    const existing = products.find((product) => product.slug === slug && product.type === assetType.value)
        ?? products.find((product) => product.directory === target)
        ?? null;

    if (existing === null && existsSync(target)) {
        return fail(context, `${path} exists but is not a product folder (no product.json). Move it away and import again.`, 1);
    }

    if (existing !== null && !options.force) {
        /** @type {string[]} */
        let changes = [];

        try {
            const { documents } = readCachedDocuments(workspace.root, workspace.baseUrl, ['rules', 'libraries', 'categories']);

            const local = readLocalState(existing, documents);

            changes = describeChanges(compareWithRemote(local, existing.manifest.remote), planListingImagesFor(local, existing.manifest.remote));
        } catch {
            changes = [];
        }

        const detail = existing.manifest.remote === null
            ? 'It was never synced, so every local file would be replaced.'
            : (changes.length === 0 ? 'It has no local changes since the last sync.' : `Local changes that would be lost: ${changes.join(', ')}.`);

        return fail(context, `${existing.path} already exists. ${detail} Run import again with --force to replace it (commit first to keep a copy).`, 1, { product: existing.path, local_changes: changes });
    }

    mkdirSync(typeDirectory, { recursive: true });

    const temporary = join(typeDirectory, `.${slug}.import-${process.pid}`);
    let written;

    rmSync(temporary, { recursive: true, force: true });

    try {
        written = await writeProductFolder(temporary, bundle, assetType.value);
    } catch (error) {
        rmSync(temporary, { recursive: true, force: true });

        return fail(context, messageOf(error), 1);
    }

    /** @type {string|null} */
    let replacedFrom = null;

    if (existing !== null) {
        const aside = join(typeDirectory, `.${slug}.replaced-${process.pid}`);
        const creatorTests = join(existing.directory, testsDirectoryName);

        if (existsSync(creatorTests) && !existsSync(join(temporary, testsDirectoryName))) {
            renameSync(creatorTests, join(temporary, testsDirectoryName));
        }

        rmSync(aside, { recursive: true, force: true });
        renameSync(existing.directory, aside);
        renameSync(temporary, target);
        rmSync(aside, { recursive: true, force: true });
        replacedFrom = existing.path;
    } else {
        renameSync(temporary, target);
    }

    const revertedFrom = typeof bundle.product.draft?.reverted_from === 'string' ? bundle.product.draft.reverted_from : null;
    const message = revertedFrom === null ? `Import ${slug} from the marketplace` : `Revert ${slug} to ${revertedFrom} as ${written.version}`;
    const git = commitProduct(workspace.root, existing !== null && existing.directory !== target ? [existing.directory, target] : target, message);

    if (git.error !== null) {
        warnings = [...warnings, git.error];
    }

    const result = {
        product: path,
        slug,
        type: assetType.value,
        title: bundle.product.title ?? slug,
        version: written.version,
        template_source: bundle.template_source ?? null,
        replaced: replacedFrom,
        files: written.files,
        assets: written.assets,
        skipped: written.skipped,
        git,
    };

    if (options.json) {
        writeJson(stdout, result);

        return 0;
    }

    for (const warning of warnings) {
        stderr.write(`note: ${warning}\n`);
    }

    for (const entry of written.skipped) {
        stderr.write(`note: skipped ${entry.filename}: ${entry.reason}\n`);
    }

    const source = bundle.template_source === 'live' ? 'the live version (there is no draft)' : 'the draft';

    stdout.write(`${replacedFrom === null ? 'Imported' : `Replaced ${replacedFrom} with`} ${path} (${assetType.label.toLowerCase()} "${result.title}", version ${written.version}, template from ${source})${git.committed ? `, committed "${message}"` : ''}\n${[...written.files, ...written.assets.map((asset) => asset.path)].map((file) => `  ${path}/${file}`).join('\n')}\n\nNext: npx @rafflex/dev status ${slug}\n`);

    return 0;
}
