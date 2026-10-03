import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { versionAfterSync } from '../src/commands/synced.js';
import { compareWithRemote, listingHash, optionOverridesHash, remoteFromProduct, templateHash, unwrapProductPayload } from '../src/sync-state.js';
import { bundleFixture } from './helpers/bundles.js';
import { runJson } from './helpers/cli.js';
import { temporaryWorkspace } from './helpers/project.js';

const spin = bundleFixture('spin-to-win', 'https://media.example').product;
const wall = bundleFixture('winner-wall', 'https://media.example').product;

/**
 * @param {string} root
 * @param {string} path
 */
function productJson(root, path) {
    return JSON.parse(readFileSync(join(root, path, 'product.json'), 'utf8'));
}

describe('synced', () => {
    test('records the get_product result, the slug, and renames the title named folder', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win!', folder: 'spin-to-win-draft', version: '1.0.0' }] });
        const { code, output } = await runJson(['synced', 'spin-to-win-draft'], { cwd: root, input: JSON.stringify(spin) });

        assert.equal(code, 0, JSON.stringify(output));
        assert.equal(output.product, 'games/spin-to-win');
        assert.equal(output.previous_product, 'games/spin-to-win-draft');
        assert.equal(output.renamed, true);
        assert.equal(output.version, '1.3.0');
        assert.equal(output.previous_version, '1.0.0');
        assert.equal(existsSync(join(root, 'games', 'spin-to-win-draft')), false);

        const written = productJson(root, 'games/spin-to-win');

        assert.equal(written.slug, 'spin-to-win');
        assert.equal(written.version, '1.3.0');
        assert.equal(written.title, 'Spin to Win!');
        assert.ok(Math.abs(Date.parse(written.remote.synced_at) - Date.now()) < 60000);
        assert.deepEqual(written.remote.draft, {
            version: '1.3.0',
            revision: 7,
            submitted: false,
            template_sha256: templateHash(spin.draft.template),
            option_overrides_sha256: optionOverridesHash(spin.draft.option_overrides, spin.draft.template),
        });
        assert.equal(written.remote.live_version, '1.2.0');
        assert.equal(written.remote.live_channel, 'stable');
        assert.equal(written.remote.live, null);
        assert.deepEqual(written.remote.latest_review, spin.latest_review);
        assert.deepEqual(written.remote.media.map((/** @type {any} */ entry) => entry.tag), ['background', 'logo', 'win-jingle', 'three']);
    });

    test('accepts an MCP tool result, a JSON-RPC response, and a text content block', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Winner Wall', type: 'block', slug: 'winner-wall', version: '1.0.0' }] });

        for (const envelope of [
            { structuredContent: wall, content: [] },
            { jsonrpc: '2.0', id: 1, result: { structuredContent: wall } },
            { content: [{ type: 'text', text: JSON.stringify(wall) }] },
        ]) {
            const { code, output } = await runJson(['synced', 'winner-wall'], { cwd: root, input: JSON.stringify(envelope) });

            assert.equal(code, 0, JSON.stringify(output));
            assert.equal(output.remote.status, 'published');
        }
    });

    test('a live only product records the live baseline and moves to the next minor', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Winner Wall', type: 'block', slug: 'winner-wall', version: '1.0.0' }] });
        const { output } = await runJson(['synced', 'winner-wall'], { cwd: root, input: JSON.stringify(wall) });

        assert.equal(output.version, '1.1.0');
        assert.deepEqual(output.remote.live, { version: '1.0.0', template_sha256: wall.versions[0].template_sha256, option_overrides_sha256: optionOverridesHash({}) });
        assert.equal(productJson(root, 'blocks/winner-wall').version, '1.1.0');
    });

    test('refuses a result for another product or type, and input that is not a result', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win' }, { title: 'Winner Wall', type: 'block' }] });
        const otherSlug = await runJson(['synced', 'spin-to-win'], { cwd: root, input: JSON.stringify({ ...spin, slug: 'other-game' }) });
        const otherType = await runJson(['synced', 'winner-wall'], { cwd: root, input: JSON.stringify(spin) });
        const empty = await runJson(['synced', 'spin-to-win'], { cwd: root, input: '' });
        const notProduct = await runJson(['synced', 'spin-to-win'], { cwd: root, input: '{"items": []}' });

        assert.equal(otherSlug.code, 1);
        assert.match(otherSlug.output.error, /is for other-game, but games\/spin-to-win is spin-to-win/);
        assert.equal(otherType.code, 1);
        assert.match(otherType.output.error, /is for a game \(spin-to-win\), but blocks\/winner-wall is a block/);
        assert.equal(empty.code, 2);
        assert.match(empty.output.error, /Pipe the get_product result/);
        assert.equal(notProduct.code, 2);
        assert.equal(productJson(root, 'games/spin-to-win').remote, null);
    });

    test('keeps the folder when the slug folder is already taken', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin', folder: 'spin' }, { title: 'Spin to Win', folder: 'spin-to-win', slug: null }] });
        const { code, output } = await runJson(['synced', 'spin'], { cwd: root, input: JSON.stringify(spin) });

        assert.equal(code, 0);
        assert.equal(output.renamed, false);
        assert.match(output.notes[0], /games\/spin-to-win already exists/);
        assert.equal(productJson(root, 'games/spin').slug, 'spin-to-win');
    });
});

