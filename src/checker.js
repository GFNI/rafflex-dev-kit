import { compilePatterns, decodeEscapes, matchPatterns } from './banned-patterns.js';
import { availablePlayCounts, gameContext, nearestPlayCount } from './context.js';
import { gameTwigLogicIssues, playthroughHookIssues } from './game-rules.js';
import { scriptViolations, sourceScriptViolations } from './script-rules.js';
import { compileTemplate, lineAt, renderTemplate, TemplateRenderError } from './twig-engine.js';
import { lintTemplate } from './twig-lint.js';

/**
 * The kit's version of the marketplace's template check (PRD 34's
 * check_template): the safety lint over the source, the same lint over
 * the rendered output of every scenario, a render of every scenario at
 * the chosen play count, and unknown file tags, reported as
 * `{code, message, fix, scenario?, line?}` with the codes and fix hints
 * from rules.issue_codes. Asset files the media library would refuse are
 * reported too, with a `file` naming them.
 *
 * Every result is guidance: the marketplace's own check is the verdict.
 */

/** Codes the marketplace reports without blocking submission. */
export const platformWarningCodes = ['option_warning', 'unknown_file_tag', 'game_twig_logic', 'playthrough_hooks_missing'];

/**
 * The kit's own quality warnings (PRD 41): the house style, ESLint, the
 * HTML validator, and browser findings that teach rather than block.
 */
export const kitWarningCodes = ['unformatted', 'script_lint', 'alpine_state', 'markup', 'console_error', 'request_failed'];

/** Every code that is reported without blocking. */
export const nonBlockingCodes = [...platformWarningCodes, ...kitWarningCodes];

export const verdictNote = "The marketplace's own check is the final verdict.";


/**
 * Messages the platform classifies as the sandbox refusing a render
 * (TemplateCheck::SandboxPolicyPatterns), rather than a plain render error.
 */
const sandboxPolicyPatterns = [/\bis not allowed\b/, /^Unknown "[^"]+" (?:function|filter|test)\b/, /^Too many nested for loops\b/, /^Template rendering exceeded\b/];

/**
 * @typedef {{code: string, message: string, fix: string, scenario?: string, line?: number, file?: string}} Issue
 */

/**
 * @param {Issue} issue
 */
export function isBlocking(issue) {
    return !nonBlockingCodes.includes(issue.code);
}

/**
 * @param {any} rules
 * @param {string} code
 */
function fixFor(rules, code) {
    const entry = rules.issue_codes?.[code];

    if (typeof entry === 'string') {
        return entry;
    }

    return entry?.fix ?? '';
}

/**
 * @param {string} message
 */
function renderFailureCode(message) {
    return sandboxPolicyPatterns.some((pattern) => pattern.test(message)) ? 'sandbox' : 'render_error';
}

/**
 * @param {string} message
 * @returns {number|undefined}
 */
function lineFrom(message) {
    const match = message.match(/\bat line (\d+)\b/);

    return match === null ? undefined : Number(match[1]);
}

/**
 * Every key a template reads from the files map: the bracket form
 * anywhere, plus dot access inside Twig tags, in order of first appearance.
 *
 * @param {string} template
 * @returns {string[]}
 */
