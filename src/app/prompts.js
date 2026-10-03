import { loadDocuments, readCachedDocuments } from '../remote.js';

/**
 * The app's wording for the AI comes from the marketplace's prompts.json
 * (PRD 42), never from the kit, so prompts improve without a kit release.
 * The kit only fills the `{placeholder}` tokens locally.
 */

/** How long a loaded prompts.json is used before the next page load refreshes it. */
export const promptsRefreshMs = 5 * 60 * 1000;

/** The placeholders the kit fills; any other brace text is left as written. */
export const promptPlaceholders = ['title', 'path', 'slug', 'type', 'version', 'live_version', 'issues', 'issue'];

/**
 * @typedef {{title: string, description: string, text: string}} PromptEntry
 * @typedef {{key: string, label: string, kind: string, connect: string}} PromptClient
 * @typedef {{key: string, label: string, url: string, prompt_param: string, path_param?: string|null, max_prompt?: number|null, command?: string|null}} PromptOpener
 * @typedef {{version?: string, prompts: Record<string, PromptEntry>, clients: PromptClient[], openers: PromptOpener[], links: Record<string, string>}} PromptsDocument
 */

/**
 * Fill a prompt's placeholders. Unknown or missing values leave the token
 * as written, so a newer prompts.json never shows an empty gap.
 *
 * @param {string} text
 * @param {Record<string, string|null|undefined>} values
 */
export function fillPrompt(text, values) {
    return text.replace(/\{([a-z_]+)\}/g, (token, name) => {
        const value = values[name];

        return promptPlaceholders.includes(name) && typeof value === 'string' && value !== '' ? value : token;
    });
}

/**
 * One issue as a prompt line: what is wrong, where, and the fix.
 *
 * @param {{message: string, fix?: string, scenario?: string, file?: string, line?: number}} issue
 */
export function issueText(issue) {
    const where = [issue.file, issue.line ? `line ${issue.line}` : null, issue.scenario ? `scenario ${issue.scenario}` : null].filter(Boolean).join(', ');

    return `${issue.message}${where === '' ? '' : ` (${where})`}${issue.fix ? ` Fix: ${issue.fix}` : ''}`;
}

/**
 * @param {{message: string, fix?: string, scenario?: string, file?: string, line?: number}[]} issues
 */
export function issuesText(issues) {
    return issues.map((issue) => `- ${issueText(issue)}`).join('\n');
}

/**
 * @param {unknown} document
 * @returns {PromptsDocument|null}
 */
function validPrompts(document) {
    const candidate = /** @type {any} */ (document);

    if (candidate === null || typeof candidate !== 'object' || typeof candidate.prompts !== 'object' || candidate.prompts === null) {
        return null;
    }

    return {
        version: candidate.version,
        prompts: candidate.prompts,
        clients: Array.isArray(candidate.clients) ? candidate.clients : [],
        openers: Array.isArray(candidate.openers) ? candidate.openers : [],
        links: typeof candidate.links === 'object' && candidate.links !== null ? candidate.links : {},
    };
}

/**
 * Keeps prompts.json loaded for the app: fetched at start, refreshed at
 * most every few minutes when a page asks, and read from the workspace
 * cache when the marketplace cannot be reached.
 *
 * @param {{workspaceDirectory: string, baseUrl: string, fetchImpl?: typeof fetch, now?: () => number}} options
 */
export function promptSource({ workspaceDirectory, baseUrl, fetchImpl, now = Date.now }) {
    /** @type {PromptsDocument|null} */
    let document = validPrompts(readCachedDocuments(workspaceDirectory, baseUrl, ['prompts']).documents.prompts);
    /** @type {string|null} */
    let error = null;
    let loadedAt = Number.NEGATIVE_INFINITY;
    /** @type {Promise<void>|null} */
    let pending = null;

    const refresh = async () => {
        try {
            const loaded = await loadDocuments({ workspaceDirectory, baseUrl, names: ['prompts'], ...(fetchImpl ? { fetchImpl } : {}) });
            const next = validPrompts(loaded.documents.prompts);

            if (next === null) {
                throw new Error('prompts.json has no prompts.');
            }

            document = next;
            error = null;
        } catch (refreshError) {
            error = String(/** @type {Error} */ (refreshError)?.message ?? refreshError);
        }

        loadedAt = now();
    };

    return {
        /**
         * The current prompts, refreshed first when they are older than
         * the refresh interval.
         *
         * @param {{force?: boolean}} [options]
         * @returns {Promise<{document: PromptsDocument|null, error: string|null}>}
         */
        async get({ force = false } = {}) {
            if (force || now() - loadedAt >= promptsRefreshMs) {
                pending ??= refresh().finally(() => {
                    pending = null;
                });
                await pending;
            }

            return { document, error: document === null ? error ?? 'The marketplace has not sent its prompts yet.' : null };
        },
    };
}
