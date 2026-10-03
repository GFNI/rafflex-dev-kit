import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { commandOnPath, detectClients } from '../src/app/clients.js';
import { productState, publishStep, testSummary } from '../src/app/product-state.js';
import { fillPrompt, issuesText, promptSource, promptsRefreshMs } from '../src/app/prompts.js';
import { describeScreenshot, normaliseResult, readLastResult, writeAppResult } from '../src/app/results.js';
import { findOrCreateWorkspace, setupFolderName } from '../src/commands/dev.js';
import { isolatedGitEnv } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { fixturePrompts, temporaryDirectory, temporaryProduct, temporaryWorkspace } from './helpers/project.js';

/**
 * @param {Record<string, any>} remote
 * @param {Record<string, any>} [extra]
 */
function summary(remote, extra = {}) {
    return {
        path: 'games/spin-to-win',
        type: 'game',
        title: 'Spin to Win',
        version: '1.1.0',
        slug: 'spin-to-win',
        url: '/p/games/spin-to-win/',
        remote: { pushed: true, synced: true, status: 'published', live_version: null, in_review: false, review: null, stale: false, ...remote },
        local: { changed: [] },
        problems: [],
        ...extra,
    };
}

describe('product state', () => {
    test('names the state, most important first', () => {
        assert.equal(productState(summary({ pushed: false }, { slug: null, local: null })).label, 'Not pushed yet');
        assert.equal(productState(summary({ in_review: true, live_version: '1.0.0' }, { local: { changed: ['template'] } })).label, 'In review');
        assert.equal(productState(summary({ review: { decision: 'changes_requested', version: '1.1.0' } }, { local: { changed: ['template'] } })).label, 'Changes requested');
        assert.equal(productState(summary({ review: { decision: 'rejected', version: '1.1.0' } })).label, 'Rejected');
        assert.equal(productState(summary({ live_version: '1.0.0' }, { local: { changed: ['listing'] } })).label, 'Changes not pushed');
        assert.equal(productState(summary({ live_version: '1.2.0' })).label, 'Live 1.2.0');
        assert.equal(productState(summary({})).label, 'Pushed, not live');
    });

    test('summarises the last test as Passed, Issues, or Not tested', () => {
        const passed = normaliseResult({ passed: true, issues: [] }, { productDirectory: temporaryDirectory() });
        const failed = normaliseResult({ passed: false, issues: [{ code: 'safety', message: 'Blocked', fix: 'Remove it' }] }, { productDirectory: temporaryDirectory() });

        assert.equal(testSummary(null).label, 'Not tested');
        assert.equal(testSummary(passed).label, 'Passed');
        assert.equal(testSummary(failed).label, 'Issues');
    });

    test('Get it live is disabled with a reason while tests have blocking issues or a playthrough fails', () => {
        const prompts = fixturePrompts();
        const blocked = normaliseResult({ issues: [{ code: 'safety', message: 'Blocked', fix: 'Remove it' }] }, { productDirectory: temporaryDirectory() });
        const mismatch = normaliseResult({ passed: false, playthrough: [{ scenario: 'mixed', passed: false, plays: [{ expected: 'win', actual: 'lose' }] }] }, { productDirectory: temporaryDirectory() });
        const warningsOnly = normaliseResult({ issues: [{ code: 'unformatted', message: 'Not formatted', fix: 'Run format', blocking: false }] }, { productDirectory: temporaryDirectory() });

        for (const result of [blocked, mismatch]) {
            const step = publishStep(summary({ live_version: '1.0.0' }), result, prompts);

            assert.equal(step.disabled, true);
            assert.equal(step.next, 'Fix these first, or ask your AI to.');
            assert.equal(step.prompt?.key, 'fix');
        }

        assert.equal(publishStep(summary({ live_version: '1.0.0' }), warningsOnly, prompts).disabled, false);
    });
});

