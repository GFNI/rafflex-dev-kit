import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildPlan } from '../src/commands/plan.js';
import { readLocalState, remoteFromProduct } from '../src/sync-state.js';
import { loadWorkspace, selectProduct } from '../src/workspace.js';
import { bundleFile, bundleFixture, serveFixtureMedia } from './helpers/bundles.js';
import { run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { startMediaServer } from './helpers/media-server.js';
import { fixtureDocuments, temporaryWorkspace } from './helpers/project.js';

const sha = (/** @type {string|Buffer} */ data) => createHash('sha256').update(data).digest('hex');
const documents = fixtureDocuments();

describe('plan', () => {
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

    test('lists exactly an edited template and a new image, and nothing once pushed and synced', async () => {
        const root = temporaryWorkspace();
        const bundle = bundleFixture('spin-to-win', media.baseUrl);

        await runJson(['import', bundleFile(bundle)], { cwd: root, baseUrl: marketplace.baseUrl });

        const directory = join(root, 'games', 'spin-to-win');
        const template = `${readFileSync(join(directory, 'template.twig'), 'utf8')}<img src="{{ files['star'] }}">\n`;

        writeFileSync(join(directory, 'template.twig'), template);
        writeFileSync(join(directory, 'assets', 'star.png'), 'star bytes');

        const { code, output: planned } = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });
        const { ready, verify, ...output } = planned;

        assert.equal(code, 0);
        assert.equal(ready, true);
        assert.deepEqual({ ...verify, warning_count: undefined }, { ready: true, browser_tests: 'skipped', blocking_issues: [], warning_count: undefined });
        assert.deepEqual(output, {
            product: 'games/spin-to-win',
            slug: 'spin-to-win',
            nothing_to_push: false,
            stale_remote: false,
            template: { changed: true },
            options: { changed: false },
            listing: { changed: false },
            assets: [{ path: 'assets/star.png', filename: 'star.png', tag: 'star', kind: 'image', size: 10, mime_type: 'image/png', sha256: sha('star bytes'), change: 'new' }],
            removed_assets: [],
            release_notes: 'Adds a blue wheel.',
            version: '1.3.0',
            suggested_version: null,
        });

        const human = await run(['plan'], { cwd: directory, baseUrl: marketplace.baseUrl });

        assert.match(human.stdout, /1\. update_draft: template, version_number 1\.3\.0, base_revision 7, changelog from Unreleased/);
        assert.match(human.stdout, /2\. request_media_upload: assets\/star\.png as star, image\/png, 10 bytes \(new\)/);
        assert.match(human.stdout, /3\. get_product, then pipe it to npx @rafflex\/dev synced games\/spin-to-win/);
        assert.doesNotMatch(human.stdout, /update_product_details|create_product/);

        const formatted = readFileSync(join(directory, 'template.twig'), 'utf8');

        assert.notEqual(formatted, template);
        assert.match(formatted, /<img src="\{\{ files\['star'\] \}\}" \/>\n$/);

        const pushed = {
            ...bundle.product,
            draft: { ...bundle.product.draft, template: formatted, revision: 9 },
            media: [...bundle.product.media, { tag: 'star', filename: 'star.png', kind: 'image', mime_type: 'image/png', size_bytes: 10, sha256: sha('star bytes'), url: 'https://media.example/star.png', library: null }],
        };
        const synced = await runJson(['synced', 'spin-to-win'], { cwd: root, input: JSON.stringify({ structuredContent: pushed }) });

        assert.equal(synced.code, 0);

        const again = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(again.output.nothing_to_push, true, JSON.stringify(again.output));
        assert.match((await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl })).stdout, /Nothing to push\./);
    });

    test('a product not on the marketplace yet plans everything, starting with create_product', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Lucky Dip', assets: { 'prize.png': 'prize' }, changelog: '# Changelog\n\n## Unreleased\n\nFirst release.\n' }] });
        const { output } = await runJson(['plan', 'lucky-dip'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(output.slug, null);
        assert.equal(output.nothing_to_push, false);
        assert.equal(output.stale_remote, true);
        assert.deepEqual([output.template.changed, output.options.changed, output.listing.changed], [true, true, true]);
        assert.deepEqual(output.options.option_overrides, {});
        assert.deepEqual(output.listing.fields, { description: '', documentation: '', install_notes: '', video_url: '', category_ids: [], tag_names: [] });
        assert.deepEqual(output.assets.map((/** @type {any} */ asset) => [asset.tag, asset.change]), [['prize', 'new']]);
        assert.equal(output.release_notes, 'First release.');

        const human = await run(['plan', 'lucky-dip'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.match(human.stdout, /Not on the marketplace yet\./);
        assert.match(human.stdout, /1\. create_product \(type game, title "Lucky Dip", the template\)/);
        assert.match(human.stdout, /update_product_details/);
    });

    test('a stale snapshot, a hashless remote file, and changed options and listing', async () => {
        const root = temporaryWorkspace({
            products: [{
                title: 'Spin to Win',
                slug: 'spin-to-win',
                options: { heading: { label: 'Prize' } },
                listing: '---\ncategory_ids: [3]\ntag_names: []\nvideo_url: ""\n---\n\n## Description\n\nNew words.\n',
                assets: { 'background.png': 'png v1', 'three.module.min.js': readFileSync(new URL('./fixtures/lib/fake-three.module.js', import.meta.url)) },
                remote: {
                    ...remoteFromProduct(bundleFixture('spin-to-win', 'https://media.example').product, new Date(Date.now() - 25 * 60 * 60 * 1000)),
                    media: [
                        { tag: 'background', filename: 'background.png', sha256: null, kind: 'image', library: null },
                        { tag: 'gone', filename: 'gone.png', sha256: sha('gone'), kind: 'image', library: null },
                    ],
                },
            }],
        });
        const product = selectProduct(loadWorkspace(root), 'spin-to-win', root);
        const { plan } = buildPlan(product, documents);

        assert.equal(plan.stale_remote, true);
        assert.deepEqual(plan.options, { changed: true, option_overrides: { heading: { label: 'Prize' } } });
        assert.deepEqual(plan.listing, { changed: true, fields: { description: 'New words.', documentation: '', install_notes: '', video_url: '', category_ids: [3], tag_names: [] } });
        assert.deepEqual(plan.assets.map((asset) => [asset.path, asset.change, 'library' in asset ? asset.library : null]), [
            ['assets/background.png', 'changed', null],
            ['assets/three.module.min.js', 'new', 'three.js'],
        ]);
        assert.deepEqual(plan.removed_assets, [{ tag: 'gone', filename: 'gone.png' }]);
        assert.equal(plan.release_notes, null);

        const human = await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.match(human.stdout, /On the marketplace but not in assets\/: gone\.png \(gone\)\./);
        assert.match(human.stdout, /tell the creator to remove them from the product's media in the browser/);
        assert.doesNotMatch(human.stdout, /\d\. .*gone/);
    });

    test('a removed asset alone is reported but leaves nothing to push', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win' }] });
        const product = selectProduct(loadWorkspace(root), 'spin-to-win', root);
        const local = readLocalState(product, documents);

        writeFileSync(join(root, 'games', 'spin-to-win', 'product.json'), JSON.stringify({
            ...product.manifest,
            remote: {
                synced_at: new Date().toISOString(),
                status: 'draft',
                live_version: null,
                live_channel: null,
                draft: { version: product.version, revision: 1, submitted: false, template_sha256: local.template?.sha256, option_overrides_sha256: 'sha256' in local.options ? local.options.sha256 : null },
                listing_sha256: 'sha256' in local.listing ? local.listing.sha256 : null,
                latest_review: null,
                media: [{ tag: 'old-logo', filename: 'old-logo.png', sha256: sha('old'), kind: 'image', library: null }],
            },
        }));

        const { output } = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(output.nothing_to_push, true, JSON.stringify(output));
        assert.deepEqual(output.removed_assets, [{ tag: 'old-logo', filename: 'old-logo.png' }]);

        const human = await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.match(human.stdout, /Nothing to push\.\n {2}On the marketplace but not in assets\/: old-logo\.png \(old-logo\)\./);
    });

    test('a library attached under a custom tag is matched by its hash, not reported changed or removed', async () => {
        const libraryBytes = readFileSync(new URL('./fixtures/lib/fake-three.module.js', import.meta.url));
        const root = temporaryWorkspace({
            products: [{
                title: 'Spin to Win',
                slug: 'spin-to-win',
                assets: { 'three.module.min.js': libraryBytes },
                remote: { synced_at: new Date().toISOString(), status: 'draft', live_version: null, live_channel: null, draft: null, listing_sha256: null, latest_review: null, media: [{ tag: 'threejs', filename: 'three.module.min.js', sha256: sha(libraryBytes), kind: 'library', library: 'three.js' }] },
            }],
        });
        const { output } = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.deepEqual(output.assets, []);
        assert.deepEqual(output.removed_assets, []);
    });

    test('a library is attached rather than uploaded, and a review in progress is called out', async () => {
        const root = temporaryWorkspace({
            products: [{
                title: 'Spin to Win',
                slug: 'spin-to-win',
                assets: { 'three.module.min.js': readFileSync(new URL('./fixtures/lib/fake-three.module.js', import.meta.url)) },
                remote: { synced_at: new Date().toISOString(), status: 'published', live_version: '1.0.0', live_channel: 'stable', draft: { version: '1.1.0', revision: 2, submitted: true, template_sha256: null, option_overrides_sha256: null }, listing_sha256: null, latest_review: null, media: [] },
            }],
        });
        const human = await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.match(human.stdout, /1\.1\.0 is in review and cannot be changed until the decision/);
        assert.match(human.stdout, /attach_approved_library: three\.js as three \(new\)/);
    });

    test('a missing template or unreadable options.json fails the plan', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Broken', options: 'not an object' }] });

        writeFileSync(join(root, 'games', 'broken', 'options.json'), '{nope');

        const { code, output } = await runJson(['plan', 'broken'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(code, 1);
        assert.match(output.error, /options\.json cannot be read/);
    });
});
