import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureIgnored } from '../src/git.js';
import { optionOverridesHash, templateHash } from '../src/sync-state.js';
import { isolatedGitEnv, run, runJson } from './helpers/cli.js';
import { temporaryWorkspace } from './helpers/project.js';
import { marketplaceProduct, sha256, startFakeMarketplace } from './helpers/sync-server.js';

const template = '<p>{{ play_count }}</p>\n';
const png = (/** @type {string} */ text) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } }).trim();
}

/**
 * A git workspace with the given products, committed.
 *
 * @param {import('./helpers/project.js').ProductSpec[]} products
 */
function gitWorkspace(products) {
    const root = temporaryWorkspace({ products });

    ensureIgnored(root);
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'Scaffold']);

    return root;
}

/**
 * @param {string} root
 * @param {string} path
 */
function productJson(root, path) {
    return JSON.parse(readFileSync(join(root, path, 'product.json'), 'utf8'));
}

/**
 * Every file under a folder, outside .git.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function allFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === '.git') {
            return [];
        }

        const path = join(directory, entry.name);

        return entry.isDirectory() ? allFiles(path) : [path];
    });
}

describe('push', () => {
    /** @type {Awaited<ReturnType<typeof startFakeMarketplace>>} */
    let marketplace;

    before(async () => {
        marketplace = await startFakeMarketplace();
    });

    after(() => marketplace.close());

    /**
     * Run the kit against the stand in marketplace.
     *
     * @param {string[]} args
     * @param {string} cwd
     */
    const kit = (args, cwd) => runJson(args, { cwd, baseUrl: marketplace.baseUrl });

    /**
     * A product on the marketplace and in a git workspace, recorded with
     * synced through a link, so a push starts from a known state.
     *
     * @param {string} slug
     * @param {Record<string, any>} [overrides]
     * @param {Partial<import('./helpers/project.js').ProductSpec>} [spec]
     */
    async function syncedProduct(slug, overrides = {}, spec = {}) {
        marketplace.seed(marketplaceProduct({ slug, title: slug, ...overrides }));

        const root = gitWorkspace([{ title: slug, slug, template, ...spec }]);
        const link = marketplace.issueLink(slug);
        const synced = await kit(['synced', slug, link], root);

        assert.equal(synced.code, 0, JSON.stringify(synced.output));

        return { root, link, path: `games/${slug}`, directory: join(root, 'games', slug) };
    }

    test('a first push creates the product, records its slug, and renames the folder', async () => {
        const root = gitWorkspace([{ title: 'Lucky Dip', folder: 'lucky-dip-draft', template, changelog: '# Changelog\n\n## Unreleased\n\nFirst version.\n' }]);
        const link = marketplace.issueLink(null);
        const before = marketplace.pushes().length;
        const { code, output, stderr } = await kit(['push', 'lucky-dip-draft', link], root);

        assert.equal(code, 0, `${JSON.stringify(output)}\n${stderr}`);
        assert.equal(output.created, true);
        assert.equal(output.pushed, true);
        assert.equal(output.slug, 'lucky-dip');
        assert.equal(output.product, 'games/lucky-dip');
        assert.equal(output.revision, 1);
        assert.deepEqual(output.changed, { template: true, options: false, listing: false });
        assert.equal(existsSync(join(root, 'games', 'lucky-dip-draft')), false);

        const body = marketplace.pushes()[before].body;

        assert.deepEqual(body.create, { type: 'game', title: 'Lucky Dip' });
        assert.equal(body.base_revision, null);
        assert.equal(body.template, template);
        assert.equal(body.version, '1.0.0');
        assert.equal(body.release_notes, 'First version.');
        assert.equal('listing' in body, false);
        assert.equal('option_overrides' in body, false);

        const written = productJson(root, 'games/lucky-dip');

        assert.equal(written.slug, 'lucky-dip');
        assert.equal(written.remote.draft.revision, 1);
        assert.equal(written.remote.draft.template_sha256, templateHash(template));
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Push lucky-dip 1.0.0 (draft revision 1)');
        assert.equal(git(root, ['status', '--porcelain']), '');
        assert.equal(output.link.includes('signature'), false);
        assert.match(output.link, /\/mcp\/sync\/[a-z0-9-]+\?…$/);
    });

    test('the sync link is never written to disk or committed', async () => {
        const { root, link, path } = await syncedProduct('secret-keeper');

        writeFileSync(join(root, path, 'template.twig'), '<p>{{ play_count }} plays</p>\n');

        const prose = await run(['push', 'secret-keeper', link], { cwd: root, baseUrl: marketplace.baseUrl });
        const signature = new URL(link).searchParams.get('signature') ?? '';

        assert.equal(prose.code, 0, prose.stderr);
        assert.ok(signature.length > 10);
        assert.equal(`${prose.stdout}${prose.stderr}`.includes(signature), false);
        assert.match(prose.stdout, /through http:\/\/127\.0\.0\.1:\d+\/mcp\/sync\/[a-z0-9-]+\?…/);

        for (const file of allFiles(root)) {
            assert.equal(readFileSync(file).includes(signature), false, file);
        }

        assert.equal(git(root, ['log', '-p', '--all']).includes(signature), false);
    });

    test('a push sends only the part that changed: template, options, listing, release notes', async () => {
        const { root, link, path, directory } = await syncedProduct('only-changes');

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} left {{ options.heading }}</p>\n');

        const templatePush = await kit(['push', path, link], root);
        const templateBody = marketplace.pushes().at(-1)?.body;

        assert.equal(templatePush.code, 0, JSON.stringify(templatePush.output));
        assert.deepEqual(Object.keys(templateBody).sort(), ['base_revision', 'template', 'version']);
        assert.equal(templateBody.base_revision, 1);
        assert.equal(templatePush.output.revision, 2);
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Push only-changes 1.0.0 (draft revision 2)');

        writeFileSync(join(directory, 'options.json'), '{"heading": {"label": "Heading"}}\n');

        const optionsPush = await kit(['push', path, link], root);
        const optionsBody = marketplace.pushes().at(-1)?.body;

        assert.equal(optionsPush.code, 0, JSON.stringify(optionsPush.output));
        assert.deepEqual(Object.keys(optionsBody).sort(), ['base_revision', 'option_overrides', 'version']);
        assert.deepEqual(optionsBody.option_overrides, { heading: { label: 'Heading' } });
        assert.equal(productJson(root, path).remote.draft.option_overrides_sha256, optionOverridesHash({ heading: { label: 'Heading' } }));

        writeFileSync(join(directory, 'listing.md'), '---\ncategory_ids: [3]\ntag_names: [wheel]\nvideo_url: ""\n---\n\n## Description\n\nSpin it.\n\n## Documentation\n\n## Install notes\n');

        const listingPush = await kit(['push', path, link], root);
        const listingBody = marketplace.pushes().at(-1)?.body;

        assert.equal(listingPush.code, 0, JSON.stringify(listingPush.output));
        assert.deepEqual(Object.keys(listingBody).sort(), ['base_revision', 'listing']);
        assert.deepEqual(listingBody.listing, { description: 'Spin it.', documentation: null, install_notes: null, video_url: null, category_ids: [3], tag_names: ['wheel'] });
        assert.deepEqual(listingPush.output.changed, { template: false, options: false, listing: true });

        writeFileSync(join(directory, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\nA faster spin.\n');

        const notesPush = await kit(['push', path, link], root);
        const notesBody = marketplace.pushes().at(-1)?.body;

        assert.equal(notesPush.code, 0, JSON.stringify(notesPush.output));
        assert.deepEqual(notesBody, { base_revision: 3, version: '1.0.0', release_notes: 'A faster spin.' });
    });

    test('a push uploads new files with their tag and attaches approved libraries, then nothing is left to push', async () => {
        const library = readFileSync(new URL('./fixtures/lib/fake-three.module.js', import.meta.url));
        const { root, link, path, directory } = await syncedProduct('with-files');
        const star = png('star');

        writeFileSync(join(directory, 'assets', 'star.png'), star);
        writeFileSync(join(directory, 'assets', 'three.module.min.js'), library);

        const pushed = await kit(['push', path, link], root);
        const body = marketplace.pushes().at(-1)?.body;

        assert.equal(pushed.code, 0, JSON.stringify(pushed.output));
        assert.deepEqual(body.uploads, [{ filename: 'star.png', size_bytes: star.length, mime_type: 'image/png', purpose: 'library', tag: 'star', description: null, sha256: sha256(star) }]);
        assert.deepEqual(body.libraries, [{ name: 'three.js', version: '0.0.0-test', tag: 'three' }]);
        assert.deepEqual(pushed.output.uploaded, [{ path: 'assets/star.png', purpose: 'library', tag: 'star' }]);
        assert.deepEqual(pushed.output.attached, [{ library: 'three.js', tag: 'three' }]);

        const put = marketplace.uploads().at(-1);

        assert.equal(put?.bytes, star.length);
        assert.equal(put?.headers['content-type'], 'image/png');
        assert.equal(put?.headers['content-length'], String(star.length));
        assert.deepEqual(productJson(root, path).remote.media.map((/** @type {any} */ entry) => entry.tag).sort(), ['star', 'three']);

        const pushesBefore = marketplace.pushes().length;
        const again = await kit(['push', path, link], root);

        assert.equal(again.code, 0, JSON.stringify(again.output));
        assert.equal(again.output.nothing_to_push, true);
        assert.equal(again.output.pushed, false);
        assert.equal(marketplace.pushes().length, pushesBefore);
    });

    test('listing images go up as cover and screenshot, and the keep list removes the screenshots no longer in the folder', async () => {
        const old = png('old screenshot');
        const { root, link, path, directory } = await syncedProduct('with-images', { screenshots: [{ url: 'https://media.example/old.png', sha256: sha256(old) }, { url: 'https://media.example/unhashed.png', sha256: null }] });
        const cover = png('cover');
        const shot = png('new screenshot');

        mkdirSync(join(directory, 'listing', 'screenshots'), { recursive: true });
        writeFileSync(join(directory, 'listing', 'cover.png'), cover);
        writeFileSync(join(directory, 'listing', 'screenshots', '01.png'), shot);

        const { code, output } = await kit(['push', path, link], root);
        const body = marketplace.pushes().at(-1)?.body;

        assert.equal(code, 0, JSON.stringify(output));
        assert.deepEqual(body.uploads.map((/** @type {any} */ upload) => [upload.filename, upload.purpose, upload.sha256]), [['cover.png', 'cover', sha256(cover)], ['01.png', 'screenshot', sha256(shot)]]);
        assert.deepEqual(body.screenshots_keep, [sha256(shot)]);
        assert.equal(output.removed_screenshots, 1);
        assert.deepEqual(output.uploaded.map((/** @type {any} */ entry) => entry.purpose), ['cover', 'screenshot']);

        const remote = productJson(root, path).remote;

        assert.equal(remote.listing_images.cover.sha256, sha256(cover));
        assert.deepEqual(remote.listing_images.screenshots.map((/** @type {any} */ entry) => entry.sha256), [null, sha256(shot)]);
    });

    test('no keep list is sent while listing/screenshots/ is empty', async () => {
        const { root, link, path, directory } = await syncedProduct('no-screenshots', { screenshots: [{ url: 'https://media.example/kept.png', sha256: sha256('kept') }] });

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} again</p>\n');

        const { code } = await kit(['push', path, link], root);

        assert.equal(code, 0);
        assert.equal('screenshots_keep' in marketplace.pushes().at(-1)?.body, false);
    });

    test('more files than one batch go up in further pushes that carry only uploads', async () => {
        const { root, link, path, directory } = await syncedProduct('many-files');

        for (let index = 1; index <= 12; index++) {
            writeFileSync(join(directory, 'assets', `tile-${String(index).padStart(2, '0')}.png`), png(`tile ${index}`));
        }

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} tiles</p>\n');

        const before = marketplace.pushes().length;
        const { code, output } = await kit(['push', path, link], root);
        const [first, second] = marketplace.pushes().slice(before);

        assert.equal(code, 0, JSON.stringify(output));
        assert.equal(marketplace.pushes().length - before, 2);
        assert.equal(first.body.uploads.length, 10);
        assert.equal(first.body.template, '<p>{{ play_count }} tiles</p>\n');
        assert.deepEqual(Object.keys(second.body).sort(), ['base_revision', 'uploads']);
        assert.equal(second.body.base_revision, 2);
        assert.deepEqual(second.body.uploads.map((/** @type {any} */ upload) => upload.filename), ['tile-11.png', 'tile-12.png']);
        assert.equal(output.uploaded.length, 12);
        assert.equal(productJson(root, path).remote.media.length, 12);
    });

    test('a changed locked file blocks the push, which says to save it under a new name', async () => {
        const logo = png('logo');
        const { root, link, path, directory } = await syncedProduct('locked-logo', {
            media: [{ tag: 'logo', filename: 'logo.png', kind: 'image', mime_type: 'image/png', size_bytes: logo.length, sha256: sha256(logo), description: 'The logo', url: 'https://media.example/logo.png', library: null, locked: true }],
        });

        writeFileSync(join(directory, 'assets', 'logo.png'), png('a new logo'));
        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} logo</p>\n');

        const before = marketplace.pushes().length;
        const { code, output } = await kit(['push', path, link], root);

        assert.equal(code, 1, JSON.stringify(output));
        assert.equal(marketplace.pushes().length, before);
        assert.equal(output.error.code, 'not_ready');
        assert.deepEqual(output.error.issues.map((/** @type {any} */ issue) => [issue.code, issue.file]), [['asset_locked', 'assets/logo.png']]);
        assert.match(output.error.issues[0].message, /Save your change as assets\/logo-2\.png/);
    });

    test('refuses when the draft changed on the marketplace and the folder differs from it', async () => {
        const { root, link, path, directory } = await syncedProduct('studio-edit');
        const product = /** @type {Record<string, any>} */ (marketplace.products.get('studio-edit'));

        product.draft = { ...product.draft, template: '<p>edited in the studio</p>\n', revision: 2 };
        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} mine</p>\n');

        const before = marketplace.pushes().length;
        const { code, output } = await kit(['push', path, link], root);

        assert.equal(code, 1);
        assert.equal(output.error.code, 'conflict');
        assert.match(output.error.message, /revision 2, and this workspace last recorded revision 1/);
        assert.match(output.error.message, /export_product and npx @rafflex\/dev import <bundle_url> --force/);
        assert.equal(marketplace.pushes().length, before);
    });

    test('a refused push prints the marketplace\'s issues like check does, and changes nothing locally', async () => {
        const { root, link, path, directory } = await syncedProduct('refused');
        const recorded = readFileSync(join(directory, 'product.json'), 'utf8');

        writeFileSync(join(directory, 'listing.md'), '---\ncategory_ids: [2]\ntag_names: []\nvideo_url: ""\n---\n\n## Description\n\nIt spins.\n');
        marketplace.behaviour.validate = (body) => (body.listing ? [{ code: 'invalid_argument', field: 'listing.category_ids.0', message: 'The selected category is invalid.' }] : null);

        try {
            const json = await kit(['push', path, link], root);

            assert.equal(json.code, 1);
            assert.equal(json.output.error.code, 'validation_failed');
            assert.deepEqual(json.output.error.issues, [{ code: 'invalid_argument', field: 'listing.category_ids.0', message: 'The selected category is invalid.' }]);
            assert.equal(readFileSync(join(directory, 'product.json'), 'utf8'), recorded);

            const prose = await run(['push', path, link], { cwd: root, baseUrl: marketplace.baseUrl });

            assert.equal(prose.code, 1);
            assert.match(prose.stderr, / {2}error {3}\[invalid_argument\] listing\.category_ids\.0: The selected category is invalid\./);
        } finally {
            marketplace.behaviour.validate = null;
        }
    });

    test('an expired link and a rate limit say what to do next, and exit 2', async () => {
        const { root, link, path, directory } = await syncedProduct('limits');

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} soon</p>\n');
        marketplace.behaviour.rateLimited = 30;

        try {
            const limited = await kit(['push', path, link], root);

            assert.equal(limited.code, 2);
            assert.equal(limited.output.error.code, 'rate_limited');
            assert.equal(limited.output.error.retry_after_seconds, 30);
            assert.match(limited.output.error.message, /Wait 30 seconds/);
        } finally {
            marketplace.behaviour.rateLimited = null;
        }

        marketplace.expire(link);

        const expired = await kit(['push', path, link], root);

        assert.equal(expired.code, 2);
        assert.equal(expired.output.error.code, 'expired');
        assert.match(expired.output.error.message, /Ask your AI for a new link with request_sync/);
    });

    test('a failed upload records what landed and a second push sends only what is missing', async () => {
        const { root, link, path, directory } = await syncedProduct('retry-upload');

        writeFileSync(join(directory, 'assets', 'a.png'), png('a'));
        writeFileSync(join(directory, 'assets', 'b.png'), png('b'));
        marketplace.behaviour.failUploads.add('b.png');

        try {
            const failed = await kit(['push', path, link], root);

            assert.equal(failed.code, 1);
            assert.equal(failed.output.error.code, 'upload_failed');
            assert.match(failed.output.error.message, /assets\/b\.png/);
            assert.deepEqual(failed.output.uploaded.map((/** @type {any} */ entry) => entry.path), ['assets/a.png']);
            assert.deepEqual(failed.output.not_uploaded.map((/** @type {any} */ entry) => entry.path), ['assets/b.png']);
            assert.deepEqual(productJson(root, path).remote.media.map((/** @type {any} */ entry) => entry.tag), ['a']);
        } finally {
            marketplace.behaviour.failUploads.clear();
        }

        const before = marketplace.uploads().length;
        const retried = await kit(['push', path, marketplace.issueLink('retry-upload')], root);

        assert.equal(retried.code, 0, JSON.stringify(retried.output));
        assert.deepEqual(retried.output.uploaded.map((/** @type {any} */ entry) => entry.path), ['assets/b.png']);
        assert.equal(marketplace.uploads().length - before, 1);
    });

    test('verify blocks a push, and a fresh saved verify is reused', async () => {
        const { root, link, path, directory } = await syncedProduct('verify-first');

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }}</p>\n<script>eval("1")</script>\n');

        const blocked = await kit(['push', path, link], root);

        assert.equal(blocked.code, 1);
        assert.equal(blocked.output.error.code, 'not_ready');
        assert.ok(blocked.output.error.issues.length > 0);

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} fixed</p>\n');

        const verified = await kit(['verify', path], root);

        assert.equal(verified.code, 0, JSON.stringify(verified.output));

        const saved = join(directory, '.results', 'verify.json');
        const later = new Date(Date.now() + 5000);

        utimesSync(saved, later, later);

        const reused = await kit(['push', path, link], root);

        assert.equal(reused.code, 0, JSON.stringify(reused.output));
        assert.doesNotMatch(reused.stderr, /Verifying/);
        assert.ok(statSync(saved).mtimeMs >= later.getTime() - 1000);
    });

    test('refuses a link on another origin, a link for another product, and a redirect, without sending anything', async () => {
        const { root, link, path } = await syncedProduct('guarded');
        const before = marketplace.requests.length;
        const foreign = await kit(['push', path, 'https://elsewhere.example/mcp/sync/abc?signature=x'], root);

        assert.equal(foreign.code, 2);
        assert.equal(foreign.output.error.code, 'invalid_link');
        assert.equal(marketplace.requests.length, before);

        const newProduct = await kit(['push', path, marketplace.issueLink(null)], root);

        assert.equal(newProduct.code, 1);
        assert.equal(newProduct.output.error.code, 'wrong_link');

        marketplace.behaviour.getStatus = 302;

        try {
            const redirected = await kit(['push', path, link], root);

            assert.equal(redirected.code, 2);
            assert.equal(redirected.output.error.code, 'unexpected_response');
        } finally {
            marketplace.behaviour.getStatus = null;
        }

        const missing = await kit(['push', path], root);

        assert.equal(missing.code, 2);
        assert.match(missing.output.error.message, /request_sync with slug guarded/);
    });

    test('refuses an upload link on another origin', async () => {
        const { root, link, path, directory } = await syncedProduct('foreign-upload');

        writeFileSync(join(directory, 'assets', 'c.png'), png('c'));
        marketplace.behaviour.uploadOrigin = 'http://127.0.0.2:9';

        try {
            const { code, output } = await kit(['push', path, link], root);

            assert.equal(code, 1);
            assert.equal(output.not_uploaded[0].path, 'assets/c.png');
            assert.match(output.not_uploaded[0].message, /not the marketplace, so nothing was sent/);
        } finally {
            marketplace.behaviour.uploadOrigin = null;
        }
    });
});

