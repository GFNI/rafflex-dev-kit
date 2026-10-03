import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { recordedMedia, scanAssets } from '../src/assets.js';
import { startDevServer } from '../src/dev-server.js';
import { ensureIgnored } from '../src/git.js';
import { loadWorkspace } from '../src/workspace.js';
import { isolatedGitEnv, runJson } from './helpers/cli.js';
import { fixtureDocuments, stubPrompts, temporaryProduct, temporaryWorkspace } from './helpers/project.js';
import { marketplaceProduct, sha256, startFakeMarketplace } from './helpers/sync-server.js';

const { rules } = fixtureDocuments();
const urlFor = (/** @type {string} */ path) => `/assets/${path}`;
const png = (/** @type {string} */ text) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from('logo-webp-data')]);

/**
 * The files map a product folder's assets give, with this marketplace media.
 *
 * @param {Record<string, string|Buffer>} assets
 * @param {{filename: string, tag: string}[]} media
 */
function filesFor(assets, media) {
    const directory = temporaryProduct({ assets });

    return scanAssets(join(directory, 'assets'), rules, [], urlFor, media).files;
}

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } }).trim();
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
function get(url) {
    return new Promise((resolve, reject) => {
        request(url, (response) => {
            let body = '';

            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => resolve(body));
        }).on('error', reject).end();
    });
}

describe('a file keeps its tag', () => {
    test('deleting a file never relabels another (logo.webp stays logo-2)', () => {
        const media = [{ filename: 'logo.png', tag: 'logo' }, { filename: 'logo.webp', tag: 'logo-2' }];

        assert.deepEqual(filesFor({ 'logo.png': 'a', 'logo.webp': 'b' }, media), { logo: '/assets/logo.png', 'logo-2': '/assets/logo.webp' });
        assert.deepEqual(filesFor({ 'logo.webp': 'b' }, media), { 'logo-2': '/assets/logo.webp' });
    });

    test('a file retagged on the marketplace keeps that tag', () => {
        assert.deepEqual(filesFor({ 'logo-final.png': 'a' }, [{ filename: 'logo-final.png', tag: 'hero' }]), { hero: '/assets/logo-final.png' });
    });

    test('a file import named after its tag keeps that tag', () => {
        assert.deepEqual(filesFor({ 'logo.png': 'a' }, [{ filename: 'logo-final.png', tag: 'logo' }]), { logo: '/assets/logo.png' });
    });

    test('a renamed file is a new file, and takes a tag no marketplace file holds', () => {
        const media = [{ filename: 'logo.png', tag: 'logo' }];

        assert.deepEqual(filesFor({ 'brand.png': 'a' }, media), { brand: '/assets/brand.png' });
        assert.deepEqual(filesFor({ 'logo.webp': 'a' }, media), { 'logo-2': '/assets/logo.webp' });
    });

    test('a new file whose stem is a marketplace tag is suffixed past it', () => {
        const media = [{ filename: 'hero-art.png', tag: 'hero' }];

        assert.deepEqual(filesFor({ 'hero-art.png': 'a', 'hero.png': 'b' }, media), { hero: '/assets/hero-art.png', 'hero-2': '/assets/hero.png' });
        assert.deepEqual(filesFor({ 'hero.jpg': 'b' }, media), { 'hero-2': '/assets/hero.jpg' });
        assert.deepEqual(filesFor({ 'logo.png': 'a', 'logo.webp': 'b' }, [{ filename: 'logo.png', tag: 'logo' }]), { logo: '/assets/logo.png', 'logo-2': '/assets/logo.webp' });
    });

    test('two new files with one stem skip every tag already taken', () => {
        const media = [{ filename: 'other.png', tag: 'win-2' }];

        assert.deepEqual(filesFor({ 'win.png': 'a', 'win.mp3': 'b', 'other.png': 'c' }, media), {
            'win-2': '/assets/other.png',
            win: '/assets/win.mp3',
            'win-3': '/assets/win.png',
        });
    });

    test('a product never pushed is tagged by file name, as before', () => {
        assert.deepEqual(filesFor({ 'Background.png': 'a', 'background.jpg': 'b' }, []), { background: '/assets/Background.png', 'background-2': '/assets/background.jpg' });
        assert.deepEqual(recordedMedia({ manifest: { remote: null } }), []);
    });
});

