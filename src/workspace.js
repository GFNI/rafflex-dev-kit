import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readCachedDocuments, resolveBaseUrl } from './remote.js';
import { newerTime, readSyncTimes, syncTimeKey } from './sync-times.js';

/**
 * The workspace: one folder per creator account holding every product in
 * a fixed layout.
 *
 *   rafflex.json            {"workspace": 1, "base_url"?: string}
 *   AGENTS.md, CLAUDE.md    generated guidance for the creator's AI
 *   .rafflex/cache/         the kit's rules cache
 *   games/<folder>/         one folder per product, per type folder
 *   blocks/<folder>/
 *
 * A product folder holds product.json (kit written), template.twig,
 * options.json, listing.md, CHANGELOG.md, and assets/.
 */

export const workspaceFilename = 'rafflex.json';
export const productFilename = 'product.json';
export const templateFilename = 'template.twig';
export const optionsFilename = 'options.json';
export const listingFilename = 'listing.md';
export const changelogFilename = 'CHANGELOG.md';
export const assetsDirectoryName = 'assets';
/** The creator's own browser specs (PRD 41), committed, never pushed. */
export const testsDirectoryName = 'tests';
/** Browser test output (PRD 41), git ignored, never pushed. */
export const resultsDirectoryName = '.results';

/** The workspace format this kit writes and understands. */
export const WorkspaceFormat = 1;

/** The platform's asset types when the manifest (or its cache) does not list them. */
export const defaultAssetTypes = Object.freeze([
    Object.freeze({ value: 'game', folder: 'games', label: 'Game' }),
    Object.freeze({ value: 'block', folder: 'blocks', label: 'Block' }),
]);

export const legacyLayoutMessage = 'This folder uses the old single project layout. Run npx @rafflex/dev init in a new folder.';

/**
 * @typedef {{value: string, folder: string, label: string}} AssetType
 * @typedef {{workspace: number, base_url?: string|null}} WorkspaceConfig
 * @typedef {{root: string, config: WorkspaceConfig, baseUrl: string, assetTypes: AssetType[]}} Workspace
 *
 * @typedef {object} ProductRemoteDraft
 * @property {string|null} version
 * @property {number|null} revision
 * @property {boolean} submitted
 * @property {string|null} template_sha256
 * @property {string|null} option_overrides_sha256
 *
 * @typedef {object} ProductRemote
 * @property {string} synced_at
 * @property {string|null} status
 * @property {string|null} live_version
 * @property {string|null} live_channel
 * @property {ProductRemoteDraft|null} draft
 * @property {string|null} listing_sha256
 * @property {Record<string, any>|null} latest_review
 * @property {{tag: string, filename: string, sha256: string|null, kind: string, library: any, locked?: boolean, size_bytes?: number}[]} media
 * @property {import('./listing-images.js').RemoteListingImages} [listing_images]  The cover and screenshots with their SHA-256, when the marketplace reported them.
 *
 * @typedef {{type: string, slug: string|null, title: string, version: string, remote: ProductRemote|null, previous_paths?: string[]}} ProductManifest
 *
 * @typedef {object} Product
 * @property {string} path         Workspace relative path, the product's id in output: "games/spin-to-win".
 * @property {string} folder       The folder name: "spin-to-win".
 * @property {string} directory    Absolute path of the product folder.
 * @property {string} type         The asset type value of its type folder ("game").
 * @property {string|null} slug
 * @property {string} title
 * @property {string} version
 * @property {ProductManifest} manifest  product.json as read.
 * @property {string} templatePath
 * @property {string} optionsPath
 * @property {string} listingPath
 * @property {string} changelogPath
 * @property {string} assetsDirectory
 */

export class WorkspaceError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'WorkspaceError';
    }
}

/**
 * @param {string} path
 * @returns {any}
 */
function readJsonFile(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new WorkspaceError(`${path} is not valid JSON: ${/** @type {Error} */ (error).message}`);
    }
}

/**
 * The workspace root: the nearest folder at or above `start` holding a
 * rafflex.json with `"workspace": 1`. A rafflex.json with a `type` key is
 * the retired single project layout and is refused. Returns null when
 * there is no rafflex.json at all.
 *
 * @param {string} start
 * @returns {string|null}
 */
export function findWorkspaceRoot(start) {
    let directory = resolve(start);

    while (true) {
        const configPath = join(directory, workspaceFilename);

        if (existsSync(configPath)) {
            validateWorkspaceConfig(readJsonFile(configPath), configPath);

            return directory;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return null;
        }

        directory = parent;
    }
}

