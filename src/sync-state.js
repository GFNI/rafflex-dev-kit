import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { scanAssets } from './assets.js';
import { canonicalListing, parseListing, sortedJson } from './listing.js';
import { readTemplate } from './workspace.js';

/**
 * What a product looks like locally against the last remote snapshot
 * recorded in product.json (`remote`, written by `synced` from a
 * get_product result). Shared by status, plan, and synced, so all three
 * hash the same way:
 *
 * - template: sha256 of the template text
 * - options: sha256 of sorted key JSON of the option overrides
 * - listing: sha256 of the canonical listing (see listing.js)
 * - assets: sha256 of each file, compared with remote.media by tag, except
 *   approved libraries, which match by hash and then library name (a
 *   library attached under a custom tag is still the same library)
 */

/** How old a remote snapshot may be before the kit asks for a fresh read. */
export const remoteStaleAfterMs = 24 * 60 * 60 * 1000;

/** @type {Record<string, string>} */
const mimeTypes = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    glb: 'model/gltf-binary',
    js: 'text/javascript',
};

/** Upload rules for scanning when no rules are cached: every type the platform takes, no size limits. */
const fallbackRules = { upload_rules: { extensions: Object.keys(mimeTypes), max_bytes_by_kind: {}, refusals: {} } };

/**
 * @param {string|Buffer} data
 */
export function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

/**
 * @param {string} filename
 */
