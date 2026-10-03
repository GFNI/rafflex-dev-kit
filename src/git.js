import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Git is the workspace's history and rollback when it is installed. The
 * kit works without it and never asks for credentials or pushes.
 */

const gitTimeoutMs = 30000;

/**
 * Run git in a folder, never interactively.
 *
 * @param {string} directory
 * @param {string[]} args
 * @param {Record<string, string>} [env] Extra environment, such as a temporary index.
 * @returns {{ok: boolean, stdout: string, stderr: string, missing: boolean}}
 */
export function runGit(directory, args, env = {}) {
    const result = spawnSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: gitTimeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    const missing = /** @type {NodeJS.ErrnoException|undefined} */ (result.error)?.code === 'ENOENT';

    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim() || (result.error?.message ?? ''), missing };
}

/**
 * @param {string} directory
 */
export function isGitInstalled(directory) {
    return !runGit(directory, ['--version']).missing;
}

/**
 * Whether `directory` is inside a git work tree.
 *
 * @param {string} directory
 */
export function isInsideRepository(directory) {
    const result = runGit(directory, ['rev-parse', '--is-inside-work-tree']);

    return result.ok && result.stdout.trim() === 'true';
}

/**
 * The git state of a folder, for status output.
 *
 * @param {string} directory
 * @returns {{installed: boolean, repository: boolean}}
 */
export function gitState(directory) {
    const installed = isGitInstalled(directory);

    return { installed, repository: installed && isInsideRepository(directory) };
}

/**
 * Stage everything and commit. Fails (without changing the user's git
 * configuration) when git has no identity or the commit is refused.
 *
 * @param {string} directory
 * @param {string} message
 * @returns {{ok: boolean, error?: string}}
 */
export function commitAll(directory, message) {
    const added = runGit(directory, ['add', '-A']);

    if (!added.ok) {
        return { ok: false, error: added.stderr };
    }

    const committed = runGit(directory, ['commit', '-q', '-m', message]);

    return committed.ok ? { ok: true } : { ok: false, error: committed.stderr };
}

/**
 * What the workspace never commits: the kit's cache and every product's
 * test output (PRD 41).
 */
export const ignoredEntries = Object.freeze([
    { pattern: '.rafflex/', comment: "# The Rafflex dev kit's rules and Playwright cache", matches: /^\/?\.rafflex\/?$/ },
    { pattern: '.results/', comment: "# Each product's browser test output (screenshots, last run)", matches: /^\/?(?:\*\*\/)?\.results\/?$/ },
]);

/**
 * Make sure the workspace .gitignore ignores the cache and test output,
 * creating it or appending only what is missing.
 *
 * @param {string} root
 * @returns {{created: boolean, added: string[]}}
 */