/**
 * @param {any} config
 * @param {string} configPath
 * @returns {WorkspaceConfig}
 */
function validateWorkspaceConfig(config, configPath) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new WorkspaceError(`${configPath} must be a JSON object.`);
    }

    if (Object.hasOwn(config, 'type')) {
        throw new WorkspaceError(legacyLayoutMessage);
    }

    if (typeof config.workspace === 'number' && config.workspace > WorkspaceFormat) {
        throw new WorkspaceError(`${configPath} is a newer workspace (${config.workspace}) than this kit understands (${WorkspaceFormat}). Run npx @rafflex/dev@latest to update.`);
    }

    if (config.workspace !== WorkspaceFormat) {
        throw new WorkspaceError(`${configPath} is not a Rafflex workspace (it needs "workspace": ${WorkspaceFormat}). Run npx @rafflex/dev init in a new folder.`);
    }

    return { workspace: config.workspace, base_url: typeof config.base_url === 'string' ? config.base_url : null };
}

/**
 * The asset types a manifest publishes, keeping only entries whose folder
 * is a plain lower case name (a type folder must never point outside the
 * workspace), or the defaults when it lists none.
 *
 * @param {import('./remote.js').Manifest|null|undefined} manifest
 * @returns {AssetType[]}
 */
export function assetTypesFrom(manifest) {
    const listed = Array.isArray(manifest?.asset_types) ? manifest.asset_types : [];
    const valid = listed
        .filter((entry) => typeof entry?.value === 'string' && typeof entry?.folder === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(entry.folder))
        .map((entry) => ({ value: entry.value, folder: entry.folder, label: typeof entry.label === 'string' ? entry.label : entry.value }));

    return valid.length > 0 ? valid : defaultAssetTypes.map((type) => ({ ...type }));
}

/**
 * Load the workspace containing `start`. Asset types come from the cached
 * manifest (no network); pass `manifest` to use a freshly loaded one.
 *
 * @param {string} start
 * @param {{manifest?: import('./remote.js').Manifest|null, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Workspace}
 */
export function loadWorkspace(start, { manifest, env = process.env } = {}) {
    const root = findWorkspaceRoot(start);

    if (root === null) {
        throw new WorkspaceError(`No Rafflex workspace here or in any parent folder (no ${workspaceFilename}). Run "npx @rafflex/dev init" in a new folder to create one.`);
    }

    const config = validateWorkspaceConfig(readJsonFile(join(root, workspaceFilename)), join(root, workspaceFilename));
    const baseUrl = resolveBaseUrl(config, env);
    const assetTypes = assetTypesFrom(manifest === undefined ? readCachedDocuments(root, baseUrl, []).manifest : manifest);

    return { root, config, baseUrl, assetTypes };
}

/**
 * The same workspace with the asset types of a freshly loaded manifest.
 *
 * @param {Workspace} workspace
 * @param {import('./remote.js').Manifest|null} manifest
 * @returns {Workspace}
 */
export function withManifest(workspace, manifest) {
    return { ...workspace, assetTypes: assetTypesFrom(manifest) };
}

/**
 * The asset type named by its value ("game") or folder ("games").
 *
 * @param {Workspace} workspace
 * @param {string} name
 * @returns {AssetType|undefined}
 */
export function assetTypeNamed(workspace, name) {
    return workspace.assetTypes.find((type) => type.value === name || type.folder === name);
}

/**
 * Read a product folder. The type comes from the type folder it sits in,
 * since the layout is the contract. `remote.synced_at` is the newer of
 * product.json's and the last successful sync recorded in `.rafflex/`.
 *
 * @param {Workspace} workspace
 * @param {AssetType} assetType
 * @param {string} folder
 * @returns {Product}
 */
export function readProduct(workspace, assetType, folder) {
    const directory = join(workspace.root, assetType.folder, folder);
    const manifest = readProductJson(directory);

    // A sync that changed nothing is recorded outside git; the newer time counts.
    if (manifest.remote !== null) {
        const recorded = readSyncTimes(workspace.root)[syncTimeKey({ slug: manifest.slug, path: `${assetType.folder}/${folder}` })];

        manifest.remote = { ...manifest.remote, synced_at: /** @type {string} */ (newerTime(manifest.remote.synced_at, recorded)) };
    }

    return {
        path: `${assetType.folder}/${folder}`,
        folder,
        directory,
        type: assetType.value,
        slug: manifest.slug,
        title: manifest.title,
        version: manifest.version,
        manifest,
        templatePath: join(directory, templateFilename),
        optionsPath: join(directory, optionsFilename),
        listingPath: join(directory, listingFilename),
        changelogPath: join(directory, changelogFilename),
        assetsDirectory: join(directory, assetsDirectoryName),
    };
}

