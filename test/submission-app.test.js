import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../src/dev-server.js';
import { loadWorkspace } from '../src/workspace.js';
import { fixtureDocuments, stubPrompts, temporaryWorkspace } from './helpers/project.js';

const documents = { ...fixtureDocuments(), categories: JSON.parse(readFileSync(new URL('./fixtures/endpoints/categories.json', import.meta.url), 'utf8')) };
const loaded = { documents, warnings: [], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' };
const html = readFileSync(new URL('../src/client/app.html', import.meta.url), 'utf8');
const png = (/** @type {string} */ text) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
function getJson(url) {
    return new Promise((resolve, reject) => {
        request(url, (response) => {
            let text = '';

            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                text += chunk;
            });
            response.on('end', () => resolve(JSON.parse(text)));
        }).on('error', reject).end();
    });
}

describe('Get it live lists what review still needs', () => {
    /** @type {Awaited<ReturnType<typeof startDevServer>>} */
    let server;
    /** @type {string} */
    let root;

    before(async () => {
        root = temporaryWorkspace({
            products: [
                { title: 'Bare Game', template: '<p>{{ play_count }}</p>\n' },
                { title: 'Ready Game', template: '<p>{{ play_count }}</p>\n', listing: '---\ncategory_ids: ["Arcade Games"]\n---\n\n## Description\n\nSpin it.\n' },
            ],
        });

        const directory = join(root, 'games', 'ready-game', 'listing');

        mkdirSync(join(directory, 'screenshots'), { recursive: true });
        writeFileSync(join(directory, 'cover.png'), png('cover'));
        writeFileSync(join(directory, 'screenshots', '01.png'), png('one'));

        server = await startDevServer({ workspace: loadWorkspace(root), loaded, port: 0, watchFiles: false, prompts: stubPrompts(), detect: () => [] });
    });

    after(() => server.close());

    test('the product view carries the missing items without disabling Get it live', async () => {
        const bare = await getJson(`${server.url}p/games/bare-game/__rafflex/product`);
        const ready = await getJson(`${server.url}p/games/ready-game/__rafflex/product`);

        assert.equal(bare.submission.ready, false);
        assert.deepEqual(bare.submission.missing.map((/** @type {any} */ entry) => entry.key), ['description', 'categories', 'cover_image', 'screenshots']);
        assert.equal(bare.submission.missing[2].message, 'Add a cover image before submitting for review.');
        assert.equal(bare.publish.disabled, false);
        assert.deepEqual(ready.submission, { ready: true, missing: [] });
    });

    test('the page shows the list in the Get it live step, apart from the blocking test reason', () => {
        const live = html.slice(html.indexOf('<!-- Get it live -->'), html.indexOf('<!-- Prompts -->'));

        assert.match(live, /x-if="product\.submission && !product\.submission\.ready"/);
        assert.match(live, /<strong>Before review<\/strong>/);
        assert.match(live, /x-for="\(item, index\) in product\.submission\.missing"/);
        assert.ok(live.indexOf('product.publish.reason') < live.indexOf('Before review'));
        assert.doesNotMatch(live.slice(live.indexOf('Before review'), live.indexOf('product.publish.prompt')), /disabled/);
    });
});
