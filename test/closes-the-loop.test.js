import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { publishedCommands } from '../src/command-list.js';
import { ensureIgnored } from '../src/git.js';
import { listingImageUploadName, planListingImages } from '../src/listing-images.js';
import { overrideProblems } from '../src/options/overrides.js';
import { buildPushRequest, PushRequestError } from '../src/push-request.js';
import { refusalFrom } from '../src/sync-link.js';
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
 * A local listing image, as readListingImages returns it.
 *
 * @param {string} name
 * @param {string} content
 */
function screenshot(name, content) {
    const bytes = png(content);

    return { path: `listing/screenshots/${name}`, filename: name, extension: name.split('.').pop()?.toLowerCase() ?? '', size: bytes.length, sha256: sha256(bytes), mime_type: 'image/png' };
}

describe('push against the marketplace as it now answers', () => {
    /** @type {Awaited<ReturnType<typeof startFakeMarketplace>>} */
    let marketplace;

    before(async () => {
        marketplace = await startFakeMarketplace();
    });

    after(() => marketplace.close());

    /**
     * @param {string[]} args
     * @param {string} cwd
     */
    const kit = (args, cwd) => runJson(args, { cwd, baseUrl: marketplace.baseUrl });

    /**
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

    test('a draft changed elsewhere is no conflict when it holds an override its own template does not read', async () => {
        const options = { heading: { label: 'Heading' } };
        const { root, link, path } = await syncedProduct('kept-override', {}, { options });
        const product = /** @type {Record<string, any>} */ (marketplace.products.get('kept-override'));

        product.draft = { ...product.draft, revision: 2, option_overrides: options };

        const pushed = await kit(['push', path, link], root);

        assert.equal(pushed.code, 0, JSON.stringify(pushed.output));
        assert.equal(pushed.output.error, undefined);
        assert.equal(pushed.output.nothing_to_push, true);
    });

    test('screenshots saved under the system\'s default names upload under names of their own, in filename order', async () => {
        const { root, link, path, directory } = await syncedProduct('screens');
        const cover = png('cover');
        const first = png('first');
        const second = png('second');

        mkdirSync(join(directory, 'listing', 'screenshots'), { recursive: true });
        writeFileSync(join(directory, 'listing', 'Cover.PNG'), cover);
        writeFileSync(join(directory, 'listing', 'screenshots', 'Screen Shot 2026-10-03 at 10.00.00.png'), first);
        writeFileSync(join(directory, 'listing', 'screenshots', 'Screen Shot 2026-10-03 at 10.05.00.png'), second);
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'Pictures']);

        const pushed = await kit(['push', path, link], root);
        const body = marketplace.pushes().at(-1)?.body;

        assert.equal(pushed.code, 0, JSON.stringify(pushed.output));
        assert.deepEqual(body.uploads.map((/** @type {any} */ upload) => [upload.filename, upload.purpose]), [['cover.png', 'cover'], ['screenshot-01.png', 'screenshot'], ['screenshot-02.png', 'screenshot']]);
        assert.deepEqual(pushed.output.uploaded.map((/** @type {any} */ entry) => entry.path), [
            'listing/Cover.PNG',
            'listing/screenshots/Screen Shot 2026-10-03 at 10.00.00.png',
            'listing/screenshots/Screen Shot 2026-10-03 at 10.05.00.png',
        ]);
        assert.deepEqual(marketplace.products.get('screens')?.screenshots.map((/** @type {any} */ entry) => entry.sha256), [sha256(first), sha256(second)]);

        const again = await kit(['push', path, link], root);

        assert.equal(again.code, 0, JSON.stringify(again.output));
        assert.equal(again.output.nothing_to_push, true);
        assert.equal(git(root, ['status', '--porcelain']), '');

        const earlier = png('earlier');

        writeFileSync(join(directory, 'listing', 'screenshots', 'Screen Shot 2026-10-03 at 09.55.00.png'), earlier);

        const reordered = await kit(['push', path, link], root);
        const reorderBody = marketplace.pushes().at(-1)?.body;

        assert.equal(reordered.code, 0, JSON.stringify(reordered.output));
        assert.deepEqual(reorderBody.screenshots_keep, [sha256(earlier)]);
        assert.deepEqual(reorderBody.uploads.map((/** @type {any} */ upload) => upload.filename), ['screenshot-01.png', 'screenshot-02.png', 'screenshot-03.png']);
        assert.equal(reordered.output.removed_screenshots, 0);
        assert.deepEqual(marketplace.products.get('screens')?.screenshots.map((/** @type {any} */ entry) => entry.sha256), [sha256(earlier), sha256(first), sha256(second)]);

        const plan = await kit(['plan', path], root);

        assert.equal(plan.output.nothing_to_push, true, JSON.stringify(plan.output.listing_images));
    });

    test('a screenshot that does not upload is named by its own path', async () => {
        const { root, link, path, directory } = await syncedProduct('failed-shot');

        mkdirSync(join(directory, 'listing', 'screenshots'), { recursive: true });
        writeFileSync(join(directory, 'listing', 'screenshots', 'Screen Shot 2026-10-03 at 10.00.00.png'), png('shot'));
        marketplace.behaviour.failUploads.add('screenshot-01.png');

        try {
            const failed = await kit(['push', path, link], root);

            assert.equal(failed.code, 1);
            assert.equal(failed.output.error.code, 'upload_failed');
            assert.deepEqual(failed.output.not_uploaded.map((/** @type {any} */ entry) => [entry.path, entry.purpose]), [['listing/screenshots/Screen Shot 2026-10-03 at 10.00.00.png', 'screenshot']]);
        } finally {
            marketplace.behaviour.failUploads.clear();
        }
    });

    test('a push body over the marketplace\'s limit is refused with what to do, and nothing changes', async () => {
        const { root, link, path, directory } = await syncedProduct('too-big');
        const recorded = readFileSync(join(directory, 'product.json'), 'utf8');

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} and a long story</p>\n');
        marketplace.behaviour.maxBodyBytes = 40;

        try {
            const refused = await kit(['push', path, link], root);

            assert.equal(refused.code, 1);
            assert.equal(refused.output.error.code, 'too_large');
            assert.match(refused.output.error.message, /Push less at once/);
            assert.match(refused.output.error.message, /Move that file into assets\//);
            assert.equal(refused.output.pushed, false);
            assert.equal(readFileSync(join(directory, 'product.json'), 'utf8'), recorded);
        } finally {
            marketplace.behaviour.maxBodyBytes = 4 * 1024 * 1024;
        }
    });

    test('a link from a disconnected AI app says to reconnect it, for push, synced, and release', async () => {
        const { root, link, path, directory } = await syncedProduct('disconnected', {}, { changelog: '# Changelog\n\n## Unreleased\n\nNotes.\n' });

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} later</p>\n');
        marketplace.behaviour.disconnected = true;

        try {
            for (const args of [['push', path, link], ['synced', path, link], ['release', path, link]]) {
                const refused = await kit(args, root);

                assert.equal(refused.code, 1, args[0]);
                assert.equal(refused.output.error.code, 'forbidden', args[0]);
                assert.match(refused.output.error.message, /no longer connected/, args[0]);
                assert.equal(refused.output.error.message.match(/request_sync/g)?.length, 1, args[0]);
            }
        } finally {
            marketplace.behaviour.disconnected = false;
        }

        marketplace.expire(link);

        const expired = await kit(['push', path, link], root);

        assert.equal(expired.code, 2);
        assert.equal(expired.output.error.code, 'expired');
        assert.match(expired.output.error.message, /disconnects the AI app/);
    });

    test('too many libraries or kept screenshots is the marketplace\'s validation_failed, an exit 1', async () => {
        marketplace.seed(marketplaceProduct({ slug: 'counted' }));

        const link = marketplace.issueLink('counted');
        const post = async (/** @type {any} */ body) => fetch(link, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const libraries = await post({ base_revision: 1, libraries: [...Array(51).keys()].map((index) => ({ name: `lib-${index}`, tag: `lib-${index}` })) });
        const screenshots = await post({ base_revision: 1, screenshots_keep: [...Array(7).keys()].map((index) => sha256(String(index))) });

        for (const [response, field] of /** @type {const} */ ([[libraries, 'libraries'], [screenshots, 'screenshots_keep']])) {
            const error = refusalFrom({ status: response.status, headers: {}, text: await response.text() });

            assert.equal(error.code, 'validation_failed');
            assert.equal(error.exitCode, 1);
            assert.equal(error.issues?.[0].field, field);
        }
    });
});

