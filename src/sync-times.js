import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * When each product last read the marketplace successfully, kept in the
 * workspace's ignored `.rafflex/` folder rather than in product.json. A
 * sync that finds nothing changed does not rewrite product.json (so the
 * git tree stays clean), but it still counts as a fresh read: staleness
 * uses the newer of this time and product.json's `remote.synced_at`. A
 * fresh clone has no `.rafflex/`, and falls back to product.json.
 *
 * Keyed by slug when the product has one (a folder renamed to its slug
 * still matches), else by its path.
 */

const syncTimesFilename = 'sync-times.json';

/**
 * @param {string} root
 */
function syncTimesPath(root) {
    return join(root, '.rafflex', syncTimesFilename);
}

/**
 * @param {{slug: string|null, path: string}} product
 */
export function syncTimeKey(product) {
    return product.slug === null ? `path:${product.path}` : `slug:${product.slug}`;
}

/**
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function readSyncTimes(root) {
    try {
        const data = JSON.parse(readFileSync(syncTimesPath(root), 'utf8'));

        return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

/**
 * Record a successful read of the marketplace for a product. Never fails
 * the command: without a writable `.rafflex/` product.json's time applies.
 *
 * @param {string} root
 * @param {{slug: string|null, path: string}} product
 * @param {string} [at]
 */
export function recordSyncTime(root, product, at = new Date().toISOString()) {
    try {
        const times = { ...readSyncTimes(root), [syncTimeKey(product)]: at };
        const path = syncTimesPath(root);
        const temporary = `${path}.${process.pid}.tmp`;

        mkdirSync(join(root, '.rafflex'), { recursive: true });
        writeFileSync(temporary, `${JSON.stringify(times, null, 2)}\n`);
        renameSync(temporary, path);
    } catch {
        // product.json's synced_at still applies.
    }
}

/**
 * The newer of two ISO times, either of which may be missing.
 *
 * @param {unknown} first
 * @param {unknown} second
 * @returns {string|null}
 */
export function newerTime(first, second) {
    const times = [first, second].filter((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)));

    if (times.length === 0) {
        return typeof first === 'string' ? first : null;
    }

    return /** @type {string} */ (times.reduce((newest, value) => (Date.parse(String(value)) > Date.parse(String(newest)) ? value : newest)));
}
