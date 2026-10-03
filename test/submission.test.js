import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { submissionStatus } from '../src/submission.js';
import { listingHash, optionOverridesHash, readLocalState, templateHash } from '../src/sync-state.js';
import { loadWorkspace, selectProduct } from '../src/workspace.js';
import { run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { fixtureDocuments, temporaryWorkspace } from './helpers/project.js';

const sha = (/** @type {string|Buffer} */ data) => createHash('sha256').update(data).digest('hex');
const png = (/** @type {string} */ text) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);
const template = '<p>{{ play_count }}</p>\n';
const rules = fixtureDocuments().rules;
const categories = JSON.parse(readFileSync(new URL('./fixtures/endpoints/categories.json', import.meta.url), 'utf8'));
const [firstCategory, secondCategory] = categories.categories;
const messages = Object.fromEntries(rules.submission.requirements.map((/** @type {{key: string, message: string}} */ requirement) => [requirement.key, requirement.message]));

/**
 * listing.md with the given frontmatter lines and description.
 *
 * @param {string} frontmatter
 * @param {string} [description]
 */
function listing(frontmatter, description = 'Spin the wheel to win.') {
    return `---\n${frontmatter}\n---\n\n## Description\n\n${description}\n\n## Documentation\n\n## Install notes\n`;
}

/**
 * Put listing images into a product folder.
 *
 * @param {string} directory
 * @param {Record<string, string|Buffer>} files Paths inside listing/.
 */
function addListingImages(directory, files) {
    for (const [path, contents] of Object.entries(files)) {
        mkdirSync(join(directory, 'listing', path, '..'), { recursive: true });
        writeFileSync(join(directory, 'listing', path), contents);
    }
}

/**
 * A synced remote snapshot matching a product's template, options, and listing.
 *
 * @param {string} listingText
 * @param {Record<string, any>} [overrides]
 */
function syncedRemote(listingText, overrides = {}) {
    const fields = { description: 'Spin the wheel to win.', documentation: '', install_notes: '', video_url: '', category_ids: [firstCategory.id], tag_names: [] };

    return {
        synced_at: new Date().toISOString(),
        status: 'published',
        live_version: '1.0.0',
        live_channel: 'stable',
        draft: { version: '1.1.0', revision: 4, submitted: false, template_sha256: templateHash(template), option_overrides_sha256: optionOverridesHash({}) },
        listing_sha256: listingText === '' ? null : listingHash(fields),
        latest_review: null,
        media: [],
        ...overrides,
    };
}

