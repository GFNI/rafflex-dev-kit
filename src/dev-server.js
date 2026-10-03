import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';
import { createProduct, isInside, openFolder, testRunner } from './app/actions.js';
import { detectClients } from './app/clients.js';
import { productPrompts, productState, publishStep, testSummary } from './app/product-state.js';
import { promptSource } from './app/prompts.js';
import { imageExtensions, readLastResult, resultsDirectoryName } from './app/results.js';
import { scanAssets } from './assets.js';
import { nonBlockingCodes, runChecks, scenarioValues, verdictNote } from './checker.js';
import { qualityIssues } from './quality.js';
import { unreleasedNotes } from './commands/release.js';
import { productStatus } from './commands/status.js';
import { blockContext, gameContext } from './context.js';
import { isGitInstalled, isInsideRepository } from './git.js';
import { cspHeader, frameDocument, localCspDirectives } from './preview.js';
import { kitVersion } from './version.js';
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
const clientFiles = ['app.js', 'app.css'];

/** The app's pages: each serves the single page app, which routes on the path. */
const appPages = ['/', '/products', '/new'];

/** A product's test screenshots are served under /p/<type folder>/<folder>/results/. */
const resultsRoutePrefix = 'results/';

/** The header every action request carries the start token in. */
export const tokenHeader = 'x-rafflex-token';

/** The largest action request body the app reads. */
const maxBodyBytes = 16 * 1024;