describe('test results', () => {
    test('reads verify output with steps, screenshots, and a playthrough', () => {
        const directory = temporaryProduct();
        const result = normaliseResult({
            command: 'verify',
            passed: false,
            steps: {
                format: { passed: true, issues: [] },
                check: { passed: true, issues: [{ code: 'unformatted', message: 'Template is not formatted', fix: 'Run format', blocking: false }] },
                test: {
                    passed: false,
                    issues: [{ code: 'playthrough_mismatch', message: 'Play 2 showed lose', fix: 'Reveal the decided result', scenario: 'mixed', screenshot: '.results/screenshots/mixed-phone.png', severity: 'error' }],
                    screenshots: [{ path: '.results/screenshots/mixed-phone.png', scenario: 'mixed', device: 'phone' }, 'screenshots/no_plays-1280.png', '../outside.png'],
                    playthrough: { mixed: { passed: false, plays: [{ index: 0, expected: 'win', actual: 'win' }, { index: 1, expected: 'win', actual: 'lose' }] } },
                },
            },
        }, { productDirectory: directory, at: '2026-10-03T10:00:00.000Z' });

        assert.equal(result.status, 'issues');
        assert.equal(result.source, 'verify');
        assert.deepEqual(result.blocking.map((issue) => issue.code), ['playthrough_mismatch']);
        assert.deepEqual(result.warnings.map((issue) => issue.code), ['unformatted']);
        assert.deepEqual(result.screenshots, [
            { path: 'screenshots/mixed-phone.png', scenario: 'mixed', device: 'phone' },
            { path: 'screenshots/no_plays-1280.png', scenario: 'no_plays', device: '1280' },
        ]);
        assert.deepEqual(result.playthrough, [{
            scenario: 'mixed',
            passed: false,
            message: null,
            plays: [{ number: 1, expected: 'win', actual: 'win', passed: true }, { number: 2, expected: 'win', actual: 'lose', passed: false }],
        }]);
    });

    test('reads the verify result shape of PRD 41: ready, runs, workspace relative screenshots, and playthrough records', () => {
        const directory = temporaryProduct();
        const result = normaliseResult({
            product: 'games/spin-to-win',
            ready: false,
            browser_tests: 'failed',
            format: { product: 'games/spin-to-win', changed: false },
            check: { product: 'games/spin-to-win', passed: true, issues: [] },
            test: {
                passed: false,
                skipped: false,
                issues: [{ code: 'playthrough_mismatch', message: 'Play 2 revealed lose', fix: 'Reveal the decided result', scenario: 'mixed', screenshot: 'games/spin-to-win/.results/screenshots/mixed-play.png' }],
                runs: [{ scenario: 'mixed', device: 'phone', width: 390, screenshot: 'games/spin-to-win/.results/screenshots/mixed-phone.png' }],
                playthrough: [{ scenario: 'mixed', expected: ['win', 'win'], revealed: ['win', 'lose'], passed: false }],
            },
            issues: [{ code: 'playthrough_mismatch', message: 'Play 2 revealed lose', fix: 'Reveal the decided result', scenario: 'mixed', screenshot: 'games/spin-to-win/.results/screenshots/mixed-play.png' }],
            blocking: 1,
            warnings: 0,
        }, { productDirectory: directory });

        assert.equal(result.status, 'issues');
        assert.equal(result.blocking.length, 1);
        assert.deepEqual(result.screenshots.map((shot) => [shot.path, shot.scenario, shot.device]), [
            ['screenshots/mixed-play.png', 'mixed', null],
            ['screenshots/mixed-phone.png', 'mixed', 'phone'],
        ]);
        assert.deepEqual(result.playthrough[0].plays, [{ number: 1, expected: 'win', actual: 'win', passed: true }, { number: 2, expected: 'win', actual: 'lose', passed: false }]);
        assert.equal(normaliseResult({ ready: false, test: { skipped: true, reason: 'Playwright is not installed, so the browser tests were skipped.' }, issues: [] }, { productDirectory: directory }).notes[0], 'Playwright is not installed, so the browser tests were skipped.');
    });

    test('reads check output, notes skipped browser tests, and finds screenshots on disk', () => {
        const directory = temporaryProduct();

        mkdirSync(join(directory, '.results', 'all_win'), { recursive: true });
        writeFileSync(join(directory, '.results', 'all_win', 'tablet.png'), 'png');

        const result = normaliseResult({ passed: true, issues: [{ code: 'option_warning', message: 'Option has no label', fix: 'Add a label' }], test: { skipped: 'Browser tests skipped: Playwright is not installed.' } }, { productDirectory: directory });

        assert.equal(result.status, 'passed');
        assert.deepEqual(result.blocking, []);
        assert.equal(result.warnings[0].code, 'option_warning');
        assert.deepEqual(result.notes, ['Browser tests skipped: Playwright is not installed.']);
        assert.deepEqual(result.screenshots, [{ path: 'all_win/tablet.png', scenario: 'all_win', device: 'tablet' }]);
    });

    test('a run that printed an error is an error, and no output at all is too', () => {
        const directory = temporaryProduct();

        assert.equal(normaliseResult({ passed: false, error: 'No products', issues: [] }, { productDirectory: directory }).status, 'error');
        assert.equal(normaliseResult(null, { productDirectory: directory }).status, 'error');
    });

    test('reads the newest result file, unwrapping what the app wrote', () => {
        const directory = temporaryProduct();

        assert.equal(readLastResult(directory), null);

        writeAppResult(directory, { source: 'check', at: '2026-10-03T09:00:00.000Z', output: { passed: true, issues: [] }, exitCode: 0 });

        const fromApp = readLastResult(directory);

        assert.equal(fromApp?.status, 'passed');
        assert.equal(fromApp?.at, '2026-10-03T09:00:00.000Z');
        assert.equal(fromApp?.source, 'check');
        assert.equal(readFileSync(join(directory, '.results', '.gitignore'), 'utf8'), '*\n');

        writeFileSync(join(directory, '.results', 'verify.json'), JSON.stringify({ passed: false, issues: [{ code: 'safety', message: 'Blocked', fix: 'Remove it' }] }));

        assert.equal(readLastResult(directory)?.status, 'issues');
    });

    test('names scenario and device from a screenshot path', () => {
        assert.deepEqual(describeScreenshot('screenshots/all_win-phone.png'), { scenario: 'all_win', device: 'phone' });
        assert.deepEqual(describeScreenshot('mixed/desktop.png'), { scenario: 'mixed', device: 'desktop' });
        assert.deepEqual(describeScreenshot('no_plays@390.png'), { scenario: 'no_plays', device: '390' });
        assert.deepEqual(describeScreenshot('cover.png'), { scenario: 'cover', device: null });
    });
});

