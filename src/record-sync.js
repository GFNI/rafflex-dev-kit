import { existsSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { normaliseFeedback } from './feedback.js';
import { commitProduct, currentBranch, gitState, lastPushCommit, runGit } from './git.js';
import { isSlug, resolvesInside, slugPattern } from './safe-paths.js';
import { bumpVersion, compareVersions, isVersion } from './semver.js';
import { compareWithRemote, readLocalState, remoteFromProduct } from './sync-state.js';
import { recordSyncTime } from './sync-times.js';
import { formatProductJson, productFilename, writeProductJson } from './workspace.js';

/**
 * Recording a product's marketplace state in product.json, shared by
 * `synced` (a get_product result or a sync link), `push`, and `release`.
 *
 * The commit says what happened. "Push <slug> <version> (draft revision
 * <n>)" is used only when the product folder matches what the marketplace
 * now holds (a push, by the kit or through the tools), so `restore
 * last-push` can trust it; a push where some files did not upload says so
 * ("…, 2 files not uploaded)") and keeps those files out of the commit. A
 * draft changed elsewhere (in the studio) is recorded as "Sync <slug>
 * (draft revision <n>)", and any other change to the recorded state (the
 * draft went into review, a decision, locked media, feedback) commits
 * product.json alone as "Sync <slug> (<what changed>)". Restore skips
 * every Sync. Reading a state that differs only in its sync time writes
 * nothing, so the tree stays clean.
 */

export { slugPattern };

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
    if (!isSlug(payload.slug)) {
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
 * @param {number} [notUploaded] Files a push did not upload.
 */
export function syncCommitMessage(verb, slug, version, draft, notUploaded = 0) {
    const missing = notUploaded > 0 ? `${notUploaded} ${notUploaded === 1 ? 'file' : 'files'} not uploaded` : null;

    if (draft === null || draft.version === null) {
        return `${verb} ${slug} ${version}${missing === null ? '' : ` (${missing})`}`;
    }

    if (verb === 'Sync') {
        return `Sync ${slug}${Number.isInteger(draft.revision) ? ` (draft revision ${draft.revision})` : ` ${draft.version}`}`;
    }

    const details = [Number.isInteger(draft.revision) ? `draft revision ${draft.revision}` : null, missing].filter(Boolean);

    return `Push ${slug} ${draft.version}${details.length === 0 ? '' : ` (${details.join(', ')})`}`;
}

/**
 * What changed in the recorded state when the draft did not, for a
 * "Sync <slug> (…)" subject.
 *
 * @param {Record<string, any>|null} previous
 * @param {Record<string, any>} current
 */
function stateChangeSummary(previous, current) {
    const parts = [];

    if (current.draft?.submitted === true && previous?.draft?.submitted !== true) {
        parts.push('in review');
    }

    const decision = current.latest_review?.decision;

    if (typeof decision === 'string' && decision !== previous?.latest_review?.decision) {
        parts.push(`review ${decision.replaceAll('_', ' ')}`);
    }

    if (current.status !== previous?.status && typeof current.status === 'string') {
        parts.push(current.status);
    }

    if (current.live_version !== previous?.live_version && typeof current.live_version === 'string') {
        parts.push(`live ${current.live_version}`);
    }

    return parts.length === 0 ? 'marketplace state' : parts.join(', ');
}

/**
 * product.json's text without the sync time, to tell a state that only
 * was read again from one that changed.
 *
 * @param {Record<string, any>} manifest
 */
function withoutSyncTime(manifest) {
    const remote = manifest.remote !== null && typeof manifest.remote === 'object' ? { ...manifest.remote, synced_at: null } : manifest.remote;

    return formatProductJson({ ...manifest, remote });
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
 * @property {string|null} renamed_from The path before the rename.
 * @property {boolean} changed     Whether product.json changed beyond the sync time.
 * @property {string[]} notes
 * @property {Record<string, any>} remote
 * @property {string|null} message  The commit subject, or null when nothing was committed.
 * @property {import('./git.js').ProductCommit} git
 */

export class UnsafeSlugError extends Error {}

/**
 * Record a get_product shaped payload as product.json's remote state: the
 * slug the first time (renaming a title named folder to it, and keeping
 * the old path in `previous_paths` so commands still find it), the
 * version to work on, the branch, and the feedback when given (otherwise
 * the last recorded feedback is kept). A state that differs from the
 * recorded one only in its sync time is not written; the time of every
 * successful read goes to `.rafflex/sync-times.json` (outside git), so it
 * still counts as fresh. Then commit:
 *
 * - `kind: "push"`: the product folder as "Push …" (the kit just pushed
 *   it), holding back `notUploaded` files so they still show as changes;
 * - `kind: "auto"`: when the draft revision or version changed, or on the
 *   first sync, the folder as "Push …" when it matches the marketplace and
 *   "Sync … (draft revision n)" when it does not; when only other recorded
 *   state changed, product.json alone as "Sync <slug> (<what changed>)";
 * - `kind: "none"`: never (the caller commits, as release does).
 *
 * Throws UnsafeSlugError, before writing anything, when the payload's
 * slug is not a slug (a folder name must never leave the workspace).
 *
 * @param {object} options
 * @param {import('./workspace.js').Workspace} options.workspace
 * @param {import('./workspace.js').Product} options.product
 * @param {Record<string, any>} options.payload
 * @param {unknown} [options.feedback]   The sync link's feedback; undefined keeps the recorded one.
 * @param {'push'|'auto'|'none'} [options.kind]
 * @param {string|null} [options.previousDirectory] A folder the product was renamed from earlier in the same command.
 * @param {string[]} [options.notUploaded] Paths, relative to the product folder, that a push did not upload.
 * @returns {RecordedState}
 */
export function recordProductState({ workspace, product, payload, feedback, kind = 'auto', previousDirectory = null, notUploaded = [] }) {
    if (!isSlug(payload.slug)) {
        throw new UnsafeSlugError(`The marketplace answered with "${String(payload.slug)}" as the slug, which is not a valid slug, so nothing was recorded. Contact support@rafflex.io.`);
    }

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
    const typeFolder = path.split('/')[0];
    const target = join(workspace.root, typeFolder, payload.slug);
    const renaming = product.slug === null && product.folder !== payload.slug;
    const previousPaths = Array.isArray(product.manifest.previous_paths) ? product.manifest.previous_paths.filter((entry) => typeof entry === 'string') : [];
    const manifest = {
        ...product.manifest,
        slug: payload.slug,
        version,
        remote,
        ...(renaming && !existsSync(target) ? { previous_paths: [...new Set([...previousPaths, product.path])].slice(-5) } : {}),
    };
    const changed = withoutSyncTime(manifest) !== withoutSyncTime(product.manifest);

    if (changed) {
        writeProductJson(directory, manifest);
    }

    if (renaming) {
        if (existsSync(target)) {
            notes.push(`${typeFolder}/${payload.slug} already exists, so ${product.path} keeps its folder name. Move or remove the other folder and rename this one to ${payload.slug}.`);
        } else if (!resolvesInside(join(workspace.root, typeFolder), target)) {
            notes.push(`${product.path} keeps its folder name: ${payload.slug} cannot be a folder name.`);
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

    if (renamed) {
        notes.push(`${product.path} is now ${path}: use ${payload.slug} or ${path} in later commands.`);
    }

    const draft = recorded.draft;
    const previousDraft = previousRemote?.draft ?? null;
    const draftChanged = previousRemote === null
        || (draft?.revision ?? null) !== (previousDraft?.revision ?? null)
        || (draft?.version ?? null) !== (previousDraft?.version ?? null);
    const earlier = renamed ? product.directory : previousDirectory;
    /** @type {string|null} */
    let message = null;
    /** @type {string|string[]} */
    let paths = commitPaths(workspace.root, directory, earlier);
    /** @type {{paths: string[], from: string|null}|undefined} */
    let holdBack;

    if (kind === 'push') {
        message = syncCommitMessage('Push', payload.slug, version, draft, notUploaded.length);

        if (notUploaded.length > 0) {
            holdBack = {
                paths: notUploaded.map((file) => join(directory, file)),
                from: gitState(workspace.root).repository ? lastPushCommit(workspace.root, directory, payload.slug)?.commit ?? null : null,
            };
        }
    } else if (kind === 'auto' && draftChanged) {
        message = syncCommitMessage(matches ? 'Push' : 'Sync', payload.slug, version, draft);
    } else if (kind === 'auto' && (changed || renamed)) {
        message = `Sync ${payload.slug} (${stateChangeSummary(previousRemote, remote)})`;
        paths = renamed ? paths : join(directory, productFilename);
    }

    const git = message === null
        ? { repository: gitState(workspace.root).repository, committed: false, commit: null, tag: null, tag_created: false, tag_existed: false, error: null }
        : commitProduct(workspace.root, paths, message, null, { holdBack });

    if (git.error !== null) {
        notes.push(git.error);
    }

    recordSyncTime(workspace.root, { slug: payload.slug, path }, recorded.synced_at);

    if (version !== product.version) {
        notes.push(`Version ${product.version} -> ${version}${draft === null ? ' (the next minor after the live version)' : ' (the draft\'s version on the marketplace)'}.`);
    }

    return { path, directory, slug: payload.slug, version, renamed, renamed_from: renamed ? product.path : null, changed, notes, remote, message: git.committed ? message : null, git };
}
