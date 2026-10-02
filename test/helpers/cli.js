import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './project.js';

const bin = fileURLToPath(new URL('../../bin/rafflex-dev.js', import.meta.url));
const gitHome = temporaryDirectory('rafflex-dev-git-');
const gitConfig = join(gitHome, 'gitconfig');

writeFileSync(gitConfig, '[user]\n\tname = Kit Test\n\temail = kit@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');

/**
 * Git isolated from the machine's configuration, with a known identity.
 */
export const isolatedGitEnv = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };

/**
 * Run the kit's binary.
 *
 * @param {string[]} args
 * @param {{cwd: string, baseUrl?: string, env?: Record<string, string>, input?: string}} options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function run(args, { cwd, baseUrl, env = {}, input }) {
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...isolatedGitEnv, RAFFLEX_BASE_URL: baseUrl ?? 'http://127.0.0.1:9', ...env } }, (error, stdout, stderr) => {
            resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
        });

        child.stdin?.end(input ?? '');
    });
}

/**
 * Run the kit with --json and parse the output.
 *
 * @param {string[]} args
 * @param {{cwd: string, baseUrl?: string, env?: Record<string, string>}} options
 */
export async function runJson(args, options) {
    const result = await run([...args, '--json'], options);
    let output;

    try {
        output = JSON.parse(result.stdout);
    } catch {
        throw new Error(`Not JSON (exit ${result.code}): ${result.stdout}\n${result.stderr}`);
    }

    return { ...result, output };
}