/**
 * Every product in the workspace: each folder holding a product.json
 * under a type folder, in type order then folder name order.
 *
 * @param {Workspace} workspace
 * @returns {Product[]}
 */
export function listProducts(workspace) {
    /** @type {Product[]} */
    const products = [];

    for (const assetType of workspace.assetTypes) {
        /** @type {string[]} */
        let entries;

        try {
            entries = readdirSync(join(workspace.root, assetType.folder));
        } catch {
            continue;
        }

        for (const entry of entries.sort()) {
            if (entry.startsWith('.')) {
                continue;
            }

            const directory = join(workspace.root, assetType.folder, entry);

            if (!statSync(directory).isDirectory() || !existsSync(join(directory, productFilename))) {
                continue;
            }

            products.push(readProduct(workspace, assetType, entry));
        }
    }

    return products;
}

/**
 * The product whose folder contains `directory`, or null.
 *
 * @param {Product[]} products
 * @param {string} directory
 * @returns {Product|null}
 */
export function productContaining(products, directory) {
    const target = resolve(directory);

    return products.find((product) => target === product.directory || target.startsWith(`${product.directory}${sep}`)) ?? null;
}

/**
 * Resolve a product argument: a slug, a folder name, or a path (relative
 * to the workspace or to `cwd`).
 *
 * @param {Workspace} workspace
 * @param {Product[]} products
 * @param {string} argument
 * @param {string} cwd
 * @returns {Product}
 */
export function resolveProduct(workspace, products, argument, cwd) {
    const name = argument.replace(/[\\/]+$/, '');
    const fromCwd = resolve(cwd, name);
    const fromRoot = resolve(workspace.root, name);
    const matches = products.filter((product) => product.slug === name
        || product.folder === name
        || product.path === name.split(sep).join('/')
        || product.directory === fromCwd
        || product.directory === fromRoot);

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new WorkspaceError(`"${argument}" matches more than one product (${matches.map((product) => product.path).join(', ')}). Name it by path, for example ${matches[0].path}.`);
    }

    const renamed = renamedProduct(workspace, products, name, fromCwd);

    if (renamed !== null) {
        return renamed;
    }

    const known = products.length === 0 ? 'There are no products yet; add one with npx @rafflex/dev new.' : `Products: ${products.map((product) => product.slug ?? product.path).join(', ')}.`;

    throw new WorkspaceError(`No product "${argument}" in this workspace. ${known}`);
}

/**
 * The product a folder used to be, by a path the kit recorded in its
 * product.json (`previous_paths`) when it renamed the folder to the slug
 * on the first push, so a command run with the old path still finds it.
 * Says on stderr where the folder is now.
 *
 * @param {Workspace} workspace
 * @param {Product[]} products
 * @param {string} name
 * @param {string} fromCwd
 * @returns {Product|null}
 */
function renamedProduct(workspace, products, name, fromCwd) {
    const wanted = new Set([name.split(sep).join('/'), relative(workspace.root, fromCwd).split(sep).join('/')]);
    const matches = products.filter((product) => {
        const previous = Array.isArray(product.manifest.previous_paths) ? product.manifest.previous_paths : [];

        return previous.some((/** @type {unknown} */ path) => typeof path === 'string' && (wanted.has(path) || path.split('/').pop() === name));
    });

    if (matches.length !== 1) {
        return null;
    }

    process.stderr.write(`note: ${name} was renamed to its slug; the product is now ${matches[0].path}.\n`);

    return matches[0];
}

/**
 * The products a command works on.
 *
 * - Named products resolve by slug, folder name, or path.
 * - `all` (or `fallback: 'all'` outside a product folder) means every
 *   product in the workspace.
 * - Otherwise the product containing `cwd`, or an error asking for one.
 *
 * @param {Workspace} workspace
 * @param {{names?: string[], all?: boolean, cwd: string, fallback?: 'all'|'required'}} options
 * @returns {Product[]}
 */
export function selectProducts(workspace, { names = [], all = false, cwd, fallback = 'required' }) {
    const products = listProducts(workspace);

    if (all) {
        if (names.length > 0) {
            throw new WorkspaceError('Name products or pass --all, not both.');
        }

        return products;
    }

    if (names.length > 0) {
        const selected = names.map((name) => resolveProduct(workspace, products, name, cwd));

        return selected.filter((product, index) => selected.indexOf(product) === index);
    }

    const containing = productContaining(products, cwd);

    if (containing !== null) {
        return [containing];
    }

    if (fallback === 'all') {
        return products;
    }

    throw new WorkspaceError(products.length === 0
        ? 'There are no products in this workspace yet. Add one with npx @rafflex/dev new <game|block> "<title>".'
        : `Name a product (${products.map((product) => product.slug ?? product.path).join(', ')}) or run this inside its folder.`);
}

