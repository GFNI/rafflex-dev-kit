import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';
import { scanAssets } from './assets.js';
import { runChecks, scenarioValues, verdictNote } from './checker.js';
import { blockContext, gameContext } from './context.js';
import { cspHeader, frameDocument, localCspDirectives } from './preview.js';
import { readTemplate } from './project.js';
import { renderTemplate } from './twig-engine.js';

const require = createRequire(import.meta.url);
const alpinePath = require.resolve('alpinejs/dist/cdn.min.js');
const clientDirectory = new URL('./client/', import.meta.url);

/** @type {Record<string, string>} */
const contentTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp3': 'audio/mpeg',
    '.glb': 'model/gltf-binary',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
};

/**
 * @param {string} relativePath
 */
export function assetUrl(relativePath) {
    return `/assets/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Watch the template, rafflex.json, and the assets folder, calling
 * `onChange` (debounced) on any change. Recursive fs.watch where the
 * platform supports it, polling otherwise.
 *
 * @param {import('./project.js').Project} project
 * @param {() => void} onChange
 * @returns {() => void} Stops watching.
 */
export function watchProject(project, onChange) {
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    const trigger = () => {
        if (timer !== null) {
            clearTimeout(timer);
        }

        timer = setTimeout(() => {
            timer = null;
            onChange();
        }, 60);
    };
    const isRelevant = (/** @type {string|null} */ filename) => {
        if (filename === null) {
            return true;
        }

        const path = filename.split(sep).join('/');

        return path === 'template.twig' || path === 'rafflex.json' || path === 'assets' || path.startsWith('assets/');
    };

    try {
        const watcher = watch(project.directory, { recursive: true }, (event, filename) => {
            if (isRelevant(filename === null ? null : String(filename))) {
                trigger();
            }
        });

        return () => watcher.close();
    } catch {
        return pollProject(project, trigger);
    }
}

/**
 * @param {import('./project.js').Project} project
 * @param {() => void} trigger
 */
function pollProject(project, trigger) {
    const signature = () => {
        const parts = [];

        for (const path of [project.templatePath, join(project.directory, 'rafflex.json')]) {
            try {
                const stats = statSync(path);

                parts.push(`${path}:${stats.mtimeMs}:${stats.size}`);
            } catch {
                parts.push(`${path}:missing`);
            }
        }

        const walk = (/** @type {string} */ directory) => {
            let entries = [];

            try {
                entries = readdirSync(directory, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const path = join(directory, entry.name);

                if (entry.isDirectory()) {
                    walk(path);
                    continue;
                }

                const stats = statSync(path, { throwIfNoEntry: false });

                parts.push(`${path}:${stats?.mtimeMs}:${stats?.size}`);
            }
        };

        walk(project.assetsDirectory);

        return parts.join('|');
    };

    let last = signature();
    const interval = setInterval(() => {
        const next = signature();

        if (next !== last) {
            last = next;
            trigger();
        }
    }, 500);

    return () => clearInterval(interval);
}

/**
 * @typedef {object} DevServerOptions
 * @property {import('./project.js').Project} project
 * @property {import('./remote.js').LoadedDocuments} loaded
 * @property {number} port
 * @property {string} [host]
 * @property {boolean} [watchFiles]
 */

/**
 * Start the preview server: the controls page, the sandboxed frame, the
 * project's assets, the problems the kit finds, and a Server-Sent Events
 * stream that tells the page to reload when a project file changes. Binds
 * to the loopback interface only and answers GET requests only.
 *
 * @param {DevServerOptions} options
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, notifyChange: () => void}>}
 */
export async function startDevServer({ project, loaded, port, host = '127.0.0.1', watchFiles = true }) {
    const { documents } = loaded;
    /** @type {Set<import('node:http').ServerResponse>} */
    const listeners = new Set();
    let actualPort = port;
    let origin = `http://${host}:${port}`;
    const libraryUrls = (documents.libraries?.libraries ?? []).map((/** @type {{url: string}} */ library) => library.url);
    const assetsRoot = resolve(project.assetsDirectory);

    const projectState = () => {
        const template = readTemplate(project);
        const scan = scanAssets(project.assetsDirectory, documents.rules, documents.libraries?.libraries ?? [], assetUrl);

        return { template, scan };
    };

    /**
     * @param {URL} url
     */
    const selectionFrom = (url) => {
        const scenarios = scenarioValues(documents);
        const requestedScenario = url.searchParams.get('scenario') ?? '';
        const scenario = scenarios.includes(requestedScenario) ? requestedScenario : scenarios[0];
        const { min = 1, max = 25, default: fallback = 5 } = documents.contexts.play_count ?? {};
        const requestedCount = Number.parseInt(url.searchParams.get('play_count') ?? '', 10);
        const playCount = Number.isFinite(requestedCount) ? Math.min(max, Math.max(min, requestedCount)) : fallback;

        return { scenario, playCount };
    };

    /**
     * @param {import('node:http').ServerResponse} response
     * @param {number} status
     * @param {string} body
     * @param {Record<string, string>} [headers]
     */
    const send = (response, status, body, headers = {}) => {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
        response.end(body);
    };

    /**
     * @param {URL} url
     * @param {import('node:http').ServerResponse} response
     */
    const serveFrame = (url, response) => {
        const { scenario, playCount } = selectionFrom(url);
        const { template, scan } = projectState();
        const context = project.config.type === 'block'
            ? blockContext(documents.contexts, { files: scan.files, template })
            : gameContext(documents.contexts, { scenario, playCount, files: scan.files, template });
        let html = null;
        let error = null;

        try {
            html = renderTemplate(template, context, documents.rules.sandbox);
        } catch (renderError) {
            error = String(/** @type {Error} */ (renderError).message);
        }

        const directives = localCspDirectives(documents.rules.preview_csp ?? {}, origin, libraryUrls);

        send(response, 200, frameDocument({ html, error, background: context.settings?.background }), {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': cspHeader(directives),
            'Referrer-Policy': 'no-referrer',
        });
    };

    /**
     * @param {URL} url
     * @param {import('node:http').ServerResponse} response
     */
    const serveProblems = (url, response) => {
        const { scenario, playCount } = selectionFrom(url);
        let payload;

        try {
            const { template, scan } = projectState();
            const { issues, skippedPatterns } = runChecks({
                template,
                files: scan.files,
                assetRefusals: scan.refusals,
                documents,
                playCount,
                renderedPlayCounts: 'current',
            });

            payload = {
                issues,
                warnings: loaded.warnings,
                skipped_patterns: skippedPatterns,
                note: verdictNote,
                scenario,
                play_count: playCount,
                files: scan.assets.map((asset) => ({ tag: asset.tag, path: `assets/${asset.path}`, kind: asset.kind, library: asset.library?.name ?? null })),
            };
        } catch (error) {
            payload = { issues: [], warnings: loaded.warnings, error: String(/** @type {Error} */ (error).message), note: verdictNote };
        }

        send(response, 200, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8' });
    };

    /**
     * @param {import('node:http').ServerResponse} response
     */
    const serveConfig = (response) => {
        send(response, 200, JSON.stringify({
            type: project.config.type,
            product: project.config.product,
            scenarios: documents.contexts.scenarios ?? [],
            play_count: documents.contexts.play_count ?? { min: 1, max: 25, default: 5 },
            rules_version: documents.rules.version ?? null,
            base_url: loaded.baseUrl,
            offline: loaded.offline,
        }), { 'Content-Type': 'application/json; charset=utf-8' });
    };

    /**
     * @param {string} pathname
     * @param {import('node:http').ServerResponse} response
     */
    const serveAsset = (pathname, response) => {
        let decoded;

        try {
            decoded = decodeURIComponent(pathname.slice('/assets/'.length));
        } catch {
            send(response, 400, 'Bad path');

            return;
        }

        const path = resolve(assetsRoot, decoded);

        if (!path.startsWith(`${assetsRoot}${sep}`) || relative(assetsRoot, path).split(sep).some((part) => part.startsWith('.')) || !existsSync(path) || !statSync(path).isFile()) {
            send(response, 404, 'Not found');

            return;
        }

        response.writeHead(200, {
            'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
            // The frame runs on an opaque origin, so loading a .glb is a
            // cross origin fetch.
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff',
        });
        createReadStream(path).pipe(response);
    };

    /**
     * @param {string} name
     * @param {import('node:http').ServerResponse} response
     */
    const serveClient = (name, response) => {
        const body = readFileSync(new URL(name, clientDirectory), 'utf8');

        send(response, 200, body, {
            'Content-Type': contentTypes[extname(name)] ?? 'text/plain; charset=utf-8',
            'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
    };

    /**
     * @param {import('node:http').ServerResponse} response
     */
    const serveEvents = (response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        response.write('retry: 1000\n\n');
        listeners.add(response);
        response.on('close', () => listeners.delete(response));
    };

    const server = createServer((request, response) => {
        const hostHeader = request.headers.host ?? '';

        if (hostHeader !== `${host}:${actualPort}` && hostHeader !== `localhost:${actualPort}`) {
            send(response, 403, 'This server only answers requests for its own address.');

            return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            send(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

            return;
        }

        const url = new URL(request.url ?? '/', origin);

        try {
            switch (url.pathname) {
                case '/':
                    serveClient('index.html', response);

                    return;
                case '/__rafflex/app.js':
                    serveClient('app.js', response);

                    return;
                case '/__rafflex/app.css':
                    serveClient('app.css', response);

                    return;
                case '/__rafflex/alpine.js':
                    send(response, 200, readFileSync(alpinePath, 'utf8'), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=3600' });

                    return;
                case '/__rafflex/config':
                    serveConfig(response);

                    return;
                case '/__rafflex/problems':
                    serveProblems(url, response);

                    return;
                case '/__rafflex/events':
                    serveEvents(response);

                    return;
                case '/frame':
                    serveFrame(url, response);

                    return;
                default:
                    if (url.pathname.startsWith('/assets/')) {
                        serveAsset(url.pathname, response);

                        return;
                    }

                    send(response, 404, 'Not found');
            }
        } catch (error) {
            send(response, 500, String(/** @type {Error} */ (error).message));
        }
    });

    actualPort = await listenOnFreePort(server, host, port);
    origin = `http://${host}:${actualPort}`;

    const notifyChange = () => {
        for (const listener of listeners) {
            listener.write(`event: reload\ndata: ${Date.now()}\n\n`);
        }
    };

    const keepAlive = setInterval(() => {
        for (const listener of listeners) {
            listener.write(': keep-alive\n\n');
        }
    }, 15000);
    const stopWatching = watchFiles ? watchProject(project, notifyChange) : () => {};

    return {
        url: `${origin}/`,
        port: actualPort,
        notifyChange,
        close: () => new Promise((resolveClose) => {
            clearInterval(keepAlive);
            stopWatching();

            for (const listener of listeners) {
                listener.end();
            }

            server.close(() => resolveClose());
        }),
    };
}

/**
 * Listen on the port, or the next free one after it.
 *
 * @param {import('node:http').Server} server
 * @param {string} host
 * @param {number} port
 * @returns {Promise<number>}
 */
function listenOnFreePort(server, host, port) {
    return new Promise((resolvePort, reject) => {
        let candidate = port;
        const attempt = () => {
            const onError = (/** @type {NodeJS.ErrnoException} */ error) => {
                if (error.code === 'EADDRINUSE' && candidate < port + 50) {
                    candidate++;
                    attempt();

                    return;
                }

                reject(error);
            };

            server.once('error', onError);
            server.listen(candidate, host, () => {
                server.off('error', onError);

                const address = server.address();

                resolvePort(typeof address === 'object' && address !== null ? address.port : candidate);
            });
        };

        attempt();
    });
}