describe('deleting a released file leaves the others working', () => {
    test('check, plan, and the preview keep files[logo-2] and blame nothing', async () => {
        const marketplace = await startFakeMarketplace();

        try {
            const template = `<img src="{{ files['logo-2'] }}" alt="Logo">\n`;
            const media = [
                { filename: 'logo.png', tag: 'logo', sha256: sha256(png('logo')), kind: 'image', locked: true, size_bytes: png('logo').length, url: 'https://static.example/logo.png', library: null },
                { filename: 'logo.webp', tag: 'logo-2', sha256: sha256(webp), kind: 'image', locked: false, size_bytes: webp.length, url: 'https://static.example/logo.webp', library: null },
            ];

            marketplace.seed(marketplaceProduct({ slug: 'logos', title: 'Logos', media, draft: { version: '1.1.0', revision: 1, channel: 'stable', changelog: null, template, option_overrides: {}, submitted: false } }));

            const root = temporaryWorkspace({ products: [{ title: 'Logos', slug: 'logos', template, assets: { 'logo.png': png('logo'), 'logo.webp': webp } }] });
            const directory = join(root, 'games', 'logos');

            ensureIgnored(root);
            git(root, ['init', '-q', '-b', 'main']);
            git(root, ['add', '-A']);
            git(root, ['commit', '-q', '-m', 'Scaffold']);
            assert.equal((await runJson(['synced', 'logos', marketplace.issueLink('logos')], { cwd: root, baseUrl: marketplace.baseUrl })).code, 0);
            rmSync(join(directory, 'assets', 'logo.png'));

            const check = await runJson(['check', 'logos'], { cwd: root, baseUrl: marketplace.baseUrl });
            const codes = check.output.issues.map((/** @type {{code: string}} */ issue) => issue.code);

            assert.equal(codes.includes('unknown_file_tag'), false);
            assert.equal(codes.includes('asset_locked'), false);

            const plan = await runJson(['plan', 'logos'], { cwd: root, baseUrl: marketplace.baseUrl });

            assert.deepEqual(plan.output.assets, []);
            assert.deepEqual(plan.output.refusals, []);
            assert.deepEqual(plan.output.removed_assets, [{ tag: 'logo', filename: 'logo.png' }]);

            const workspace = loadWorkspace(root);
            const server = await startDevServer({ workspace, loaded: { documents: fixtureDocuments(), warnings: [], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' }, port: 0, watchFiles: false, prompts: stubPrompts(), detect: () => [] });

            try {
                assert.match(await get(`${server.url}p/games/logos/frame`), /<img src="\/p\/games\/logos\/assets\/logo\.webp" alt="Logo"/);
            } finally {
                server.close();
            }
        } finally {
            marketplace.close();
        }
    });

    test('a locked file is matched by its own name, never by a tag it shares', async () => {
        const marketplace = await startFakeMarketplace();

        try {
            const template = `<img src="{{ files['logo'] }}" alt="Logo">\n`;
            const media = [{ filename: 'logo.png', tag: 'logo', sha256: sha256(png('logo')), kind: 'image', locked: true, size_bytes: png('logo').length, url: 'https://static.example/logo.png', library: null }];

            marketplace.seed(marketplaceProduct({ slug: 'locked', title: 'Locked', media, draft: { version: '1.1.0', revision: 1, channel: 'stable', changelog: null, template, option_overrides: {}, submitted: false } }));

            const root = temporaryWorkspace({ products: [{ title: 'Locked', slug: 'locked', template, assets: { 'logo.png': png('logo') } }] });
            const directory = join(root, 'games', 'locked');

            assert.equal((await runJson(['synced', 'locked', marketplace.issueLink('locked')], { cwd: root, baseUrl: marketplace.baseUrl })).code, 0);
            rmSync(join(directory, 'assets', 'logo.png'));
            writeFileSync(join(directory, 'assets', 'logo.webp'), webp);

            const renamed = await runJson(['plan', 'locked'], { cwd: root, baseUrl: marketplace.baseUrl });

            assert.deepEqual(renamed.output.refusals, []);
            assert.deepEqual(renamed.output.assets.map((/** @type {{path: string, tag: string, change: string}} */ asset) => [asset.path, asset.tag, asset.change]), [['assets/logo.webp', 'logo-2', 'new']]);

            rmSync(join(directory, 'assets', 'logo.webp'));
            writeFileSync(join(directory, 'assets', 'logo.png'), png('logo changed'));

            const changed = await runJson(['plan', 'locked'], { cwd: root, baseUrl: marketplace.baseUrl });

            assert.deepEqual(changed.output.refusals.map((/** @type {{code: string, path: string}} */ refusal) => [refusal.code, refusal.path]), [['asset_locked', 'assets/logo.png']]);
            assert.equal(JSON.parse(readFileSync(join(directory, 'product.json'), 'utf8')).remote.media[0].tag, 'logo');
        } finally {
            marketplace.close();
        }
    });
});
