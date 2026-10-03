import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Playwright is optional (PRD 41): browser tests need it, nothing else
 * does. It is offered once, with one command, and installed with its
 * Chromium into the workspace's own kit cache (.rafflex/playwright), so
 * nothing lands outside the workspace and the version is pinned with the
 * kit.
 */

export const playwrightVersion = '1.63.0';

export const installCommand = 'npx @rafflex/dev test --install';

/**
 * @param {string} workspaceRoot
 */
export function playwrightCacheDirectory(workspaceRoot) {
    return join(workspaceRoot, '.rafflex', 'playwright');
}

/**
 * @param {string} workspaceRoot
 */
function browsersDirectory(workspaceRoot) {
    return join(playwrightCacheDirectory(workspaceRoot), 'browsers');
}

/**
 * @typedef {{chromium: any, source: 'workspace'|'kit'}} LoadedPlaywright
 */

/**
 * Playwright from the workspace cache, else one the kit can resolve (a
 * development checkout). Null when neither exists or RAFFLEX_NO_PLAYWRIGHT
 * is set.
 *
 * @param {string} workspaceRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<LoadedPlaywright|null>}
 */
export async function loadPlaywright(workspaceRoot, env = process.env) {
    if (env.RAFFLEX_NO_PLAYWRIGHT === '1') {
        return null;
    }

    const cache = playwrightCacheDirectory(workspaceRoot);

    if (existsSync(join(cache, 'node_modules', 'playwright-core'))) {
        try {
            const resolved = createRequire(join(cache, 'package.json')).resolve('playwright-core');

            if (existsSync(browsersDirectory(workspaceRoot))) {
                process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDirectory(workspaceRoot);
            }

            const module = await import(pathToFileURL(resolved).href);

            return { chromium: (module.default ?? module).chromium, source: 'workspace' };
        } catch {
            // Fall through to a Playwright the kit can resolve.
        }
    }

    try {
        const module = await import('playwright-core');

        return { chromium: (module.default ?? module).chromium, source: 'kit' };
    } catch {
        return null;
    }
}

/**
 * Launch headless Chromium, or explain why it cannot start.
 *
 * @param {LoadedPlaywright} playwright
 * @returns {Promise<{browser: any, error: null}|{browser: null, error: string}>}
 */
export async function launchChromium(playwright) {
    try {
        return { browser: await playwright.chromium.launch({ headless: true }), error: null };
    } catch (error) {
        return { browser: null, error: String(/** @type {Error} */ (error).message).split('\n')[0] };
    }
}

/**
 * The commands `test --install` runs, in order.
 *
 * @param {string} workspaceRoot
 * @returns {{command: string, args: string[], env: Record<string, string>}[]}
 */
export function installSteps(workspaceRoot) {
    const cache = playwrightCacheDirectory(workspaceRoot);

    return [
        { command: 'npm', args: ['install', '--prefix', cache, '--no-audit', '--no-fund', '--save-exact', `playwright-core@${playwrightVersion}`], env: {} },
        { command: process.execPath, args: [join(cache, 'node_modules', 'playwright-core', 'cli.js'), 'install', '--only-shell', 'chromium'], env: { PLAYWRIGHT_BROWSERS_PATH: browsersDirectory(workspaceRoot) } },
    ];
}

/**
 * Install Playwright and Chromium into the workspace cache.
 *
 * @param {string} workspaceRoot
 * @param {NodeJS.WritableStream} log
 * @returns {{ok: boolean, error?: string}}
 */
export function installPlaywright(workspaceRoot, log) {
    const cache = playwrightCacheDirectory(workspaceRoot);

    mkdirSync(cache, { recursive: true });

    if (!existsSync(join(cache, 'package.json'))) {
        writeFileSync(join(cache, 'package.json'), `${JSON.stringify({ private: true, description: 'Playwright for npx @rafflex/dev test' }, null, 2)}\n`);
    }

    for (const step of installSteps(workspaceRoot)) {
        log.write(`$ ${step.command === process.execPath ? 'node' : step.command} ${step.args.join(' ')}\n`);

        const result = spawnSync(step.command, step.args, {
            cwd: cache,
            stdio: ['ignore', 'inherit', 'inherit'],
            env: { ...process.env, ...step.env },
            shell: process.platform === 'win32' && step.command === 'npm',
        });

        if (result.status !== 0) {
            return { ok: false, error: `${step.command === process.execPath ? 'node' : step.command} ${step.args[0]} failed${result.error ? `: ${result.error.message}` : ''}.` };
        }
    }

    return { ok: true };
}
