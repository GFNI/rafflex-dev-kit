import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanAssets } from './assets.js';
import { scenarioValues } from './checker.js';
import { gameContext } from './context.js';
import { assetUrl, startDevServer } from './dev-server.js';
import { hasPlaythroughHooks } from './game-rules.js';
import { buyerImageRuns } from './options/browser-run.js';
import { kitIssue } from './quality.js';
import { readTemplate, resultsDirectoryName, testsDirectoryName } from './workspace.js';

/**
 * The browser tests (PRD 41), run in headless Chromium against the kit's
 * own preview frame, which is served under the platform's preview CSP:
 *
 * - run through: every scenario (a block has one) at phone, tablet, and
 *   desktop widths, recording console errors, uncaught exceptions, failed
 *   requests, and CSP violations, with a screenshot of each;
 * - playthrough (games with the hooks): clicks data-rafflex-play once per
 *   entry in plays and checks each data-rafflex-result revealed matches
 *   the predetermined result, in order, and that no plays shows an empty
 *   state;
 * - buyer images (games whose template uses images): every image a buyer
 *   may replace swapped for a placeholder of another shape, at one phone
 *   and one desktop width (see options/browser-run.js);
 * - the creator's own specs in tests/, with the kit's helpers.
 *
 * Everything a run writes goes in the product's .results/ folder.
 */

export const devices = Object.freeze([
    { name: 'phone', width: 390, height: 844 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'desktop', width: 1280, height: 800 },
]);

const revealTimeoutMs = 10000;

const settleMs = 300;

/**
 * Records every outcome the page reveals once recording starts: an element
 * gaining data-rafflex-result="win|lose", or its value changing.
 */
const revealRecorder = `(() => {
    const recorded = new WeakMap();
    window.__rafflexReveals = [];
    window.__rafflexRecording = false;
    window.__rafflexViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
        window.__rafflexViolations.push({ directive: event.effectiveDirective || event.violatedDirective, blocked: event.blockedURI || 'inline' });
    });
    const consider = (element) => {
        if (!window.__rafflexRecording || !(element instanceof Element)) {
            return;
        }
        const value = element.getAttribute('data-rafflex-result');
        if ((value === 'win' || value === 'lose') && recorded.get(element) !== value) {
            recorded.set(element, value);
            window.__rafflexReveals.push(value);
        }
    };
    new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                consider(mutation.target);
                continue;
            }
            for (const node of mutation.addedNodes) {
                if (node instanceof Element) {
                    consider(node);
                    node.querySelectorAll('[data-rafflex-result]').forEach(consider);
                }
            }
        }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-rafflex-result'] });
})();`;

/**
 * @typedef {import('./checker.js').Issue & {screenshot?: string}} TestIssue
 * @typedef {{scenario: string|null, device: string, width: number, screenshot: string}} RunRecord
 * @typedef {{scenario: string, expected: string[], revealed: string[], passed: boolean}} PlaythroughRecord
 * @typedef {{file: string, name: string, passed: boolean, error?: string, screenshot?: string}} CreatorTestRecord
 * @typedef {{issues: TestIssue[], runs: RunRecord[], playthrough: PlaythroughRecord[]|null, creator_tests: CreatorTestRecord[], buyer_images: RunRecord[]|null}} BrowserTestResult
 */

/**
 * @param {any} page
 * @param {number} ms
 */
function pause(page, ms) {
    return page.waitForTimeout(ms);
}

/**
 * Watch a page for the problems a run through reports.
 *
 * @param {any} page
 */
function watchPage(page) {
    /** @type {{code: string, message: string}[]} */
    const found = [];

    page.on('console', (/** @type {any} */ message) => {
        const text = message.text();

        if (message.type() === 'error' && !/Content Security Policy|Refused to/i.test(text) && !/Failed to load resource/i.test(text)) {
            found.push({ code: 'console_error', message: `Console error: ${text}` });
        }
    });
    page.on('pageerror', (/** @type {Error} */ error) => {
        found.push({ code: 'uncaught_exception', message: `Uncaught ${error.name ?? 'Error'}: ${error.message}` });
    });
    page.on('requestfailed', (/** @type {any} */ request) => {
        const failure = request.failure()?.errorText ?? 'failed';

        if (!/ERR_BLOCKED_BY_CSP|ERR_ABORTED/.test(failure)) {
            found.push({ code: 'request_failed', message: `Request failed (${failure}): ${request.url()}` });
        }
    });
    page.on('response', (/** @type {any} */ response) => {
        if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
            found.push({ code: 'request_failed', message: `Request failed (HTTP ${response.status()}): ${response.url()}` });
        }
    });

    return found;
}

/**
 * @param {any} page
 * @returns {Promise<{code: string, message: string}[]>}
 */
