import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBlocking, verdictNote } from '../checker.js';
import { submissionLines, submissionStatus } from '../submission.js';
import { kitVersion } from '../version.js';
import { productFilename, resultsDirectoryName } from '../workspace.js';
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
 * @property {import('../submission.js').SubmissionStatus} submission What review still needs; never changes `ready`.
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
 * @param {(line: string) => void} [options.onProgress] One line per step, for the Rafflex app.
 * @returns {Promise<VerifyResult[]>}
 */
export async function verifyProducts({ workspace, loaded, products, onProgress = () => {} }) {
    /** @type {{format: import('./format.js').FormatResult, check: import('./check.js').ProductCheck, submission: import('../submission.js').SubmissionStatus}[]} */
    const staged = [];

    for (const product of products) {
        onProgress(`Formatting ${product.path}`);
        const format = await formatProduct(product, loaded.documents);
        onProgress(`Checking ${product.path} in every scenario`);
        const { result: check } = await checkProduct(product, loaded, undefined);

        staged.push({ format, check, submission: submissionFor(product, loaded.documents) });
    }

    onProgress('Running the browser tests');
    const tests = await testProducts({ workspace, loaded, products });

    return staged.map(({ format, check, submission }, index) => {
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
            submission,
            note: verdictNote,
        };
    });
}

/**
 * What review still needs, or nothing to report when the product's files
 * cannot be read (the check reports that).
 *
 * @param {import('../workspace.js').Product} product
 * @param {Record<string, any>} documents
 * @returns {import('../submission.js').SubmissionStatus}
 */
function submissionFor(product, documents) {
    try {
        return submissionStatus(product, documents);
    } catch {
        return { ready: true, missing: [] };
    }
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
    lines.push(...submissionLines(result.submission));

    return lines;
}

/**
 * A fingerprint of everything in a product folder a verify result depends
 * on: the path and SHA-256 of every file, except the kit's own output
 * (`.results/`) and product.json (rewritten with the marketplace's state).
 * An added, changed, or deleted file at any depth changes it.
 *
 * @param {string} directory
 * @returns {string}
 */
export function productFilesFingerprint(directory) {
    const hash = createHash('sha256');
    const walk = (/** @type {string} */ folder, /** @type {string} */ prefix) => {
        const entries = readdirSync(folder, { withFileTypes: true }).sort((first, second) => (first.name < second.name ? -1 : 1));

        for (const entry of entries) {
            if (prefix === '' && (entry.name === resultsDirectoryName || entry.name === productFilename)) {
                continue;
            }

            const path = join(folder, entry.name);
            const name = `${prefix}${entry.name}`;

            if (entry.isDirectory()) {
                walk(path, `${name}/`);
                continue;
            }

            hash.update(`${name}\0`);
            hash.update(entry.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'not a file');
            hash.update('\0');
        }
    };

    walk(directory, '');

    return hash.digest('hex');
}

/**
 * The version of everything a verify was judged by: this kit and each of
 * the platform's documents it loaded. A rule change on the platform, or a
 * kit update, makes a saved result stale.
 *
 * @param {{documents?: Record<string, any>}|null|undefined} loaded
 * @returns {string}
 */
export function rulesFingerprint(loaded) {
    const documents = loaded?.documents ?? {};
    const versions = Object.keys(documents).sort().map((name) => `${name}=${documents[name]?.version ?? 'none'}`);

    return [`kit=${kitVersion}`, ...versions].join(';');
}

/**
 * Keep the full result in the product's .results/verify.json, so the
 * Rafflex app shows a verify the AI ran in its terminal (PRD 42), with
 * what it was judged against (`verified_against`: the folder's files and
 * the rules), so push reuses it only while both are unchanged.
 *
 * @param {import('../workspace.js').Product} product
 * @param {VerifyResult} result
 * @param {{documents?: Record<string, any>}} [loaded] The documents the verify used; without them the result is never reused.
 */
export function saveVerifyResult(product, result, loaded) {
    const directory = join(product.directory, resultsDirectoryName);

    try {
        const verifiedAgainst = loaded === undefined ? null : { files: productFilesFingerprint(product.directory), rules: rulesFingerprint(loaded) };

        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'verify.json'), `${JSON.stringify({ ...result, verified_against: verifiedAgainst }, null, 2)}\n`);
    } catch {
        // A read only folder keeps the result in the output only.
    }
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

    const results = await verifyProducts({
        workspace: selection.workspace,
        loaded: /** @type {import('../remote.js').LoadedDocuments} */ (selection.loaded),
        products: selection.products,
        onProgress: (line) => {
            if (options.json) {
                stderr.write(`${line}\n`);
            }
        },
    });
    const ready = results.every((result) => result.ready);

    for (const [index, result] of results.entries()) {
        saveVerifyResult(selection.products[index], result, selection.loaded);
    }

    if (options.json) {
        writeJson(stdout, results.length === 1 ? results[0] : { ready, products: results });

        return ready ? 0 : 1;
    }

    stdout.write(`${[...results.flatMap((result, index) => [...(index > 0 ? [''] : []), ...verifyLines(result)]), verdictNote].join('\n')}\n`);

    return ready ? 0 : 1;
}
