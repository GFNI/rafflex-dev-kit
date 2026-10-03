import { existsSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { normaliseFeedback } from './feedback.js';
import { commitProduct, currentBranch, gitState, runGit } from './git.js';
import { bumpVersion, compareVersions, isVersion } from './semver.js';
import { compareWithRemote, readLocalState, remoteFromProduct } from './sync-state.js';
import { writeProductJson } from './workspace.js';

/**
 * Recording a product's marketplace state in product.json, shared by
 * `synced` (a get_product result or a sync link), `push`, and `release`.
 *
 * The commit says what happened. "Push <slug> <version> (draft revision
 * <n>)" is used only when the product folder matches what the marketplace
 * now holds (a push, by the kit or through the tools), so `restore
 * last-push` can trust it. A draft changed elsewhere (in the studio) is
 * recorded as "Sync <slug> (draft revision <n>)", which restore skips.
 */

export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The version to work on after reading the server: the draft's version
 * when there is a draft, otherwise the next minor after the latest
 * released version when the local one is not already above it.
 *
 * @param {string} current
 * @param {import('./workspace.js').ProductRemote} remote
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
 * Why a product payload cannot be recorded for this product folder, or
 * null when it can.
 *
 * @param {import('./workspace.js').Product} product
 * @param {Record<string, any>} payload
 * @param {string} source What the payload is, for the message ("That get_product result", "That link").
 * @returns {{message: string, exitCode: number}|null}
 */
export function payloadMismatch(product, payload, source) {
    if (!slugPattern.test(payload.slug)) {
        return { message: `${source} has an invalid slug "${payload.slug}".`, exitCode: 2 };
    }

    if (payload.type !== product.type) {
        return { message: `${source} is for a ${payload.type} (${payload.slug}), but ${product.path} is a ${product.type}. Use the right product.`, exitCode: 1 };
    }

    if (product.slug !== null && product.slug !== payload.slug) {
        return { message: `${source} is for ${payload.slug}, but ${product.path} is ${product.slug}. Use the right product, or name it: ${payload.slug}.`, exitCode: 1 };
    }

    return null;
}

/**
 * The commit subject for a recorded state.
 *
 * @param {'Push'|'Sync'} verb
 * @param {string} slug
 * @param {string} version
 * @param {import('./workspace.js').ProductRemote['draft']} draft
 */
export function syncCommitMessage(verb, slug, version, draft) {
    if (draft === null || draft.version === null) {
        return `${verb} ${slug} ${version}`;
    }

    if (verb === 'Sync') {
        return `Sync ${slug}${Number.isInteger(draft.revision) ? ` (draft revision ${draft.revision})` : ` ${draft.version}`}`;
    }

    return `Push ${slug} ${draft.version}${Number.isInteger(draft.revision) ? ` (draft revision ${draft.revision})` : ''}`;
}

/**
 * Whether the product folder's template and options are what the remote
 * state now holds (its draft, or the live version without one).
 *
 * @param {import('./workspace.js').Product} product
 * @param {import('./workspace.js').ProductRemote} remote
 */
export function folderMatchesRemote(product, remote) {
    try {
        const changes = compareWithRemote(readLocalState(product, null), remote);

        return !changes.template && !changes.options;
    } catch {
        return false;
    }
}

/**
 * The paths to stage for a commit: the product folder, and its old folder
 * after a rename when git tracks it (so the move is one commit).
 *
 * @param {string} root
 * @param {string} directory
 * @param {string|null} previous
 * @returns {string|string[]}
 */
function commitPaths(root, directory, previous) {
    if (previous === null || previous === directory) {
        return directory;
    }

    const tracked = runGit(root, ['ls-files', '--', relative(root, previous) || '.']);

    return tracked.ok && tracked.stdout.trim() !== '' ? [previous, directory] : directory;
}

/**
 * @typedef {object} RecordedState
 * @property {string} path         The product's path after a rename.
 * @property {string} directory
 * @property {string} slug
 * @property {string} version
 * @property {boolean} renamed
 * @property {string[]} notes
 * @property {Record<string, any>} remote
 * @property {string|null} message  The commit subject, or null when nothing was committed.
 * @property {import('./git.js').ProductCommit} git
 */

/**
 * Record a get_product shaped payload as product.json's remote state: the
 * slug the first time (renaming a title named folder to it), the version
 * to work on, the branch, and the feedback when given (otherwise the last
 * recorded feedback is kept). Then commit the product folder:
 *
 * - `kind: "push"`: always, as "Push …" (the kit just pushed it);
 * - `kind: "auto"`: when the draft revision or version changed, or on the
 *   first sync, as "Push …" when the folder matches the marketplace and
 *   "Sync …" when it does not;
 * - `kind: "none"`: never (the caller commits, as release does).
 *
 * @param {object} options
 * @param {import('./workspace.js').Workspace} options.workspace
 * @param {import('./workspace.js').Product} options.product
 * @param {Record<string, any>} options.payload
 * @param {unknown} [options.feedback]   The sync link's feedback; undefined keeps the recorded one.
 * @param {'push'|'auto'|'none'} [options.kind]
 * @param {string|null} [options.previousDirectory] A folder the product was renamed from earlier in the same command.
 * @returns {RecordedState}
 */
export function recordProductState({ workspace, product, payload, feedback, kind = 'auto', previousDirectory = null }) {
    const recorded = remoteFromProduct(payload);
    const previousRemote = /** @type {any} */ (product.manifest.remote);
    const keptFeedback = feedback === undefined ? (previousRemote?.feedback ?? null) : normaliseFeedback(feedback);
    const branch = currentBranch(workspace.root);
    const remote = { ...recorded, ...(keptFeedback === null ? {} : { feedback: keptFeedback }), branch };
    const version = versionAfterSync(product.version, remote);
    let directory = product.directory;
    let path = product.path;
    let renamed = false;
    /** @type {string[]} */
    const notes = [];
    const matches = kind === 'auto' && folderMatchesRemote(product, remote);

    writeProductJson(directory, { ...product.manifest, slug: payload.slug, version, remote });

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
                notes.push(`Could not rename ${product.path} to ${typeFolder}/${payload.slug}: ${/** @type {Error} */ (error).message}`);
            }
        }
    }

    const draft = recorded.draft;
    const previousDraft = previousRemote?.draft ?? null;
    const changed = previousRemote === null
        || (draft?.revision ?? null) !== (previousDraft?.revision ?? null)
        || (draft?.version ?? null) !== (previousDraft?.version ?? null);
    const commit = kind === 'push' || (kind === 'auto' && changed);
    const message = commit ? syncCommitMessage(kind === 'push' || matches ? 'Push' : 'Sync', payload.slug, version, draft) : null;
    const earlier = renamed ? product.directory : previousDirectory;
    const git = message === null
        ? { repository: gitState(workspace.root).repository, committed: false, commit: null, tag: null, tag_created: false, tag_existed: false, error: null }
        : commitProduct(workspace.root, commitPaths(workspace.root, directory, earlier), message);

    if (git.error !== null) {
        notes.push(git.error);
    }

    if (version !== product.version) {
        notes.push(`Version ${product.version} -> ${version}${draft === null ? ' (the next minor after the live version)' : ' (the draft\'s version on the marketplace)'}.`);
    }

    return { path, directory, slug: payload.slug, version, renamed, notes, remote, message: git.committed ? message : null, git };
}
