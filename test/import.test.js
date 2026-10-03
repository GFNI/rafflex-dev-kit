import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { importedVersion, localFilenameFor, parseBundle } from '../src/commands/import.js';
import { listingHash, optionOverridesHash, templateHash } from '../src/sync-state.js';
import { bundleFile, bundleFixture, serveFixtureMedia } from './helpers/bundles.js';
import { run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { startMediaServer } from './helpers/media-server.js';
import { temporaryWorkspace } from './helpers/project.js';

const sha = (/** @type {string|Buffer} */ data) => createHash('sha256').update(data).digest('hex');

describe('import', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let marketplace;
    /** @type {Awaited<ReturnType<typeof startMediaServer>>} */
    let media;

    before(async () => {
        marketplace = await startFixtureServer();
        media = await startMediaServer();
        serveFixtureMedia(media);
    });

    after(async () => {
        await marketplace.close();
        await media.close();
    });

    test('writes a product with a draft from a bundle file, and plan then has nothing to push', async () => {
        const root = temporaryWorkspace();
        const bundle = bundleFixture('spin-to-win', media.baseUrl);
        const { code, output } = await runJson(['import', bundleFile(bundle)], { cwd: root, baseUrl: marketplace.baseUrl });
        const directory = join(root, 'games', 'spin-to-win');

        assert.equal(code, 0, JSON.stringify(output));
        assert.deepEqual({ ...output, assets: undefined, git: undefined }, {
            product: 'games/spin-to-win',
            slug: 'spin-to-win',
            type: 'game',
            title: 'Spin to Win',
            version: '1.3.0',
            template_source: 'draft',
            replaced: null,
            files: ['template.twig', 'options.json', 'listing.md', 'CHANGELOG.md'],
            assets: undefined,
            skipped: [{ filename: 'untagged.png', reason: 'It has no tag, so no template can use it.' }],
            git: undefined,
        });
        assert.equal(output.git.repository, false);
        assert.deepEqual(output.assets.map((/** @type {any} */ asset) => [asset.path, asset.tag]), [
            ['assets/background.png', 'background'],
            ['assets/logo.png', 'logo'],
            ['assets/Win Jingle.mp3', 'win-jingle'],
            ['assets/three.module.min.js', 'three'],
        ]);

        for (const name of ['template.twig', 'options.json', 'listing.md', 'CHANGELOG.md']) {
            assert.equal(readFileSync(join(directory, name), 'utf8'), bundle.files[name], name);
        }

        assert.equal(readFileSync(join(directory, 'assets', 'logo.png'), 'utf8'), 'logo bytes');

        const productJson = JSON.parse(readFileSync(join(directory, 'product.json'), 'utf8'));

        assert.deepEqual(Object.keys(productJson), ['type', 'slug', 'title', 'version', 'remote']);
        assert.deepEqual({ ...productJson.remote, synced_at: undefined }, {
            synced_at: undefined,
            status: 'published',
            live_version: '1.2.0',
            live_channel: 'stable',
            draft: {
                version: '1.3.0',
                revision: 7,
                submitted: false,
                template_sha256: templateHash(bundle.files['template.twig']),
                option_overrides_sha256: optionOverridesHash(bundle.product.draft.option_overrides, bundle.product.draft.template),
            },
            listing_sha256: listingHash({ description: 'Spin the wheel to win.', documentation: 'Set the colours in the options.\n\n## Tips\n\nKeep it short.', install_notes: '', video_url: 'https://video.example/spin', category_ids: [1, 5], tag_names: ['arcade', 'spin'] }),
            latest_review: bundle.product.latest_review,
            media: [
                { tag: 'background', filename: 'background.png', sha256: sha('png v1'), kind: 'image', library: null },
                { tag: 'logo', filename: 'logo-final.png', sha256: sha('logo bytes'), kind: 'image', library: null },
                { tag: 'win-jingle', filename: 'Win Jingle.mp3', sha256: sha('mp3 bytes'), kind: 'audio', library: null },
                { tag: 'three', filename: 'three.module.min.js', sha256: bundle.product.media[3].sha256, kind: 'library', library: 'three.js' },
            ],
            live: null,
            listing_images: { cover: null, screenshots: [] },
        });
        assert.deepEqual(readdirSync(join(root, 'games')), ['spin-to-win']);

        const plan = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(plan.code, 0);
        assert.equal(plan.output.nothing_to_push, true, JSON.stringify(plan.output));
        assert.equal(plan.output.stale_remote, false);
        assert.equal(plan.output.release_notes, 'Adds a blue wheel.');
    });

    test('a live only product from a URL compares against the live version', async () => {
        const root = temporaryWorkspace();
        const url = media.serve('/exports/winner-wall', JSON.stringify(bundleFixture('winner-wall', media.baseUrl)));
        const { code, output } = await runJson(['import', url], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(code, 0, JSON.stringify(output));
        assert.equal(output.product, 'blocks/winner-wall');
        assert.equal(output.version, '1.1.0');
        assert.equal(output.template_source, 'live');

        const remote = JSON.parse(readFileSync(join(root, 'blocks', 'winner-wall', 'product.json'), 'utf8')).remote;

        assert.equal(remote.draft, null);
        assert.deepEqual(remote.live, { version: '1.0.0', template_sha256: templateHash(readFileSync(join(root, 'blocks', 'winner-wall', 'template.twig'), 'utf8')), option_overrides_sha256: optionOverridesHash({}) });

        const plan = await runJson(['plan', 'winner-wall'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(plan.output.nothing_to_push, true, JSON.stringify(plan.output));
        assert.equal(plan.output.release_notes, null);
    });

    test('reads the bundle from standard input', async () => {
        const root = temporaryWorkspace();
        const { code, output } = await runJson(['import', '-'], { cwd: root, baseUrl: marketplace.baseUrl, input: JSON.stringify(bundleFixture('winner-wall', media.baseUrl)) });

        assert.equal(code, 0, JSON.stringify(output));
        assert.ok(existsSync(join(root, 'blocks', 'winner-wall', 'assets', 'wall.png')));
    });

    test('a media file that does not match its hash fails the import and leaves nothing behind', async () => {
        const root = temporaryWorkspace();
        const bundle = bundleFixture('spin-to-win', media.baseUrl);

        bundle.media[2].sha256 = sha('something else');

        const { code, output } = await runJson(['import', bundleFile(bundle)], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(code, 1);
        assert.match(output.error, /Win Jingle\.mp3 \(win-jingle\) does not match the bundle's hash/);
        assert.deepEqual(readdirSync(join(root, 'games')), []);
    });

    test('a media download that fails fails the import', async () => {
        const root = temporaryWorkspace();
        const bundle = bundleFixture('winner-wall', media.baseUrl);

        bundle.media[0].url = `${media.baseUrl}/media/missing.png`;

        const { code, output } = await runJson(['import', bundleFile(bundle)], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(code, 1);
        assert.match(output.error, /answered 404/);
        assert.deepEqual(readdirSync(join(root, 'blocks')), []);
    });

    test('an existing product is refused with its local changes, and replaced with --force', async () => {
        const root = temporaryWorkspace();
        const file = bundleFile(bundleFixture('winner-wall', media.baseUrl));

        await runJson(['import', file], { cwd: root, baseUrl: marketplace.baseUrl });
        writeFileSync(join(root, 'blocks', 'winner-wall', 'template.twig'), '<p>edited</p>\n');
        writeFileSync(join(root, 'blocks', 'winner-wall', 'assets', 'extra.png'), 'extra');

        const refused = await runJson(['import', file], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(refused.code, 1);
        assert.match(refused.output.error, /blocks\/winner-wall already exists\. Local changes that would be lost: template\.twig, assets\/extra\.png \(new\)\. Run import again with --force/);
        assert.deepEqual(refused.output.local_changes, ['template.twig', 'assets/extra.png (new)']);

        const forced = await runJson(['import', file, '--force'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(forced.code, 0);
        assert.equal(forced.output.replaced, 'blocks/winner-wall');
        assert.notEqual(readFileSync(join(root, 'blocks', 'winner-wall', 'template.twig'), 'utf8'), '<p>edited</p>\n');
        assert.equal(existsSync(join(root, 'blocks', 'winner-wall', 'assets', 'extra.png')), false);
        assert.deepEqual(readdirSync(join(root, 'blocks')), ['winner-wall']);
    });

    test('an existing clean product still needs --force', async () => {
        const root = temporaryWorkspace();
        const file = bundleFile(bundleFixture('winner-wall', media.baseUrl));

        await runJson(['import', file], { cwd: root, baseUrl: marketplace.baseUrl });

        const refused = await run(['import', file], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(refused.code, 1);
        assert.match(refused.stderr, /It has no local changes since the last sync/);
    });

    test('an expired bundle link asks for a fresh export', async () => {
        const url = media.serve('/exports/expired', 'Forbidden', 403);
        const { code, output } = await runJson(['import', url], { cwd: temporaryWorkspace(), baseUrl: marketplace.baseUrl });

        assert.equal(code, 2);
        assert.match(output.error, /Call export_product again/);
    });

    test('--force only applies to import', async () => {
        const result = await run(['plan', '--force'], { cwd: temporaryWorkspace() });

        assert.equal(result.code, 2);
        assert.match(result.stderr, /--force only applies to import/);
    });
});

describe('bundle parsing', () => {
    const valid = { format: 1, product: { slug: 'spin-to-win', type: 'game' }, files: {}, media: [] };

    test('refuses anything but a format 1 bundle with a valid slug', () => {
        assert.throws(() => parseBundle('nope'), /not JSON/);
        assert.throws(() => parseBundle(JSON.stringify({ ...valid, format: 2 })), /format 2, newer than this kit/);
        assert.throws(() => parseBundle(JSON.stringify({ ...valid, format: undefined })), /not a product export bundle/);
        assert.throws(() => parseBundle(JSON.stringify({ ...valid, product: { type: 'game' } })), /no product with a slug/);
        assert.throws(() => parseBundle(JSON.stringify({ ...valid, product: { slug: '../escape', type: 'game' } })), /not a valid slug/);
        assert.throws(() => parseBundle(JSON.stringify({ ...valid, files: { 'template.twig': 3 } })), /template\.twig must be text/);
        assert.deepEqual(parseBundle(JSON.stringify({ ...valid, media: undefined })).media, []);
    });

    test('names a media file so the kit derives its tag, never outside assets/', () => {
        assert.equal(localFilenameFor({ tag: 'background', filename: 'background.png', library: null }), 'background.png');
        assert.equal(localFilenameFor({ tag: 'win-jingle', filename: 'Win Jingle.mp3', library: null }), 'Win Jingle.mp3');
        assert.equal(localFilenameFor({ tag: 'logo', filename: 'logo-final.PNG', library: null }), 'logo.png');
        assert.equal(localFilenameFor({ tag: 'hack', filename: '../../etc/passwd.png', library: null }), 'hack.png');
        assert.equal(localFilenameFor({ tag: 'dot', filename: '.hidden', library: null }), 'dot');
        assert.equal(localFilenameFor({ tag: 'three', filename: 'three.module.min.js', library: { name: 'three.js' } }), 'three.module.min.js');
    });

    test('works on the draft version, else the next minor after the latest release, else 1.0.0', () => {
        assert.equal(importedVersion({ draft: { version: '2.0.0' }, versions: [{ version: '1.4.0' }] }), '2.0.0');
        assert.equal(importedVersion({ draft: null, versions: [{ version: '1.4.2' }, { version: '1.0.0' }] }), '1.5.0');
        assert.equal(importedVersion({ draft: null, versions: [] }), '1.0.0');
    });
});