describe('the submission checklist', () => {
    test('lists what review still needs, with the platform\'s messages, in its order', () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template, listing: listing('category_ids: []', '') }] });
        const product = selectProduct(loadWorkspace(root), 'spin-to-win', root);
        const documents = { rules, categories };

        assert.deepEqual(submissionStatus(product, documents), {
            ready: false,
            missing: [
                { key: 'description', message: messages.description },
                { key: 'categories', message: messages.categories },
                { key: 'cover_image', message: messages.cover_image, fix: 'npx @rafflex/dev capture games/spin-to-win' },
                { key: 'screenshots', message: messages.screenshots, fix: 'npx @rafflex/dev capture games/spin-to-win' },
            ],
        });
    });

    test('is ready with a description, a category by name, a cover, and a screenshot', () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template, listing: listing(`category_ids: ["${secondCategory.name.toUpperCase()}"]`) }] });
        const product = selectProduct(loadWorkspace(root), 'spin-to-win', root);

        addListingImages(product.directory, { 'cover.png': png('cover'), 'screenshots/01.png': png('one') });

        assert.deepEqual(submissionStatus(product, { rules, categories }), { ready: true, missing: [] });
    });

    test('needs release notes once a version is live, and takes the images the marketplace already has', () => {
        const text = listing(`category_ids: [${firstCategory.id}]`);
        const remote = syncedRemote(text, { listing_images: { cover: { url: 'https://m.example/c.png', sha256: 'aa' }, screenshots: [{ url: 'https://m.example/1.png', sha256: 'bb' }] } });
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win', version: '1.1.0', template, listing: text, remote }] });
        const product = selectProduct(loadWorkspace(root), 'spin-to-win', root);

        assert.deepEqual(submissionStatus(product, { rules, categories }), { ready: false, missing: [{ key: 'changelog', message: messages.changelog }] });

        writeFileSync(product.changelogPath, '# Changelog\n\n## Unreleased\n\nA blue wheel.\n');

        assert.equal(submissionStatus(product, { rules, categories }).ready, true);
    });

    test('says nothing when the marketplace publishes no requirements', () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template, listing: listing('category_ids: []', '') }] });
        const product = selectProduct(loadWorkspace(root), 'spin-to-win', root);
        const { submission, ...olderRules } = rules;

        assert.deepEqual(submissionStatus(product, { rules: olderRules }), { ready: true, missing: [] });
    });

    test('reports listing limits as listing_invalid', () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template, listing: listing(`category_ids: [${firstCategory.id}]`, 'x'.repeat(rules.listing.limits.description + 1)) }] });
        const product = selectProduct(loadWorkspace(root), 'spin-to-win', root);

        addListingImages(product.directory, { 'cover.png': png('cover'), 'screenshots/01.png': png('one') });

        const status = submissionStatus(product, { rules, categories }, readLocalState(product, { rules, categories }));

        assert.deepEqual(status.missing.map((entry) => entry.key), ['listing_invalid']);
        assert.match(status.missing[0].message, /Description section of listing\.md is 5001 characters; the limit is 5000/);
    });
});

