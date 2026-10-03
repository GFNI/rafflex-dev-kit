import { scanAssets } from '../assets.js';
import { isBlocking, runChecks, verdictNote } from '../checker.js';
import { assetUrl } from '../dev-server.js';
import { loadDocuments } from '../remote.js';
import { loadWorkspace, readTemplate, selectProducts, withManifest } from '../workspace.js';
import { messageOf, writeJson } from './output.js';

/**
 * @param {import('../checker.js').Issue} issue
 */
function formatIssue(issue) {
    const where = [issue.file ?? 'template.twig', issue.line ? `line ${issue.line}` : null, issue.scenario ? `scenario ${issue.scenario}` : null]
        .filter(Boolean)
        .join(', ');
    const label = isBlocking(issue) ? 'error  ' : 'warning';

    return `${label} [${issue.code}] ${where}\n        ${issue.message}\n        Fix: ${issue.fix}`;
}

/**
 * @typedef {{product: string, passed: boolean, issues: import('../checker.js').Issue[], warnings: string[], note: string, checked?: Record<string, unknown>, error?: string}} ProductCheck
 */

/**
 * Check one product with already loaded documents.
 *
 * @param {import('../workspace.js').Product} product
 * @param {import('../remote.js').LoadedDocuments} loaded
 * @param {number|undefined} requestedPlayCount
 * @returns {{result: ProductCheck, skippedPatterns: string[]}}
 */
export function checkProduct(product, loaded, requestedPlayCount) {
    const { documents } = loaded;
    let template;

    try {
        template = readTemplate(product);
    } catch (error) {
        return { result: { product: product.path, passed: false, error: messageOf(error), issues: [], warnings: [...loaded.warnings], note: verdictNote }, skippedPatterns: [] };
    }

    const scan = scanAssets(product.assetsDirectory, documents.rules, documents.libraries?.libraries ?? [], assetUrl);
    const playCount = requestedPlayCount ?? documents.contexts.play_count?.default ?? 5;
    const { issues, skippedPatterns } = runChecks({ template, files: scan.files, assetRefusals: scan.refusals, documents, playCount, renderedPlayCounts: 'all' });
    const passed = !issues.some(isBlocking);
    const warnings = [...loaded.warnings];

    if (skippedPatterns.length > 0) {
        warnings.push(`Not applied locally (the marketplace still applies them): ${skippedPatterns.join(', ')}.`);
    }

    return {
        result: {
            product: product.path,
            passed,
            issues,
            warnings,
            note: verdictNote,
            checked: { type: product.type, play_count: playCount, rules_version: documents.rules.version ?? null, base_url: loaded.baseUrl, offline: loaded.offline },
        },
        skippedPatterns,
    };
}

/**
 * @param {ProductCheck} result
 * @param {string[]} skippedPatterns
 * @param {boolean} verbose
 * @returns {string[]}
 */
function reportLines(result, skippedPatterns, verbose) {
    if (result.error !== undefined) {
        return [`${result.product}: ${result.error}`];
    }

    const checked = /** @type {{type: string, play_count: number, rules_version: string|null, base_url: string}} */ (result.checked);
    const plays = checked.play_count === 1 ? 'play' : 'plays';
    const lines = [`Checked ${result.product}/template.twig (${checked.type}) in every scenario at ${checked.play_count} ${plays}, rules ${checked.rules_version ?? 'unversioned'} from ${checked.base_url}.`];

    if (verbose && skippedPatterns.length > 0) {
        lines.push(`note: not applied locally (the marketplace still applies them): ${skippedPatterns.join(', ')}`);
    }

    lines.push('');

    const blocking = result.issues.filter(isBlocking);

    if (result.issues.length === 0) {
        lines.push('No problems found.');
    } else {
        lines.push(...result.issues.map(formatIssue), '');
        lines.push(`${blocking.length} ${blocking.length === 1 ? 'problem blocks' : 'problems block'} submission, ${result.issues.length - blocking.length} to review.`);
    }

    return lines;
}

/**
 * `check [<product>...|--all]`: render every scenario headlessly and run
 * the platform's rules on each selected product: the ones named, all with
 * --all, else the product the command runs in, else every product.
 *
 * JSON: one product prints `{product, passed, issues, warnings, note,
 * checked}`; several print `{passed, products: [that shape...]}`. Exits 1
 * when any product has an issue that would block submission, 0 otherwise,
 * 2 when the check cannot run.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runCheckCommand({ cwd, stdout, stderr, options }) {
    let products;
    let loaded;

    try {
        let workspace = loadWorkspace(cwd);

        loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl });
        workspace = withManifest(workspace, loaded.manifest);
        products = selectProducts(workspace, { names: options.positionals, all: options.all, cwd, fallback: 'all' });

        if (products.length === 0) {
            throw new Error('There are no products in this workspace yet. Add one with npx @rafflex/dev new <game|block> "<title>".');
        }
    } catch (error) {
        const message = messageOf(error);

        if (options.json) {
            writeJson(stdout, { passed: false, error: message, issues: [], warnings: [], note: verdictNote });
        } else {
            stderr.write(`${message}\n`);
        }

        return 2;
    }

    const checks = products.map((product) => checkProduct(product, loaded, options.playCount));
    const passed = checks.every(({ result }) => result.passed);

    if (options.json) {
        writeJson(stdout, checks.length === 1 ? checks[0].result : { passed, products: checks.map(({ result }) => result) });

        return passed ? 0 : 1;
    }

    const lines = loaded.warnings.map((warning) => `note: ${warning}`);

    for (const [index, { result, skippedPatterns }] of checks.entries()) {
        if (index > 0) {
            lines.push('');
        }

        lines.push(...reportLines(result, skippedPatterns, options.verbose));
    }

    if (checks.length > 1) {
        const failed = checks.filter(({ result }) => !result.passed).map(({ result }) => result.product);

        lines.push('', failed.length === 0 ? `All ${checks.length} products pass.` : `${failed.length} of ${checks.length} products need fixes: ${failed.join(', ')}.`);
    }

    lines.push(verdictNote);
    stdout.write(`${lines.join('\n')}\n`);

    return passed ? 0 : 1;
}
