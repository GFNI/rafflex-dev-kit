import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readAll } from '../cli.js';
import { commitProduct, currentBranch, gitState } from '../git.js';
import { bumpVersion, compareVersions, isVersion } from '../semver.js';
import { remoteFromProduct, unwrapProductPayload } from '../sync-state.js';
import { loadWorkspace, selectProduct, writeProductJson } from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The version to work on after reading the server: the draft's version
 * when there is a draft, otherwise the next minor after the latest
 * released version when the local one is not already above it.
 *
 * @param {string} current
 * @param {import('../workspace.js').ProductRemote} remote
 * @returns {string}
 */
export function versionAfterSync(current, remote) {
    if (typeof remote.draft?.version === 'string' && remote.draft.version !== '') {
        return remote.draft.version;
    }

    const live = remote.live_version;

    if (typeof live !== 'string' || !isVersion(live)) {
        return current;
    }

    if (isVersion(current) && compareVersions(current, live) > 0) {
        return current;
    }

    return bumpVersion(live, 'minor');
}

/**
 * `synced <product>`: read a get_product result on standard input (the
 * structured content, an MCP tool result, or an export bundle) and record
 * it as product.json's `remote` block. Also records the slug the first
 * time (renaming a title named folder to the slug), and adopts the
 * server's draft version. Refuses a result for a different product.
 *
 * After a push (a draft revision or version the last sync did not have,
 * or the first sync) it commits the product folder, and only it, as
 * "Push <slug> <version> (draft revision <n>)". The branch is recorded so
 * status can warn when the workspace moves to another one.
 *
 * JSON: `{product, previous_product, slug, version, previous_version, renamed, notes, remote, git}`.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runSyncedCommand(context) {
    const { cwd, stdout, stderr, stdin, options } = context;
    let workspace;
    let product;

    try {
        workspace = loadWorkspace(cwd);
        product = selectProduct(workspace, options.positionals[0], cwd);
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    const input = await readAll(stdin);
    /** @type {unknown} */
    let parsed;

    try {
        parsed = JSON.parse(input);
    } catch {
        return fail(context, input.trim() === ''
            ? `Pipe the get_product result for ${product.title} to this command, for example: echo '<the result JSON>' | npx @rafflex/dev synced ${product.slug ?? product.path}`
            : 'Standard input is not JSON. Pipe the get_product result exactly as the tool returned it.', 2);
    }

    const payload = unwrapProductPayload(parsed);

    if (payload === null) {
        return fail(context, 'Standard input is not a get_product result (it has no slug and type). Pipe the tool\'s structured result.', 2);
    }

    if (!slugPattern.test(payload.slug)) {
        return fail(context, `The get_product result has an invalid slug "${payload.slug}".`, 2);
    }

    if (payload.type !== product.type) {
        return fail(context, `That get_product result is for a ${payload.type} (${payload.slug}), but ${product.path} is a ${product.type}. Read the right product.`, 1);
    }

    if (product.slug !== null && product.slug !== payload.slug) {
        return fail(context, `That get_product result is for ${payload.slug}, but ${product.path} is ${product.slug}. Read the right product, or name it: npx @rafflex/dev synced ${payload.slug}`, 1);
    }

    const remote = remoteFromProduct(payload);
    const version = versionAfterSync(product.version, remote);
    let directory = product.directory;
    let path = product.path;
    let renamed = false;
    /** @type {string[]} */
    const notes = [];

    const branch = currentBranch(workspace.root);

    writeProductJson(directory, { ...product.manifest, slug: payload.slug, version, remote: { ...remote, branch } });

    if (product.slug === null && product.folder !== payload.slug) {
        const typeFolder = path.split('/')[0];
        const target = join(workspace.root, typeFolder, payload.slug);

        if (existsSync(target)) {
            notes.push(`${typeFolder}/${payload.slug} already exists, so ${product.path} keeps its folder name. Move or remove the other folder and rename this one to ${payload.slug}.`);
        } else {
            try {
                renameSync(directory, target);
                directory = target;
                path = `${typeFolder}/${payload.slug}`;
                renamed = true;
            } catch (error) {
                notes.push(`Could not rename ${product.path} to ${typeFolder}/${payload.slug}: ${messageOf(error)}`);
            }
        }
    }

    const draft = remote.draft;
    const message = draft === null || draft.version === null
        ? `Push ${payload.slug} ${version}`
        : `Push ${payload.slug} ${draft.version}${Number.isInteger(draft.revision) ? ` (draft revision ${draft.revision})` : ''}`;
    const previousDraft = product.manifest.remote?.draft ?? null;
    const pushed = product.manifest.remote === null
        || (draft?.revision ?? null) !== (previousDraft?.revision ?? null)
        || (draft?.version ?? null) !== (previousDraft?.version ?? null);
    const git = pushed
        ? commitProduct(workspace.root, renamed ? [product.directory, directory] : directory, message)
        : { repository: gitState(workspace.root).repository, committed: false, commit: null, tag: null, tag_created: false, tag_existed: false, error: null };

    if (git.error !== null) {
        notes.push(git.error);
    }

    if (version !== product.version) {
        notes.push(`Version ${product.version} -> ${version}${remote.draft === null ? ' (the next minor after the live version)' : ' (the draft\'s version on the marketplace)'}.`);
    }

    if (options.json) {
        writeJson(stdout, { product: path, previous_product: product.path, slug: payload.slug, version, previous_version: product.version, renamed, notes, remote: { ...remote, branch }, git });

        return 0;
    }

    const parts = [remote.status ?? 'unknown status', `live ${remote.live_version ?? 'none'}`];

    if (draft !== null) {
        parts.push(`draft ${draft.version ?? '?'} r${draft.revision ?? '?'}${draft.submitted ? ' in review' : ''}`);
    }

    if (typeof remote.latest_review?.decision === 'string') {
        parts.push(`review ${remote.latest_review.decision}`);
    }

    stdout.write(`${path}: recorded the marketplace state (${parts.join(', ')}).${renamed ? ` Renamed from ${product.path}.` : ''}\n${git.committed ? `Committed "${message}".\n` : ''}Run npx @rafflex/dev plan ${payload.slug} to see what is left to push.\n`);

    for (const note of notes) {
        stderr.write(`note: ${note}\n`);
    }

    return 0;
}