describe('listing image uploads', () => {
    test('each image uploads as cover or screenshot-NN by position, with its own extension in lower case', () => {
        assert.equal(listingImageUploadName('cover', screenshot('Cover.JPEG', 'c')), 'cover.jpeg');
        assert.equal(listingImageUploadName('screenshot', screenshot('Screen Shot 2026-10-03 at 10.00.00.PNG', 's'), 3), 'screenshot-03.png');
    });

    test('a screenshot the marketplace shows out of the folder\'s order goes up again after the ones before it', () => {
        const [one, two, three] = [screenshot('a.png', 'one'), screenshot('b.png', 'two'), screenshot('c.png', 'three')];
        const remote = (/** @type {any[]} */ images) => ({ cover: null, screenshots: images.map((image) => ({ url: null, sha256: image.sha256 })) });
        const local = { covers: [], cover: null, screenshots: [one, two, three] };

        assert.deepEqual(planListingImages(local, remote([one, two, three])).screenshots, []);
        assert.deepEqual(planListingImages(local, remote([one, three])).screenshots.map((image) => [image.path, image.upload_filename, image.change]), [
            ['listing/screenshots/b.png', 'screenshot-02.png', 'new'],
            ['listing/screenshots/c.png', 'screenshot-03.png', 'moved'],
        ]);
        assert.deepEqual(planListingImages(local, remote([two, one, three])).screenshots.map((image) => image.change), []);
        assert.deepEqual(planListingImages(local, { cover: null, screenshots: [{ url: null, sha256: null }, { url: null, sha256: one.sha256 }] }).screenshots.map((image) => image.path), ['listing/screenshots/b.png', 'listing/screenshots/c.png']);
    });

    test('push never names more screenshots to keep than a listing shows', () => {
        const images = [...Array(7).keys()].map((index) => screenshot(`${index}.png`, `shot ${index}`));
        const plan = /** @type {any} */ ({ template: { changed: false }, options: { changed: false }, listing: { changed: false }, assets: [], release_notes: null, listing_images: { cover: null, screenshots: [], removed_screenshots: [] } });
        const product = /** @type {any} */ ({ slug: 'many', path: 'games/many', directory: '/nowhere', type: 'game', title: 'Many', version: '1.0.0' });

        assert.throws(
            () => buildPushRequest({ product, payload: marketplaceProduct({ slug: 'many' }), plan, template, listingImages: { covers: [], cover: null, screenshots: images }, documents: { rules: { listing: { images: { screenshot: { max_count: 6 } } } } } }),
            (/** @type {any} */ error) => error instanceof PushRequestError && /holds 7 different screenshots; a listing shows at most 6/.test(error.message),
        );
    });
});