export function mimeTypeOf(filename) {
    return mimeTypes[extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Option overrides in one shape: an empty array from the platform, null, or a missing
 * file all mean no overrides.
 *
 * @param {unknown} overrides
 * @returns {Record<string, any>}
 */
export function normaliseOptionOverrides(overrides) {
    if (overrides === null || overrides === undefined || (Array.isArray(overrides) && overrides.length === 0)) {
        return {};
    }

    return /** @type {Record<string, any>} */ (overrides);
}

/**
 * @param {string} template
 */
export function templateHash(template) {
    return sha256(template);
}

/**
 * @param {unknown} overrides
 */
export function optionOverridesHash(overrides) {
    return sha256(sortedJson(normaliseOptionOverrides(overrides)));
}

/**
 * @param {Partial<import('./listing.js').ListingFields>|null|undefined} listing
 */
export function listingHash(listing) {
    return sha256(canonicalListing(listing));
}

/**
 * Whether a remote snapshot is too old (or missing) to plan a push from.
 *
 * @param {import('./workspace.js').ProductRemote|null|undefined} remote
 * @param {number} [now]
 */
export function isRemoteStale(remote, now = Date.now()) {
    const syncedAt = Date.parse(remote?.synced_at ?? '');

    return Number.isNaN(syncedAt) || now - syncedAt > remoteStaleAfterMs;
}

/**
 * @typedef {{path: string, filename: string, tag: string, kind: string, size: number, mime_type: string, sha256: string, library: string|null}} LocalAsset
 *
 * @typedef {object} LocalState
 * @property {{sha256: string, text: string}|null} template   null when template.twig is missing.
 * @property {{sha256: string, value: Record<string, any>}|{error: string}} options
 * @property {{sha256: string, fields: import('./listing.js').ListingFields}|{error: string}} listing
 * @property {LocalAsset[]} assets
 * @property {import('./assets.js').AssetRefusal[]} refusals
 */

/**
 * Read and hash a product's files. `documents` supplies the upload rules
 * and approved libraries for tagging assets as the studio would; without
 * them (offline with no cache) every file the platform takes is tagged by
 * its filename.
 *
 * @param {import('./workspace.js').Product} product
 * @param {{rules?: any, libraries?: any}|null} [documents]
 * @returns {LocalState}
 */
export function readLocalState(product, documents = null) {
    /** @type {LocalState['template']} */
    let template = null;

    try {
        const text = readTemplate(product);

        template = { sha256: templateHash(text), text };
    } catch {
        template = null;
    }

    /** @type {LocalState['options']} */
    let options;

    try {
        const value = existsSync(product.optionsPath) ? JSON.parse(readFileSync(product.optionsPath, 'utf8')) : {};

        if (value !== null && (typeof value !== 'object' || (Array.isArray(value) && value.length > 0))) {
            throw new Error('it must be a JSON object');
        }

        options = { sha256: optionOverridesHash(value), value: normaliseOptionOverrides(value) };
    } catch (error) {
        options = { error: `options.json cannot be read: ${/** @type {Error} */ (error).message}` };
    }

    /** @type {LocalState['listing']} */
    let listing;

    try {
        const fields = parseListing(existsSync(product.listingPath) ? readFileSync(product.listingPath, 'utf8') : '');

        listing = { sha256: listingHash(fields), fields };
    } catch (error) {
        listing = { error: /** @type {Error} */ (error).message };
    }

    const rules = documents?.rules?.upload_rules ? documents.rules : fallbackRules;
    const scan = scanAssets(product.assetsDirectory, rules, documents?.libraries?.libraries ?? [], (path) => path);
    const assets = scan.assets.map((asset) => ({
        path: `assets/${asset.path}`,
        filename: asset.filename,
        tag: asset.tag,
        kind: asset.kind,
        size: asset.size,
        mime_type: mimeTypeOf(asset.filename),
        sha256: asset.library?.sha256?.toLowerCase() ?? sha256(readFileSync(join(product.assetsDirectory, asset.path))),
        library: asset.library?.name ?? null,
    }));

    return { template, options, listing, assets, refusals: scan.refusals };
}

/**
 * @typedef {object} LocalChanges
 * @property {boolean} template
 * @property {boolean} options
 * @property {boolean} listing
 * @property {{new: LocalAsset[], changed: LocalAsset[], removed: {tag: string, filename: string}[]}} assets
 * @property {boolean} any
 */

/**
 * What changed locally since the remote snapshot. With no snapshot (never
 * synced) everything counts as changed. An unreadable options.json or
 * listing.md counts as changed, so a push is never planned around it
 * silently. A remote file without a recorded hash counts as changed: the
 * kit cannot prove it is the same, and uploading it again is harmless. A
 * changed library carries the tag it is attached under on the marketplace.
 *
 * The template and option hashes compare with the draft, or with the live
 * baseline (`remote.live`) when there is no draft. Without either there is
 * nothing recorded to compare with, so both count as changed.
 *
 * @param {LocalState} local
 * @param {import('./workspace.js').ProductRemote|null} remote
 * @returns {LocalChanges}
 */
export function compareWithRemote(local, remote) {
    const baseline = baselineOf(remote);
    const template = local.template === null || typeof baseline?.template_sha256 !== 'string' || local.template.sha256 !== baseline.template_sha256;
    const options = !('sha256' in local.options) || typeof baseline?.option_overrides_sha256 !== 'string' || local.options.sha256 !== baseline.option_overrides_sha256;
    const listing = !('sha256' in local.listing) || local.listing.sha256 !== remote?.listing_sha256;
    const remoteMedia = Array.isArray(remote?.media) ? remote.media : [];
    /** @type {Set<import('./workspace.js').ProductRemote['media'][number]>} */
    const claimed = new Set();
    /** @type {LocalChanges['assets']} */
    const assets = { new: [], changed: [], removed: [] };
    const hashOf = (/** @type {import('./workspace.js').ProductRemote['media'][number]} */ entry) => (typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : null);

    // Libraries first, by content hash and then library name: a library
    // attached under a custom tag is the same library, not a new file.
    for (const asset of local.assets.filter((candidate) => candidate.library !== null)) {
        const unclaimed = remoteMedia.filter((entry) => !claimed.has(entry));
        const remoteEntry = unclaimed.find((entry) => hashOf(entry) === asset.sha256)
            ?? unclaimed.find((entry) => entry.library === asset.library);

        if (remoteEntry === undefined) {
            assets.new.push(asset);
            continue;
        }

        claimed.add(remoteEntry);

        if (hashOf(remoteEntry) !== asset.sha256) {
            assets.changed.push({ ...asset, tag: remoteEntry.tag });
        }
    }

    for (const asset of local.assets.filter((candidate) => candidate.library === null)) {
        const remoteEntry = remoteMedia.find((entry) => !claimed.has(entry) && entry.tag === asset.tag);

        if (remoteEntry === undefined) {
            assets.new.push(asset);
            continue;
        }

        claimed.add(remoteEntry);

        if (hashOf(remoteEntry) !== asset.sha256) {
            assets.changed.push(asset);
        }
    }

    for (const entry of remoteMedia) {
        if (!claimed.has(entry)) {
            assets.removed.push({ tag: entry.tag, filename: entry.filename });
        }
    }

    const any = template || options || listing || assets.new.length > 0 || assets.changed.length > 0 || assets.removed.length > 0;

    return { template, options, listing, assets, any };
}

/**
 * What the local template and options compare with: the draft when there
 * is one, else the latest live version's hashes recorded by `synced`.
 *
 * @param {import('./workspace.js').ProductRemote|null|undefined} remote
 * @returns {{template_sha256?: string|null, option_overrides_sha256?: string|null}|null}
 */
export function baselineOf(remote) {
    if (remote === null || remote === undefined) {
        return null;
    }

    return remote.draft ?? /** @type {any} */ (remote).live ?? null;
}

/**
 * A get_product result in any of the shapes an AI may hand the kit: the
 * bare structured content, an MCP tool result (`structuredContent`, or a
 * JSON text content block), a JSON-RPC response wrapping one, or an export
 * bundle (`product`). Returns null when none holds a product.
 *
 * @param {unknown} payload
 * @returns {Record<string, any>|null}
 */
export function unwrapProductPayload(payload) {
    /** @type {any} */
    let value = payload;

    for (let depth = 0; depth < 4; depth++) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }

        if (typeof value.slug === 'string' && typeof value.type === 'string') {
            return value;
        }

        if (value.result !== undefined) {
            value = value.result;
            continue;
        }

        if (value.structuredContent !== undefined) {
            value = value.structuredContent;
            continue;
        }

        if (value.format !== undefined && value.product !== undefined) {
            value = value.product;
            continue;
        }

        const text = Array.isArray(value.content) ? value.content.find((/** @type {any} */ block) => block?.type === 'text' && typeof block.text === 'string')?.text : undefined;

        if (text === undefined) {
            return null;
        }

        try {
            value = JSON.parse(text);
        } catch {
            return null;
        }
    }

    return null;
}

