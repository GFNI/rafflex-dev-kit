import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startDevServer, tokenHeader } from '../src/dev-server.js';
import { listingHash, optionOverridesHash, templateHash } from '../src/sync-state.js';
import { loadWorkspace } from '../src/workspace.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { fillPrompt } from '../src/app/prompts.js';
import { addProduct, fixtureDocuments, fixturePrompts, stubPrompts, temporaryDirectory, temporaryWorkspace } from './helpers/project.js';

const documents = fixtureDocuments();
const loaded = { documents, warnings: [], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' };
const template = '<p>{{ play_count }}</p>\n';
const prompts = fixturePrompts().prompts;

/**
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>, body?: string}} [options]
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: string, json: () => any}>}
 */
function send(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const outgoing = request(url, { method, headers }, (response) => {
            let text = '';

            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                text += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text, json: () => JSON.parse(text) }));
        });

        outgoing.on('error', reject);
        outgoing.end(body);
    });
}

/**
 * @param {Awaited<ReturnType<typeof startDevServer>>} server
 * @param {string} path
 * @param {unknown} [body]
 */
function act(server, path, body = {}) {
    return send(`${server.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [tokenHeader]: server.token }, body: JSON.stringify(body) });
}

/**
 * Listen to the app's event stream.
 *
 * @param {string} url
 */
function listen(url) {
    /** @type {{event: string, data: any}[]} */
    const events = [];
    let buffer = '';
    /** @type {import('node:http').IncomingMessage|null} */
    let stream = null;

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
    }).on('error', () => {}).end();

    return {
        events,
        /**
         * @param {(event: {event: string, data: any}) => boolean} predicate
         * @param {number} [timeout]
         */
        waitFor(predicate, timeout = 20000) {
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

describe('the app on localhost', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let fixtures;
    /** @type {string} */
    let root;
    /** @type {Awaited<ReturnType<typeof startDevServer>>} */
    let server;
    /** @type {string[]} */
    const opened = [];

    before(async () => {
        fixtures = await startFixtureServer();
        root = temporaryWorkspace({
            config: { base_url: fixtures.baseUrl },
            products: [
                { title: 'Brand New', template, changelog: '# Changelog\n\n## Unreleased\n\nAdded a spinning wheel.\n' },
                { title: 'Spin to Win', slug: 'spin-to-win', version: '1.1.0', template, remote: remote({ draft: { ...remote({}).draft, submitted: true } }) },
                { title: 'Scratch Card', slug: 'scratch-card', version: '1.1.0', template, remote: remote({ latest_review: { version: '1.1.0', decision: 'changes_requested' } }) },
                { title: 'Live One', slug: 'live-one', version: '1.0.0', template, remote: remote({ draft: { ...remote({}).draft, version: '1.0.0' } }) },
                { title: 'Ready One', slug: 'ready-one', version: '1.1.0', template, remote: remote({}) },
                { type: 'block', title: 'Winner Wall', template },
            ],
        });
        server = await startDevServer({
            workspace: loadWorkspace(root),
            loaded,
            port: 0,
            watchFiles: false,
            prompts: stubPrompts(),
            detect: () => ['claude-code'],
            tests: { command: 'check', env: { ...process.env, RAFFLEX_BASE_URL: fixtures.baseUrl } },
            openFolderImpl: (directory) => {
                opened.push(directory);

                return true;
            },
        });
    });

    after(async () => {
        await server.close();
        await fixtures.close();
    });

    test('refuses requests for another host name, including actions', async () => {
        const headers = { Host: 'attacker.example:80', 'Content-Type': 'application/json', [tokenHeader]: server.token };

        assert.equal((await send(server.url, { headers: { Host: 'attacker.example' } })).status, 403);
        assert.equal((await send(`${server.url}__rafflex/actions/new`, { method: 'POST', headers, body: '{"type":"game","title":"X"}' })).status, 403);
        assert.equal(existsSync(join(root, 'games', 'x')), false);
    });

    test('refuses actions without the start token, with a wrong one, or from another origin', async () => {
        const url = `${server.url}p/games/brand-new/__rafflex/actions/open-folder`;
        const json = { 'Content-Type': 'application/json' };
        const origin = server.url.replace(/\/$/, '');
        const oneCharacterOff = `${server.token.slice(0, -1)}${server.token.endsWith('0') ? '1' : '0'}`;

        assert.equal((await send(url, { method: 'POST', headers: json, body: '{}' })).status, 403);
        assert.equal((await send(url, { method: 'POST', headers: { ...json, [tokenHeader]: 'nope' }, body: '{}' })).status, 403);
        assert.equal((await send(url, { method: 'POST', headers: { ...json, [tokenHeader]: oneCharacterOff }, body: '{}' })).status, 403);
        assert.equal((await send(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', [tokenHeader]: server.token }, body: '{}' })).status, 403);
        assert.equal((await send(url, { method: 'POST', headers: { ...json, [tokenHeader]: server.token, Origin: 'https://attacker.example' }, body: '{}' })).status, 403);
        assert.deepEqual(opened, []);
        assert.equal((await send(url, { method: 'POST', headers: { ...json, [tokenHeader]: server.token, Origin: origin }, body: '{}' })).status, 200);
        assert.deepEqual(opened, [join(root, 'games', 'brand-new')]);
    });

    test('accepts POST only on action routes', async () => {
        assert.equal((await act(server, '')).status, 405);
        assert.equal((await act(server, '__rafflex/products')).status, 405);
        assert.equal((await act(server, 'p/games/brand-new/frame')).status, 405);
        assert.equal((await act(server, 'p/games/brand-new/__rafflex/actions/delete')).status, 404);
        assert.equal((await send(server.url, { method: 'DELETE' })).status, 405);
    });

    test('never opens or serves a folder outside the workspace', async () => {
        const outside = temporaryDirectory();

        writeFileSync(join(outside, 'secret.png'), 'outside');
        mkdirSync(join(root, 'games', 'brand-new', '.results'), { recursive: true });
        symlinkSync(join(outside, 'secret.png'), join(root, 'games', 'brand-new', 'assets', 'linked.png'));
        symlinkSync(join(outside, 'secret.png'), join(root, 'games', 'brand-new', '.results', 'linked.png'));
        symlinkSync(addProduct(temporaryWorkspace(), { title: 'Elsewhere', template }), join(root, 'games', 'linked-product'));

        const before = opened.length;

        assert.equal((await send(`${server.url}p/games/brand-new/assets/linked.png`)).status, 404);
        assert.equal((await send(`${server.url}p/games/brand-new/results/linked.png`)).status, 404);
        assert.equal((await send(`${server.url}p/games/brand-new/results/..%2F..%2Fspin-to-win%2Fproduct.json`)).status, 404);
        assert.equal((await send(`${server.url}p/games/brand-new/results/..%2Ftemplate.twig`)).status, 404);
        assert.equal((await act(server, 'p/games/..%2F..%2F/__rafflex/actions/open-folder')).status, 404);
        assert.equal((await act(server, 'p/games/linked-product/__rafflex/actions/open-folder')).status, 404);
        assert.equal((await send(`${server.url}p/games/linked-product/frame`)).status, 404);
        assert.equal((await send(`${server.url}p/games/linked-product/__rafflex/product`)).status, 404);
        assert.equal(opened.length, before);
    });

    test('serves screenshots from the product results folder only', async () => {
        const results = join(root, 'blocks', 'winner-wall', '.results');

        mkdirSync(join(results, 'screenshots'), { recursive: true });
        writeFileSync(join(results, 'screenshots', 'default-phone.png'), 'png bytes');
        writeFileSync(join(results, 'run.json'), '{}');

        const image = await send(`${server.url}p/blocks/winner-wall/results/screenshots/default-phone.png`);

        assert.equal(image.status, 200);
        assert.equal(image.headers['content-type'], 'image/png');
        assert.equal(image.body, 'png bytes');
        assert.equal((await send(`${server.url}p/blocks/winner-wall/results/run.json`)).status, 404);
    });

    test('Home shows the Get started prompt, the AI apps on this computer, and the health strip', async () => {
        const home = (await send(`${server.url}__rafflex/home`)).json();

        assert.equal(home.workspace, root);
        assert.match(home.get_started.text, /^Set me up to build for the Rafflex marketplace\./);
        assert.ok(home.get_started.description.length > 0);
        assert.deepEqual(home.clients.map((/** @type {any} */ client) => [client.key, client.detected]), [['claude-code', true], ['codex', false], ['cursor', false], ['vscode', false]]);
        assert.match(home.clients[0].connect, /^claude mcp add/);
        assert.equal(home.links.web_chat, 'https://marketplace.rafflex.io/get-started');
        assert.deepEqual(home.health.map((/** @type {any} */ item) => item.key), ['rules', 'kit', 'git']);
        assert.equal(home.health[0].ok, true);
        assert.match(home.health[1].label, /^Kit \d+\.\d+\.\d+/);
        assert.ok(home.new_product.build.includes('{title}'));
        assert.ok(home.new_product.ai_start.includes('{type}'));
        assert.equal(home.prompts_error, null);
    });

    test('the product view shows Get it live with the right next step for each state', async () => {
        const detail = async (/** @type {string} */ path) => (await send(`${server.url}p/${path}/__rafflex/product`)).json();
        const brandNew = await detail('games/brand-new');
        const inReview = await detail('games/spin-to-win');
        const changesRequested = await detail('games/scratch-card');
        const live = await detail('games/live-one');
        const ready = await detail('games/ready-one');

        assert.equal(brandNew.publish.state.label, 'Not pushed yet');
        assert.equal(brandNew.publish.prompt.key, 'get_it_live_first');
        assert.equal(brandNew.publish.prompt.text, fillPrompt(prompts.get_it_live_first.text, { title: 'Brand New', path: 'games/brand-new', version: '1.0.0' }));
        assert.ok(brandNew.publish.prompt.text.includes('submit 1.0.0 for review'));
        assert.equal(brandNew.publish.disabled, false);
        assert.equal(inReview.publish.state.label, 'In review');
        assert.equal(inReview.publish.prompt.key, 'check_review');
        assert.equal(changesRequested.publish.state.label, 'Changes requested');
        assert.equal(changesRequested.publish.prompt.key, 'fix_review');
        assert.equal(live.publish.state.label, 'Live 1.0.0');
        assert.equal(live.publish.prompt.key, 'next_version');
        assert.equal(ready.publish.prompt.key, 'get_it_live');
        assert.equal(ready.publish.prompt.text, fillPrompt(prompts.get_it_live.text, { title: 'Ready One', path: 'games/ready-one', slug: 'ready-one', version: '1.1.0' }));
        assert.ok(ready.publish.prompt.text.includes('submit 1.1.0 for review with the notes in CHANGELOG.md'));
    });

    test('the product view carries its prompts filled in, the changelog, and the preview controls', async () => {
        const brandNew = (await send(`${server.url}p/games/brand-new/__rafflex/product`)).json();
        const live = (await send(`${server.url}p/games/live-one/__rafflex/product`)).json();

        assert.deepEqual(brandNew.prompts.list.map((/** @type {any} */ prompt) => prompt.key), ['iterate', 'hand_to_ai']);
        assert.ok(brandNew.prompts.list[0].text.startsWith('Change Brand New in games/brand-new: [DESCRIBE THE CHANGE].'));
        assert.deepEqual(live.prompts.list.map((/** @type {any} */ prompt) => prompt.key), ['iterate', 'next_version', 'revert', 'hand_to_ai']);
        assert.ok(live.prompts.list[1].text.startsWith('Start the next version of Live One in games/live-one. The live version is 1.0.0.'));
        assert.equal(brandNew.changelog, 'Added a spinning wheel.');
        assert.equal(brandNew.test.label, 'Not tested');
        assert.equal(brandNew.result, null);
        assert.deepEqual(brandNew.scenarios, documents.contexts.scenarios);
    });

    test('Test runs the check, streams progress, and shows issues with fix prompts; Get it live waits for the fix', async () => {
        writeFileSync(join(root, 'games', 'brand-new', 'template.twig'), '<p>{{ plays|raw }}</p>\n');

        const events = listen(`${server.url}__rafflex/events`);

        try {
            await new Promise((resolve) => {
                setTimeout(resolve, 100);
            });

            const started = await act(server, 'p/games/brand-new/__rafflex/actions/test');

            assert.equal(started.status, 202);
            assert.equal((await act(server, 'p/games/brand-new/__rafflex/actions/test')).status, 409);

            const running = await events.waitFor((event) => event.event === 'test' && event.data.status === 'running');
            const done = await events.waitFor((event) => event.event === 'test' && event.data.status === 'done');

            assert.equal(running.data.product, 'games/brand-new');
            assert.match(running.data.line, /^Running check on games\/brand-new/);
            assert.equal(done.data.result.status, 'issues');
            assert.ok(done.data.result.blocking.length > 0);
        } finally {
            events.close();
        }

        const results = join(root, 'games', 'brand-new', '.results');

        assert.equal(readFileSync(join(results, '.gitignore'), 'utf8'), '*\n');
        assert.equal(JSON.parse(readFileSync(join(results, 'app-run.json'), 'utf8')).source, 'check');

        const detail = (await send(`${server.url}p/games/brand-new/__rafflex/product`)).json();
        const products = (await send(`${server.url}__rafflex/products`)).json().products;

        assert.equal(detail.test.label, 'Issues');
        assert.equal(detail.publish.disabled, true);
        assert.equal(detail.publish.next, 'Fix these first, or ask your AI to.');
        assert.equal(detail.publish.prompt.key, 'fix');
        assert.ok(detail.publish.prompt.text.startsWith('Fix these issues in Brand New (games/brand-new) from its last test:\n\n- '));
        assert.equal(detail.prompts.fix_issue.length, detail.result.blocking.length);
        assert.ok(detail.prompts.fix_issue[0].startsWith(`Fix this in Brand New (games/brand-new): ${detail.result.blocking[0].message}`));
        assert.deepEqual(detail.prompts.list.map((/** @type {any} */ prompt) => prompt.key), ['iterate', 'fix', 'hand_to_ai']);
        assert.equal(products.find((/** @type {any} */ product) => product.path === 'games/brand-new').test.label, 'Issues');
    });

    test('New product creates the folder from the starter skeleton and returns its page', async () => {
        const created = await act(server, '__rafflex/actions/new', { type: 'block', title: 'Countdown Clock' });
        const directory = join(root, 'blocks', 'countdown-clock');

        assert.equal(created.status, 200);
        assert.deepEqual(created.json(), { product: 'blocks/countdown-clock', url: '/p/blocks/countdown-clock/' });
        assert.equal(readFileSync(join(directory, 'template.twig'), 'utf8'), JSON.parse(readFileSync(new URL('./fixtures/endpoints/skeletons.json', import.meta.url), 'utf8')).block);
        assert.equal(JSON.parse(readFileSync(join(directory, 'product.json'), 'utf8')).title, 'Countdown Clock');
        assert.equal((await act(server, '__rafflex/actions/new', { type: 'block', title: 'Countdown Clock' })).status, 422);
        assert.equal((await act(server, '__rafflex/actions/new', { type: 'theme', title: 'Nope' })).status, 422);
        assert.equal((await act(server, '__rafflex/actions/new', { type: 'game', title: '   ' })).status, 422);
    });
});

describe('the app without prompts', () => {
    test('Home and the product view say the prompts did not load, and still work', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template }] });
        const server = await startDevServer({ workspace: loadWorkspace(root), loaded: { ...loaded, offline: true }, port: 0, watchFiles: false, prompts: stubPrompts(null), detect: () => [] });

        try {
            const home = (await send(`${server.url}__rafflex/home`)).json();
            const detail = (await send(`${server.url}p/games/spin-to-win/__rafflex/product`)).json();

            assert.equal(home.get_started, null);
            assert.deepEqual(home.clients, []);
            assert.match(home.prompts_error, /prompts/);
            assert.equal(home.health.find((/** @type {any} */ item) => item.key === 'rules').ok, false);
            assert.equal(home.health.find((/** @type {any} */ item) => item.key === 'prompts').ok, false);
            assert.deepEqual(detail.prompts.list, []);
            assert.equal(detail.publish.prompt, null);
            assert.equal(detail.publish.state.label, 'Not pushed yet');
        } finally {
            await server.close();
        }
    });
});

describe('the app with PRD 41 verify', () => {
    test('Test runs verify by default, streams its steps, and reads the result verify saved', async () => {
        const fixtures = await startFixtureServer();
        const root = temporaryWorkspace({ config: { base_url: fixtures.baseUrl }, products: [{ type: 'block', title: 'Winner Wall', template: '<p>{{ settings.site_name }}</p>\n' }] });
        const server = await startDevServer({ workspace: loadWorkspace(root), loaded, port: 0, watchFiles: false, prompts: stubPrompts(), detect: () => [], tests: { env: { ...process.env, RAFFLEX_BASE_URL: fixtures.baseUrl } } });
        const events = listen(`${server.url}__rafflex/events`);

        try {
            await new Promise((resolve) => {
                setTimeout(resolve, 100);
            });

            const started = await act(server, 'p/blocks/winner-wall/__rafflex/actions/test');

            assert.equal(started.json().command, 'verify');

            const done = await events.waitFor((event) => event.event === 'test' && event.data.status === 'done', 120000);
            const lines = events.events.filter((event) => event.event === 'test' && event.data.status === 'running').map((event) => event.data.line);

            assert.ok(lines.includes('Checking blocks/winner-wall in every scenario'), lines.join('\n'));
            assert.equal(done.data.result.source, 'verify');
            assert.equal(done.data.result.status, 'passed');
            assert.equal(JSON.parse(readFileSync(join(root, 'blocks', 'winner-wall', '.results', 'verify.json'), 'utf8')).product, 'blocks/winner-wall');
            assert.equal(existsSync(join(root, 'blocks', 'winner-wall', '.results', 'app-run.json')), false);
        } finally {
            events.close();
            await server.close();
            await fixtures.close();
        }
    });
});
