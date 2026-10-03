import { spawnSync } from 'node:child_process';

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
 * @returns {{ok: boolean, stdout: string, stderr: string, missing: boolean}}
 */
export function runGit(directory, args) {
    const result = spawnSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: gitTimeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