/**
 * The listing fields of a get_product result, as listing.md holds them.
 *
 * @param {Record<string, any>} product
 * @returns {import('./listing.js').ListingFields}
 */
export function listingFromProduct(product) {
    const categories = Array.isArray(product.categories) ? product.categories : [];
    const tags = Array.isArray(product.tags) ? product.tags : [];

    return {
        description: product.description ?? '',
        documentation: product.documentation ?? '',
        install_notes: product.install_notes ?? '',
        video_url: product.video_url ?? '',
        category_ids: categories.map((/** @type {any} */ category) => Number(typeof category === 'object' && category !== null ? category.id : category)).filter((id) => Number.isInteger(id)),
        tag_names: tags.map((/** @type {any} */ tag) => String(typeof tag === 'object' && tag !== null ? tag.name : tag)),
    };
}

/**
 * The latest released version of a get_product result (versions are listed
 * newest release first), or null when nothing is released.
 *
 * @param {Record<string, any>} product
 * @returns {Record<string, any>|null}
 */
export function latestReleasedVersion(product) {
    const versions = Array.isArray(product.versions) ? product.versions : [];

    return versions.find((version) => typeof version?.version === 'string') ?? null;
}

/**
 * Map a get_product result to product.json's `remote` block: the server's
 * state with every pushed part reduced to the hash the kit compares local
 * files with. Option overrides are hashed by the kit (sorted key JSON, an
 * empty array the same as {}), so both sides never disagree on JSON
 * encoding; the live template hash is the server's own (exact bytes).
 *
 * When there is no draft, `live` records the latest released version's
 * hashes, so a live only product does not show as changed. A server that
 * does not send them yet leaves them null (the template counts as changed).
 *
 * @param {Record<string, any>} product
 * @param {Date} [now]
 * @returns {import('./workspace.js').ProductRemote & {live?: {version: string, template_sha256: string|null, option_overrides_sha256: string|null}|null}}
 */
export function remoteFromProduct(product, now = new Date()) {
    const draft = product.draft !== null && typeof product.draft === 'object' ? product.draft : null;
    const released = latestReleasedVersion(product);
    const media = Array.isArray(product.media) ? product.media : [];

    return {
        synced_at: now.toISOString(),
        status: typeof product.status === 'string' ? product.status : null,
        live_version: released?.version ?? null,
        live_channel: typeof released?.channel === 'string' ? released.channel : null,
        draft: draft === null ? null : {
            version: typeof draft.version === 'string' ? draft.version : null,
            revision: Number.isInteger(draft.revision) ? draft.revision : null,
            submitted: draft.submitted === true,
            template_sha256: typeof draft.template === 'string' ? templateHash(draft.template) : null,
            option_overrides_sha256: optionOverridesHash(draft.option_overrides),
        },
        listing_sha256: listingHash(listingFromProduct(product)),
        latest_review: product.latest_review !== null && typeof product.latest_review === 'object' ? product.latest_review : null,
        media: media
            .filter((entry) => typeof entry?.tag === 'string' && entry.tag !== '')
            .map((entry) => ({
                tag: entry.tag,
                filename: String(entry.filename ?? ''),
                sha256: typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : null,
                kind: String(entry.kind ?? ''),
                library: typeof entry.library?.name === 'string' ? entry.library.name : (typeof entry.library === 'string' ? entry.library : null),
            })),
        live: draft !== null || released === null ? null : {
            version: released.version,
            template_sha256: typeof released.template_sha256 === 'string' ? released.template_sha256.toLowerCase() : null,
            option_overrides_sha256: Object.hasOwn(released, 'option_overrides') ? optionOverridesHash(released.option_overrides) : null,
        },
    };
}
