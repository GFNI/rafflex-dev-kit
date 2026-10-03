import { isBlocking, verdictNote } from '../checker.js';
import { checkProduct } from './check.js';
import { formatProduct, loadSelection } from './format.js';
import { messageOf, writeJson } from './output.js';
import { testLines, testProducts } from './test.js';

/**
 * @typedef {object} VerifyResult
 * @property {string} product
 * @property {boolean} ready            Nothing blocks a push: check passed and the browser tests passed or were skipped.
 * @property {'passed'|'failed'|'skipped'} browser_tests
 * @property {import('./format.js').FormatResult} format
 * @property {import('./check.js').ProductCheck} check
 * @property {import('./test.js').TestResult} test
 * @property {(import('../checker.js').Issue & {screenshot?: string})[]} issues Every check and test issue.
 * @property {number} blocking          How many issues block.
 * @property {number} warnings          How many issues are warnings.
 * @property {string} note
 */

/**
 * format, then check, then test, for each product: the one command the AI
 * runs before every push (PRD 41).
 *
 * @param {object} options
 * @param {import('../workspace.js').Workspace} options.workspace
 * @param {import('../remote.js').LoadedDocuments} options.loaded
 * @param {import('../workspace.js').Product[]} options.products
 * @returns {Promise<VerifyResult[]>}
 */
export async function verifyProducts({ workspace, loaded, products }) {
    /** @type {{format: import('./format.js').FormatResult, check: import('./check.js').ProductCheck}[]} */
    const staged = [];

    for (const product of products) {
        const format = await formatProduct(product, loaded.documents);
        const { result: check } = await checkProduct(product, loaded, undefined);

        staged.push({ format, check });
    }

    const tests = await testProducts({ workspace, loaded, products });

    return staged.map(({ format, check }, index) => {
        const test = tests[index];
        const issues = [...check.issues, ...test.issues];
        const blocking = issues.filter(isBlocking).length;

        return {
            product: check.product,
            ready: check.error === undefined && blocking === 0,
            browser_tests: test.skipped ? 'skipped' : (test.passed ? 'passed' : 'failed'),
            format,
            check,
            test,
            issues,
            blocking,
            warnings: issues.length - blocking,
            note: verdictNote,
        };
    });
}

/**
 * @param {VerifyResult} result
 * @returns {string[]}
 */
function verifyLines(result) {
    const lines = [`${result.product}: ${result.ready ? 'ready to push' : 'not ready to push'}${result.browser_tests === 'skipped' ? ' (browser tests skipped)' : ''}.`];

    if (result.format.error !== null) {
        lines.push(`  format: not formatted. ${result.format.error}`);
    } else {
        lines.push(`  format: ${result.format.written ? 'formatted template.twig' : 'already in the house style'}.`);
    }

    if (result.check.error !== undefined) {
        lines.push(`  check: ${result.check.error}`);
    }

    for (const issue of result.check.issues) {
        const where = [issue.line ? `line ${issue.line}` : null, issue.scenario ? `scenario ${issue.scenario}` : null].filter(Boolean).join(', ');

        lines.push(`  ${isBlocking(issue) ? 'error  ' : 'warning'} [${issue.code}]${where === '' ? '' : ` ${where}`}: ${issue.message}`, `          Fix: ${issue.fix}`);
    }

    lines.push(...testLines(result.test).map((line, index) => (index === 0 ? `  test: ${line.replace(`${result.product}: `, '')}` : `  ${line}`)));
    lines.push(`  ${result.blocking} blocking, ${result.warnings} ${result.warnings === 1 ? 'warning' : 'warnings'}.`);

    return lines;
}

/**
 * `verify [<product>...|--all]`: format, then check, then test when
 * Playwright is installed. Run before every push; fix every blocking
 * issue and push only when ready.
 *
 * JSON: one product prints `{product, ready, browser_tests, format, check,
 * test, issues, blocking, warnings, note}`; several print `{ready,
 * products: [that shape...]}`. Exits 1 when a product is not ready.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runVerifyCommand(context) {
    const { stdout, stderr, options } = context;
    let selection;

    try {
        selection = await loadSelection(context, { requireDocuments: true });
    } catch (error) {
        const message = messageOf(error);

        if (options.json) {
            writeJson(stdout, { ready: false, error: message });
        } else {
            stderr.write(`${message}\n`);
        }

        return 2;
    }

    const results = await verifyProducts({ workspace: selection.workspace, loaded: /** @type {import('../remote.js').LoadedDocuments} */ (selection.loaded), products: selection.products });
    const ready = results.every((result) => result.ready);

    if (options.json) {
        writeJson(stdout, results.length === 1 ? results[0] : { ready, products: results });

        return ready ? 0 : 1;
    }

    stdout.write(`${[...results.flatMap((result, index) => [...(index > 0 ? [''] : []), ...verifyLines(result)]), verdictNote].join('\n')}\n`);

    return ready ? 0 : 1;
}
