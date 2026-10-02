import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kitVersion } from './version.js';

/**
 * The marketplace's public dev kit documents (rules, contexts, skeletons,
 * libraries, fixtures), fetched from the manifest with ETags and cached in
 * the project so the kit works offline. These GET requests are the only
 * network traffic the kit makes: no credentials, no telemetry, no uploads.
 */

export const defaultBaseUrl = 'https://marketplace.rafflex.io';

export const projectDocuments = ['rules', 'contexts', 'skeletons', 'libraries'];

const requestTimeoutMs = 15000;

/** The newest manifest `contract` this kit understands. Contract changes are additive until this bumps. */
export const SupportedContract = 1;

export class RulesUnavailableError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'RulesUnavailableError';
    }
}

/**
 * The marketplace base URL: RAFFLEX_BASE_URL, then rafflex.json's
 * base_url, then production.
 *
 * @param {{base_url?: string|null}|null} [projectConfig]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveBaseUrl(projectConfig = null, env = process.env) {
    const configured = env.RAFFLEX_BASE_URL || projectConfig?.base_url || defaultBaseUrl;

    return configured.replace(/\/+$/, '');
}

/**
 * @param {string} baseUrl
 */
function cacheKeyFor(baseUrl) {
    return new URL(baseUrl).host.replace(/[^a-z0-9.-]/gi, '_');
}

/**
 * @param {string} path
 */
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @param {string} path
 * @param {string} contents
 */
function writeAtomically(path, contents) {
    const temporary = `${path}.${process.pid}.tmp`;

    writeFileSync(temporary, contents);
    renameSync(temporary, path);
}

/**
 * @param {string} url
 * @param {string|undefined} etag
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{status: 'fresh', body: string, etag: string|null}|{status: 'unchanged'}>}
 */
async function getDocument(url, etag, fetchImpl) {
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json', 'User-Agent': `rafflex-dev/${kitVersion}` };

    if (etag) {
        headers['If-None-Match'] = etag;
    }

    const response = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(requestTimeoutMs) });

    if (response.status === 304) {
        return { status: 'unchanged' };
    }

    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }

    const body = await response.text();

    JSON.parse(body);

    return { status: 'fresh', body, etag: response.headers.get('etag') };
}

/**
 * @param {unknown} error
 */
function describeError(error) {
    const cause = /** @type {any} */ (error)?.cause;
    const detail = cause?.code ?? cause?.message;

    return detail ? `${/** @type {Error} */ (error).message} (${detail})` : String(/** @type {Error} */ (error)?.message ?? error);
}

/**
 * @typedef {{url: string, version?: string}} EndpointEntry
 * @typedef {{version?: string, generated_at?: string, endpoints: Record<string, string|EndpointEntry>, versions?: Record<string, string>}} Manifest
 * @typedef {{documents: Record<string, any>, manifest: Manifest|null, warnings: string[], offline: boolean, baseUrl: string, cacheDirectory: string}} LoadedDocuments
 */

/**
 * Load the named documents, refreshing them from the marketplace when
 * possible and falling back to the project cache when not.
 *
 * - The manifest is fetched first (with If-None-Match). When it cannot be
 *   reached, every document comes from the cache with an offline warning.
 * - A document whose manifest version (manifest.versions) matches the cached copy is used
 *   from the cache without a request; otherwise it is fetched with its
 *   ETag, so an unchanged document costs a 304.
 * - A document that cannot be refreshed while the manifest says it changed
 *   is used from the cache with a warning that the cached rules are older
 *   than the marketplace's.
 * - With neither network nor cache, RulesUnavailableError explains what to
 *   do.
 *
 * @param {{projectDirectory: string, baseUrl: string, names?: string[], fetchImpl?: typeof fetch}} options
 * @returns {Promise<LoadedDocuments>}
 */
