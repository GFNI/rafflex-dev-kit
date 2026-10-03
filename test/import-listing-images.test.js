import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureIgnored } from '../src/git.js';
import { bundleFile, bundleFixture, serveFixtureMedia } from './helpers/bundles.js';
import { isolatedGitEnv, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { startMediaServer } from './helpers/media-server.js';
import { temporaryWorkspace } from './helpers/project.js';

const sha = (/** @type {string|Buffer} */ data) => createHash('sha256').update(data).digest('hex');
const png = (/** @type {string} */ text) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);
const jpeg = (/** @type {string} */ text) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(text)]);

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } }).trim();
}

describe('import with listing images', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let marketplace;
    /** @type {Awaited<ReturnType<typeof startMediaServer>>} */
    let media;
    const cover = png('cover');
    const first = jpeg('first');
    const second = png('second');

    before(async () => {
        marketplace = await startFixtureServer();
        media = await startMediaServer();
        serveFixtureMedia(media);
        media.serve('/listing/cover-a1b2', cover);
        media.serve('/listing/shot-1.jpg', first);
        media.serve('/listing/shot-2.png', second);
    });

    after(async () => {
        await marketplace.close();
        await media.close();
    });

    /**
     * The spin-to-win bundle with a cover and two screenshots.
     *
     * @param {Record<string, any>} [overrides]
     */
    function bundleWithImages(overrides = {}) {
        const bundle = bundleFixture('spin-to-win', media.baseUrl);

        bundle.product = {
            ...bundle.product,
            cover_image_url: `${media.baseUrl}/listing/cover-a1b2`,
            cover_image_sha256: sha(cover),
            screenshot_urls: [`${media.baseUrl}/listing/shot-1.jpg`, `${media.baseUrl}/listing/shot-2.png`],
            screenshots: [{ url: `${media.baseUrl}/listing/shot-1.jpg`, sha256: sha(first) }, { url: `${media.baseUrl}/listing/shot-2.png`, sha256: sha(second) }],
            ...overrides,
        };

        return bundle;
    }

    test('downloads the cover and screenshots into listing/, in order, records them, and commits them', async () => {
        const root = temporaryWorkspace();

        ensureIgnored(root);
        git(root, ['init', '-q', '-b', 'main']);
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'Scaffold']);

        const { code, output } = await runJson(['import', bundleFile(bundleWithImages())], { cwd: root, baseUrl: marketplace.baseUrl });
        const directory = join(root, 'games', 'spin-to-win');

        assert.equal(code, 0, JSON.stringify(output));
        assert.deepEqual(output.files.filter((/** @type {string} */ file) => file.startsWith('listing/')), ['listing/cover.png', 'listing/screenshots/01.jpg', 'listing/screenshots/02.png']);
        assert.deepEqual(readFileSync(join(directory, 'listing', 'cover.png')), cover);
        assert.deepEqual(readFileSync(join(directory, 'listing', 'screenshots', '01.jpg')), first);

        const remote = JSON.parse(readFileSync(join(directory, 'product.json'), 'utf8')).remote;

        assert.deepEqual(remote.listing_images, {
            cover: { url: `${media.baseUrl}/listing/cover-a1b2`, sha256: sha(cover) },
            screenshots: [{ url: `${media.baseUrl}/listing/shot-1.jpg`, sha256: sha(first) }, { url: `${media.baseUrl}/listing/shot-2.png`, sha256: sha(second) }],
        });
        assert.match(git(root, ['ls-tree', '-r', '--name-only', 'HEAD']), /games\/spin-to-win\/listing\/screenshots\/02\.png/);
        assert.equal(git(root, ['status', '--porcelain']), '');

        const plan = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(plan.output.nothing_to_push, true, JSON.stringify(plan.output.listing_images));
        assert.deepEqual(plan.output.listing_images, { cover: null, screenshots: [], removed_screenshots: [] });
        assert.deepEqual(plan.output.submission, { ready: true, missing: [] });

        mkdirSync(join(directory, 'listing', 'screenshots'), { recursive: true });
        writeFileSync(join(directory, 'listing', 'screenshots', '03.png'), png('third'));

        const status = await runJson(['status', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.deepEqual(status.output.products[0].changes.listing_images, { cover: false, screenshots: 1 });
        assert.equal(status.output.products[0].changes.any, true);

        const refused = await runJson(['import', bundleFile(bundleWithImages())], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(refused.code, 1);
        assert.ok(refused.output.local_changes.includes('listing/screenshots/03.png (new)'));
    });

    test('refuses a listing image whose download does not match its hash', async () => {
        const root = temporaryWorkspace();
        const { code, output } = await runJson(['import', bundleFile(bundleWithImages({ cover_image_sha256: sha('something else') }))], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(code, 1);
        assert.match(output.error, /The cover image does not match the bundle's hash/);
        assert.equal(existsSync(join(root, 'games', 'spin-to-win')), false);
    });
});