describe('the checklist and the new checks through the CLI', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let marketplace;

    before(async () => {
        marketplace = await startFixtureServer();
    });

    after(() => marketplace.close());

    test('verify, plan, and status report submission; it never changes ready', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template, listing: listing(`categories: ["${secondCategory.name}"]`), changelog: '# Changelog\n\n## Unreleased\n\nFirst.\n' }] });
        const verified = await runJson(['verify', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(verified.code, 0, JSON.stringify(verified.output.issues));
        assert.equal(verified.output.ready, true);
        assert.deepEqual(verified.output.submission.missing.map((/** @type {any} */ entry) => entry.key), ['cover_image', 'screenshots']);

        const human = await run(['verify', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.match(human.stdout, /Before review \(a draft can be pushed without these\):\n {4}- Add a cover image before submitting for review\. Run npx @rafflex\/dev capture games\/spin-to-win to make listing images from the preview\./);

        const planned = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(planned.code, 0);
        assert.deepEqual(planned.output.listing.fields.category_ids, [secondCategory.id]);
        assert.equal(planned.output.submission.ready, false);

        const status = await runJson(['status'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.deepEqual(status.output.products[0].submission.missing.map((/** @type {any} */ entry) => entry.key), ['cover_image', 'screenshots']);
        assert.match((await run(['status'], { cwd: root, baseUrl: marketplace.baseUrl })).stdout, /Before review/);
    });

    test('plan lists the cover and each new screenshot as uploads with their purpose', async () => {
        const text = listing(`category_ids: [${firstCategory.id}]`);
        const cover = png('cover');
        const one = png('one');
        const two = png('two');
        const root = temporaryWorkspace({
            products: [{
                title: 'Spin to Win',
                slug: 'spin-to-win',
                version: '1.1.0',
                template,
                listing: text,
                changelog: '# Changelog\n\n## Unreleased\n\nNew pictures.\n',
                remote: syncedRemote(text, { listing_images: { cover: null, screenshots: [{ url: 'https://m.example/1.png', sha256: sha(one) }, { url: 'https://m.example/old.png', sha256: 'old' }] } }),
            }],
        });
        const directory = join(root, 'games', 'spin-to-win');

        addListingImages(directory, { 'cover.png': cover, 'screenshots/01.png': one, 'screenshots/02.png': two });

        const { code, output } = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(code, 0, JSON.stringify(output.verify));
        assert.equal(output.nothing_to_push, false);
        assert.deepEqual(output.listing_images, {
            cover: { path: 'listing/cover.png', upload_filename: 'cover.png', sha256: sha(cover), size: cover.length, mime_type: 'image/png', change: 'new' },
            screenshots: [{ path: 'listing/screenshots/02.png', upload_filename: 'screenshot-02.png', sha256: sha(two), size: two.length, mime_type: 'image/png', change: 'new' }],
            removed_screenshots: ['old'],
        });
        assert.equal(output.submission.ready, true);

        const human = await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.match(human.stdout, /1\. request_media_upload: listing\/cover\.png as filename cover\.png with purpose cover, image\/png, \d+ bytes \(new\)/);
        assert.match(human.stdout, /2\. request_media_upload: listing\/screenshots\/02\.png as filename screenshot-02\.png with purpose screenshot, image\/png, \d+ bytes \(new\)/);
        assert.match(human.stdout, /1 screenshot is on the marketplace but not in listing\/screenshots\/; push removes it\.\n {2}When this shell cannot reach the marketplace, tell the creator to remove those screenshots in the browser before the uploads\./);
        assert.doesNotMatch(human.stdout, /Before review/);
    });

    test('plan does not re upload a locked file, and says how to ship the change', async () => {
        const text = listing(`category_ids: [${firstCategory.id}]`);
        const root = temporaryWorkspace({
            products: [{
                title: 'Spin to Win',
                slug: 'spin-to-win',
                version: '1.1.0',
                template,
                listing: text,
                assets: { 'wheel.png': png('new wheel') },
                remote: syncedRemote(text, {
                    media: [{ tag: 'wheel', filename: 'wheel.png', sha256: sha(png('old wheel')), kind: 'image', library: null, locked: true }],
                }),
            }],
        });
        const { output } = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.deepEqual(output.assets, []);
        assert.equal(output.nothing_to_push, true);
        assert.equal(output.refusals.length, 1);
        assert.equal(output.refusals[0].code, 'asset_locked');
        assert.equal(output.refusals[0].path, 'assets/wheel.png');
        assert.match(output.refusals[0].message, /^wheel\.png is referenced by a submitted or published version and cannot be overwritten\. Upload it under a new name\. Save your change as assets\/wheel-2\.png \(restore assets\/wheel\.png from git\) and use files\['wheel-2'\] in the template\.$/);
        assert.match((await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl })).stdout, /Not planned \[asset_locked\] assets\/wheel\.png/);
    });

    test('a changed locked file blocks check, verify, and plan, so nothing reads as ready', async () => {
        const text = listing(`category_ids: [${firstCategory.id}]`);
        const root = temporaryWorkspace({
            products: [{
                title: 'Spin to Win',
                slug: 'spin-to-win',
                version: '1.1.0',
                template,
                listing: text,
                assets: { 'wheel.png': png('new wheel'), 'star.png': png('star') },
                remote: syncedRemote(text, {
                    media: [
                        { tag: 'wheel', filename: 'wheel.png', sha256: sha(png('old wheel')), kind: 'image', library: null, locked: true },
                        { tag: 'star', filename: 'star.png', sha256: sha(png('star')), kind: 'image', library: null, locked: true },
                    ],
                }),
            }],
        });
        const check = await runJson(['check', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });
        const plan = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });
        const locked = check.output.issues.filter((/** @type {any} */ issue) => issue.code === 'asset_locked');

        assert.equal(check.code, 1);
        assert.equal(check.output.passed, false);
        assert.deepEqual(locked.map((/** @type {any} */ issue) => issue.file), ['assets/wheel.png']);
        assert.match(locked[0].message, /cannot be overwritten\. Upload it under a new name\. Save your change as assets\/wheel-2\.png/);
        assert.match(locked[0].fix, /new filename/);
        assert.equal(plan.code, 1);
        assert.equal(plan.output.ready, false);
        assert.deepEqual(plan.output.verify.blocking_issues.map((/** @type {any} */ issue) => issue.code), ['asset_locked']);
        assert.equal(plan.output.refusals[0].code, 'asset_locked');
    });

    test('check blocks a listing the marketplace would refuse', async () => {
        const { limits } = rules.listing;
        const tags = Array.from({ length: limits.max_tags + 1 }, (_, index) => `"tag${index}"`).join(', ');
        const root = temporaryWorkspace({
            products: [
                { title: 'Too Long', template, listing: listing(`category_ids: ["Racing", 999]\ntag_names: [${tags}, "${'t'.repeat(limits.tag_name + 1)}"]\nvideo_url: "not a link"`, 'x'.repeat(limits.description + 1)) },
                { title: 'Broken', template, listing: '---\ncategory_ids: [3\n---\n' },
            ],
        });
        const directory = join(root, 'games', 'too-long');

        addListingImages(directory, {
            'cover.png': Buffer.from('not an image at all'),
            'cover.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
            ...Object.fromEntries(Array.from({ length: rules.listing.images.screenshot.max_count + 1 }, (_, index) => [`screenshots/${index}.png`, png(String(index))])),
            'screenshots/big.png': Buffer.concat([png('big'), Buffer.alloc(rules.listing.images.screenshot.max_bytes)]),
            'screenshots/notes.txt': 'not an image',
        });

        const { code, output } = await runJson(['check', 'too-long'], { cwd: root, baseUrl: marketplace.baseUrl });
        const listingMessages = output.issues.filter((/** @type {any} */ issue) => issue.code === 'listing_invalid').map((/** @type {any} */ issue) => issue.message);

        assert.equal(code, 1);
        assert.equal(output.passed, false);
        assert.ok(listingMessages.some((message) => /Description section of listing\.md is 5001 characters; the limit is 5000/.test(message)));
        assert.ok(listingMessages.some((message) => /has 12 tag_names; a product can have at most 10/.test(message)));
        assert.ok(listingMessages.some((message) => /a tag can be at most 50/.test(message)));
        assert.ok(listingMessages.some((message) => /video_url "not a link" is not a web address/.test(message)));
        assert.ok(listingMessages.some((message) => message.includes(`the marketplace does not have: 999, Racing. Use category names from this list: ${categories.categories.map((/** @type {any} */ category) => category.name).join(', ')}.`)));
        assert.ok(listingMessages.some((message) => /listing\/ holds 2 cover images \(cover\.jpg, cover\.png\)\. Keep one\./.test(message)));
        assert.ok(listingMessages.some((message) => /listing\/cover\.png is named as a PNG image but its content is not one the marketplace can identify/.test(message)));
        assert.ok(listingMessages.some((message) => /listing\/screenshots holds 9 screenshots; a product shows at most 6/.test(message)));
        assert.ok(listingMessages.some((message) => /listing\/screenshots\/big\.png is 2 MB; a screenshot can be at most 2 MB/.test(message)));
        assert.ok(listingMessages.some((message) => /listing\/screenshots\/notes\.txt cannot be used as a screenshot/.test(message)));

        const broken = await runJson(['check', 'broken'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(broken.code, 1);
        assert.deepEqual(broken.output.issues.filter((/** @type {any} */ issue) => issue.code === 'listing_invalid').map((/** @type {any} */ issue) => [issue.file, issue.message]), [['listing.md', "listing.md's category_ids list is not closed with ]."]]);
    });

    test('a product whose state never recorded its listing images says to refresh it, and plans and captures none', async () => {
        const text = listing(`category_ids: [${firstCategory.id}]`);
        const root = temporaryWorkspace({
            products: [
                { title: 'Spin to Win', slug: 'spin-to-win', version: '1.1.0', template, listing: text, remote: syncedRemote(text) },
                { title: 'Known None', slug: 'known-none', version: '1.1.0', template, listing: text, remote: syncedRemote(text, { listing_images: { cover: null, screenshots: [] } }) },
            ],
        });
        const refresh = 'The marketplace may already have a cover and screenshots: this product\'s state was recorded without them (by an older kit). Refresh it first: call request_sync with slug spin-to-win, then run npx @rafflex/dev synced spin-to-win "<sync_url>".';
        const unknown = selectProduct(loadWorkspace(root), 'spin-to-win', root);
        const known = selectProduct(loadWorkspace(root), 'known-none', root);

        const images = (/** @type {import('../src/submission.js').MissingRequirement[]} */ missing) => missing.filter((entry) => entry.key === 'cover_image' || entry.key === 'screenshots');

        assert.deepEqual(images(submissionStatus(unknown, { rules, categories }).missing), [
            { key: 'cover_image', message: `${messages.cover_image} ${refresh}`, fix: 'npx @rafflex/dev synced spin-to-win "<sync_url>"' },
            { key: 'screenshots', message: `${messages.screenshots} ${refresh}`, fix: 'npx @rafflex/dev synced spin-to-win "<sync_url>"' },
        ]);
        assert.deepEqual(images(submissionStatus(known, { rules, categories }).missing).map((entry) => entry.fix), ['npx @rafflex/dev capture known-none', 'npx @rafflex/dev capture known-none']);

        const capture = await runJson(['capture', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(capture.code, 0);
        assert.equal(capture.output.skipped, true);
        assert.deepEqual(capture.output.captured, []);
        assert.match(capture.output.reason, /^Nothing was captured\. The marketplace may already have a cover and screenshots.+capture spin-to-win --force to make them anyway\.$/);

        for (const slug of ['spin-to-win', 'known-none']) {
            addListingImages(join(root, 'games', slug), { 'cover.png': png('cover'), 'screenshots/01.png': png('one') });
        }

        const unknownPlan = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });
        const knownPlan = await runJson(['plan', 'known-none'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.deepEqual(unknownPlan.output.listing_images, { cover: null, screenshots: [], removed_screenshots: [], remote_unknown: true });
        assert.match((await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl })).stdout, /Listing images are not planned: the recorded state does not say which the marketplace has\./);
        assert.equal(knownPlan.output.listing_images.cover.path, 'listing/cover.png');
        assert.deepEqual(knownPlan.output.listing_images.screenshots.map((/** @type {any} */ image) => image.path), ['listing/screenshots/01.png']);
    });

    test('check takes a cover or screenshot under any file name, because push uploads it under a name of its own', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template, listing: listing(`category_ids: [${firstCategory.id}]`) }] });

        addListingImages(join(root, 'games', 'spin-to-win'), {
            'Cover.PNG': png('cover'),
            'screenshots/Screen Shot 2026-10-03 at 10.00.00.png': png('one'),
            'screenshots/02-win.png': png('two'),
        });

        const { output } = await runJson(['check', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });
        const plan = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.deepEqual(output.issues.filter((/** @type {any} */ issue) => issue.code === 'listing_invalid'), []);
        assert.deepEqual(plan.output.listing_images.cover.upload_filename, 'cover.png');
        assert.deepEqual(plan.output.listing_images.screenshots.map((/** @type {any} */ image) => [image.path, image.upload_filename]), [
            ['listing/screenshots/02-win.png', 'screenshot-01.png'],
            ['listing/screenshots/Screen Shot 2026-10-03 at 10.00.00.png', 'screenshot-02.png'],
        ]);
    });

    test('check blocks names the upload refuses, duplicates, a full library, and content that is not what its name says', async () => {
        const root = temporaryWorkspace({
            products: [{
                title: 'Spin to Win',
                template,
                listing: listing(`category_ids: [${firstCategory.id}]`),
                assets: {
                    'Win Jingle.mp3': Buffer.from('ID3\x04rest', 'latin1'),
                    'wheel.png': Buffer.from('not an image at all'),
                    'hero.png': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
                    'fanfare.png': Buffer.from([0xff, 0xfb, 0x90, 0x44]),
                    'aac.mp3': Buffer.from([0xff, 0xf1, 0x50, 0x40]),
                    'Prize.png': png('a'),
                    'prize.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
                    'one/star.png': png('one'),
                    'two/star.png': png('two'),
                    'huge.png': Buffer.concat([png('huge'), Buffer.alloc(4 * 1024 * 1024)]),
                    'huge-2.png': Buffer.concat([png('huge 2'), Buffer.alloc(4 * 1024 * 1024)]),
                    'huge-3.png': Buffer.concat([png('huge 3'), Buffer.alloc(4 * 1024 * 1024)]),
                    'huge-4.png': Buffer.concat([png('huge 4'), Buffer.alloc(4 * 1024 * 1024)]),
                    'huge-5.png': Buffer.concat([png('huge 5'), Buffer.alloc(4 * 1024 * 1024)]),
                    'huge-6.png': Buffer.concat([png('huge 6'), Buffer.alloc(4 * 1024 * 1024)]),
                    'huge-7.png': Buffer.concat([png('huge 7'), Buffer.alloc(4 * 1024 * 1024)]),
                },
            }],
        });
        const { code, output } = await runJson(['check', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });
        const byCode = (/** @type {string} */ wanted) => output.issues.filter((/** @type {any} */ issue) => issue.code === wanted).map((/** @type {any} */ issue) => issue.message);

        assert.equal(code, 1);
        assert.deepEqual(byCode('asset_filename'), ['assets/Win Jingle.mp3 cannot be uploaded under this name. Use letters, numbers, dots, hyphens, and underscores only in file names. Rename it to assets/Win-Jingle.mp3 (its tag stays win-jingle).']);
        assert.deepEqual(byCode('asset_duplicate'), [
            'assets/one/star.png and assets/two/star.png upload under the same name, so one would replace the other. Rename one, for example to star-2.png.',
        ]);
        assert.deepEqual(byCode('asset_capacity'), ['This media library is full (maximum 25 MB). The files in assets/ add up to 28 MB, over the 25 MB a product\'s media library holds.']);
        assert.deepEqual(byCode('asset_content_mismatch'), [
            'assets/aac.mp3 is named as MP3 audio but holds AAC audio, which the marketplace does not accept here. Export it again as MP3 audio.',
            'assets/wheel.png is named as a PNG image but its content is not one the marketplace can identify. Export it again as a PNG image.',
        ]);
        assert.deepEqual(byCode('asset_content_warning'), [
            "assets/fanfare.png is named as a PNG image but holds MP3 audio. The marketplace stores it as what it is, so files['fanfare'] is a sound, not an image. Rename it to fanfare.mp3 if that is intended.",
        ]);
        assert.ok(output.issues.filter((/** @type {any} */ issue) => issue.code.startsWith('asset_')).every((/** @type {any} */ issue) => issue.fix !== '' && typeof issue.file === 'string'));
    });

    test('the capacity counts files still on the marketplace that assets/ no longer holds', async () => {
        const text = listing(`category_ids: [${firstCategory.id}]`);
        const big = Buffer.concat([png('big'), Buffer.alloc(4 * 1024 * 1024)]);
        const assets = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((name) => [`${name}.png`, Buffer.concat([png(name), Buffer.alloc(4 * 1024 * 1024)])]));
        const media = Object.entries(assets).map(([filename, contents]) => ({ tag: filename.slice(0, 1), filename, sha256: sha(contents), kind: 'image', library: null, size_bytes: contents.length }));
        const product = (/** @type {string} */ title, /** @type {any[]} */ gone) => ({ title, slug: title.toLowerCase(), version: '1.1.0', template, listing: text, assets: { ...assets, 'f.png': big }, remote: syncedRemote(text, { media: [...media, ...gone] }) });
        const root = temporaryWorkspace({
            products: [
                product('Sized', [{ tag: 'old', filename: 'old.png', sha256: 'x', kind: 'image', library: null, size_bytes: 3 * 1024 * 1024 }, { tag: 'three', filename: 'three.js', sha256: 'y', kind: 'library', library: 'three.js', size_bytes: 9 * 1024 * 1024 }]),
                product('Unsized', [{ tag: 'old', filename: 'old.png', sha256: 'x', kind: 'image', library: null }]),
            ],
        });
        const capacity = async (/** @type {string} */ slug) => (await runJson(['check', slug], { cwd: root, baseUrl: marketplace.baseUrl })).output.issues.filter((/** @type {any} */ issue) => issue.code === 'asset_capacity').map((/** @type {any} */ issue) => issue.message);

        assert.deepEqual(await capacity('sized'), ['This media library is full (maximum 25 MB). The files in assets/ add up to 27 MB (3 MB of it in files still on the marketplace but no longer in assets/; remove them in the browser to free the space), over the 25 MB a product\'s media library holds.']);
        assert.deepEqual(await capacity('unsized'), []);
    });

    test('files already on the marketplace are not judged by their names or content again', async () => {
        const text = listing(`category_ids: [${firstCategory.id}]`);
        const jingle = Buffer.from('not really audio');
        const root = temporaryWorkspace({
            products: [{
                title: 'Spin to Win',
                slug: 'spin-to-win',
                version: '1.1.0',
                template,
                listing: text,
                assets: { 'Win Jingle.mp3': jingle },
                remote: syncedRemote(text, { media: [{ tag: 'win-jingle', filename: 'Win Jingle.mp3', sha256: sha(jingle), kind: 'audio', library: null }] }),
            }],
        });
        const { output } = await runJson(['check', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.deepEqual(output.issues.filter((/** @type {any} */ issue) => issue.code.startsWith('asset_')), []);
    });

    test('an older marketplace without the new rules or categories skips these checks quietly', async () => {
        const older = await startFixtureServer();

        older.changeDocument('rules', (document) => {
            const { listing: _listing, submission: _submission, ...older } = document;
            const { filename_pattern: _pattern, max_filename_length: _length, library_capacity_bytes: _capacity, ...uploadRules } = older.upload_rules;

            return { ...older, upload_rules: uploadRules, version: 'older-rules' };
        });
        older.changeManifest((manifest) => {
            const { categories: _endpoint, ...endpoints } = manifest.endpoints;

            return { ...manifest, endpoints, version: `${manifest.version}-older` };
        });

        try {
            const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template, listing: listing('category_ids: [3]', 'x'.repeat(6000)), assets: { 'Win Jingle.mp3': Buffer.from('ID3\x04', 'latin1') } }] });
            const { code, output } = await runJson(['verify', 'spin-to-win'], { cwd: root, baseUrl: older.baseUrl });

            assert.equal(code, 0, JSON.stringify(output.issues));
            assert.deepEqual(output.submission, { ready: true, missing: [] });

            writeFileSync(join(root, 'games', 'spin-to-win', 'listing.md'), listing('category_ids: ["Wheels"]'));

            const named = await runJson(['check', 'spin-to-win'], { cwd: root, baseUrl: older.baseUrl });

            assert.match(named.output.issues.find((/** @type {any} */ issue) => issue.code === 'listing_invalid')?.message ?? '', /names categories \(Wheels\), but the marketplace's category list could not be loaded/);
        } finally {
            await older.close();
        }
    });
});
