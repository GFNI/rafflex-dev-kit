import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDevServer } from '../dev-server.js';
import { loadDocuments } from '../remote.js';
import { findWorkspaceRoot, listProducts, loadWorkspace, productContaining, resolveProduct, withManifest, workspaceFilename } from '../workspace.js';
import { createWorkspace } from './init.js';
import { fail, messageOf, writeJson } from './output.js';

export const defaultPort = 5173;

/** The folder the one line setup creates the workspace in, inside the current folder. */
export const setupFolderName = 'rafflex';

/**
 * Find the workspace to open, setting one up when there is none: the
 * workspace the folder is in, else a `rafflex` folder here that already is
 * one, else a new workspace in a new (or empty) `rafflex` folder here. It
 * asks nothing, so running the same command again opens the same
 * workspace. A `rafflex` folder holding other files is left alone.
 *
 * @param {string} cwd
 * @returns {Promise<{root: string, created: boolean, warnings: string[]}>}
 */
export async function findOrCreateWorkspace(cwd) {
    const existing = findWorkspaceRoot(cwd);

    if (existing !== null) {
        return { root: existing, created: false, warnings: [] };
    }

    const directory = join(cwd, setupFolderName);

    if (existsSync(join(directory, workspaceFilename))) {
        return { root: directory, created: false, warnings: [] };
    }

    if (existsSync(directory) && readdirSync(directory).length > 0) {
        throw new Error(`There is already a ${setupFolderName} folder here with other files in it. Run npx @rafflex/dev@latest in another folder.`);
    }

    mkdirSync(directory, { recursive: true });

    const created = await createWorkspace(directory);
    const gitNote = created.git.note === null ? [] : [created.git.note];

    return { root: directory, created: true, warnings: [...created.warnings, ...gitNote] };
}

/**
 * Open a URL in the default browser, ignoring failure (a headless
 * machine simply has no browser to open).
 *
 * @param {string} url
 */
function openBrowser(url) {
    const [command, args] = process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '""', url]]
            : ['xdg-open', [url]];

    try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });

        child.on('error', () => {});
        child.unref();
    } catch {
        // No browser available.
    }
}

/**
 * The default command: start the Rafflex app for the whole workspace,
 * open the browser, and keep running until interrupted. Returns null once
 * the server is up (the process stays alive), or an exit code when it
 * cannot start.
 *
 * Outside a workspace (and with no product named) it first sets one up in
 * a `rafflex` folder here, asking nothing. The browser opens on the
 * product named, or the product folder the command runs in; anywhere else
 * it opens the app's home. It prints three lines: the workspace, the
 * app's address, and how to stop it.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number|null>}
 */
export async function runDevCommand(context) {
    const { cwd, stdout, stderr, options } = context;
    let workspace;
    let product;
    let loaded;
    let setup;

    try {
        setup = options.positionals.length === 0 ? await findOrCreateWorkspace(cwd) : { root: cwd, created: false, warnings: [] };
        workspace = loadWorkspace(setup.root);
        loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl });
        workspace = withManifest(workspace, loaded.manifest);

        const products = listProducts(workspace);
        const [name] = options.positionals;

        product = name !== undefined ? resolveProduct(workspace, products, name, cwd) : productContaining(products, cwd);
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    const server = await startDevServer({ workspace, loaded, port: options.port ?? defaultPort });
    const openUrl = product === null ? server.url : server.urlFor(product);
    const warnings = [...setup.warnings, ...loaded.warnings];

    if (options.json) {
        writeJson(stdout, { url: openUrl, index_url: server.url, product: product?.path ?? null, workspace: workspace.root, created: setup.created, warnings });
    } else {
        for (const warning of warnings) {
            stderr.write(`note: ${warning}\n`);
        }

        stdout.write(`Workspace: ${workspace.root}\nRafflex app: ${openUrl}\nLeave this running. Close it with Ctrl+C.\n`);
    }

    if (options.open) {
        openBrowser(openUrl);
    }

    const stop = () => {
        server.close().then(() => process.exit(0));
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    return null;
}