export function referencedFileKeys(template) {
    /** @type {Map<number, string>} */
    const keysByOffset = new Map();

    for (const match of template.matchAll(/files\[\s*(['"])(.+?)\1\s*\]/g)) {
        keysByOffset.set(match.index + match[0].indexOf(match[2]), match[2]);
    }

    for (const tag of template.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g)) {
        for (const match of tag[0].matchAll(/(?<![\w.$])files\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
            keysByOffset.set(tag.index + match.index, match[1]);
        }
    }

    return [...new Set([...keysByOffset.entries()].sort((first, second) => first[0] - second[0]).map(([, key]) => key))];
}

/**
 * @param {any} documents
 */
export function scenarioValues(documents) {
    return (documents.contexts.scenarios ?? []).map((/** @type {{value: string}} */ scenario) => scenario.value);
}

/**
 * @typedef {object} CheckInput
 * @property {string} template
 * @property {Record<string, string>} files Tag to URL, as the preview renders with.
 * @property {{file: string, message: string}[]} [assetRefusals]
 * @property {{rules: any, contexts: any, libraries: any}} documents
 * @property {number} [playCount] The play count scenarios render at (the server's check_template default when omitted).
 * @property {'all'|'current'} [renderedPlayCounts] Scan the rendered output at every available play count (as the server does) or only the current one.
 * @property {string} [templateName]
 * @property {string} [type] The asset type; a game also gets the game warnings.
 */

/**
 * @param {CheckInput} input
 * @returns {{issues: Issue[], skippedPatterns: string[]}}
 */
export function runChecks(input) {
    const { template, files, documents } = input;
    const { rules, contexts } = documents;
    const templateName = input.templateName ?? 'template.twig';
    const playCount = input.playCount ?? contexts.play_count?.default ?? 5;
    const { patterns, skipped } = compilePatterns(rules.banned_patterns);
    const libraries = documents.libraries?.libraries ?? [];
    const approvedUrls = new Set(libraries.map((/** @type {{url: string}} */ library) => library.url));
    const isApprovedUrl = (/** @type {string} */ url) => approvedUrls.has(url);
    const scenarios = scenarioValues(documents);
    /** @type {Issue[]} */
    const issues = [];
    const issue = (/** @type {Omit<Issue, 'fix'>} */ details) => {
        /** @type {Issue} */
        const full = { code: details.code, message: details.message, fix: fixFor(rules, details.code) };

        if (details.scenario !== undefined) {
            full.scenario = details.scenario;
        }

        if (details.line !== undefined) {
            full.line = details.line;
        }

        if (details.file !== undefined) {
            full.file = details.file;
        }

        return full;
    };

    /** @type {Issue[]} */
    const safetyIssues = [];
    const maxBytes = rules.template_max_bytes;
    const tooLarge = typeof maxBytes === 'number' && Buffer.byteLength(template, 'utf8') > maxBytes;

    if (tooLarge) {
        safetyIssues.push(issue({ code: 'too_large', message: rules.messages?.too_large ?? `The template is too large (maximum ${maxBytes / 1000} KB).` }));
    }

    if (!tooLarge) {
        const seenMessages = new Set();

        for (const match of matchPatterns(template, patterns, { includeSourceOnly: true })) {
            if (!seenMessages.has(match.message)) {
                seenMessages.add(match.message);
                safetyIssues.push(issue({ code: 'safety', message: match.message, line: lineAt(template, match.offset) }));
            }
        }

        for (const violation of sourceScriptViolations(template, files, isApprovedUrl, rules.script_rules)) {
            if (!seenMessages.has(violation.message)) {
                seenMessages.add(violation.message);
                safetyIssues.push(issue({ code: 'safety', message: violation.message, line: lineAt(template, violation.offset) }));
            }
        }
    }

    /** @type {Issue[]} */
    const renderFailures = [];
    /** @type {Set<string>} */
    const renderFailureMessages = new Set();

    for (const scenario of scenarios) {
        try {
            renderTemplate(template, gameContext(contexts, { scenario, playCount, files, template }), rules.sandbox, { name: templateName });
        } catch (error) {
            const message = String(/** @type {Error} */ (error).message);

            renderFailureMessages.add(message);
            renderFailures.push(issue({
                code: error instanceof TemplateRenderError && error.sandbox ? 'sandbox' : renderFailureCode(message),
                message,
                scenario,
                line: lineFrom(message),
            }));
        }
    }

    if (safetyIssues.length === 0) {
        safetyIssues.push(...renderedIssues({ template, files, contexts, rules, scenarios, patterns, isApprovedUrl, playCount, templateName, mode: input.renderedPlayCounts ?? 'all', issue, renderFailureMessages }));
    }

    issues.push(...safetyIssues, ...renderFailures, ...extraLintIssues(template, rules, issue), ...unknownTagIssues(template, files, issue));

    if (input.type === 'game') {
        issues.push(...[...gameTwigLogicIssues(template, rules.game_rules), ...playthroughHookIssues(template, rules.game_rules)].map((found) => issue(found)));
    }

    for (const refusal of input.assetRefusals ?? []) {
        issues.push(issue({ code: 'safety', message: refusal.message, file: refusal.file }));
    }

    return { issues, skippedPatterns: skipped };
}

/**
 * The banned patterns and script rules over the rendered output of every
 * scenario. File URLs are replaced by first party placeholder paths for
 * the scan (as the platform does), so a hosted file never reads as an
 * external reference while a script src still has to resolve to an
 * approved library. The first render failure ends the pass, as it does on
 * the platform, and is reported unless a scenario render already reported
 * the same failure.
 *
 * @param {object} options
 * @returns {Issue[]}
 */
function renderedIssues({ template, files, contexts, rules, scenarios, patterns, isApprovedUrl, playCount, templateName, mode, issue, renderFailureMessages }) {
    /** @type {Record<string, string>} */
    const placeholders = {};
    /** @type {Record<string, string>} */
    const placeholderUrls = {};

    for (const [tag, url] of Object.entries(files)) {
        placeholders[tag] = `/media/${tag}`;
        placeholderUrls[`/media/${tag}`] = url;
    }

    const isAllowedSource = (/** @type {string} */ source) => isApprovedUrl(placeholderUrls[source] ?? source);
    /** @type {Issue[]} */
    const found = [];
    const seen = new Set();
    const minimum = contexts.play_count?.min ?? 1;

    for (const scenario of scenarios) {
        const counts = scenario === 'no_plays'
            ? [nearestPlayCount(contexts, scenario, minimum)]
            : mode === 'all' ? availablePlayCounts(contexts, scenario) : [nearestPlayCount(contexts, scenario, playCount)];

        for (const count of counts) {
            let html;

            try {
                html = renderTemplate(template, gameContext(contexts, { scenario, playCount: count, files: placeholders, template }), rules.sandbox, { name: templateName });
            } catch (error) {
                const message = String(/** @type {Error} */ (error).message);

                if (renderFailureMessages.has(message)) {
                    return found;
                }

                return [...found, issue({
                    code: error instanceof TemplateRenderError && error.sandbox ? 'sandbox' : renderFailureCode(message),
                    message: `${rules.messages?.sandbox_failure_prefix ?? 'The template does not pass the Twig sandbox: '}${message}`,
                    line: lineFrom(message),
                })];
            }

            const messages = [
                ...matchPatterns(html, patterns, { includeSourceOnly: false }).map((match) => match.message),
                ...matchPatterns(decodeEscapes(html), patterns, { includeSourceOnly: false }).map((match) => match.message),
                ...scriptViolations(html, isAllowedSource, rules.script_rules).map((violation) => violation.message),
            ];

            for (const message of messages) {
                if (!seen.has(message)) {
                    seen.add(message);
                    found.push(issue({ code: 'rendered_output', message, scenario }));
                }
            }
        }
    }

    return found;
}

/**
 * The sandbox reports only the first whitelist violation per render; the
 * kit lists the rest too so they can all be fixed in one pass.
 *
 * @param {string} template
 * @param {any} rules
 * @param {(details: Omit<Issue, 'fix'>) => Issue} issue
 * @returns {Issue[]}
 */
function extraLintIssues(template, rules, issue) {
    let tokens;

    try {
        tokens = compileTemplate(template).tokens;
    } catch {
        return [];
    }

    return lintTemplate(tokens, template, rules.sandbox)
        .slice(1)
        .map((violation) => issue({ code: 'sandbox', message: `${violation.message} in "template.twig" at line ${violation.line}.`, line: violation.line }));
}

/**
 * @param {string} template
 * @param {Record<string, string>} files
 * @param {(details: Omit<Issue, 'fix'>) => Issue} issue
 * @returns {Issue[]}
 */
function unknownTagIssues(template, files, issue) {
    return referencedFileKeys(template)
        .filter((key) => files[key] === undefined)
        .map((key) => issue({ code: 'unknown_file_tag', message: `The template references files['${key}'], but no uploaded file has that tag.` }));
}
