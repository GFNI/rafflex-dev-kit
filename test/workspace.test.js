import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { bumpVersion, compareVersions, isVersion } from '../src/semver.js';
import {
    assetTypesFrom,
    defaultAssetTypes,
    findWorkspaceRoot,
    formatProductJson,
    legacyLayoutMessage,
    listProducts,
    loadWorkspace,
    readProductJson,
    selectProducts,
    withManifest,
    WorkspaceError,
    writeProductJson,
} from '../src/workspace.js';
import { addProduct, temporaryDirectory, temporaryWorkspace } from './helpers/project.js';

describe('workspace root', () => {
    test('is the nearest rafflex.json with workspace 1', () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win' }] });
        const deep = join(root, 'games', 'spin-to-win', 'assets');

        assert.equal(findWorkspaceRoot(deep), root);
        assert.equal(loadWorkspace(deep).root, root);
        assert.equal(findWorkspaceRoot(temporaryDirectory()), null);
    });

    test('refuses the old single project layout with the contract message', () => {
        const directory = temporaryDirectory();

        writeFileSync(join(directory, 'rafflex.json'), JSON.stringify({ type: 'game', product: null }));
        mkdirSync(join(directory, 'assets'));

        assert.throws(() => loadWorkspace(join(directory, 'assets')), (error) => error instanceof WorkspaceError && error.message === legacyLayoutMessage);
    });

    test('refuses a workspace newer than the kit and a rafflex.json that is not a workspace', () => {
        const newer = temporaryWorkspace({ config: { workspace: 2 } });
        const other = temporaryDirectory();

        writeFileSync(join(other, 'rafflex.json'), '{}');

        assert.throws(() => loadWorkspace(newer), /npx @rafflex\/dev@latest/);
        assert.throws(() => loadWorkspace(other), /not a Rafflex workspace/);
    });

    test('outside any workspace says to run init', () => {
        assert.throws(() => loadWorkspace(temporaryDirectory()), /npx @rafflex\/dev init/);
    });
});

describe('asset types', () => {
    test('come from the manifest, keeping only safe folder names', () => {
        assert.deepEqual(assetTypesFrom({ endpoints: {}, asset_types: [{ value: 'code', folder: 'code', label: 'Code' }, { value: 'bad', folder: '../x' }] }), [{ value: 'code', folder: 'code', label: 'Code' }]);
    });

    test('fall back to games and blocks with no manifest or cache', () => {
        assert.deepEqual(assetTypesFrom(null), defaultAssetTypes);
        assert.deepEqual(loadWorkspace(temporaryWorkspace()).assetTypes, defaultAssetTypes);
    });

    test('a new type from the manifest is a new top level folder', () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win' }] });

        mkdirSync(join(root, 'code', 'ticker'), { recursive: true });
        writeFileSync(join(root, 'code', 'ticker', 'product.json'), JSON.stringify({ type: 'code', slug: null, title: 'Ticker', version: '1.0.0', remote: null }));

        const workspace = withManifest(loadWorkspace(root), { endpoints: {}, asset_types: [...defaultAssetTypes, { value: 'code', folder: 'code', label: 'Code' }] });

        assert.deepEqual(listProducts(workspace).map((product) => [product.path, product.type]), [['games/spin-to-win', 'game'], ['code/ticker', 'code']]);
    });
});

