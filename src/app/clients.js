import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Which AI apps are on this computer, so Home offers the right connect
 * command. Only by looking for a known command on the PATH or a known
 * application folder: nothing is run, and nothing is read from those
 * apps' settings. Keys match the clients in the marketplace's
 * prompts.json.
 *
 * @type {Record<string, {commands: string[], apps: Partial<Record<NodeJS.Platform, string[]>>}>}
 */
export const clientSignatures = {
    'claude-code': { commands: ['claude'], apps: {} },
    codex: { commands: ['codex'], apps: { darwin: ['/Applications/Codex.app', '~/Applications/Codex.app'] } },
    cursor: {
        commands: ['cursor'],
        apps: {
            darwin: ['/Applications/Cursor.app', '~/Applications/Cursor.app'],
            win32: ['%LOCALAPPDATA%/Programs/cursor/Cursor.exe'],
        },
    },
    vscode: {
        commands: ['code'],
        apps: {
            darwin: ['/Applications/Visual Studio Code.app', '~/Applications/Visual Studio Code.app'],
            win32: ['%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe'],
        },
    },
};

/**
 * @typedef {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string, exists?: (path: string) => boolean}} DetectionOptions
 */

/**
 * Whether a command is on the PATH, without running it.
 *
 * @param {string} command
 * @param {DetectionOptions} [options]
 */
export function commandOnPath(command, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
    const directories = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter((directory) => directory !== '');
    const extensions = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((extension) => extension.toLowerCase())] : [''];

    return directories.some((directory) => extensions.some((extension) => exists(join(directory, `${command}${extension}`))));
}

/**
 * @param {string} path
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function expandPath(path, env, home) {
    return path
        .replace(/^~(?=\/)/, home)
        .replace(/%([A-Z_]+)%/g, (match, name) => env[name] ?? match);
}

/**
 * The keys of the AI apps found on this computer.
 *
 * @param {DetectionOptions} [options]
 * @returns {string[]}
 */
export function detectClients({ env = process.env, platform = process.platform, home = homedir(), exists = existsSync } = {}) {
    return Object.entries(clientSignatures)
        .filter(([, signature]) => signature.commands.some((command) => commandOnPath(command, { env, platform, exists }))
            || (signature.apps[platform] ?? []).some((path) => {
                const expanded = expandPath(path, env, home);

                return !expanded.includes('%') && exists(expanded);
            }))
        .map(([key]) => key);
}
