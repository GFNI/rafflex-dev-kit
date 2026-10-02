import { spawn } from 'node:child_process';
import { startDevServer } from '../dev-server.js';
import { loadProject } from '../project.js';
import { loadDocuments, resolveBaseUrl } from '../remote.js';

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
 * The default command: start the preview server, open the browser, and
 * keep running until interrupted. Returns null once the server is up (the
 * process stays alive), or an exit code when it cannot start.
 *
 * @param {{cwd: string, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream, options: import('../cli.js').CliOptions}} context
 * @returns {Promise<number|null>}
 */
export async function runDevCommand({ cwd, stdout, stderr, options }) {
    let project;
    let loaded;

    try {
        project = loadProject(cwd);
        loaded = await loadDocuments({ projectDirectory: project.directory, baseUrl: resolveBaseUrl(project.config) });
    } catch (error) {
        stderr.write(`${/** @type {Error} */ (error).message}\n`);

        return 2;
    }

    for (const warning of loaded.warnings) {
        stderr.write(`note: ${warning}\n`);
    }

    const server = await startDevServer({ project, loaded, port: options.port ?? defaultPort });

    stdout.write(`Previewing ${project.config.type} at ${server.url}\nRules ${loaded.documents.rules.version ?? 'unversioned'} from ${loaded.baseUrl}. Save template.twig or anything in assets/ to reload.\nThe marketplace's own check is the final verdict. Press Ctrl+C to stop.\n`);

    if (options.open) {
        openBrowser(server.url);
    }

    const stop = () => {
        server.close().then(() => process.exit(0));
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    return null;
}