/** The app page's own CSP: Alpine evaluates its directives, so it needs eval; nothing else is allowed. */
const appCsp = `default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

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
 * @property {string} [token]         The action token (random by default).
 * @property {ReturnType<typeof promptSource>} [prompts] Where prompts.json comes from.
 * @property {() => string[]} [detect] Which AI apps are on this computer.
 * @property {{command?: string, env?: NodeJS.ProcessEnv}} [tests] How tests run (tests of the app).
 * @property {(directory: string) => boolean} [openFolderImpl]
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
 * @returns {Promise<{url: string, port: number, token: string, urlFor: (product: {path: string}) => string, close: () => Promise<void>, notifyChange: (change?: WorkspaceChange) => void}>}
 */
export async function startDevServer({
    workspace,
    loaded,
    port,
    host = '127.0.0.1',
    watchFiles = true,
    pollFiles = false,
    token = randomBytes(24).toString('hex'),
    prompts = promptSource({ workspaceDirectory: workspace.root, baseUrl: loaded.baseUrl }),
    detect = () => detectClients(),
    tests = {},
    openFolderImpl = (directory) => openFolder(directory),
}) {
    const { documents } = loaded;
    /** @type {Map<import('node:http').ServerResponse, string|null>} Each listener's product path, or null for the index. */
    const listeners = new Map();
    let actualPort = port;
    let origin = `http://${host}:${port}`;
    const detectedClients = detect();
    const git = { installed: isGitInstalled(workspace.root), repository: isInsideRepository(workspace.root) };
    /** @type {Map<string, import('./app/results.js').TestResult>} */
    const finishedRuns = new Map();
    const runner = testRunner({
        workspaceRoot: workspace.root,
        ...(tests.command ? { command: tests.command } : {}),
        ...(tests.env ? { env: tests.env } : {}),
        onEvent: (event) => {
            if (event.result !== undefined) {
                finishedRuns.set(event.product, event.result);
            }

            broadcast('test', event);
        },
    });

    /**
     * Send an event to every open app page.
     *
     * @param {string} event
     * @param {unknown} data
     */
    const broadcast = (event, data) => {
        for (const [listener, productPath] of listeners) {
            if (productPath === null) {
                listener.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        }
    };

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

        const directory = join(workspace.root, assetType.folder, folder);

        if (!existsSync(join(directory, productFilename)) || !isInside(workspace.root, directory)) {
            return null;
        }

        return readProduct(workspace, assetType, folder);
    };

    /**
     * @param {import('./workspace.js').Product} product
     */
    const productFiles = (product) => {
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
     * The frame's CSP: the published preview CSP with the platform's
     * media sources (uploads origin, models path) mapped to this product's
     * assets path only, so one product's template cannot load another's
     * files, plus the kit's Alpine build. Library builds keep the
     * published libraries path.
     *
     * @param {import('./workspace.js').Product} product
     */
    const frameCsp = (product) => {
        const directives = localCspDirectives(documents.rules.preview_csp ?? {}, `${origin}${productBasePath(product)}${assetsDirectoryName}/`);

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
        const { template, scan } = productFiles(product);
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
    const serveProblems = async (product, url, response) => {
        const { scenario, playCount } = selectionFrom(url);
        let payload;

        try {
            const { template, scan } = productFiles(product);
            const { issues, skippedPatterns } = runChecks({
                template,
                files: scan.files,
                assetRefusals: scan.refusals,
                documents,
                playCount,
                renderedPlayCounts: 'current',
                type: product.type,
            });

            issues.push(...await qualityIssues({ type: product.type, template, files: scan.files, documents }));

            payload = {
                issues,
                warning_codes: nonBlockingCodes,
                warnings: loaded.warnings,
                skipped_patterns: skippedPatterns,
                note: verdictNote,
                scenario,
                play_count: playCount,
                files: scan.assets.map((asset) => ({ tag: asset.tag, path: `assets/${asset.path}`, kind: asset.kind, library: asset.library?.name ?? null })),
            };
        } catch (error) {
            payload = { issues: [], warning_codes: nonBlockingCodes, warnings: loaded.warnings, error: String(/** @type {Error} */ (error).message), note: verdictNote };
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
    const serveProducts = async (response) => {
        const { document } = await prompts.get();
        /** @type {ReturnType<typeof productSummary>[]} */
        const products = [];
        /** @type {string[]} */
        const errors = [];

        try {
            for (const product of listProducts(workspace)) {
                products.push(appSummary(product, document));
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
     * A product's summary for the app: the index summary plus its state,
     * last test result, and folder.
     *
     * @param {import('./workspace.js').Product} product
     * @param {import('./app/prompts.js').PromptsDocument|null} promptsDocument
     */
    const appSummary = (product, promptsDocument) => {
        const summary = productSummary(product, documents);
        const result = readLastResult(product.directory);

        return {
            ...summary,
            directory: product.directory,
            state: productState(summary),
            test: { ...testSummary(result), at: result?.at ?? null, running: runner.isRunning(product.path) },
            hand_to_ai: productPrompts(summary, result, promptsDocument).hand_to_ai?.text ?? null,
        };
    };

    /**
     * Everything the product view shows: the summary, the last test
     * result, Get it live, the prompts, and the Unreleased notes.
     *
     * @param {import('./workspace.js').Product} product
     * @param {import('node:http').ServerResponse} response
     */
    const serveProductDetail = async (product, response) => {
        const summary = productSummary(product, documents);
        const result = readLastResult(product.directory) ?? finishedRuns.get(product.path) ?? null;
        const { document } = await prompts.get();
        let changelog = null;

        try {
            changelog = unreleasedNotes(readFileSync(product.changelogPath, 'utf8'));
        } catch {
            // No changelog yet.
        }

        sendJson(response, {
            ...summary,
            directory: product.directory,
            state: productState(summary),
            test: { ...testSummary(result), running: runner.isRunning(product.path), lines: runner.linesOf(product.path), command: runner.command },
            result,
            publish: publishStep(summary, result, document),
            prompts: productPrompts(summary, result, document),
            changelog,
            scenarios: documents.contexts.scenarios ?? [],
            play_count: documents.contexts.play_count ?? { min: 1, max: 25, default: 5 },
        });
    };

    /**
     * Home: the Get started prompt, the AI apps on this computer with
     * their connect commands, and the health strip.
     *
     * @param {URL} url
     * @param {import('node:http').ServerResponse} response
     */
    const serveHome = async (url, response) => {
        const { document, error } = await prompts.get({ force: url.searchParams.has('refresh') });
        const getStarted = document?.prompts?.get_started ?? null;
        const clients = (document?.clients ?? []).map((client) => ({ ...client, detected: detectedClients.includes(client.key) }));
        const staleRules = loaded.warnings.some((warning) => /older than the marketplace/.test(warning));
        const health = [
            loaded.offline || staleRules
                ? { key: 'rules', ok: false, label: 'Using saved platform rules', fix: 'Connect to the internet, then close and start the app again.' }
                : { key: 'rules', ok: true, label: 'Platform rules are current', fix: null },
            { key: 'kit', ok: true, label: `Kit ${kitVersion}`, fix: null },
            !git.installed
                ? { key: 'git', ok: false, label: 'git is missing', fix: 'Install git from git-scm.com so every change can be undone.' }
                : git.repository
                    ? { key: 'git', ok: true, label: 'git is on', fix: null }
                    : { key: 'git', ok: false, label: 'No history yet', fix: 'Ask your AI to turn on git in this workspace.' },
            ...(document === null ? [{ key: 'prompts', ok: false, label: 'Prompts did not load', fix: 'Connect to the internet, then reload this page.' }] : []),
        ];

        sendJson(response, {
            workspace: workspace.root,
            kit_version: kitVersion,
            types: workspace.assetTypes,
            get_started: getStarted === null ? null : { text: String(getStarted.text ?? ''), description: String(getStarted.description ?? '') },
            new_product: {
                build: document?.prompts?.new_product?.text ?? null,
                ai_start: document?.prompts?.new_product_ai_start?.text ?? null,
            },
            clients,
            links: document?.links ?? {},
            prompts_error: error,
            health,
        });
    };

    /**
     * @param {import('node:http').IncomingMessage} request
     * @returns {Promise<any>}
     */
    const readBody = (request) => new Promise((resolveBody, reject) => {
        let body = '';

        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            body += chunk;

            if (body.length > maxBodyBytes) {
                reject(new Error('Too large'));
                request.destroy();
            }
        });
        request.on('end', () => {
            try {
                resolveBody(body === '' ? {} : JSON.parse(body));
            } catch {
                reject(new Error('Not JSON'));
            }
        });
        request.on('error', reject);
    });

    /**
     * Whether an action request is the app's own: it carries the start
     * token, is JSON (so a plain cross site form cannot send it), and comes
     * from the app's own origin when the browser says where it came from.
     *
     * @param {import('node:http').IncomingMessage} request
     */
    const isAuthorisedAction = (request) => {
        const given = Buffer.from(String(request.headers[tokenHeader] ?? ''));
        const expected = Buffer.from(token);
        const requestOrigin = request.headers.origin;

        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            return false;
        }

        if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
            return false;
        }

        return requestOrigin === undefined || requestOrigin === origin || requestOrigin === `http://localhost:${actualPort}`;
    };

    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    const serveNewProduct = async (request, response) => {
        let body;

        try {
            body = await readBody(request);
        } catch {
            send(response, 400, 'Bad request');

            return;
        }

        const type = typeof body.type === 'string' ? body.type : '';
        const title = typeof body.title === 'string' ? body.title.trim() : '';

        if (!workspace.assetTypes.some((assetType) => assetType.value === type) || title === '' || title.length > 120) {
            send(response, 422, JSON.stringify({ error: 'Give it a name and choose game or block.' }), { 'Content-Type': 'application/json; charset=utf-8' });

            return;
        }

        const { code, output } = await createProduct(workspace.root, type, title);

        if (code !== 0) {
            send(response, 422, JSON.stringify({ error: output.error ?? 'The product could not be created.' }), { 'Content-Type': 'application/json; charset=utf-8' });

            return;
        }

        notifyChange({ type: 'products' });
        sendJson(response, { product: output.product, url: `${productRoutePrefix}${String(output.product).split('/').map(encodeURIComponent).join('/')}/` });
    };

    /**
     * @param {import('./workspace.js').Product} product
     * @param {string} action
     * @param {import('node:http').ServerResponse} response
     */
    const serveProductAction = (product, action, response) => {
        if (!isInside(workspace.root, product.directory)) {
            send(response, 404, 'Not found');

            return;
        }

        switch (action) {
            case 'test':
                if (!runner.start(product)) {
                    send(response, 409, JSON.stringify({ error: 'A test is already running for this product.' }), { 'Content-Type': 'application/json; charset=utf-8' });

                    return;
                }

                send(response, 202, JSON.stringify({ started: true, command: runner.command }), { 'Content-Type': 'application/json; charset=utf-8' });

                return;
            case 'open-folder':
                sendJson(response, { opened: openFolderImpl(product.directory) });

                return;
            default:
                send(response, 404, 'Not found');
        }
    };

    /**
     * A screenshot or other image from the product's `.results/` folder.
     *
     * @param {import('./workspace.js').Product} product
     * @param {string} rawPath
     * @param {import('node:http').ServerResponse} response
     */
    const serveResult = (product, rawPath, response) => {
        const resultsRoot = join(product.directory, resultsDirectoryName);
        const path = confinedPath(resultsRoot, rawPath, { allowHidden: false });

        if (path === null || !imageExtensions.includes(extname(path).toLowerCase())) {
            send(response, 404, 'Not found');

            return;
        }

        response.writeHead(200, { 'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        createReadStream(path).pipe(response);
    };

    /**
     * @param {import('./workspace.js').Product} product
     * @param {string} rawPath The URL encoded path below assets/.
     * @param {import('node:http').ServerResponse} response
     */
    const serveAsset = (product, rawPath, response) => {
        const path = confinedPath(product.assetsDirectory, rawPath, { allowHidden: false });

        if (path === null) {
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
        let body = readFileSync(new URL(name, clientDirectory), 'utf8');

        if (name === 'app.html') {
            body = body.replace('__RAFFLEX_TOKEN__', token);
        }

        send(response, 200, body, {
            'Content-Type': contentTypes[extname(name)] ?? 'text/plain; charset=utf-8',
            'Content-Security-Policy': appCsp,
            'Referrer-Policy': 'no-referrer',
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
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    const serveProductRoute = async (url, request, response) => {
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

        if (request.method === 'POST') {
            if (!rest.startsWith('__rafflex/actions/')) {
                send(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

                return;
            }

            if (!isAuthorisedAction(request)) {
                send(response, 403, 'This action needs the app\'s start token.');

                return;
            }

            serveProductAction(product, rest.slice('__rafflex/actions/'.length), response);

            return;
        }

        if (rest.startsWith(resultsRoutePrefix)) {
            serveResult(product, rest.slice(resultsRoutePrefix.length), response);

            return;
        }

        switch (rest) {
            case '':
                serveClient('app.html', response);

                return;
            case '__rafflex/product':
                await serveProductDetail(product, response);

                return;
            case 'frame':
                serveFrame(product, url, response);

                return;
            case '__rafflex/config':
                serveConfig(product, response);

                return;
            case '__rafflex/problems':
                await serveProblems(product, url, response);

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

    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    const handle = async (request, response) => {
        const hostHeader = request.headers.host ?? '';

        if (hostHeader !== `${host}:${actualPort}` && hostHeader !== `localhost:${actualPort}`) {
            send(response, 403, 'This server only answers requests for its own address.');

            return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
            send(response, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });

            return;
        }

        const url = new URL(request.url ?? '/', origin);

        if (url.pathname.startsWith(productRoutePrefix)) {
            await serveProductRoute(url, request, response);

            return;
        }

        if (request.method === 'POST') {
            if (url.pathname !== '/__rafflex/actions/new') {
                send(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

                return;
            }

            if (!isAuthorisedAction(request)) {
                send(response, 403, 'This action needs the app\'s start token.');

                return;
            }

            await serveNewProduct(request, response);

            return;
        }

        if (appPages.includes(url.pathname)) {
            serveClient('app.html', response);

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
            case '/__rafflex/home':
                await serveHome(url, response);

                return;
            case '/__rafflex/events':
                serveEvents(null, response);

                return;
            default:
                send(response, 404, 'Not found');
        }
    };

    const server = createServer((request, response) => {
        handle(request, response).catch((error) => {
            if (!response.headersSent) {
                send(response, 500, String(/** @type {Error} */ (error).message));
            } else {
                response.end();
            }
        });
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
        token,
        close: () => new Promise((resolveClose) => {
            clearInterval(keepAlive);
            stopWatching();
            runner.stopAll();

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

/**
 * The file a URL encoded path names inside `root`, or null when it is
 * not a file there: it must decode, resolve inside `root` after following
 * links, and (unless allowed) not pass through a hidden name.
 *
 * @param {string} root
 * @param {string} rawPath
 * @param {{allowHidden?: boolean}} [options]
 * @returns {string|null}
 */
export function confinedPath(root, rawPath, { allowHidden = false } = {}) {
    let decoded;

    try {
        decoded = decodeURIComponent(rawPath);
    } catch {
        return null;
    }

    if (decoded.includes('\0')) {
        return null;
    }

    const base = resolve(root);
    const path = resolve(base, decoded);

    if (!path.startsWith(`${base}${sep}`)) {
        return null;
    }

    if (!allowHidden && relative(base, path).split(sep).some((part) => part.startsWith('.'))) {
        return null;
    }

    if (!existsSync(path) || !statSync(path).isFile() || !isInside(base, path)) {
        return null;
    }

    return path;
}
