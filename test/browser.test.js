import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { launchChromium, loadPlaywright } from '../src/playwright.js';
import { run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { temporaryWorkspace } from './helpers/project.js';

const withBrowser = { RAFFLEX_NO_PLAYWRIGHT: '0' };

/**
 * A game that reveals plays[i].won for each click: correct when `flip` is
 * false, wrong on the second play when it is true.
 *
 * @param {{flip?: boolean, extra?: string}} [options]
 */
function game({ flip = false, extra = '' } = {}) {
    const reveal = flip ? "(revealed.length === 2 ? !play.won : play.won) ? 'win' : 'lose'" : "play.won ? 'win' : 'lose'";

    return `<div x-data='{ plays: {{ plays|json }}, revealed: [] }'>
    <p x-show="plays.length === 0">Buy tickets to play.</p>
    <button type="button" data-rafflex-play x-show="revealed.length < plays.length" @click="revealed.push(plays[revealed.length])">Play</button>
    <ul>
        <template x-for="(play, index) in revealed" :key="index">
            <li :data-rafflex-result="${reveal}" x-text="play.won ? 'Win' : 'No win'"></li>
        </template>
    </ul>
    ${extra}
</div>
`;
}

const playwright = await loadPlaywright(temporaryWorkspace());
const launched = playwright === null ? { browser: null } : await launchChromium(playwright);
const browserAvailable = launched.browser !== null;

await launched.browser?.close();

describe('browser tests without Playwright', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    test('test and verify say how to install it and skip cleanly', async () => {
        const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', template: game() }] });
        const human = await run(['test'], { cwd: root, baseUrl: server.baseUrl });

        assert.equal(human.code, 0);
        assert.match(human.stdout, /Playwright is not installed, so the browser tests were skipped\. Install it \(a large download, ask first\) with: npx @rafflex\/dev test --install/);

        const tested = await runJson(['test'], { cwd: root, baseUrl: server.baseUrl });

        assert.equal(tested.code, 0);
        assert.equal(tested.output.skipped, true);
        assert.equal(tested.output.install, 'npx @rafflex/dev test --install');

        const verified = await runJson(['verify'], { cwd: root, baseUrl: server.baseUrl });

        assert.equal(verified.code, 0, JSON.stringify(verified.output));
        assert.equal(verified.output.ready, true);
        assert.equal(verified.output.browser_tests, 'skipped');
        assert.match((await run(['verify'], { cwd: root, baseUrl: server.baseUrl })).stdout, /ready to push \(browser tests skipped\)/);
        assert.equal(existsSync(join(root, 'games', 'spin-to-win', '.results')), false);
    });
});