describe('AI app detection', () => {
    test('finds commands on the PATH and known applications, without running anything', () => {
        const present = new Set(['/usr/local/bin/claude', '/Applications/Cursor.app']);
        const exists = (/** @type {string} */ path) => present.has(path);

        assert.equal(commandOnPath('claude', { env: { PATH: '/usr/bin:/usr/local/bin' }, platform: 'darwin', exists }), true);
        assert.equal(commandOnPath('codex', { env: { PATH: '/usr/bin:/usr/local/bin' }, platform: 'darwin', exists }), false);
        assert.deepEqual(detectClients({ env: { PATH: '/usr/bin:/usr/local/bin' }, platform: 'darwin', home: '/Users/me', exists }), ['claude-code', 'cursor']);
    });

    test('uses PATHEXT and LOCALAPPDATA on Windows', () => {
        const present = new Set(['C:\\Tools/codex.cmd', 'C:\\Users\\me\\AppData\\Local/Programs/Microsoft VS Code/Code.exe']);
        const exists = (/** @type {string} */ path) => present.has(path.replaceAll('\\\\', '\\'));
        const env = { Path: 'C:\\Tools', PATHEXT: '.EXE;.CMD', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

        assert.deepEqual(detectClients({ env, platform: 'win32', home: 'C:\\Users\\me', exists }), ['codex', 'vscode']);
    });
});

describe('prompts from the marketplace', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let fixtures;

    before(async () => {
        fixtures = await startFixtureServer();
    });

    after(() => fixtures.close());

    test('fills the known placeholders and leaves the rest as written', () => {
        assert.equal(fillPrompt('Build {title} in {path}: {unknown} {version}', { title: 'Spin', path: 'games/spin', version: '' }), 'Build Spin in games/spin: {unknown} {version}');
        assert.equal(issuesText([{ message: 'Blocked', fix: 'Remove it', scenario: 'mixed', line: 3 }]), '- Blocked (line 3, scenario mixed) Fix: Remove it');
    });

    test('loads prompts.json, refreshes it after the interval, and keeps the cached copy offline', async () => {
        const root = temporaryWorkspace();
        let now = 0;
        const source = promptSource({ workspaceDirectory: root, baseUrl: fixtures.baseUrl, now: () => now });
        const first = await source.get();

        assert.equal(first.error, null);
        assert.match(first.document?.prompts.iterate.text ?? '', /^Change \{title\}/);

        fixtures.changeDocument('prompts', (document) => ({ ...document, version: 'changed000001', prompts: { ...document.prompts, iterate: { ...document.prompts.iterate, text: 'Now change {title}.' } } }));

        assert.match((await source.get()).document?.prompts.iterate.text ?? '', /^Change/);

        now += promptsRefreshMs;

        assert.equal((await source.get()).document?.prompts.iterate.text, 'Now change {title}.');

        fixtures.failing.add('manifest');
        now += promptsRefreshMs;

        const offline = await source.get();

        assert.equal(offline.document?.prompts.iterate.text, 'Now change {title}.');
        assert.equal(offline.error, null);
        fixtures.failing.delete('manifest');
    });

    test('says why when the marketplace has no prompts.json and nothing is cached', async () => {
        fixtures.failing.add('prompts');

        try {
            const { document, error } = await promptSource({ workspaceDirectory: temporaryWorkspace(), baseUrl: fixtures.baseUrl }).get();

            assert.equal(document, null);
            assert.match(error ?? '', /prompts\.json/);
        } finally {
            fixtures.failing.delete('prompts');
        }
    });
});