async function cspViolations(page) {
    const violations = await page.evaluate(() => /** @type {any} */ (window).__rafflexViolations ?? []).catch(() => []);

    return violations.map((/** @type {{directive: string, blocked: string}} */ violation) => ({
        code: 'csp_violation',
        message: `The preview CSP blocked ${violation.blocked} (${violation.directive}).`,
    }));
}

/**
 * @param {any} page
 * @returns {Promise<string[]>}
 */
function reveals(page) {
    return page.evaluate(() => [.../** @type {any} */ (window).__rafflexReveals ?? []]);
}

/**
 * Click the visible data-rafflex-play element and wait for the next
 * revealed outcome.
 *
 * @param {any} page
 * @param {number} already How many outcomes were revealed before.
 * @returns {Promise<{value: string|null, problem: string|null}>}
 */
async function playNextEntry(page, already) {
    await page.evaluate(() => {
        /** @type {any} */ (window).__rafflexRecording = true;
    });

    const control = page.locator('[data-rafflex-play]:visible').first();

    try {
        await control.waitFor({ state: 'visible', timeout: revealTimeoutMs });
        await control.click({ timeout: revealTimeoutMs });
    } catch {
        return { value: null, problem: 'there is no visible, clickable data-rafflex-play element to play the next entry' };
    }

    const deadline = Date.now() + revealTimeoutMs;

    while (Date.now() < deadline) {
        const revealed = await reveals(page);

        if (revealed.length > already) {
            return { value: revealed[already], problem: null };
        }

        await pause(page, 50);
    }

    return { value: null, problem: 'nothing revealed a result: set data-rafflex-result to win or lose on the element that shows the outcome' };
}

/**
 * Play a game through in one scenario on an open page.
 *
 * @param {any} page
 * @param {string} scenario
 * @param {boolean[]} expectedWins
 * @returns {Promise<{record: PlaythroughRecord, issues: {code: string, message: string}[]}>}
 */
async function playThrough(page, scenario, expectedWins) {
    const expected = expectedWins.map((won) => (won ? 'win' : 'lose'));
    /** @type {{code: string, message: string}[]} */
    const issues = [];
    const mismatch = (/** @type {string} */ message) => issues.push({ code: 'playthrough_mismatch', message });

    if (expected.length === 0) {
        await pause(page, settleMs);

        const state = await page.evaluate(() => ({
            controls: [...document.querySelectorAll('[data-rafflex-play]')].filter((element) => element instanceof HTMLElement && element.offsetParent !== null && !(/** @type {any} */ (element).disabled)).length,
            text: (document.body?.innerText ?? '').trim(),
        }));

        if (state.controls > 0) {
            mismatch('With no plays, the game still shows a data-rafflex-play control. Show the empty state instead.');
        }

        if (state.text === '') {
            mismatch('With no plays, the game shows no text. Show an empty state, for example "Buy tickets to play".');
        }

        return { record: { scenario, expected, revealed: [], passed: issues.length === 0 }, issues };
    }

    /** @type {string[]} */
    const revealed = [];

    for (let index = 0; index < expected.length; index++) {
        const { value, problem } = await playNextEntry(page, revealed.length);

        if (problem !== null) {
            mismatch(`Play ${index + 1} of ${expected.length}: ${problem}.`);
            break;
        }

        revealed.push(/** @type {string} */ (value));

        if (value !== expected[index]) {
            mismatch(`Play ${index + 1} of ${expected.length} revealed ${value}, but the platform decided ${expected[index]}.`);
        }
    }

    await pause(page, settleMs);

    const all = await reveals(page);

    if (revealed.length === expected.length && all.length > expected.length) {
        mismatch(`The game revealed ${all.length} results for ${expected.length} plays.`);
    }

    return { record: { scenario, expected, revealed: all.length > revealed.length ? all : revealed, passed: issues.length === 0 }, issues };
}

/**
 * @param {string} workspaceRoot
 * @param {string} path
 */
function relativeToWorkspace(workspaceRoot, path) {
    return relative(workspaceRoot, path).split('\\').join('/');
}

/**
 * The creator's spec files: tests/*.spec.mjs and tests/*.spec.js.
 *
 * @param {string} productDirectory
 * @returns {string[]}
 */
export function creatorSpecFiles(productDirectory) {
    const directory = join(productDirectory, testsDirectoryName);

    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory)
        .filter((name) => /\.spec\.m?js$/.test(name))
        .sort()
        .map((name) => join(directory, name));
}

/**
 * Run the browser tests for one product.
 *
 * @param {object} options
 * @param {any} options.browser A launched Playwright browser.
 * @param {import('./workspace.js').Workspace} options.workspace
 * @param {import('./remote.js').LoadedDocuments} options.loaded
 * @param {import('./workspace.js').Product} options.product
 * @returns {Promise<BrowserTestResult>}
 */