export async function loadDocuments({ projectDirectory, baseUrl, names = projectDocuments, fetchImpl = globalThis.fetch }) {
    const cacheDirectory = join(projectDirectory, '.rafflex', 'cache', cacheKeyFor(baseUrl));
    const metaPath = join(cacheDirectory, 'meta.json');
    const meta = readJson(metaPath) ?? { documents: {} };
    meta.documents ??= {};
    /** @type {string[]} */
    const warnings = [];
    /** @type {Record<string, any>} */
    const documents = {};
    const cached = (/** @type {string} */ name) => readJson(join(cacheDirectory, `${name}.json`));
    const manifestUrl = `${baseUrl}/dev-kit/manifest.json`;
    /** @type {Manifest|null} */
    let manifest = null;
    let manifestChanged = false;

    try {
        const cachedManifest = cached('manifest');
        const result = await getDocument(manifestUrl, cachedManifest ? meta.manifest_etag : undefined, fetchImpl);

        if (result.status === 'unchanged') {
            manifest = cachedManifest;
        } else {
            manifest = JSON.parse(result.body);
            mkdirSync(cacheDirectory, { recursive: true });
            writeAtomically(join(cacheDirectory, 'manifest.json'), result.body);
            meta.manifest_etag = result.etag;
        }

        manifestChanged = meta.manifest_version !== undefined && meta.manifest_version !== manifest?.version;
    } catch (error) {
        const missing = names.filter((name) => cached(name) === null);

        if (missing.length > 0) {
            throw new RulesUnavailableError(`Could not reach ${baseUrl} (${describeError(error)}) and there is no cached copy of ${missing.map((name) => `${name}.json`).join(', ')}. Connect to the internet and run again. Behind a proxy or with a local certificate authority, set NODE_EXTRA_CA_CERTS.`);
        }

        for (const name of names) {
            documents[name] = cached(name);
        }

        const fetchedAt = meta.fetched_at ? ` from ${meta.fetched_at}` : '';

        warnings.push(`Working offline with the cached rules${fetchedAt}: could not reach ${baseUrl} (${describeError(error)}).`);

        return { documents, manifest: cached('manifest'), warnings, offline: true, baseUrl, cacheDirectory };
    }

    if (typeof manifest?.contract === 'number' && manifest.contract > SupportedContract) {
        throw new RulesUnavailableError(`The marketplace publishes rules contract ${manifest.contract}, newer than this kit understands (${SupportedContract}). Run npx @rafflex/dev@latest to update.`);
    }

    /** @type {string[]} */
    const stale = [];

    for (const name of names) {
        const entry = manifest?.endpoints?.[name];
        const url = typeof entry === 'string' ? entry : entry?.url ?? `${baseUrl}/dev-kit/${name}.json`;
        const expectedVersion = manifest?.versions?.[name] ?? (typeof entry === 'object' ? entry?.version : undefined);
        const cachedDocument = cached(name);
        const cachedMeta = meta.documents[name] ?? {};

        if (cachedDocument !== null && expectedVersion !== undefined && cachedDocument.version === expectedVersion) {
            documents[name] = cachedDocument;
            continue;
        }

        try {
            const result = await getDocument(url, cachedDocument !== null ? cachedMeta.etag : undefined, fetchImpl);

            if (result.status === 'unchanged') {
                documents[name] = cachedDocument;
                continue;
            }

            mkdirSync(cacheDirectory, { recursive: true });
            writeAtomically(join(cacheDirectory, `${name}.json`), result.body);
            documents[name] = JSON.parse(result.body);
            meta.documents[name] = { etag: result.etag, version: documents[name].version ?? null, url };
        } catch (error) {
            if (cachedDocument === null) {
                throw new RulesUnavailableError(`Could not download ${url} (${describeError(error)}) and there is no cached copy. Try again in a moment.`);
            }

            documents[name] = cachedDocument;

            const knownChanged = (expectedVersion !== undefined && cachedDocument.version !== expectedVersion) || manifestChanged;

            if (knownChanged) {
                stale.push(name);
            } else {
                warnings.push(`Could not refresh ${name}.json (${describeError(error)}); using the cached copy.`);
            }
        }
    }

    if (stale.length > 0) {
        warnings.push(`Your cached rules are older than the marketplace's (${stale.map((name) => `${name}.json`).join(', ')} could not be refreshed). Results may differ from the server's check until the kit can download them.`);
    } else {
        meta.manifest_version = manifest?.version;
    }

    meta.fetched_at = new Date().toISOString();
    mkdirSync(cacheDirectory, { recursive: true });
    writeAtomically(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    return { documents, manifest, warnings, offline: false, baseUrl, cacheDirectory };
}
