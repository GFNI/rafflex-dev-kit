import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { commandNamed } from '../command-list.js';
import { lastResultTime, normaliseResult, readLastResult, writeAppResult } from './results.js';

/**
 * The app's actions: create a product, test one, and open its folder.
 * Every path is confined to the workspace, and each action runs the same
 * command the AI would, so the app adds no second way of doing things.
 */

const binPath = fileURLToPath(new URL('../../bin/rafflex-dev.js', import.meta.url));

/** The longest a test may run before the app stops it. */
export const testTimeoutMs = 10 * 60 * 1000;

/**
 * Whether `path` resolves (following links) inside `root`.
 *
 * @param {string} root
 * @param {string} path
 */
export function isInside(root, path) {
    let realRoot;
    let realPath;

    try {
        realRoot = realpathSync(root);
        realPath = realpathSync(path);
    } catch {
        return false;
    }

    const inside = relative(realRoot, realPath);

    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * The command a test runs: `verify` (PRD 41), or `check` on a kit without
 * it.
 */
export function testCommand() {
    return commandNamed('verify') !== undefined ? 'verify' : 'check';
}

/**
 * @param {string} directory
 * @param {{platform?: NodeJS.Platform, spawnImpl?: typeof spawn}} [options]
 */
export function openFolder(directory, { platform = process.platform, spawnImpl = spawn } = {}) {
    const [command, args] = platform === 'darwin'
        ? ['open', [directory]]
        : platform === 'win32'
            ? ['explorer', [directory]]
            : ['xdg-open', [directory]];

    try {
        const child = spawnImpl(command, args, { stdio: 'ignore', detached: true });

        child.on('error', () => {});
        child.unref();

        return true;
    } catch {
        return false;
    }
}

/**
 * Create a product with the kit's own `new` command, in process.
 *
 * @param {string} workspaceRoot
 * @param {string} type
 * @param {string} title
 * @returns {Promise<{code: number, output: any}>}
 */
export async function createProduct(workspaceRoot, type, title) {
    const { main } = await import('../cli.js');
    let text = '';
    const stdout = new Writable({
        write(chunk, encoding, callback) {
            text += chunk;
            callback();
        },
    });
    const code = await main(['new', type, title, '--json'], { cwd: workspaceRoot, stdout, stderr: new Writable({ write: (chunk, encoding, callback) => callback() }) });

    try {
        return { code: code ?? 0, output: JSON.parse(text) };
    } catch {
        return { code: 2, output: { error: text.trim() || 'The product could not be created.' } };
    }
}

/**
 * @typedef {{product: string, status: 'running'|'done', line?: string, result?: import('./results.js').TestResult}} TestEvent
 */

/**
 * Runs tests, one at a time per product, and reports progress lines and
 * the result as events.
 *
 * @param {{workspaceRoot: string, onEvent: (event: TestEvent) => void, env?: NodeJS.ProcessEnv, command?: string, spawnImpl?: typeof spawn}} options
 */
export function testRunner({ workspaceRoot, onEvent, env = process.env, command = testCommand(), spawnImpl = spawn }) {
    /** @type {Map<string, {child: import('node:child_process').ChildProcess, lines: string[]}>} */
    const running = new Map();

    return {
        command,
        /**
         * @param {string} productPath
         */
        isRunning: (productPath) => running.has(productPath),
        /**
         * @param {string} productPath
         */
        linesOf: (productPath) => running.get(productPath)?.lines ?? [],
        /**
         * Start a test for a product. Returns false when one is already
         * running for it.
         *
         * @param {{path: string, directory: string}} product
         * @returns {boolean}
         */
        start(product) {
            if (running.has(product.path)) {
                return false;
            }

            const startedAt = new Date();
            const startedMs = Date.now();
            const child = spawnImpl(process.execPath, [binPath, command, product.path, '--json'], {
                cwd: workspaceRoot,
                env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const entry = { child, lines: /** @type {string[]} */ ([]) };
            let stdout = '';
            let partial = '';
            const timer = setTimeout(() => child.kill(), testTimeoutMs);
            const emitLine = (/** @type {string} */ line) => {
                const text = line.trim();

                if (text === '') {
                    return;
                }

                entry.lines.push(text);
                onEvent({ product: product.path, status: 'running', line: text });
            };

            running.set(product.path, entry);
            emitLine(`Running ${command} on ${product.path}`);
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', (chunk) => {
                stdout += chunk;
            });
            child.stderr?.on('data', (chunk) => {
                const lines = `${partial}${chunk}`.split(/\r?\n/);

                partial = lines.pop() ?? '';
                lines.forEach(emitLine);
            });

            const finish = (/** @type {number|null} */ exitCode, /** @type {string|null} */ failure) => {
                if (!running.has(product.path)) {
                    return;
                }

                clearTimeout(timer);
                emitLine(partial);
                running.delete(product.path);

                let output;

                try {
                    output = JSON.parse(stdout);
                } catch {
                    output = { passed: false, error: failure ?? (stdout.trim() || `The ${command} command stopped without a result.`), issues: [] };
                }

                if (lastResultTime(product.directory) < startedMs) {
                    writeAppResult(product.directory, { source: command, at: startedAt.toISOString(), output, exitCode });
                }

                const result = readLastResult(product.directory) ?? normaliseResult(output, { productDirectory: product.directory, at: startedAt.toISOString(), source: command });

                onEvent({ product: product.path, status: 'done', result });
            };

            child.on('error', (error) => finish(null, `Could not start the test: ${error.message}`));
            child.on('close', (code) => finish(code, null));

            return true;
        },
        stopAll() {
            for (const { child } of running.values()) {
                child.kill();
            }

            running.clear();
        },
    };
}