describe('published limits and usage', () => {
    test('the joined choices limit is read from the rules when they publish it', () => {
        const fields = [{ key: 'size', type: 'text' }];
        const choices = { size: { choices: ['Small', 'Medium', 'Large'] } };
        const published = overrideProblems(choices, /** @type {any} */ (fields), { option_overrides: { max_choices_length: 10 } });

        assert.deepEqual(published.map((problem) => problem.message), ['options.json "size" choices add up to 18 characters (one per line); the marketplace allows 10.']);
        assert.deepEqual(overrideProblems(choices, /** @type {any} */ (fields), {}), []);
    });

    test('the sync commands quote their links in every usage line', async () => {
        const usage = Object.fromEntries(publishedCommands().map((command) => [command.name, command.usage]));

        assert.equal(usage.import, 'npx @rafflex/dev import "<bundle>"');
        assert.equal(usage.push, 'npx @rafflex/dev push <product> "<sync_url>"');
        assert.equal(usage.synced, 'npx @rafflex/dev synced <product> ["<sync_url>"]');
        assert.equal(usage.release, 'npx @rafflex/dev release <product> ["<sync_url>"]');

        const help = await run(['--help'], { cwd: temporaryWorkspace() });

        for (const line of Object.values(usage)) {
            assert.ok(help.stdout.includes(line), line);
        }
    });
});