describe('mapping get_product to remote', () => {
    test('hashes empty option overrides the same whether the platform sent [] or {}', () => {
        const fromArray = remoteFromProduct({ ...spin, draft: { ...spin.draft, option_overrides: [] } });
        const fromObject = remoteFromProduct({ ...spin, draft: { ...spin.draft, option_overrides: {} } });

        assert.equal(fromArray.draft?.option_overrides_sha256, fromObject.draft?.option_overrides_sha256);
        assert.equal(fromArray.draft?.option_overrides_sha256, optionOverridesHash({}));
    });

    test('hashes the listing with trimmed bodies, sorted ids and tags, and nulls as empty', () => {
        const remote = remoteFromProduct({ ...wall, description: '\n Shows recent winners. \n', documentation: null, categories: [{ id: 9 }, { id: 2 }], tags: ['b', 'a'] });

        assert.equal(remote.listing_sha256, listingHash({ description: 'Shows recent winners.', install_notes: 'Place it under the competition.', category_ids: [2, 9], tag_names: ['a', 'b'] }));
    });

    test('a server without version hashes leaves the live baseline null, so the template counts as changed', () => {
        const remote = remoteFromProduct({ ...wall, versions: [{ version: '1.0.0', channel: 'stable', published_at: null }] });

        assert.deepEqual(remote.live, { version: '1.0.0', template_sha256: null, option_overrides_sha256: null });
    });

    test('without a draft the template and options compare with the live baseline', () => {
        const remote = remoteFromProduct(wall);
        const template = '<ul class="wall">\n    {% for winner in winners %}\n    <li>{{ winner.name }}</li>\n    {% endfor %}\n</ul>\n';
        const local = /** @type {any} */ ({ template: { text: template, sha256: templateHash(template) }, options: { value: {}, sha256: optionOverridesHash({}) }, listing: { fields: {}, sha256: remote.listing_sha256 }, assets: [], refusals: [] });

        assert.deepEqual([compareWithRemote(local, remote).template, compareWithRemote(local, remote).options], [false, false]);
        assert.equal(compareWithRemote(local, { ...remote, live: { version: '1.0.0', template_sha256: null, option_overrides_sha256: null } }).template, true);
    });

    test('keeps only tagged media and records a library by name', () => {
        const remote = remoteFromProduct(spin);

        assert.equal(remote.media.length, 4);
        assert.equal(remote.media[3].library, 'three.js');
        assert.equal(remote.media[0].library, null);
    });

    test('finds the product in any envelope', () => {
        assert.equal(unwrapProductPayload({ format: 1, product: spin })?.slug, 'spin-to-win');
        assert.equal(unwrapProductPayload({ result: { content: [{ type: 'text', text: 'not json' }] } }), null);
        assert.equal(unwrapProductPayload([spin]), null);
    });

    test('the version follows the draft, else moves past the live version', () => {
        const remote = /** @type {any} */ ({ draft: null, live_version: '1.2.0' });

        assert.equal(versionAfterSync('1.0.0', /** @type {any} */ ({ draft: { version: '1.4.0' }, live_version: '1.2.0' })), '1.4.0');
        assert.equal(versionAfterSync('1.2.0', remote), '1.3.0');
        assert.equal(versionAfterSync('2.0.0', remote), '2.0.0');
        assert.equal(versionAfterSync('1.0.0', /** @type {any} */ ({ draft: null, live_version: null })), '1.0.0');
    });
});
