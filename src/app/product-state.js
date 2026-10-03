import { fillPrompt, issuesText, issueText } from './prompts.js';

/**
 * What the app says about a product: its state in a few words, its last
 * test result, and the one next step for getting it live, each with the
 * prompt that hands the step to the creator's AI.
 */

/**
 * @typedef {ReturnType<typeof import('../dev-server.js').productSummary>} ProductSummary
 * @typedef {{key: string, label: string, tone: 'ok'|'warning'|'error'|'muted'}} ProductState
 */

/**
 * The product's state, most important first: "Not pushed yet", "Changes
 * requested", "In review", "Changes not pushed", "Live 1.2.0", or
 * "Pushed, not live".
 *
 * @param {ProductSummary} summary
 * @returns {ProductState}
 */
export function productState(summary) {
    const { remote } = summary;

    if (!remote.pushed) {
        return { key: 'not_pushed', label: 'Not pushed yet', tone: 'muted' };
    }

    if (remote.review !== null && ['changes_requested', 'rejected'].includes(remote.review.decision)) {
        return { key: 'changes_requested', label: remote.review.decision === 'rejected' ? 'Rejected' : 'Changes requested', tone: 'error' };
    }

    if (remote.in_review) {
        return { key: 'in_review', label: 'In review', tone: 'warning' };
    }

    if ((summary.local?.changed.length ?? 0) > 0 || !remote.synced) {
        return { key: 'changes_not_pushed', label: 'Changes not pushed', tone: 'warning' };
    }

    if (remote.live_version !== null) {
        return { key: 'live', label: `Live ${remote.live_version}`, tone: 'ok' };
    }

    return { key: 'pushed', label: 'Pushed, not live', tone: 'muted' };
}

/**
 * @param {import('./results.js').TestResult|null} result
 * @returns {{status: 'passed'|'issues'|'not_tested', label: string, tone: 'ok'|'error'|'muted'}}
 */
export function testSummary(result) {
    if (result === null) {
        return { status: 'not_tested', label: 'Not tested', tone: 'muted' };
    }

    if (result.status === 'passed') {
        return { status: 'passed', label: 'Passed', tone: 'ok' };
    }

    return { status: 'issues', label: 'Issues', tone: 'error' };
}

/**
 * The values a product's prompts are filled with.
 *
 * @param {ProductSummary} summary
 * @param {import('./results.js').TestResult|null} result
 * @returns {Record<string, string|null>}
 */
export function promptValues(summary, result) {
    const issues = result === null ? [] : result.blocking.length > 0 ? result.blocking : result.warnings;

    return {
        title: summary.title,
        path: summary.path,
        slug: summary.slug ?? summary.path.split('/').pop() ?? null,
        type: summary.type,
        version: summary.version,
        live_version: summary.remote.live_version,
        issues: issues.length > 0 ? issuesText(issues) : null,
    };
}

/**
 * @param {import('./prompts.js').PromptsDocument|null} prompts
 * @param {string} key
 * @param {Record<string, string|null>} values
 * @returns {{key: string, title: string, description: string, text: string}|null}
 */
export function promptFor(prompts, key, values) {
    const entry = prompts?.prompts?.[key];

    if (entry === undefined || typeof entry?.text !== 'string') {
        return null;
    }

    return { key, title: String(entry.title ?? ''), description: String(entry.description ?? ''), text: fillPrompt(entry.text, values) };
}

/**
 * The prompts on a product's page: change something, fix (when the last
 * test found issues), next version (once live), revert (once pushed), and
 * hand to AI.
 *
 * @param {ProductSummary} summary
 * @param {import('./results.js').TestResult|null} result
 * @param {import('./prompts.js').PromptsDocument|null} prompts
 */
export function productPrompts(summary, result, prompts) {
    const values = promptValues(summary, result);
    const hasIssues = result !== null && (result.blocking.length > 0 || result.warnings.length > 0);
    const keys = [
        'iterate',
        hasIssues ? 'fix' : null,
        summary.remote.live_version !== null ? 'next_version' : null,
        summary.remote.pushed ? 'revert' : null,
        'hand_to_ai',
    ].filter((key) => key !== null);

    return {
        list: keys.map((key) => promptFor(prompts, key, values)).filter((prompt) => prompt !== null),
        hand_to_ai: promptFor(prompts, 'hand_to_ai', values),
        fix_issue: result === null
            ? []
            : result.blocking.map((issue) => promptFor(prompts, 'fix_issue', { ...values, issue: issueText(issue) })?.text ?? null),
    };
}

/**
 * Get it live: the state, the one thing to do next, and its prompt. It is
 * disabled while the last test has blocking issues.
 *
 * @param {ProductSummary} summary
 * @param {import('./results.js').TestResult|null} result
 * @param {import('./prompts.js').PromptsDocument|null} prompts
 * @returns {{state: ProductState, next: string, disabled: boolean, reason: string|null, prompt: ReturnType<typeof promptFor>}}
 */
export function publishStep(summary, result, prompts) {
    const state = productState(summary);
    const values = promptValues(summary, result);

    if (result !== null && (result.blocking.length > 0 || result.playthrough.some((playthrough) => !playthrough.passed))) {
        return { state, next: 'Fix these first, or ask your AI to.', disabled: true, reason: 'The last test found problems that block review.', prompt: promptFor(prompts, 'fix', values) };
    }

    /** @type {[string, string]} */
    const [key, next] = (() => {
        switch (state.key) {
            case 'not_pushed':
                return ['get_it_live_first', `Ask your AI to test it, push it, and send ${summary.version} for review.`];
            case 'changes_requested':
                return ['fix_review', 'The reviewer asked for changes. Ask your AI to make them and send it back.'];
            case 'in_review':
                return ['check_review', `${summary.version} is with our team. You will see the decision here after your AI checks.`];
            case 'live':
                if (summary.remote.live_version === summary.version) {
                    return ['next_version', `${summary.version} is live. Start the next version when you are ready.`];
                }

                return ['get_it_live', `Ask your AI to send ${summary.version} for review.`];
            default:
                return ['get_it_live', `Ask your AI to test it, push it, and send ${summary.version} for review.`];
        }
    })();

    return { state, next, disabled: false, reason: null, prompt: promptFor(prompts, key, values) };
}
