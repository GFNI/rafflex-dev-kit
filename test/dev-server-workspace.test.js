import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { classifyChange, startDevServer } from '../src/dev-server.js';
import { listingHash, optionOverridesHash, templateHash } from '../src/sync-state.js';
import { loadWorkspace } from '../src/workspace.js';
import { isolatedGitEnv } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { addProduct, fixtureDocuments, temporaryWorkspace } from './helpers/project.js';

const documents = fixtureDocuments();
const loaded = { documents, warnings: [], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' };
const template = '<p>{{ play_count }}</p>\n';

/**
 * @param {string} url
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: string}>}
 */
function get(url) {
    return new Promise((resolve, reject) => {
        request(url, (response) => {
            let body = '';

            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        }).on('error', reject).end();
    });
}

/**
 * Listen to an SSE stream and keep every event it sends.
 *
 * @param {string} url
 */
function listen(url) {
    /** @type {{event: string, data: any}[]} */
    const events = [];
    let buffer = '';
    /** @type {import('node:http').IncomingMessage|null} */
    let stream = null;
    const ready = new Promise((resolve) => {
        request(url, (response) => {
            stream = response;
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                buffer += chunk;

                const blocks = buffer.split('\n\n');

                buffer = blocks.pop() ?? '';

                for (const block of blocks) {
                    const event = block.match(/^event: (.+)$/m)?.[1];
                    const data = block.match(/^data: (.+)$/m)?.[1];

                    if (event !== undefined) {
                        events.push({ event, data: data === undefined ? null : JSON.parse(data) });
                    }
                }
            });
            resolve(true);
        }).on('error', () => {}).end();
    });

    return {
        events,
        ready,
        /**
         * @param {(event: {event: string, data: any}) => boolean} predicate
         * @param {number} [timeout]
         */
        waitFor(predicate, timeout = 5000) {
            return new Promise((resolve, reject) => {
                const started = Date.now();
                const check = () => {
                    const found = events.find(predicate);

                    if (found !== undefined) {
                        resolve(found);
                    } else if (Date.now() - started > timeout) {
                        reject(new Error(`no matching event in ${JSON.stringify(events)}`));
                    } else {
                        setTimeout(check, 20);
                    }
                };

                check();
            });
        },
        close: () => /** @type {import('node:http').IncomingMessage|null} */ (stream)?.destroy(),
    };
}

/**
 * @param {number} milliseconds
 */