export async function runBrowserTests({ browser, workspace, loaded, product }) {
    const { documents } = loaded;
    const resultsDirectory = join(product.directory, resultsDirectoryName);
    const screenshots = join(resultsDirectory, 'screenshots');

    rmSync(resultsDirectory, { recursive: true, force: true });
    mkdirSync(screenshots, { recursive: true });

    const template = readTemplate(product);
    const files = scanAssets(product.assetsDirectory, documents.rules, documents.libraries?.libraries ?? [], assetUrl).files;
    const playCount = documents.contexts.play_count?.default ?? 5;
    const isGame = product.type !== 'block';
    const scenarios = isGame ? scenarioValues(documents) : [null];
    const hooked = isGame && hasPlaythroughHooks(template);
    const server = await startDevServer({ workspace, loaded, port: 0, watchFiles: false });
    const frameUrl = (/** @type {string|null} */ scenario, count = playCount, /** @type {{options?: Record<string, unknown>, buyerImages?: boolean}} */ extra = {}) => {
        const query = new URLSearchParams(scenario === null ? {} : { scenario, play_count: String(count ?? playCount) });

        if (extra.options !== undefined && Object.keys(extra.options).length > 0) {
            query.set('options', JSON.stringify(extra.options));
        }

        if (extra.buyerImages === true) {
            query.set('buyer_images', '1');
        }

        return `${server.urlFor(product)}frame${query.size === 0 ? '' : `?${query}`}`;
    };
    const expectedWins = (/** @type {string} */ scenario) => gameContext(documents.contexts, { scenario, playCount, files, template }).plays.map((/** @type {{won: boolean}} */ play) => play.won === true);
    /** @type {TestIssue[]} */
    const issues = [];
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {RunRecord[]} */
    const runs = [];
    /** @type {PlaythroughRecord[]|null} */
    const playthrough = hooked ? [] : null;
    const addIssue = (/** @type {{code: string, message: string}} */ found, /** @type {string|null} */ scenario, /** @type {string|undefined} */ screenshot) => {
        const key = `${found.code}|${found.message}|${scenario}`;

        if (seen.has(key)) {
            return;
        }

        seen.add(key);

        /** @type {TestIssue} */
        const issue = kitIssue(found.code, found.message, scenario === null ? {} : { scenario });

        if (screenshot !== undefined) {
            issue.screenshot = screenshot;
        }

        issues.push(issue);
    };

    try {
        for (const scenario of scenarios) {
            const outcomes = await Promise.all(devices.map(async (device) => {
                const context = await browser.newContext({ viewport: { width: device.width, height: device.height } });

                try {
                    await context.addInitScript(revealRecorder);

                    const page = await context.newPage();
                    const found = watchPage(page);
                    const screenshot = join(screenshots, `${scenario ?? 'block'}-${device.name}.png`);

                    await page.goto(frameUrl(scenario), { waitUntil: 'load' });
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                    await pause(page, settleMs);
                    await page.screenshot({ path: screenshot, fullPage: true });

                    const shot = relativeToWorkspace(workspace.root, screenshot);
                    /** @type {{record: PlaythroughRecord, issues: {code: string, message: string}[], screenshot: string}|null} */
                    let played = null;

                    if (playthrough !== null && scenario !== null && device.name === 'desktop') {
                        const { record, issues: playIssues } = await playThrough(page, scenario, expectedWins(scenario));
                        const playShot = join(screenshots, `${scenario}-playthrough.png`);

                        await page.screenshot({ path: playShot, fullPage: true });
                        played = { record, issues: playIssues, screenshot: relativeToWorkspace(workspace.root, playShot) };
                    }

                    return { run: { scenario, device: device.name, width: device.width, screenshot: shot }, problems: [...found, ...await cspViolations(page)], played };
                } finally {
                    await context.close();
                }
            }));

            for (const outcome of outcomes) {
                runs.push(outcome.run);

                if (outcome.played !== null && playthrough !== null) {
                    playthrough.push(outcome.played.record);

                    for (const playIssue of outcome.played.issues) {
                        addIssue(playIssue, scenario, outcome.played.screenshot);
                    }
                }
            }

            for (const outcome of outcomes) {
                for (const problem of outcome.problems) {
                    addIssue(problem, scenario, outcome.run.screenshot);
                }
            }
        }

        const buyerImages = await buyerImageRuns({ browser, workspace, product, template, documents, frameUrl, scenario: scenarios[0], screenshots, devices, watchPage, cspViolations, settle: (/** @type {any} */ page) => pause(page, settleMs), relativeToWorkspace });

        for (const run of buyerImages?.runs ?? []) {
            runs.push(run);
        }

        for (const problem of buyerImages?.problems ?? []) {
            addIssue(problem, 'buyer_images', problem.screenshot);
        }

        const creatorTests = await runCreatorSpecs({ browser, workspace, product, frameUrl, expectedWins, screenshots, scenarios });

        for (const failed of creatorTests.filter((test) => !test.passed)) {
            addIssue({ code: 'creator_test_failed', message: `${failed.file}: ${failed.name}: ${failed.error}` }, null, failed.screenshot);
        }

        return { issues, runs, playthrough, creator_tests: creatorTests, buyer_images: buyerImages === null ? null : buyerImages.runs };
    } finally {
        await server.close();
    }
}