/**
 * The single product a command works on: the one named, or the one
 * containing `cwd`.
 *
 * @param {Workspace} workspace
 * @param {string|undefined} name
 * @param {string} cwd
 * @returns {Product}
 */
export function selectProduct(workspace, name, cwd) {
    return selectProducts(workspace, { names: name === undefined ? [] : [name], cwd })[0];
}

const productKeys = ['type', 'slug', 'title', 'version', 'remote'];
const remoteKeys = ['synced_at', 'status', 'live_version', 'live_channel', 'draft', 'listing_sha256', 'latest_review', 'media', 'listing_images'];
const draftKeys = ['version', 'revision', 'submitted', 'template_sha256', 'option_overrides_sha256'];
const mediaKeys = ['tag', 'filename', 'sha256', 'kind', 'library', 'locked', 'size_bytes'];

/**
 * Copy an object with `keys` first, in that order, then any other keys in
 * their existing order, so product.json diffs stay small and stable.
 *
 * @param {Record<string, any>} value
 * @param {string[]} keys
 * @returns {Record<string, any>}
 */
function ordered(value, keys) {
    /** @type {Record<string, any>} */
    const result = {};

    for (const key of keys) {
        if (Object.hasOwn(value, key)) {
            result[key] = value[key];
        }
    }

    for (const [key, entry] of Object.entries(value)) {
        if (!Object.hasOwn(result, key)) {
            result[key] = entry;
        }
    }

    return result;
}

/**
 * product.json in the kit's stable key order.
 *
 * @param {Record<string, any>} data
 * @returns {ProductManifest}
 */
export function normaliseProductJson(data) {
    const product = ordered({ slug: null, remote: null, ...data }, productKeys);

    if (product.remote !== null && typeof product.remote === 'object') {
        const remote = ordered(product.remote, remoteKeys);

        if (remote.draft !== null && typeof remote.draft === 'object') {
            remote.draft = ordered(remote.draft, draftKeys);
        }

        if (Array.isArray(remote.media)) {
            remote.media = remote.media.map((/** @type {Record<string, any>} */ entry) => ordered(entry, mediaKeys));
        }

        product.remote = remote;
    }

    return /** @type {ProductManifest} */ (product);
}

/**
 * Read a product folder's product.json, filling the fields an older or
 * hand edited file lacks.
 *
 * @param {string} directory
 * @returns {ProductManifest}
 */
export function readProductJson(directory) {
    const path = join(directory, productFilename);

    if (!existsSync(path)) {
        throw new WorkspaceError(`${path} is missing.`);
    }

    const data = readJsonFile(path);

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new WorkspaceError(`${path} must be a JSON object.`);
    }

    const folder = directory.split(sep).pop() ?? '';

    return normaliseProductJson({
        ...data,
        slug: typeof data.slug === 'string' && data.slug !== '' ? data.slug : null,
        title: typeof data.title === 'string' && data.title !== '' ? data.title : folder,
        version: typeof data.version === 'string' ? data.version : '1.0.0',
        remote: data.remote !== null && typeof data.remote === 'object' && !Array.isArray(data.remote) ? data.remote : null,
    });
}

/**
 * The exact text the kit writes for product.json: stable key order, two
 * space JSON, and a trailing newline.
 *
 * @param {Record<string, any>} data
 */
export function formatProductJson(data) {
    return `${JSON.stringify(normaliseProductJson(data), null, 2)}\n`;
}

/**
 * Write product.json atomically.
 *
 * @param {string} directory
 * @param {Record<string, any>} data
 */
export function writeProductJson(directory, data) {
    const path = join(directory, productFilename);
    const temporary = `${path}.${process.pid}.tmp`;

    writeFileSync(temporary, formatProductJson(data));
    renameSync(temporary, path);
}

/**
 * @param {Product} product
 */
export function readTemplate(product) {
    try {
        return readFileSync(product.templatePath, 'utf8');
    } catch {
        throw new WorkspaceError(`${product.path}/${templateFilename} is missing.`);
    }
}

/**
 * A path relative to the workspace root, with forward slashes.
 *
 * @param {Workspace} workspace
 * @param {string} path
 */
export function workspacePath(workspace, path) {
    return relative(workspace.root, path).split(sep).join('/');
}