describe('browser tests with Playwright', { skip: browserAvailable ? false : 'Chromium is not available here' }, () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    test('a correct game passes the playthrough in every scenario, with screenshots at every width', async () => {
        const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', template: game() }] });
        const { code, output } = await runJson(['test', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(code, 0, JSON.stringify(output.issues));
        assert.equal(output.passed, true);
        assert.equal(output.skipped, false);
        assert.deepEqual(output.issues, []);
        assert.deepEqual(output.playthrough.map((/** @type {any} */ play) => [play.scenario, play.passed]), [['mixed', true], ['all_win', true], ['all_lose', true], ['big_win', true], ['no_plays', true]]);
        assert.deepEqual(output.playthrough.find((/** @type {any} */ play) => play.scenario === 'no_plays').expected, []);
        assert.ok(output.playthrough.find((/** @type {any} */ play) => play.scenario === 'mixed').expected.includes('win'));
        assert.equal(output.runs.length, 15);

        for (const runRecord of output.runs) {
            assert.ok(existsSync(join(root, runRecord.screenshot)), runRecord.screenshot);
            assert.match(runRecord.screenshot, /^games\/spin-to-win\/\.results\/screenshots\//);
        }

        assert.deepEqual(JSON.parse(readFileSync(join(root, 'games', 'spin-to-win', '.results', 'last-run.json'), 'utf8')).playthrough, output.playthrough);
        assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.results\/$/m);
    });

    test('a game that reveals the wrong result fails with playthrough_mismatch', async () => {
        const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', template: game({ flip: true }) }] });
        const { code, output } = await runJson(['test'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });
        const mismatches = output.issues.filter((/** @type {any} */ issue) => issue.code === 'playthrough_mismatch');

        assert.equal(code, 1);
        assert.equal(output.passed, false);
        assert.ok(mismatches.some((/** @type {any} */ issue) => issue.scenario === 'all_win' && issue.message === 'Play 3 of 5 revealed lose, but the platform decided win.'));
        assert.ok(mismatches.every((/** @type {any} */ issue) => issue.screenshot.endsWith('-playthrough.png')));
        assert.equal(output.playthrough.find((/** @type {any} */ play) => play.scenario === 'no_plays').passed, true);

        const verified = await runJson(['verify'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(verified.code, 1);
        assert.equal(verified.output.ready, false);
        assert.equal(verified.output.browser_tests, 'failed');

        const planned = await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(planned.code, 1);
        assert.match(planned.stdout, /Not ready to push: \d+ blocking issues?\. Fix them, then run plan again:/);
        assert.match(planned.stdout, /\[playthrough_mismatch\] scenario all_win: Play 3 of 5 revealed lose/);
        assert.doesNotMatch(planned.stdout, /create_product/);
    });

    test('errors, failed requests, and CSP violations are reported against a screenshot', async () => {
        const extra = `<img src="https://elsewhere.example/a.png" alt="">
    <script>
        console.error('the wheel is stuck');
        missingFunction();
    </script>`;
        const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', template: game({ extra }) }] });
        const { output } = await runJson(['test'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });
        const codes = new Set(output.issues.map((/** @type {any} */ issue) => issue.code));

        assert.ok(codes.has('console_error'), JSON.stringify(output.issues));
        assert.ok(codes.has('uncaught_exception'));
        assert.ok(codes.has('csp_violation'));
        assert.ok(output.issues.some((/** @type {any} */ issue) => issue.code === 'uncaught_exception' && /missingFunction is not defined/.test(issue.message) && issue.scenario === 'mixed' && issue.screenshot === 'games/spin-to-win/.results/screenshots/mixed-phone.png'));
        assert.equal(output.passed, false);
    });

    test("the creator's specs in tests/ run with the kit's helpers", async () => {
        const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', template: game() }] });
        const tests = join(root, 'games', 'spin-to-win', 'tests');

        mkdirSync(tests);
        writeFileSync(join(tests, 'reveal.spec.mjs'), `export default {
    'the first play reveals the platform result': async ({ open, playNext, result, expected, screenshot, assert }) => {
        await open('mixed');
        const first = await playNext();
        assert.equal(first, expected('mixed')[0]);
        assert.equal(await result(), first);
        await screenshot('first-play');
    },
    'a deliberate failure is reported': async ({ open, page, assert }) => {
        await open('no_plays');
        assert.ok(await page.getByText('Jackpot').isVisible(), 'no jackpot banner');
    },
};
`);

        const { code, output } = await runJson(['test'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(code, 1);
        assert.deepEqual(output.creator_tests.map((/** @type {any} */ spec) => [spec.file, spec.name, spec.passed]), [
            ['tests/reveal.spec.mjs', 'the first play reveals the platform result', true],
            ['tests/reveal.spec.mjs', 'a deliberate failure is reported', false],
        ]);
        assert.ok(existsSync(join(root, 'games', 'spin-to-win', '.results', 'screenshots', 'first-play.png')));
        assert.ok(output.issues.some((/** @type {any} */ issue) => issue.code === 'creator_test_failed' && issue.message.includes('no jackpot banner')));
    });

    test('a block gets the run through at every width and no playthrough', async () => {
        const root = temporaryWorkspace({ products: [{ type: 'block', title: 'Winner Wall', folder: 'winner-wall', template: '<section><h2>Winners</h2></section>\n' }] });
        const { code, output } = await runJson(['test'], { cwd: root, baseUrl: server.baseUrl, env: withBrowser });

        assert.equal(code, 0, JSON.stringify(output));
        assert.equal(output.playthrough, null);
        assert.deepEqual(output.runs.map((/** @type {any} */ runRecord) => [runRecord.scenario, runRecord.device]), [[null, 'phone'], [null, 'tablet'], [null, 'desktop']]);
    });
});