/**
 * The helpers a creator's spec receives.
 *
 * @typedef {object} SpecHelpers
 * @property {any} page The Playwright page (after open).
 * @property {(scenario?: string, options?: {width?: number, playCount?: number, options?: Record<string, unknown>}) => Promise<any>} open Open the product in a scenario, optionally with option values set as a site owner or buyer sets them.
 * @property {() => Promise<string>} playNext Play the next entry and return the revealed result.
 * @property {() => Promise<string|null>} result The last revealed result.
 * @property {() => Promise<string[]>} results Every revealed result so far.
 * @property {(scenario?: string) => string[]} expected The predetermined results of a scenario.
 * @property {(name: string) => Promise<string>} screenshot Save a screenshot in .results/screenshots.
 * @property {typeof assert} assert node:assert/strict.
 */

/**
 * @param {object} options
 * @returns {Promise<CreatorTestRecord[]>}
 */
async function runCreatorSpecs({ browser, workspace, product, frameUrl, expectedWins, screenshots, scenarios }) {
    /** @type {CreatorTestRecord[]} */
    const records = [];

    for (const file of creatorSpecFiles(product.directory)) {
        const name = relativeToWorkspace(product.directory, file);
        /** @type {[string, Function][]} */
        let tests;

        try {
            const module = await import(`${pathToFileURL(file).href}?run=${Date.now()}`);
            const exported = module.default ?? module.tests;

            tests = typeof exported === 'function' ? [[name, exported]] : Object.entries(exported ?? {}).filter(([, value]) => typeof value === 'function');

            if (tests.length === 0) {
                throw new Error('export a test function, or an object of named test functions, as the default export');
            }
        } catch (error) {
            records.push({ file: name, name: '(load)', passed: false, error: String(/** @type {Error} */ (error).message) });
            continue;
        }

        for (const [testName, run] of tests) {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const safeName = `${name}-${testName}`.replace(/[^\w.-]+/g, '-');
            /** @type {CreatorTestRecord} */
            const record = { file: name, name: testName, passed: true };

            try {
                await context.addInitScript(revealRecorder);

                const page = await context.newPage();
                /** @type {SpecHelpers} */
                const helpers = {
                    page,
                    open: async (scenario = scenarios[0] ?? undefined, options = {}) => {
                        if (options.width !== undefined) {
                            await page.setViewportSize({ width: options.width, height: 800 });
                        }

                        await page.goto(frameUrl(scenario ?? null, options.playCount, { options: options.options }), { waitUntil: 'load' });
                        await pause(page, settleMs);

                        return page;
                    },
                    playNext: async () => {
                        const { value, problem } = await playNextEntry(page, (await reveals(page)).length);

                        if (problem !== null) {
                            throw new Error(problem);
                        }

                        return /** @type {string} */ (value);
                    },
                    result: async () => (await reveals(page)).at(-1) ?? null,
                    results: () => reveals(page),
                    expected: (scenario = scenarios[0] ?? 'mixed') => expectedWins(scenario).map((/** @type {boolean} */ won) => (won ? 'win' : 'lose')),
                    screenshot: async (shotName) => {
                        const path = join(screenshots, `${String(shotName).replace(/[^\w.-]+/g, '-')}.png`);

                        await page.screenshot({ path, fullPage: true });

                        return relativeToWorkspace(workspace.root, path);
                    },
                    assert,
                };

                await run(helpers);
            } catch (error) {
                record.passed = false;
                record.error = String(/** @type {Error} */ (error).message).split('\n')[0];

                try {
                    const path = join(screenshots, `${safeName}-failed.png`);
                    const pages = context.pages();

                    if (pages.length > 0) {
                        await pages[0].screenshot({ path, fullPage: true });
                        record.screenshot = relativeToWorkspace(workspace.root, path);
                    }
                } catch {
                    // No screenshot for a page that never opened.
                }
            } finally {
                await context.close();
            }

            records.push(record);
        }
    }

    return records;
}

/**
 * Save the last run's JSON in the product's .results folder.
 *
 * @param {import('./workspace.js').Product} product
 * @param {unknown} result
 */
export function saveLastRun(product, result) {
    const directory = join(product.directory, resultsDirectoryName);

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'last-run.json'), `${JSON.stringify(result, null, 2)}\n`);
}