describe('synced and release with a sync link', () => {
    /** @type {Awaited<ReturnType<typeof startFakeMarketplace>>} */
    let marketplace;

    before(async () => {
        marketplace = await startFakeMarketplace();
    });

    after(() => marketplace.close());

    const feedback = {
        review: { version: '1.0.0', decision: 'changes_requested', notes: 'Add an empty state.\nAnd a <b>bold</b> claim.', decided_at: '2026-10-02T10:00:00+00:00', failing_checks: ['A cover image'] },
        open_bug_reports: 2,
        unanswered_questions: 1,
        statistics: { installs: 12, sales: 3, rating: 4.5, ratings_count: 4 },
    };

    test('synced records the state and the feedback, and status shows them', async () => {
        marketplace.seed(marketplaceProduct({ slug: 'reviewed', latest_review: { version: '1.0.0', decision: 'changes_requested', notes: feedback.review.notes, decided_at: feedback.review.decided_at } }));
        marketplace.behaviour.feedback = feedback;

        const root = gitWorkspace([{ title: 'Reviewed', slug: 'reviewed', template }]);

        try {
            const synced = await runJson(['synced', 'reviewed', marketplace.issueLink('reviewed')], { cwd: root, baseUrl: marketplace.baseUrl });

            assert.equal(synced.code, 0, JSON.stringify(synced.output));
            assert.deepEqual(synced.output.feedback, feedback);
            assert.deepEqual(productJson(root, 'games/reviewed').remote.feedback, feedback);
        } finally {
            marketplace.behaviour.feedback = null;
        }

        const status = await runJson(['status', 'reviewed'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.deepEqual(status.output.products[0].feedback, feedback);

        const prose = await run(['status', 'reviewed'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.match(prose.stdout, /review: changes requested on 1\.0\.0\. Notes: Add an empty state\. And a <b>bold<\/b> claim\./);
        assert.match(prose.stdout, /still failing: A cover image/);
        assert.match(prose.stdout, /buyers: 2 open bug reports \(read them with list_bug_reports\), 1 unanswered question \(read them with list_questions\)/);
        assert.match(prose.stdout, /numbers: 12 installs, 3 sales, rated 4\.5 \(4 ratings\)/);
    });

    test('synced refuses a link for a product not created yet', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Unborn', template }] });
        const { code, output } = await runJson(['synced', 'unborn', marketplace.issueLink(null)], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(code, 1);
        assert.equal(output.code, 'not_created');
    });

    test('release marks the version in review; with a link it records the fresh state', async () => {
        marketplace.seed(marketplaceProduct({ slug: 'releasing' }));

        const root = gitWorkspace([{ title: 'Releasing', slug: 'releasing', template, changelog: '# Changelog\n\n## Unreleased\n\nFirst.\n' }]);

        await runJson(['synced', 'releasing', marketplace.issueLink('releasing')], { cwd: root, baseUrl: marketplace.baseUrl });

        const released = await runJson(['release', 'releasing'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(released.code, 0, JSON.stringify(released.output));
        assert.equal(released.output.in_review, true);
        assert.equal(productJson(root, 'games/releasing').remote.draft.submitted, true);
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Release releasing 1.0.0');
        assert.equal(git(root, ['status', '--porcelain']), '');

        const status = await runJson(['status', 'releasing'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(status.output.products[0].in_review, true);

        const product = /** @type {Record<string, any>} */ (marketplace.products.get('releasing'));

        product.draft = { ...product.draft, submitted: true, submitted_at: '2026-10-03T10:00:00+00:00' };
        writeFileSync(join(root, 'games', 'releasing', 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\nSecond.\n\n## 1.0.0 (submitted 2026-10-03)\n\nFirst.\n');

        const withLink = await runJson(['release', 'releasing', marketplace.issueLink('releasing')], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(withLink.code, 0, JSON.stringify(withLink.output));
        assert.equal(withLink.output.in_review, true);
        assert.equal(productJson(root, 'games/releasing').remote.draft.submitted, true);
    });
});

describe('truthful sync commits', () => {
    test('a draft changed elsewhere is committed as a sync, and restore last-push skips it', async () => {
        const root = gitWorkspace([{ title: 'Studio', slug: 'studio', template }]);
        const product = marketplaceProduct({ slug: 'studio', title: 'Studio' });
        const first = await runJson(['synced', 'studio'], { cwd: root, input: JSON.stringify(product) });

        assert.equal(first.output.git.committed, true);
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Push studio 1.0.0 (draft revision 1)');

        const edited = { ...product, draft: { ...product.draft, template: '<p>edited in the studio</p>\n', revision: 2 } };
        const second = await runJson(['synced', 'studio'], { cwd: root, input: JSON.stringify(edited) });

        assert.equal(second.output.git.committed, true);
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Sync studio (draft revision 2)');

        writeFileSync(join(root, 'games', 'studio', 'template.twig'), '<p>unpushed</p>\n');

        const restore = await runJson(['restore', 'studio', 'last-push'], { cwd: root });

        assert.equal(restore.output.subject, 'Push studio 1.0.0 (draft revision 1)');
    });
});
