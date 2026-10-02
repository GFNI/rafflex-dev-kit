import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';
import { scanAssets } from './assets.js';
import { runChecks, scenarioValues, verdictNote } from './checker.js';
import { productStatus } from './commands/status.js';
import { blockContext, gameContext } from './context.js';
import { cspHeader, frameDocument, localCspDirectives } from './preview.js';
import { assetsDirectoryName, listProducts, optionsFilename, productFilename, readProduct, readTemplate, templateFilename } from './workspace.js';
import { renderTemplate } from './twig-engine.js';

const require = createRequire(import.meta.url);
const alpinePath = require.resolve('alpinejs/dist/cdn.min.js');
const clientDirectory = new URL('./client/', import.meta.url);

/** Every product's preview lives under /p/<type folder>/<folder>/. */
export const productRoutePrefix = '/p/';

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

/** The client files served from /__rafflex/. */
const clientFiles = ['app.js', 'app.css', 'workspace.js'];

/** Files whose change reloads a product's preview. */
const previewFiles = [templateFilename, optionsFilename, productFilename];

/**
 * The path a product's preview is served under: "/p/games/spin-to-win/".
 *
 * @param {{path: string}} product
 */
export function productBasePath(product) {
    return `${productRoutePrefix}${product.path.split('/').map(encodeURIComponent).join('/')}/`;
}

/**
 * The local URL of a file in a product's assets folder. Without a base
 * path (check, which never serves files) it is "/assets/<path>".
 *
 * @param {string} relativePath
 * @param {string} [basePath]
 */
