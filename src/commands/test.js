import { runBrowserTests, saveLastRun } from '../browser-test.js';
import { isBlocking } from '../checker.js';
import { ensureIgnored } from '../git.js';
import { installCommand, installPlaywright, launchChromium, loadPlaywright } from '../playwright.js';
import { resultsDirectoryName } from '../workspace.js';
import { loadSelection } from './format.js';
import { messageOf, writeJson } from './output.js';

/**
 * @typedef {object} TestResult
 * @property {string} product
 * @property {boolean} passed       No blocking issue (true when skipped).
 * @property {boolean} skipped      Playwright is not installed or Chromium did not start.
 * @property {string|null} reason   Why the browser tests were skipped.
 * @property {string|null} install  The command that installs Playwright, when it is missing.
 * @property {(import('../checker.js').Issue & {screenshot?: string})[]} issues
 * @property {import('../browser-test.js').RunRecord[]} runs
 * @property {import('../browser-test.js').PlaythroughRecord[]|null} playthrough Null for blocks and games without the hooks.
 * @property {import('../browser-test.js').CreatorTestRecord[]} creator_tests
 * @property {string} results       The product's results folder, workspace relative.
 */

export const missingPlaywrightReason = 'Playwright is not installed, so the browser tests were skipped.';

/**
 * @param {import('../workspace.js').Product} product
 * @param {string} reason
 * @param {string|null} install
 * @returns {TestResult}
 */
export function skippedTest(product, reason, install) {
    return { product: product.path, passed: true, skipped: true, reason, install, issues: [], runs: [], playthrough: null, creator_tests: [], results: `${product.path}/${resultsDirectoryName}` };
}

/**
 * Run the browser tests for products, or skip them all when Playwright
 * is missing or Chromium cannot start.
 *
 * @param {object} options
 * @param {import('../workspace.js').Workspace} options.workspace
 * @param {import('../remote.js').LoadedDocuments} options.loaded
 * @param {import('../workspace.js').Product[]} options.products
 * @returns {Promise<TestResult[]>}
 */
export async function testProducts({ workspace, loaded, products }) {
    const playwright = await loadPlaywright(workspace.root);

    if (playwright === null) {
        return products.map((product) => skippedTest(product, missingPlaywrightReason, installCommand));
    }

    const { browser, error } = await launchChromium(playwright);

    if (browser === null) {
        return products.map((product) => skippedTest(product, `Chromium did not start (${error}), so the browser tests were skipped.`, installCommand));
    }

    ensureIgnored(workspace.root);

    /** @type {TestResult[]} */
    const results = [];

    try {
        for (const product of products) {
            let run;

            try {
                run = await runBrowserTests({ browser, workspace, loaded, product });
            } catch (runError) {
                results.push({ ...skippedTest(product, `The browser tests could not run: ${messageOf(runError)}`, null), passed: false });
                continue;
            }

            /** @type {TestResult} */
            const result = {
                product: product.path,
                passed: !run.issues.some(isBlocking),
                skipped: false,
                reason: null,
                install: null,
                issues: run.issues,
                runs: run.runs,
                playthrough: run.playthrough,
                creator_tests: run.creator_tests,
                results: `${product.path}/${resultsDirectoryName}`,
            };

            saveLastRun(product, result);
            results.push(result);
        }
    } finally {
        await browser.close();
    }

    return results;
}

/**
 * @param {TestResult} result
 * @returns {string[]}
 */
export function testLines(result) {
    if (result.skipped) {
        return [`${result.product}: ${result.reason}${result.install === null ? '' : ` Install it (a large download, ask first) with: ${result.install}`}`];
    }

    const scenarios = new Set(result.runs.map((run) => run.scenario ?? 'block'));
    const lines = [`${result.product}: rendered ${scenarios.size} ${scenarios.size === 1 ? 'scenario' : 'scenarios'} at phone, tablet, and desktop widths. Screenshots in ${result.results}/screenshots.`];

    if (result.playthrough === null) {
        lines.push('  playthrough: skipped (no data-rafflex-play and data-rafflex-result hooks).');
    } else {
        for (const play of result.playthrough) {
            lines.push(`  playthrough ${play.scenario}: ${play.passed ? 'passed' : 'FAILED'} (expected ${play.expected.join(', ') || 'no plays'}${play.passed ? '' : `; revealed ${play.revealed.join(', ') || 'nothing'}`})`);
        }
    }

    for (const spec of result.creator_tests) {
        lines.push(`  ${spec.passed ? 'passed' : 'FAILED'} ${spec.file}: ${spec.name}${spec.passed ? '' : `: ${spec.error}`}`);
    }

    for (const issue of result.issues) {
        lines.push(`  ${isBlocking(issue) ? 'error  ' : 'warning'} [${issue.code}]${issue.scenario ? ` scenario ${issue.scenario}` : ''}: ${issue.message}${issue.screenshot ? ` (${issue.screenshot})` : ''}`);
    }

    const blocking = result.issues.filter(isBlocking).length;

    lines.push(blocking === 0 ? '  No blocking problems.' : `  ${blocking} ${blocking === 1 ? 'problem blocks' : 'problems block'} pushing.`);

    return lines;
}

/**
 * `test [<product>...|--all] [--install]`: the browser run through,
 * playthrough, and the creator's specs in headless Chromium. Without
 * Playwright it prints the install command and skips (exit 0). With
 * --install it installs Playwright and Chromium into .rafflex/.
 *
 * JSON: one product prints `{product, passed, skipped, reason, install,
 * issues, runs, playthrough, creator_tests, results}`; several print
 * `{passed, skipped, products: [that shape...]}`. Exits 1 when a blocking
 * issue is found.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runTestCommand(context) {
    const { stdout, stderr, options } = context;
    let selection;

    try {
        selection = await loadSelection(context, { requireDocuments: true });
    } catch (error) {
        const message = messageOf(error);

        if (options.json) {
            writeJson(stdout, { passed: false, error: message });
        } else {
            stderr.write(`${message}\n`);
        }

        return 2;
    }

    if (options.install) {
        const log = options.json ? stderr : stdout;

        log.write('Installing Playwright and Chromium into .rafflex/playwright (about 100 MB, once per workspace).\n');

        const installed = installPlaywright(selection.workspace.root, log);

        if (options.json) {
            writeJson(stdout, { installed: installed.ok, error: installed.error ?? null });
        } else {
            stdout.write(installed.ok ? 'Installed. Run npx @rafflex/dev test to run the browser tests.\n' : `${installed.error}\n`);
        }

        return installed.ok ? 0 : 2;
    }

    const results = await testProducts({ workspace: selection.workspace, loaded: /** @type {import('../remote.js').LoadedDocuments} */ (selection.loaded), products: selection.products });
    const passed = results.every((result) => result.passed);

    if (options.json) {
        writeJson(stdout, results.length === 1 ? results[0] : { passed, skipped: results.every((result) => result.skipped), products: results });

        return passed ? 0 : 1;
    }

    if (results.every((result) => result.skipped) && results.length > 1) {
        stdout.write(`${results[0].reason} Install it (a large download, ask first) with: ${installCommand}\n`);

        return 0;
    }

    stdout.write(`${results.flatMap((result, index) => [...(index > 0 ? [''] : []), ...testLines(result)]).join('\n')}\n`);

    return passed ? 0 : 1;
}