function pause(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * @param {Partial<import('../src/workspace.js').ProductRemote>} overrides
 */
function remote(overrides) {
    return {
        synced_at: new Date().toISOString(),
        status: 'published',
        live_version: '1.0.0',
        live_channel: 'stable',
        draft: { version: '1.1.0', revision: 3, submitted: false, template_sha256: templateHash(template), option_overrides_sha256: optionOverridesHash({}) },
        listing_sha256: listingHash({}),
        latest_review: null,
        media: [],
        ...overrides,
    };
}

describe('workspace index', () => {
    /** @type {string} */
    let root;
    /** @type {Awaited<ReturnType<typeof startDevServer>>} */
    let server;

    before(async () => {
        root = temporaryWorkspace({
            products: [
                { title: 'Brand New', template },
                { title: 'Spin to Win', slug: 'spin-to-win', version: '1.1.0', template, remote: remote({ draft: { ...remote({}).draft, submitted: true } }) },
                { title: 'Scratch Card', slug: 'scratch-card', version: '1.1.0', template: '<p>edited</p>', remote: remote({ latest_review: { version: '1.1.0', decision: 'changes_requested', notes: 'Fix it' } }) },
                { type: 'block', title: 'Winner Wall', slug: 'winner-wall', template },
            ],
        });
        server = await startDevServer({ workspace: loadWorkspace(root), loaded, port: 0, watchFiles: false });
    });

    after(() => server.close());

    test('serves the index page at the root', async () => {
        const page = await get(server.url);

        assert.equal(page.status, 200);
        assert.match(page.body, /<title>Rafflex workspace<\/title>/);
        assert.match(page.body, /src="\/__rafflex\/workspace\.js"/);
        assert.equal((await get(`${server.url}__rafflex/workspace.js`)).status, 200);
    });

    test('lists every product with its version, remote state, and local changes', async () => {
        const payload = JSON.parse((await get(`${server.url}__rafflex/products`)).body);
        const byPath = Object.fromEntries(payload.products.map((/** @type {any} */ product) => [product.path, product]));

        assert.deepEqual(payload.products.map((/** @type {any} */ product) => product.path), ['games/brand-new', 'games/scratch-card', 'games/spin-to-win', 'blocks/winner-wall']);
        assert.equal(byPath['games/brand-new'].url, '/p/games/brand-new/');
        assert.equal(byPath['games/brand-new'].remote.pushed, false);
        assert.equal(byPath['games/brand-new'].local, null);

        assert.equal(byPath['games/spin-to-win'].version, '1.1.0');
        assert.equal(byPath['games/spin-to-win'].remote.live_version, '1.0.0');
        assert.equal(byPath['games/spin-to-win'].remote.in_review, true);
        assert.equal(byPath['games/spin-to-win'].remote.review, null);
        assert.deepEqual(byPath['games/spin-to-win'].local, { changed: [] });

        assert.equal(byPath['games/scratch-card'].remote.in_review, false);
        assert.deepEqual(byPath['games/scratch-card'].remote.review, { decision: 'changes_requested', version: '1.1.0' });
        assert.deepEqual(byPath['games/scratch-card'].local, { changed: ['template'] });

        assert.equal(byPath['blocks/winner-wall'].type, 'block');
        assert.equal(byPath['blocks/winner-wall'].remote.pushed, true);
        assert.equal(byPath['blocks/winner-wall'].remote.synced, false);
    });

    test('an empty workspace shows how to create a product', async () => {
        const empty = await startDevServer({ workspace: loadWorkspace(temporaryWorkspace()), loaded, port: 0, watchFiles: false });

        try {
            const payload = JSON.parse((await get(`${empty.url}__rafflex/products`)).body);
            const page = await get(empty.url);

            assert.deepEqual(payload.products, []);
            assert.ok(page.body.includes('npx @rafflex/dev new game "My game"'));
        } finally {
            await empty.close();
        }
    });
});

describe('per product routes', () => {
    /** @type {string} */
    let root;
    /** @type {Awaited<ReturnType<typeof startDevServer>>} */
    let server;

    before(async () => {
        root = temporaryWorkspace({
            products: [
                { title: 'Alpha', template: `<img src="{{ files['background'] }}">`, assets: { 'background.png': 'alpha png' } },
                { title: 'Bravo', template: `<img src="{{ files['background'] }}">`, assets: { 'background.png': 'bravo png', 'secret.png': 'bravo only' } },
                { type: 'block', title: 'Alpha', template: '<p>block</p>' },
            ],
        });
        writeFileSync(join(root, 'games', 'outside.png'), 'outside');
        server = await startDevServer({ workspace: loadWorkspace(root), loaded, port: 0, watchFiles: false });
    });

    after(() => server.close());

    test('each product has its own page, config, frame, and files map', async () => {
        const alpha = `${server.url}p/games/alpha/`;
        const bravo = `${server.url}p/games/bravo/`;
        const alphaConfig = JSON.parse((await get(`${alpha}__rafflex/config`)).body);
        const blockConfig = JSON.parse((await get(`${server.url}p/blocks/alpha/__rafflex/config`)).body);

        assert.equal((await get(alpha)).status, 200);
        assert.equal(alphaConfig.path, 'games/alpha');
        assert.equal(alphaConfig.type, 'game');
        assert.equal(blockConfig.path, 'blocks/alpha');
        assert.equal(blockConfig.type, 'block');
        assert.match((await get(`${alpha}frame`)).body, /<img src="\/p\/games\/alpha\/assets\/background\.png">/);
        assert.match((await get(`${bravo}frame`)).body, /<img src="\/p\/games\/bravo\/assets\/background\.png">/);
        assert.equal((await get(`${alpha}assets/background.png`)).body, 'alpha png');
        assert.equal((await get(`${bravo}assets/background.png`)).body, 'bravo png');
        assert.equal(JSON.parse((await get(`${bravo}__rafflex/problems`)).body).files.length, 2);
    });

    test("a product's frame CSP reaches only its own assets", async () => {
        const csp = String((await get(`${server.url}p/games/alpha/frame`)).headers['content-security-policy']);
        const origin = server.url.replace(/\/$/, '');

        assert.ok(csp.includes(`img-src 'self' data: blob: ${origin}/p/games/alpha/assets/;`), csp);
        assert.equal(csp.includes('/p/games/bravo/'), false);
        assert.equal(new RegExp(`${origin}[ ;]`).test(csp), false, 'the bare origin is never allowed');
    });

    test('redirects to the trailing slash and refuses unknown products', async () => {
        const redirect = await get(`${server.url}p/games/alpha?scenario=all_win`);

        assert.equal(redirect.status, 308);
        assert.equal(redirect.headers.location, '/p/games/alpha/?scenario=all_win');
        assert.equal((await get(`${server.url}p/games/nope/`)).status, 404);
        assert.equal((await get(`${server.url}p/themes/alpha/`)).status, 404);
        assert.equal((await get(`${server.url}p/games/.hidden/`)).status, 404);
        assert.equal((await get(`${server.url}frame`)).status, 404);
        assert.equal((await get(`${server.url}assets/background.png`)).status, 404);
    });

    test('never serves another product, or anything outside the assets folder, through a product route', async () => {
        const alpha = `${server.url}p/games/alpha/`;

        for (const path of [
            'assets/..%2F..%2Fbravo%2Fassets%2Fsecret.png',
            'assets/%2E%2E%2F%2E%2E%2Fbravo%2Fassets%2Fsecret.png',
            'assets/..%5C..%5Cbravo%5Cassets%5Csecret.png',
            'assets/..%2F..%2Foutside.png',
            'assets/..%2Fproduct.json',
            'assets/secret.png',
        ]) {
            const response = await get(`${alpha}${path}`);

            assert.equal(response.status, 404, path);
            assert.notEqual(response.body, 'bravo only', path);
        }

        assert.equal((await get(`${server.url}p/games/..%2Fgames%2Fbravo/assets/secret.png`)).status, 404);
        assert.equal((await get(`${server.url}p/games/bravo/assets/secret.png`)).body, 'bravo only');
    });
});

describe('workspace watcher', () => {
    test('classifies changes by product and by preview relevance', () => {
        const workspace = loadWorkspace(temporaryWorkspace());

        assert.deepEqual(classifyChange(workspace, 'games/spin/template.twig'), [{ type: 'product', path: 'games/spin', preview: true }]);
        assert.deepEqual(classifyChange(workspace, 'games/spin/assets/bg.png'), [{ type: 'product', path: 'games/spin', preview: true }]);
        assert.deepEqual(classifyChange(workspace, 'games/spin/options.json'), [{ type: 'product', path: 'games/spin', preview: true }]);
        assert.deepEqual(classifyChange(workspace, 'games/spin/product.json'), [{ type: 'products' }, { type: 'product', path: 'games/spin', preview: true }]);
        assert.deepEqual(classifyChange(workspace, 'games/spin/listing.md'), [{ type: 'product', path: 'games/spin', preview: false }]);
        assert.deepEqual(classifyChange(workspace, 'games/spin'), [{ type: 'products' }, { type: 'product', path: 'games/spin', preview: true }]);
        assert.deepEqual(classifyChange(workspace, 'AGENTS.md'), []);
        assert.deepEqual(classifyChange(workspace, '.rafflex/cache/x.json'), []);
        assert.deepEqual(classifyChange(workspace, 'games/.DS_Store'), []);
    });

    for (const pollFiles of [false, true]) {
        test(`reloads only the changed product's preview, and refreshes the index (${pollFiles ? 'polling' : 'fs.watch'})`, async () => {
            const root = temporaryWorkspace({ products: [{ title: 'Alpha', template }, { title: 'Bravo', template }] });
            const server = await startDevServer({ workspace: loadWorkspace(root), loaded, port: 0, pollFiles });
            const alpha = listen(`${server.url}p/games/alpha/__rafflex/events`);
            const bravo = listen(`${server.url}p/games/bravo/__rafflex/events`);
            const index = listen(`${server.url}__rafflex/events`);

            try {
                await Promise.all([alpha.ready, bravo.ready, index.ready]);
                // Late file system events from creating the workspace must
                // settle first, even on a machine busy with browser tests.
                await pause(1000);

                writeFileSync(join(root, 'games', 'alpha', 'template.twig'), '<p>changed</p>');

                const reload = await alpha.waitFor((event) => event.event === 'reload');

                assert.equal(reload.data.product, 'games/alpha');
                await index.waitFor((event) => event.event === 'change' && event.data.path === 'games/alpha');

                writeFileSync(join(root, 'games', 'alpha', 'listing.md'), '---\n---\n');
                await index.waitFor((event) => event.event === 'change' && event.data.preview === false);

                addProduct(root, { title: 'Charlie', template });
                await index.waitFor((event) => event.event === 'products');
                await pause(pollFiles ? 700 : 300);

                assert.deepEqual(bravo.events.filter((event) => event.event === 'reload'), []);
                assert.equal(alpha.events.filter((event) => event.event === 'reload').length, 1, JSON.stringify(alpha.events));
            } finally {
                alpha.close();
                bravo.close();
                index.close();
                await server.close();
            }
        });
    }
});

describe('opening the preview', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let fixtures;
    const bin = fileURLToPath(new URL('../bin/rafflex-dev.js', import.meta.url));

    before(async () => {
        fixtures = await startFixtureServer();
    });

    after(() => fixtures.close());

    /**
     * Start the preview with --json, read the line it prints, and stop it.
     *
     * @param {string[]} args
     * @param {string} cwd
     * @returns {Promise<any>}
     */
    function startPreview(args, cwd) {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [bin, 'dev', ...args, '--json', '--no-open', '--port', '0'], { cwd, env: { ...process.env, ...isolatedGitEnv, RAFFLEX_BASE_URL: fixtures.baseUrl } });
            let output = '';
            const timeout = setTimeout(() => {
                child.kill();
                reject(new Error(`no output: ${output}`));
            }, 10000);

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                output += chunk;

                try {
                    const parsed = JSON.parse(output);

                    clearTimeout(timeout);
                    child.kill();
                    resolve(parsed);
                } catch {
                    // Not all of it yet.
                }
            });
            child.on('exit', () => {
                clearTimeout(timeout);
                reject(new Error(`exited early: ${output}`));
            });
        });
    }

    test('opens the product the command runs in, the one named, or the index', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win' }, { type: 'block', title: 'Winner Wall' }] });

        mkdirSync(join(root, 'games', 'spin-to-win', 'assets', 'nested'), { recursive: true });

        const inside = await startPreview([], join(root, 'games', 'spin-to-win', 'assets', 'nested'));
        const named = await startPreview(['winner-wall'], root);
        const atRoot = await startPreview([], root);
        const inTypeFolder = await startPreview([], join(root, 'games'));

        assert.equal(inside.product, 'games/spin-to-win');
        assert.match(inside.url, /^http:\/\/127\.0\.0\.1:\d+\/p\/games\/spin-to-win\/$/);
        assert.equal(inside.index_url, inside.url.replace('p/games/spin-to-win/', ''));
        assert.equal(named.product, 'blocks/winner-wall');
        assert.match(named.url, /\/p\/blocks\/winner-wall\/$/);
        assert.equal(atRoot.product, null);
        assert.equal(atRoot.url, atRoot.index_url);
        assert.match(atRoot.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
        assert.equal(inTypeFolder.product, null);
    });
});