describe('one command setup', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let fixtures;
    const bin = fileURLToPath(new URL('../bin/rafflex-dev.js', import.meta.url));

    before(async () => {
        fixtures = await startFixtureServer();
    });

    after(() => fixtures.close());

    /**
     * Start the app, read what it prints, and stop it.
     *
     * @param {string[]} args
     * @param {string} cwd
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    function startApp(args, cwd) {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [bin, ...args, '--no-open', '--port', '0'], { cwd, env: { ...process.env, ...isolatedGitEnv, RAFFLEX_BASE_URL: fixtures.baseUrl } });
            let stdout = '';
            let stderr = '';
            const timeout = setTimeout(() => {
                child.kill();
                reject(new Error(`no output: ${stdout} ${stderr}`));
            }, 15000);

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
            });
            child.stdout.on('data', (chunk) => {
                stdout += chunk;

                const complete = args.includes('--json') ? (() => {
                    try {
                        JSON.parse(stdout);

                        return true;
                    } catch {
                        return false;
                    }
                })() : stdout.split('\n').length > 3;

                if (complete) {
                    clearTimeout(timeout);
                    child.kill();
                    resolve({ stdout, stderr });
                }
            });
            child.on('exit', () => {
                clearTimeout(timeout);
                reject(new Error(`exited early: ${stdout} ${stderr}`));
            });
        });
    }

    test('in an empty folder it creates the workspace, asks nothing, and prints three lines', async () => {
        const folder = realpathSync(temporaryDirectory());
        const { stdout } = await startApp([], folder);
        const workspace = join(folder, setupFolderName);
        const lines = stdout.trimEnd().split('\n');

        assert.equal(lines.length, 3);
        assert.equal(lines[0], `Workspace: ${workspace}`);
        assert.match(lines[1], /^Rafflex app: http:\/\/127\.0\.0\.1:\d+\/$/);
        assert.equal(lines[2], 'Leave this running. Close it with Ctrl+C.');
        assert.equal(JSON.parse(readFileSync(join(workspace, 'rafflex.json'), 'utf8')).workspace, 1);
        assert.ok(existsSync(join(workspace, 'AGENTS.md')));
        assert.ok(existsSync(join(workspace, 'games')));
        assert.ok(existsSync(join(workspace, '.git')));
    });

    test('running it again opens the same workspace, from the parent or from inside it', async () => {
        const folder = realpathSync(temporaryDirectory());
        const first = JSON.parse((await startApp(['--json'], folder)).stdout);
        const again = JSON.parse((await startApp(['--json'], folder)).stdout);
        const inside = JSON.parse((await startApp(['--json'], join(folder, setupFolderName, 'games'))).stdout);

        assert.equal(first.created, true);
        assert.equal(first.workspace, join(folder, setupFolderName));
        assert.equal(again.created, false);
        assert.equal(again.workspace, first.workspace);
        assert.equal(inside.created, false);
        assert.equal(inside.workspace, first.workspace);
    });

    test('inside a workspace it never creates another, and a rafflex folder with other files is left alone', async () => {
        const root = temporaryWorkspace();
        const busy = temporaryDirectory();

        mkdirSync(join(busy, setupFolderName));
        writeFileSync(join(busy, setupFolderName, 'notes.txt'), 'mine');

        assert.deepEqual(await findOrCreateWorkspace(root), { root, created: false, warnings: [] });
        assert.equal(existsSync(join(root, setupFolderName)), false);
        await assert.rejects(findOrCreateWorkspace(busy), /already a rafflex folder here with other files/);
        assert.equal(existsSync(join(busy, setupFolderName, 'rafflex.json')), false);
    });
});
