import { existsSync, readdirSync } from 'node:fs';
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

/**
 * How the kit tells that an app can open a prompt from a link, and that its
 * CLI can start with one, keyed as prompts.json lists its `openers`. Only
 * by looking for files: Claude Code registers its `claude-cli://` handler
 * on the first prompt of an interactive session (a user level app on macOS,
 * a desktop entry on Linux, the registry on Windows, which the kit cannot
 * read without running something, so the CLI on the PATH stands in there).
 * An opener the kit does not know is never offered as a link.
 *
 * @type {Record<string, {handler: (options: Required<DetectionOptions> & {readdir: (path: string) => string[]}) => boolean, command?: string}>}
 */
export const openerSignatures = {
    'claude-code': {
        command: 'claude',
        handler: ({ env, platform, home, exists }) => {
            if (platform === 'darwin') {
                return exists(join(home, 'Applications', 'Claude Code URL Handler.app'));
            }

            if (platform === 'win32') {
                return commandOnPath('claude', { env, platform, exists });
            }

            return exists(join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'applications', 'claude-code-url-handler.desktop'));
        },
    },
    'claude-code-vscode': {
        handler: ({ home, readdir }) => readdir(join(home, '.vscode', 'extensions')).some((name) => name.startsWith('anthropic.claude-code-')),
    },
    codex: {
        command: 'codex',
        handler: ({ platform, home, exists }) => platform === 'darwin'
            && ['ChatGPT.app', 'Codex.app'].some((app) => exists(join('/Applications', app)) || exists(join(home, 'Applications', app))),
    },
    cursor: {
        handler: ({ env, platform, home, exists }) => commandOnPath('cursor', { env, platform, exists })
            || (clientSignatures.cursor.apps[platform] ?? []).some((path) => {
                const expanded = expandPath(path, env, home);

                return !expanded.includes('%') && exists(expanded);
            }),
    },
};

/**
 * @param {string} path
 * @returns {string[]}
 */
function listDirectory(path) {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
}

/**
 * The marketplace's openers, each marked with whether its link and its
 * terminal command work on this computer.
 *
 * @template {{key: string}} T
 * @param {T[]} openers
 * @param {DetectionOptions & {readdir?: (path: string) => string[]}} [options]
 * @returns {(T & {link_ready: boolean, command_ready: boolean})[]}
 */
export function detectOpeners(openers, { env = process.env, platform = process.platform, home = homedir(), exists = existsSync, readdir = listDirectory } = {}) {
    return openers.map((opener) => {
        const signature = openerSignatures[opener.key];

        if (signature === undefined) {
            return { ...opener, link_ready: false, command_ready: false };
        }

        return {
            ...opener,
            link_ready: signature.handler({ env, platform, home, exists, readdir }),
            command_ready: signature.command !== undefined && commandOnPath(signature.command, { env, platform, exists }),
        };
    });
}