export function assetUrl(relativePath, basePath = '/') {
    return `${basePath}assets/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * @typedef {{type: 'products'}|{type: 'product', path: string, preview: boolean}} WorkspaceChange
 */

/**
 * What a change at `filename` (relative to the workspace root) means:
 * the product list changed (a product folder or its product.json came or
 * went), a product changed (and whether its preview should reload), or
 * nothing the server cares about.
 *
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} filename
 * @returns {WorkspaceChange[]}
 */
export function classifyChange(workspace, filename) {
    const parts = filename.split(sep).join('/').split('/').filter((part) => part !== '');
    const [typeFolder, folder, ...rest] = parts;

    if (typeFolder === undefined || !workspace.assetTypes.some((type) => type.folder === typeFolder)) {
        return [];
    }

    if (folder === undefined) {
        return [{ type: 'products' }];
    }

    if (folder.startsWith('.')) {
        return [];
    }

    const path = `${typeFolder}/${folder}`;

    if (rest.length === 0) {
        return [{ type: 'products' }, { type: 'product', path, preview: true }];
    }

    const [entry] = rest;
    const preview = previewFiles.includes(entry) || entry === assetsDirectoryName;
    /** @type {WorkspaceChange[]} */
    const changes = [{ type: 'product', path, preview }];

    if (entry === productFilename && rest.length === 1) {
        changes.unshift({ type: 'products' });
    }

    return changes;
}

/**
 * Watch the whole workspace with one watcher and report what changed,
 * debounced per product: `onChange({type: 'products'})` when the product
 * list may have changed, and `onChange({type: 'product', path, preview})`
 * when a file in a product folder changed. Recursive fs.watch where the
 * platform supports it, polling every 500ms otherwise.
 *
 * @param {import('./workspace.js').Workspace} workspace
 * @param {(change: WorkspaceChange) => void} onChange
 * @param {{poll?: boolean}} [options]
 * @returns {() => void} Stops watching.
 */
export function watchWorkspace(workspace, onChange, { poll = false } = {}) {
    /** @type {Map<string, {timer: NodeJS.Timeout, change: WorkspaceChange}>} */
    const pending = new Map();
    const trigger = (/** @type {WorkspaceChange} */ change) => {
        const key = change.type === 'products' ? '' : change.path;
        const existing = pending.get(key);

        if (existing !== undefined) {
            clearTimeout(existing.timer);

            if (existing.change.type === 'product' && change.type === 'product') {
                change = { ...change, preview: change.preview || existing.change.preview };
            }
        }

        const timer = setTimeout(() => {
            pending.delete(key);
            onChange(change);
        }, 60);

        pending.set(key, { timer, change });
    };
    const triggerAll = () => {
        trigger({ type: 'products' });

        for (const product of safeListProducts(workspace)) {
            trigger({ type: 'product', path: product.path, preview: true });
        }
    };
    const stopPending = () => {
        for (const { timer } of pending.values()) {
            clearTimeout(timer);
        }

        pending.clear();
    };

    if (!poll) {
        try {
            const watcher = watch(workspace.root, { recursive: true }, (event, filename) => {
                if (filename === null) {
                    triggerAll();

                    return;
                }

                for (const change of classifyChange(workspace, String(filename))) {
                    trigger(change);
                }
            });

            watcher.on('error', () => {});

            return () => {
                watcher.close();
                stopPending();
            };
        } catch {
            // Recursive watching is unsupported here: poll instead.
        }
    }

    const stopPolling = pollWorkspace(workspace, trigger);

    return () => {
        stopPolling();
        stopPending();
    };
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @returns {import('./workspace.js').Product[]}
 */
function safeListProducts(workspace) {
    try {
        return listProducts(workspace);
    } catch {
        return [];
    }
}

/**
 * The polling fallback: a signature of every product folder's files,
 * compared every 500ms.
 *
 * @param {import('./workspace.js').Workspace} workspace
 * @param {(change: WorkspaceChange) => void} trigger
 */
function pollWorkspace(workspace, trigger) {
    const productFolders = () => {
        /** @type {string[]} */
        const paths = [];

        for (const assetType of workspace.assetTypes) {
            let entries = [];

            try {
                entries = readdirSync(join(workspace.root, assetType.folder), { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(workspace.root, assetType.folder, entry.name, productFilename))) {
                    paths.push(`${assetType.folder}/${entry.name}`);
                }
            }
        }

        return paths.sort();
    };
    const signatureOf = (/** @type {string} */ path) => {
        /** @type {{preview: string[], other: string[]}} */
        const parts = { preview: [], other: [] };
        const walk = (/** @type {string} */ directory, /** @type {boolean} */ preview) => {
            let entries = [];

            try {
                entries = readdirSync(directory, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const full = join(directory, entry.name);
                const isPreview = preview || previewFiles.includes(entry.name) || entry.name === assetsDirectoryName;

                if (entry.isDirectory()) {
                    walk(full, isPreview);
                    continue;
                }

                const stats = statSync(full, { throwIfNoEntry: false });

                (isPreview ? parts.preview : parts.other).push(`${full}:${stats?.mtimeMs}:${stats?.size}`);
            }
        };

        walk(join(workspace.root, ...path.split('/')), false);

        return { preview: parts.preview.join('|'), other: parts.other.join('|') };
    };
    const snapshot = () => new Map(productFolders().map((path) => [path, signatureOf(path)]));

    let last = snapshot();
    const interval = setInterval(() => {
        const next = snapshot();

        if ([...next.keys()].join('|') !== [...last.keys()].join('|')) {
            trigger({ type: 'products' });
        }

        for (const [path, signature] of next) {
            const previous = last.get(path);

            if (previous === undefined || previous.preview !== signature.preview) {
                trigger({ type: 'product', path, preview: true });
            } else if (previous.other !== signature.other) {
                trigger({ type: 'product', path, preview: false });
            }
        }

        last = next;
    }, 500);

    return () => clearInterval(interval);
}

/**
 * One line state for the workspace index: the remote side (from the last
 * `synced`) and what changed locally since.
 *
 * @param {import('./workspace.js').Product} product
 * @param {{rules?: any, libraries?: any}} documents
 */
export function productSummary(product, documents) {
    const status = productStatus(product, documents);
    const remote = product.manifest.remote;
    const decision = remote?.latest_review?.decision ?? remote?.latest_review?.status ?? null;
    const inReview = status.in_review;
    const { changes } = status;
    const assetParts = [
        changes.assets.new.length > 0 && `${changes.assets.new.length} new`,
        changes.assets.changed.length > 0 && `${changes.assets.changed.length} changed`,
        changes.assets.removed.length > 0 && `${changes.assets.removed.length} removed`,
    ].filter(Boolean);
    const changed = [changes.template && 'template', changes.options && 'options', changes.listing && 'listing', assetParts.length > 0 && `assets (${assetParts.join(', ')})`].filter(Boolean);

    return {
        path: product.path,
        type: product.type,
        title: product.title,
        version: product.version,
        slug: product.slug,
        url: productBasePath(product),
        remote: {
            pushed: product.slug !== null,
            synced: remote !== null,
            status: remote?.status ?? null,
            live_version: remote?.live_version ?? null,
            in_review: inReview,
            review: !inReview && typeof decision === 'string' && decision !== 'approved'
                ? { decision, version: remote?.latest_review?.version ?? null }
                : null,
            stale: status.stale_remote,
        },
        local: remote === null ? null : { changed: /** @type {string[]} */ (changed) },
        problems: status.problems,
    };
}

/**
 * @typedef {object} DevServerOptions
 * @property {import('./workspace.js').Workspace} workspace
 * @property {import('./remote.js').LoadedDocuments} loaded
 * @property {number} port
 * @property {string} [host]
 * @property {boolean} [watchFiles]
 * @property {boolean} [pollFiles]   Poll instead of fs.watch (tests).
 */

/**
 * Start the preview server for a whole workspace:
 *
 * - `/` the workspace index (every product with its version, remote state,
 *   and local changes), fed by `/__rafflex/products` and refreshed over
 *   `/__rafflex/events` when products or their files change.
 * - `/p/<type folder>/<folder>/` one product's preview: the controls page,
 *   with `frame`, `assets/*`, `__rafflex/config`, `__rafflex/problems`, and
 *   `__rafflex/events` (reloads for that product only) under the same
 *   prefix. A product's frame and files map only reach its own assets.
 *
 * Binds to the loopback interface only and answers GET requests for its
 * own host name only.
 *
 * @param {DevServerOptions} options
 * @returns {Promise<{url: string, port: number, urlFor: (product: {path: string}) => string, close: () => Promise<void>, notifyChange: (change?: WorkspaceChange) => void}>}
 */
export async function startDevServer({ workspace, loaded, port, host = '127.0.0.1', watchFiles = true, pollFiles = false }) {
    const { documents } = loaded;
    /** @type {Map<import('node:http').ServerResponse, string|null>} Each listener's product path, or null for the index. */
    const listeners = new Map();
    let actualPort = port;
    let origin = `http://${host}:${port}`;
    const libraryUrls = (documents.libraries?.libraries ?? []).map((/** @type {{url: string}} */ library) => library.url);

    /**
     * The product a /p/ route names, read fresh so title and version edits
     * show without a restart. Null when the segments do not name a product
     * folder of a known type.
     *
     * @param {string} typeFolder
     * @param {string} folder
     * @returns {import('./workspace.js').Product|null}
     */
    const productAt = (typeFolder, folder) => {
        const assetType = workspace.assetTypes.find((type) => type.folder === typeFolder);

        if (assetType === undefined || folder === '' || folder.startsWith('.') || /[\\/\0]/.test(folder)) {
            return null;
        }

        if (!existsSync(join(workspace.root, assetType.folder, folder, productFilename))) {
            return null;
        }

        return readProduct(workspace, assetType, folder);
    };

    /**
     * @param {import('./workspace.js').Product} product
     */
    const productState = (product) => {
        const template = readTemplate(product);
        const basePath = productBasePath(product);
        const scan = scanAssets(product.assetsDirectory, documents.rules, documents.libraries?.libraries ?? [], (path) => assetUrl(path, basePath));

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
     * @param {import('node:http').ServerResponse} response
     * @param {unknown} payload
     */
    const sendJson = (response, payload) => {
        send(response, 200, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8' });
    };

    /**
     * The frame's CSP: the published preview CSP with the uploads origin
     * mapped to this product's assets path only, plus the kit's Alpine
     * build, so one product's template cannot load another's files.
     *
     * @param {import('./workspace.js').Product} product
     */
    const frameCsp = (product) => {
        const directives = localCspDirectives(documents.rules.preview_csp ?? {}, `${origin}${productBasePath(product)}${assetsDirectoryName}/`, libraryUrls);

        if (directives['script-src'] !== undefined) {
            directives['script-src'] = [...directives['script-src'], `${origin}/__rafflex/alpine.js`];
        }

        return cspHeader(directives);
    };

    /**
     * @param {import('./workspace.js').Product} product
     * @param {URL} url
     * @param {import('node:http').ServerResponse} response
     */
    const serveFrame = (product, url, response) => {
        const { scenario, playCount } = selectionFrom(url);
        const { template, scan } = productState(product);
        const context = product.type === 'block'
            ? blockContext(documents.contexts, { files: scan.files, template })
            : gameContext(documents.contexts, { scenario, playCount, files: scan.files, template });
        let html = null;
        let error = null;

        try {
            html = renderTemplate(template, context, documents.rules.sandbox);
        } catch (renderError) {
            error = String(/** @type {Error} */ (renderError).message);
        }

        send(response, 200, frameDocument({ html, error, background: context.settings?.background, theme: documents.contexts.theme }), {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': frameCsp(product),
            'Referrer-Policy': 'no-referrer',
        });
    };

    /**
     * @param {import('./workspace.js').Product} product
     * @param {URL} url
     * @param {import('node:http').ServerResponse} response
     */
    const serveProblems = (product, url, response) => {
        const { scenario, playCount } = selectionFrom(url);
        let payload;

        try {
            const { template, scan } = productState(product);
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

        sendJson(response, payload);
    };

    /**
     * @param {import('./workspace.js').Product} product
     * @param {import('node:http').ServerResponse} response
     */
    const serveConfig = (product, response) => {
        sendJson(response, {
            type: product.type,
            product: product.slug,
            path: product.path,
            title: product.title,
            version: product.version,
            scenarios: documents.contexts.scenarios ?? [],
            play_count: documents.contexts.play_count ?? { min: 1, max: 25, default: 5 },
            rules_version: documents.rules.version ?? null,
            base_url: loaded.baseUrl,
            offline: loaded.offline,
        });
    };

    /**
     * @param {import('node:http').ServerResponse} response
     */
    const serveProducts = (response) => {
        /** @type {ReturnType<typeof productSummary>[]} */
        const products = [];
        /** @type {string[]} */
        const errors = [];

        try {
            for (const product of listProducts(workspace)) {
                products.push(productSummary(product, documents));
            }
        } catch (error) {
            errors.push(String(/** @type {Error} */ (error).message));
        }

        sendJson(response, {
            workspace: workspace.root,
            offline: loaded.offline,
            rules_version: documents.rules.version ?? null,
            warnings: [...loaded.warnings, ...errors],
            types: workspace.assetTypes,
            products,
        });
    };

    /**
     * @param {import('./workspace.js').Product} product
     * @param {string} rawPath The URL encoded path below assets/.
     * @param {import('node:http').ServerResponse} response
     */
    const serveAsset = (product, rawPath, response) => {
        const assetsRoot = resolve(product.assetsDirectory);
        let decoded;

        try {
            decoded = decodeURIComponent(rawPath);
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
     * @param {string|null} productPath
     * @param {import('node:http').ServerResponse} response
     */
    const serveEvents = (productPath, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        response.write('retry: 1000\n\n');
        listeners.set(response, productPath);
        response.on('close', () => listeners.delete(response));
    };

    /**
     * @param {URL} url
     * @param {import('node:http').ServerResponse} response
     */
    const serveProductRoute = (url, response) => {
        const segments = url.pathname.slice(productRoutePrefix.length).split('/');

        if (segments.length < 2) {
            send(response, 404, 'Not found');

            return;
        }

        let typeFolder;
        let folder;

        try {
            typeFolder = decodeURIComponent(segments[0]);
            folder = decodeURIComponent(segments[1]);
        } catch {
            send(response, 400, 'Bad path');

            return;
        }

        const product = productAt(typeFolder, folder);

        if (product === null) {
            send(response, 404, `No product at ${typeFolder}/${folder} in this workspace.`);

            return;
        }

        if (segments.length === 2) {
            response.writeHead(308, { Location: `${productBasePath(product)}${url.search}`, 'Cache-Control': 'no-store' });
            response.end();

            return;
        }

        const rest = segments.slice(2).join('/');

        switch (rest) {
            case '':
                serveClient('index.html', response);

                return;
            case 'frame':
                serveFrame(product, url, response);

                return;
            case '__rafflex/config':
                serveConfig(product, response);

                return;
            case '__rafflex/problems':
                serveProblems(product, url, response);

                return;
            case '__rafflex/events':
                serveEvents(product.path, response);

                return;
            default:
                if (rest.startsWith(`${assetsDirectoryName}/`)) {
                    serveAsset(product, rest.slice(assetsDirectoryName.length + 1), response);

                    return;
                }

                send(response, 404, 'Not found');
        }
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
            if (url.pathname === '/') {
                serveClient('workspace.html', response);

                return;
            }

            if (url.pathname.startsWith(productRoutePrefix)) {
                serveProductRoute(url, response);

                return;
            }

            const clientFile = url.pathname.startsWith('/__rafflex/') ? url.pathname.slice('/__rafflex/'.length) : null;

            if (clientFile !== null && clientFiles.includes(clientFile)) {
                serveClient(clientFile, response);

                return;
            }

            switch (url.pathname) {
                case '/__rafflex/alpine.js':
                    send(response, 200, readFileSync(alpinePath, 'utf8'), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=3600' });

                    return;
                case '/__rafflex/products':
                    serveProducts(response);

                    return;
                case '/__rafflex/events':
                    serveEvents(null, response);

                    return;
                default:
                    send(response, 404, 'Not found');
            }
        } catch (error) {
            send(response, 500, String(/** @type {Error} */ (error).message));
        }
    });

    actualPort = await listenOnFreePort(server, host, port);
    origin = `http://${host}:${actualPort}`;

    /**
     * Tell the open pages what changed: a product's preview reloads only
     * for its own files; the index refreshes on any change.
     *
     * @param {WorkspaceChange} [change] Everything when omitted.
     */
    const notifyChange = (change) => {
        const data = JSON.stringify({ ...(change ?? { type: 'all' }), at: Date.now() });

        for (const [listener, productPath] of listeners) {
            if (productPath === null) {
                listener.write(`event: ${change?.type === 'product' ? 'change' : 'products'}\ndata: ${data}\n\n`);
                continue;
            }

            if (change === undefined || (change.type === 'product' && change.preview && change.path === productPath)) {
                listener.write(`event: reload\ndata: ${JSON.stringify({ product: productPath, at: Date.now() })}\n\n`);
            }
        }
    };

    const keepAlive = setInterval(() => {
        for (const listener of listeners.keys()) {
            listener.write(': keep-alive\n\n');
        }
    }, 15000);
    const stopWatching = watchFiles ? watchWorkspace(workspace, notifyChange, { poll: pollFiles }) : () => {};

    return {
        url: `${origin}/`,
        port: actualPort,
        urlFor: (product) => `${origin}${productBasePath(product)}`,
        notifyChange,
        close: () => new Promise((resolveClose) => {
            clearInterval(keepAlive);
            stopWatching();

            for (const listener of listeners.keys()) {
                listener.end();
            }

            server.closeAllConnections?.();
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
