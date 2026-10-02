import { scanAssets } from '../assets.js';
import { isBlocking, runChecks, verdictNote } from '../checker.js';
import { assetUrl } from '../dev-server.js';
import { loadProject, readTemplate } from '../project.js';
import { loadDocuments, resolveBaseUrl } from '../remote.js';

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
 * `check`: render every scenario headlessly and run the platform's rules,
 * printing a report (or JSON with --json). Exits 1 when any issue would
 * block submission, 0 otherwise, 2 when the check cannot run.
 *
 * @param {{cwd: string, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream, options: import('../cli.js').CliOptions}} context
 * @returns {Promise<number>}
 */
export async function runCheckCommand({ cwd, stdout, stderr, options }) {
    let project;
    let loaded;
    let template;

    try {
        project = loadProject(cwd);
        template = readTemplate(project);
        loaded = await loadDocuments({ projectDirectory: project.directory, baseUrl: resolveBaseUrl(project.config) });
    } catch (error) {
        const message = /** @type {Error} */ (error).message;

        if (options.json) {
            stdout.write(`${JSON.stringify({ passed: false, error: message, issues: [], warnings: [], note: verdictNote }, null, 2)}\n`);
        } else {
            stderr.write(`${message}\n`);
        }

        return 2;
    }

    const { documents } = loaded;
    const scan = scanAssets(project.assetsDirectory, documents.rules, documents.libraries?.libraries ?? [], assetUrl);
    const playCount = options.playCount ?? documents.contexts.play_count?.default ?? 5;
    const { issues, skippedPatterns } = runChecks({ template, files: scan.files, assetRefusals: scan.refusals, documents, playCount, renderedPlayCounts: 'all' });
    const blocking = issues.filter(isBlocking);
    const passed = blocking.length === 0;
    const warnings = [...loaded.warnings];

    if (skippedPatterns.length > 0) {
        warnings.push(`Not applied locally (the marketplace still applies them): ${skippedPatterns.join(', ')}.`);
    }

    if (options.json) {
        stdout.write(`${JSON.stringify({
            passed,
            issues,
            warnings,
            note: verdictNote,
            checked: { type: project.config.type, play_count: playCount, rules_version: documents.rules.version ?? null, base_url: loaded.baseUrl, offline: loaded.offline },
        }, null, 2)}\n`);

        return passed ? 0 : 1;
    }

    const lines = [`Checked template.twig (${project.config.type}) in every scenario at ${playCount} ${playCount === 1 ? 'play' : 'plays'}, rules ${documents.rules.version ?? 'unversioned'} from ${loaded.baseUrl}.`];

    for (const warning of loaded.warnings) {
        lines.push(`note: ${warning}`);
    }

    if (options.verbose && skippedPatterns.length > 0) {
        lines.push(`note: not applied locally (the marketplace still applies them): ${skippedPatterns.join(', ')}`);
    }

    lines.push('');

    if (issues.length === 0) {
        lines.push('No problems found.');
    } else {
        lines.push(...issues.map(formatIssue), '');
        lines.push(`${blocking.length} ${blocking.length === 1 ? 'problem blocks' : 'problems block'} submission, ${issues.length - blocking.length} to review.`);
    }

    lines.push(verdictNote);
    stdout.write(`${lines.join('\n')}\n`);

    return passed ? 0 : 1;
}
