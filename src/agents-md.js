import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDocuments, readCachedDocuments } from './remote.js';
import { workspaceFilename } from './workspace.js';

/**
 * AGENTS.md is the creator's AI's memory between sessions, generated from
 * the marketplace's `skeletons.workspace.agents_md`. rafflex.json records
 * the sha256 of the copy the kit last wrote (`agents_md_sha256`), so the
 * kit can tell a file it may refresh from one the creator edited.
 */

export const agentsFilename = 'AGENTS.md';

/** How long status waits for the marketplace before using the cache. */
const refreshTimeoutMs = 3000;

/**
 * @typedef {'current'|'updated'|'customised'|'unknown'} AgentsMarkdownState
 */

/**
 * @param {string} text
 */
export function agentsHash(text) {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * The workspace's rafflex.json as written, with any keys the workspace
 * model does not read.
 *
 * @param {string} root
 * @returns {Record<string, any>}
 */
function readWorkspaceJson(root) {
    return JSON.parse(readFileSync(join(root, workspaceFilename), 'utf8'));
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
 * Record the hash of the AGENTS.md the kit wrote.
 *
 * @param {string} root
 * @param {string} hash
 */
function storeHash(root, hash) {
    const config = readWorkspaceJson(root);

    if (config.agents_md_sha256 === hash) {
        return;
    }

    writeAtomically(join(root, workspaceFilename), `${JSON.stringify({ ...config, agents_md_sha256: hash }, null, 2)}\n`);
}

/**
 * The marketplace's current workspace guidance: refreshed when the
 * marketplace answers within a few seconds, else the cached copy, else
 * null.
 *
 * @param {import('./workspace.js').Workspace} workspace
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string|null>}
 */
export async function serverAgentsMarkdown(workspace, fetchImpl = globalThis.fetch) {
    const quickFetch = /** @type {typeof fetch} */ ((url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(refreshTimeoutMs) }));
    let skeletons = null;

    try {
        skeletons = (await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl, names: ['skeletons'], fetchImpl: quickFetch })).documents.skeletons;
    } catch {
        skeletons = readCachedDocuments(workspace.root, workspace.baseUrl, ['skeletons']).documents.skeletons;
    }

    const text = skeletons?.workspace?.agents_md;

    return typeof text === 'string' ? text : null;
}

/**
 * Bring AGENTS.md up to date with the marketplace's guidance when it is
 * still exactly what the kit generated:
 *
 * - `current`: it already matches the marketplace's copy (the stored hash
 *   is brought in line, so later changes refresh it).
 * - `updated`: it was the kit's copy, the marketplace's changed, and it
 *   has been rewritten.
 * - `customised`: the creator edited it (or removed it), so it is left
 *   alone.
 * - `unknown`: the marketplace's copy is not available (offline with no
 *   cache, or a marketplace without workspace guidance).
 *
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string|null} serverText
 * @returns {AgentsMarkdownState}
 */
export function refreshAgentsMarkdown(workspace, serverText) {
    if (serverText === null) {
        return 'unknown';
    }

    const path = join(workspace.root, agentsFilename);

    if (!existsSync(path)) {
        return 'customised';
    }

    const localHash = agentsHash(readFileSync(path, 'utf8'));
    const serverHash = agentsHash(serverText);

    if (localHash === serverHash) {
        storeHash(workspace.root, serverHash);

        return 'current';
    }

    if (readWorkspaceJson(workspace.root).agents_md_sha256 !== localHash) {
        return 'customised';
    }

    writeAtomically(path, serverText);
    storeHash(workspace.root, serverHash);

    return 'updated';
}
