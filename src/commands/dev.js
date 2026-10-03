import { spawn } from 'node:child_process';
import { startDevServer } from '../dev-server.js';
import { loadDocuments } from '../remote.js';
import { listProducts, loadWorkspace, productContaining, resolveProduct, withManifest } from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

export const defaultPort = 5173;

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
 * The default command: start one preview server for the whole workspace,
 * open the browser, and keep running until interrupted. Returns null once
 * the server is up (the process stays alive), or an exit code when it
 * cannot start.
 *
 * The browser opens on the product named, or the product folder the
 * command runs in; anywhere else in the workspace it opens the index.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number|null>}
 */
export async function runDevCommand(context) {
    const { cwd, stdout, stderr, options } = context;
    let workspace;
    let product;
    let loaded;

    try {
        workspace = loadWorkspace(cwd);
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

    if (options.json) {
        writeJson(stdout, { url: openUrl, index_url: server.url, product: product?.path ?? null, warnings: loaded.warnings });
    } else {
        for (const warning of loaded.warnings) {
            stderr.write(`note: ${warning}\n`);
        }

        const what = product === null ? `Workspace ${workspace.root}` : `Previewing ${product.path} (${product.type} ${product.version})`;

        stdout.write(`${what} at ${openUrl}\n${product === null ? '' : `Every product: ${server.url}\n`}Rules ${loaded.documents.rules.version ?? 'unversioned'} from ${loaded.baseUrl}. Save a template, options.json, or anything in assets/ to reload.\nThe marketplace's own check is the final verdict. Press Ctrl+C to stop.\n`);
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