export function ensureIgnored(root) {
    const path = join(root, '.gitignore');
    const exists = existsSync(path);
    const current = exists ? readFileSync(path, 'utf8') : '';
    const lines = current.split(/\r?\n/).map((line) => line.trim());
    const missing = ignoredEntries.filter((entry) => !lines.some((line) => entry.matches.test(line)));

    if (missing.length === 0) {
        return { created: false, added: [] };
    }

    const block = missing.map((entry) => `${entry.comment}\n${entry.pattern}\n`).join('');

    writeFileSync(path, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${exists && current !== '' ? '\n' : ''}${block}`);

    return { created: !exists, added: missing.map((entry) => entry.pattern) };
}

/**
 * The branch the workspace is on, or null (no git, detached HEAD).
 *
 * @param {string} directory
 * @returns {string|null}
 */
export function currentBranch(directory) {
    const result = runGit(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

    return result.ok ? result.stdout.trim() || null : null;
}

/**
 * @typedef {{repository: boolean, committed: boolean, commit: string|null, tag: string|null, tag_created: boolean, tag_existed: boolean, error: string|null}} ProductCommit
 */

/**
 * Commit only one product's folder (other work in the workspace stays out
 * of the commit), and optionally tag it. Nothing to commit is not an
 * error. An existing tag is never moved.
 *
 * `holdBack` names files inside the folder that must not be committed as
 * they are now (files a push did not upload): the commit keeps them as
 * they were at `from` (the previous push), or leaves them out when `from`
 * did not have them, so they still show as changes afterwards.
 *
 * @param {string} root
 * @param {string|string[]} directory The product folder, or its old and new folders after a rename.
 * @param {string} message
 * @param {string|null} [tag]
 * @param {{holdBack?: {paths: string[], from: string|null}}} [options]
 * @returns {ProductCommit}
 */
export function commitProduct(root, directory, message, tag = null, { holdBack } = {}) {
    const paths = Array.isArray(directory) ? directory : [directory];
    /** @type {ProductCommit} */
    const result = { repository: false, committed: false, commit: null, tag, tag_created: false, tag_existed: false, error: null };

    if (!gitState(root).repository) {
        return result;
    }

    result.repository = true;

    if (holdBack !== undefined && holdBack.paths.length > 0) {
        const held = commitHoldingBack(root, paths, message, holdBack);

        if (held.error !== null) {
            result.error = held.error;

            return result;
        }

        result.committed = held.committed;
        result.commit = runGit(root, ['rev-parse', 'HEAD']).stdout.trim() || null;

        return result;
    }

    const added = runGit(root, ['add', '-A', '--', ...paths]);

    if (!added.ok) {
        result.error = `git add failed: ${added.stderr}`;

        return result;
    }

    const pending = runGit(root, ['diff', '--cached', '--quiet', '--', ...paths]);

    if (pending.ok) {
        result.commit = runGit(root, ['rev-parse', 'HEAD']).stdout.trim() || null;
    } else {
        const committed = runGit(root, ['commit', '-q', '-m', message, '--', ...paths]);

        if (!committed.ok) {
            result.error = `git commit failed: ${committed.stderr}`;

            return result;
        }

        result.committed = true;
        result.commit = runGit(root, ['rev-parse', 'HEAD']).stdout.trim() || null;
    }

    if (tag === null || result.commit === null) {
        return result;
    }

    if (runGit(root, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok) {
        result.tag_existed = true;

        return result;
    }

    const tagged = runGit(root, ['tag', tag]);

    if (!tagged.ok) {
        result.error = `git tag failed: ${tagged.stderr}`;

        return result;
    }

    result.tag_created = true;

    return result;
}

/**
 * Commit `paths` as they are on disk, except the held back files, which
 * keep their version at `from` (or are left out). Built in a temporary
 * index from HEAD, so nothing else the creator staged is swept in; the
 * real index is then reset for `paths`, leaving the held back files as
 * unstaged changes.
 *
 * @param {string} root
 * @param {string[]} paths
 * @param {string} message
 * @param {{paths: string[], from: string|null}} holdBack
 * @returns {{committed: boolean, error: string|null}}
 */
function commitHoldingBack(root, paths, message, holdBack) {
    const indexPath = runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', `rafflex-index-${process.pid}`]).stdout.trim();
    const env = { GIT_INDEX_FILE: indexPath };
    const head = runGit(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).stdout.trim() || null;

    try {
        const steps = [
            head === null ? ['read-tree', '--empty'] : ['read-tree', head],
            ['add', '-A', '--', ...paths],
        ];

        for (const args of steps) {
            const step = runGit(root, args, env);

            if (!step.ok) {
                return { committed: false, error: `git ${args[0]} failed: ${step.stderr}` };
            }
        }

        for (const path of holdBack.paths) {
            const file = relative(root, path).split('\\').join('/');
            const entry = holdBack.from === null ? '' : runGit(root, ['ls-tree', holdBack.from, '--', file]).stdout.trim();
            const match = entry.match(/^(\d+) blob ([0-9a-f]+)\t/);
            const step = match === null
                ? runGit(root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', file], env)
                : runGit(root, ['update-index', '--add', '--cacheinfo', `${match[1]},${match[2]},${file}`], env);

            if (!step.ok) {
                return { committed: false, error: `git could not hold back ${file}: ${step.stderr}` };
            }
        }

        const tree = runGit(root, ['write-tree'], env).stdout.trim();

        if (tree === '' || (head !== null && runGit(root, ['rev-parse', `${head}^{tree}`]).stdout.trim() === tree)) {
            return { committed: false, error: tree === '' ? 'git write-tree failed.' : null };
        }

        const commit = runGit(root, ['commit-tree', tree, ...(head === null ? [] : ['-p', head]), '-m', message]);

        if (!commit.ok) {
            return { committed: false, error: `git commit failed: ${commit.stderr}` };
        }

        const moved = runGit(root, ['update-ref', '-m', `commit: ${message}`, 'HEAD', commit.stdout.trim(), ...(head === null ? [] : [head])]);

        if (!moved.ok) {
            return { committed: false, error: `git commit failed: ${moved.stderr}` };
        }

        runGit(root, ['reset', '-q', '--', ...paths]);

        return { committed: true, error: null };
    } finally {
        rmSync(indexPath, { force: true });
    }
}

/**
 * The newest commit whose product folder matches the marketplace: the
 * kit's own Push, Release, Import, and Revert commits for that product.
 *
 * @param {string} root
 * @param {string} directory
 * @param {string} name The product's slug (or folder name).
 * @returns {{commit: string, subject: string}|null}
 */
export function lastPushCommit(root, directory, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const log = runGit(root, ['log', '--format=%H%x09%s', '-E', `--grep=^(Push|Release|Import|Revert) ${escaped}( |$)`, '--', relative(root, directory) || '.']);

    if (!log.ok) {
        return null;
    }

    const first = log.stdout.split('\n').find((line) => line.includes('\t'));

    if (first === undefined) {
        return null;
    }

    const [commit, subject] = first.split('\t');

    return { commit, subject };
}

/**
 * Return a product folder to a commit: tracked files as they were, files
 * added since removed, with tests/ and ignored output left alone.
 *
 * @param {string} root
 * @param {string} directory
 * @param {string} commit
 * @returns {{ok: boolean, error?: string}}
 */
export function restoreProductFolder(root, directory, commit) {
    const path = relative(root, directory) || '.';
    const keep = `:(exclude)${path}/tests`;
    const restored = runGit(root, ['restore', `--source=${commit}`, '--staged', '--worktree', '--', path, keep]);

    if (!restored.ok) {
        return { ok: false, error: `git restore failed: ${restored.stderr}` };
    }

    const cleaned = runGit(root, ['clean', '-fdq', '--', path, keep]);

    return cleaned.ok ? { ok: true } : { ok: false, error: `git clean failed: ${cleaned.stderr}` };
}

/**
 * The product folder's changes since a commit (tracked and untracked),
 * outside tests/, as "M template.twig" style lines.
 *
 * @param {string} root
 * @param {string} directory
 * @param {string} commit
 * @returns {string[]}
 */
export function changesSince(root, directory, commit) {
    const path = relative(root, directory) || '.';
    const keep = `:(exclude)${path}/tests`;
    const tracked = runGit(root, ['diff', '--relative', '--name-status', commit, '--', path, keep]).stdout.split('\n').filter(Boolean);
    const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '--', path, keep]).stdout.split('\n').filter(Boolean).map((file) => `A\t${file}`);

    return [...tracked, ...untracked].map((line) => {
        const [status, file] = line.split('\t');

        return `${status} ${relative(path, file).split('\\').join('/')}`;
    });
}