describe('products', () => {
    const root = temporaryWorkspace({
        products: [
            { title: 'Spin to Win', slug: 'spin-to-win-pro' },
            { title: 'Scratch Card' },
            { type: 'block', title: 'Winner Wall', slug: 'winner-wall' },
            { type: 'block', title: 'Scratch Card', folder: 'scratch-card' },
        ],
    });

    mkdirSync(join(root, 'games', 'not-a-product'));
    mkdirSync(join(root, 'games', '.hidden'));
    const workspace = loadWorkspace(root);

    test('are the folders with a product.json under each type folder', () => {
        assert.deepEqual(listProducts(workspace).map((product) => product.path), ['games/scratch-card', 'games/spin-to-win', 'blocks/scratch-card', 'blocks/winner-wall']);
    });

    test('resolve by slug, folder name, or path', () => {
        const select = (/** @type {string[]} */ names) => selectProducts(workspace, { names, cwd: root }).map((product) => product.path);

        assert.deepEqual(select(['spin-to-win-pro']), ['games/spin-to-win']);
        assert.deepEqual(select(['spin-to-win']), ['games/spin-to-win']);
        assert.deepEqual(select(['blocks/scratch-card/']), ['blocks/scratch-card']);
        assert.deepEqual(select(['winner-wall', 'winner-wall']), ['blocks/winner-wall']);
        assert.throws(() => select(['scratch-card']), /matches more than one product \(games\/scratch-card, blocks\/scratch-card\)/);
        assert.throws(() => select(['missing']), /No product "missing"/);
    });

    test('default to the product containing the working folder', () => {
        assert.deepEqual(selectProducts(workspace, { cwd: join(root, 'blocks', 'winner-wall', 'assets') }).map((product) => product.path), ['blocks/winner-wall']);
        assert.throws(() => selectProducts(workspace, { cwd: root }), /Name a product/);
        assert.equal(selectProducts(workspace, { cwd: root, fallback: 'all' }).length, 4);
        assert.equal(selectProducts(workspace, { cwd: join(root, 'blocks', 'winner-wall'), all: true }).length, 4);
    });
});

describe('product.json', () => {
    test('is written in a stable key order with two space indentation and a newline', () => {
        const directory = addProduct(temporaryWorkspace(), { title: 'Spin to Win' });

        writeProductJson(directory, {
            remote: {
                media: [{ sha256: 'abc', tag: 'bg', kind: 'image', filename: 'bg.png', library: null }],
                draft: { submitted: false, revision: 3, version: '1.1.0', option_overrides_sha256: 'o', template_sha256: 't' },
                synced_at: '2026-10-02T10:00:00Z',
                listing_sha256: 'l',
                status: 'published',
                live_version: '1.0.0',
                live_channel: 'stable',
                latest_review: null,
            },
            version: '1.1.0',
            title: 'Spin to Win',
            type: 'game',
            slug: 'spin-to-win',
        });

        const text = readFileSync(join(directory, 'product.json'), 'utf8');
        const data = JSON.parse(text);

        assert.ok(text.startsWith('{\n  "type": "game",\n  "slug": "spin-to-win",\n  "title": "Spin to Win",\n  "version": "1.1.0",\n  "remote": {\n    "synced_at"'));
        assert.ok(text.endsWith('}\n'));
        assert.deepEqual(Object.keys(data.remote), ['synced_at', 'status', 'live_version', 'live_channel', 'draft', 'listing_sha256', 'latest_review', 'media']);
        assert.deepEqual(Object.keys(data.remote.draft), ['version', 'revision', 'submitted', 'template_sha256', 'option_overrides_sha256']);
        assert.deepEqual(Object.keys(data.remote.media[0]), ['tag', 'filename', 'sha256', 'kind', 'library']);
        assert.equal(formatProductJson(readProductJson(directory)), text);
    });

    test('fills missing fields when read', () => {
        const directory = addProduct(temporaryWorkspace(), { title: 'Spin to Win' });

        writeFileSync(join(directory, 'product.json'), JSON.stringify({ type: 'game' }));

        assert.deepEqual(readProductJson(directory), { type: 'game', slug: null, title: 'spin-to-win', version: '1.0.0', remote: null });
    });
});

describe('versions', () => {
    test('validate, compare, and bump major.minor.patch', () => {
        assert.equal(isVersion('1.2.3'), true);
        assert.equal(isVersion('1.02.3'), false);
        assert.equal(isVersion('1.2'), false);
        assert.equal(isVersion('1.2.3-beta'), false);
        assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
        assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
        assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
        assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
    });
});
