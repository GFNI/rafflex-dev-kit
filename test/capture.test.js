import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { captureScenes, coverSize } from '../src/capture.js';
import { imageDimensions } from '../src/file-content.js';
import { launchChromium, loadPlaywright } from '../src/playwright.js';
import { run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { fixtureDocuments, temporaryWorkspace } from './helpers/project.js';

const withBrowser = { RAFFLEX_NO_PLAYWRIGHT: '0' };
const rules = fixtureDocuments().rules;

/**
 * A game that reveals each play's predetermined result when clicked.
 */
const game = `<div x-data='{ plays: {{ plays|json }}, revealed: [] }'>
    <p x-show="plays.length === 0">Buy tickets to play.</p>
    <button type="button" data-rafflex-play x-show="revealed.length < plays.length" @click="revealed.push(plays[revealed.length])">Play</button>
    <ul>
        <template x-for="(play, index) in revealed" :key="index">
            <li :data-rafflex-result="play.won ? 'win' : 'lose'" x-text="play.won ? 'You won' : 'No win this time'"></li>
        </template>
    </ul>
</div>
`;

const playwright = await loadPlaywright(temporaryWorkspace());
const launched = playwright === null ? { browser: null } : await launchChromium(playwright);
const browserAvailable = launched.browser !== null;

await launched.browser?.close();

describe('capture scenes', () => {
    test('a game shows ready to play, after a win, and after a loss; a block shows itself', () => {
        const scenarios = ['mixed', 'all_win', 'all_lose', 'big_win', 'no_plays'];

        assert.deepEqual(captureScenes('game', scenarios, true), [
            { key: 'ready', scenario: 'mixed', plays: 0 },
            { key: 'win', scenario: 'big_win', plays: 1 },
            { key: 'loss', scenario: 'all_lose', plays: 1 },
        ]);
        assert.deepEqual(captureScenes('game', scenarios, false).map((scene) => scene.plays), [0, 0, 0]);
        assert.deepEqual(captureScenes('block', [], false), [{ key: 'block', scenario: null, plays: 0 }]);
        assert.equal(coverSize.width / coverSize.height, 2);
    });
});

describe('capture without Playwright', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    test('says how to install it, skips cleanly, and writes nothing', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template: game }] });
        const { code, output } = await runJson(['capture', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl });

        assert.equal(code, 0);
        assert.deepEqual(output, { product: 'games/spin-to-win', captured: [], skipped: true, reason: 'Playwright is not installed, so no listing images were captured.', install: 'npx @rafflex/dev test --install' });
        assert.equal(existsSync(join(root, 'games', 'spin-to-win', 'listing')), false);

        const human = await run(['capture'], { cwd: join(root, 'games', 'spin-to-win'), baseUrl: server.baseUrl });

        assert.equal(human.code, 0);
        assert.match(human.stdout, /no listing images were captured\. Install it \(a large download, ask first\) with: npx @rafflex\/dev test --install/);
    });

    test('takes --force, and no other command but import does', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template: game }] });

        assert.equal((await run(['capture', 'spin-to-win', '--force'], { cwd: root, baseUrl: server.baseUrl })).code, 0);
        assert.match((await run(['check', '--force'], { cwd: root, baseUrl: server.baseUrl })).stderr, /--force only applies to import and capture/);
    });
});

describe('capture in a browser', { skip: browserAvailable ? false : 'Chromium is not available' }, () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    test('writes a 2:1 cover and screenshots of a game in play, after a win, and after a loss, at desktop and phone widths', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template: game }] });
        const directory = join(root, 'games', 'spin-to-win');
        const { code, output } = await runJson(['capture', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(code, 0, JSON.stringify(output));
        assert.equal(output.skipped, false);
        assert.deepEqual(output.captured.map((/** @type {any} */ image) => image.path), [
            'listing/cover.png',
            'listing/screenshots/01-ready-desktop.png',
            'listing/screenshots/02-win-desktop.png',
            'listing/screenshots/03-loss-desktop.png',
            'listing/screenshots/04-ready-phone.png',
            'listing/screenshots/05-win-phone.png',
            'listing/screenshots/06-loss-phone.png',
        ]);
        assert.deepEqual([output.captured[0].width, output.captured[0].height], [1200, 600]);
        assert.deepEqual([output.captured[1].width, output.captured[1].height], [1280, 800]);
        assert.deepEqual([output.captured[4].width, output.captured[4].height], [390, 844]);

        for (const image of output.captured) {
            const contents = readFileSync(join(directory, image.path));

            assert.equal(contents.length, image.size);
            assert.ok(image.size <= rules.listing.images.screenshot.max_bytes);
            assert.deepEqual(imageDimensions(contents), { width: image.width, height: image.height });
        }

        const checked = await runJson(['check', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl });

        assert.deepEqual(checked.output.issues.filter((/** @type {any} */ issue) => issue.code === 'listing_invalid'), []);

        const planned = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl });

        assert.equal(planned.output.listing_images.cover.path, 'listing/cover.png');
        assert.equal(planned.output.listing_images.screenshots.length, 6);
        assert.ok(!planned.output.submission.missing.some((/** @type {any} */ entry) => ['cover_image', 'screenshots'].includes(entry.key)));

        const again = await runJson(['capture', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(again.code, 0);
        assert.equal(again.output.skipped, true);
        assert.match(again.output.reason, /listing\/ already has a cover and screenshots, so nothing was captured\. Run npx @rafflex\/dev capture games\/spin-to-win --force to replace them\./);
    });

    test('keeps what the creator supplied, and replaces it only with --force', async () => {
        const root = temporaryWorkspace({ products: [{ type: 'block', title: 'Winner Wall', template: '<section><h2>Winners</h2><p>{{ play_count }}</p></section>\n' }] });
        const directory = join(root, 'blocks', 'winner-wall');
        const own = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('mine')]);

        mkdirSync(join(directory, 'listing'), { recursive: true });
        writeFileSync(join(directory, 'listing', 'cover.png'), own);

        const first = await runJson(['capture', 'winner-wall'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(first.code, 0, JSON.stringify(first.output));
        assert.deepEqual(first.output.captured.map((/** @type {any} */ image) => image.path), ['listing/screenshots/01-block-desktop.png', 'listing/screenshots/02-block-phone.png']);
        assert.match(first.output.reason, /Kept the cover already in listing\//);
        assert.deepEqual(readFileSync(join(directory, 'listing', 'cover.png')), own);

        const forced = await runJson(['capture', 'winner-wall', '--force'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(forced.code, 0);
        assert.equal(forced.output.captured[0].path, 'listing/cover.png');
        assert.notDeepEqual(readFileSync(join(directory, 'listing', 'cover.png')), own);
        assert.deepEqual(readdirSync(join(directory, 'listing', 'screenshots')), ['01-block-desktop.png', '02-block-phone.png']);
    });
});
