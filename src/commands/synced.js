import { readAll } from '../cli.js';
import { reviewToAct, productFeedback } from '../feedback.js';
import { payloadMismatch, recordProductState, versionAfterSync } from '../record-sync.js';
import { callSyncLink, parseSyncLink, productAndLink, SyncLinkError } from '../sync-link.js';
import { unwrapProductPayload } from '../sync-state.js';
import { loadWorkspace, selectProduct } from '../workspace.js';
import { failWithCode, messageOf, writeJson } from './output.js';

export { versionAfterSync };

/**
 * Read the product's state from a sync link: the product in the
 * get_product shape and its feedback.
 *
 * @param {import('../workspace.js').Workspace} workspace
 * @param {string} raw
 * @returns {Promise<{payload: Record<string, any>|null, feedback: Record<string, any>|null, link: import('../sync-link.js').SyncLink}>}
 */
export async function readLinkState(workspace, raw) {
    const link = parseSyncLink(raw, workspace.baseUrl);
    const document = await callSyncLink(link, 'GET');

    return { payload: document.product, feedback: document.feedback, link };
}

/**
 * Report a sync link error: its code and message, and any issues.
 *
 * @param {import('../cli.js').CommandContext} context
 * @param {SyncLinkError} error
 */
export function failWithLinkError(context, error) {
    return failWithCode(context, error.toJSON(), error.exitCode);
}

/**
 * `synced <product> ["<sync_url>"]`: record the product's marketplace state
 * as product.json's `remote` block. With a sync link (from request_sync)
 * it reads the state and the feedback from the link; without one it reads
 * a get_product result on standard input (the structured content, an MCP
 * tool result, or an export bundle). Also records the slug the first time
 * (renaming a title named folder to the slug), and adopts the server's
 * draft version. Refuses a result for a different product.
 *
 * When the draft revision or version changed (or on the first sync) it
 * commits the product folder, and only it: "Push <slug> <version> (draft
 * revision <n>)" when the folder holds what the marketplace now has, and
 * "Sync <slug> (draft revision <n>)" when the draft changed elsewhere,
 * so `restore last-push` never returns to a state that was not pushed.
 * The branch is recorded so status can warn when the workspace moves to
 * another one.
 *
 * JSON: `{product, previous_product, slug, version, previous_version, renamed, notes, remote, feedback, git}`.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runSyncedCommand(context) {
    const { cwd, stdout, stderr, stdin, options } = context;
    const { name, link } = productAndLink(options.positionals);
    let workspace;
    let product;

    try {
        workspace = loadWorkspace(cwd);
        product = selectProduct(workspace, name, cwd);
    } catch (error) {
        return failWithCode(context, { code: 'cannot_run', message: messageOf(error) }, 2);
    }

    /** @type {Record<string, any>|null} */
    let payload;
    /** @type {unknown} */
    let feedback;
    let source = 'That get_product result';

    if (link !== undefined) {
        try {
            const state = await readLinkState(workspace, link);

            payload = state.payload;
            feedback = state.feedback;
            source = 'That link';
        } catch (error) {
            if (error instanceof SyncLinkError) {
                return failWithLinkError(context, error);
            }

            throw error;
        }

        if (payload === null) {
            return failWithCode(context, { code: 'not_created', message: `That link is for a product not on the marketplace yet. Push ${product.path} with npx @rafflex/dev push ${product.slug ?? product.path} "<sync_url>" to create it.` }, 1);
        }
    } else {
        const input = await readAll(stdin);
        /** @type {unknown} */
        let parsed;

        try {
            parsed = JSON.parse(input);
        } catch {
            return failWithCode(context, input.trim() === ''
                ? { code: 'no_link', message: `Give this command a sync link from request_sync: npx @rafflex/dev synced ${product.slug ?? product.path} "<sync_url>". Only when this shell cannot reach the marketplace (a sandbox without network access), pipe the get_product result for ${product.title} to it instead.` }
                : { code: 'invalid_input', message: 'Standard input is not JSON. Pipe the get_product result exactly as the tool returned it.' }, 2);
        }

        payload = unwrapProductPayload(parsed);

        if (payload === null) {
            return failWithCode(context, { code: 'invalid_input', message: 'Standard input is not a get_product result (it has no slug and type). Pipe the tool\'s structured result.' }, 2);
        }
    }

    const mismatch = payloadMismatch(product, payload, source);

    if (mismatch !== null) {
        return failWithCode(context, { code: mismatch.exitCode === 2 ? 'invalid_input' : (link === undefined ? 'wrong_product' : 'wrong_link'), message: mismatch.message }, mismatch.exitCode);
    }

    /** @type {import('../record-sync.js').RecordedState} */
    let recorded;

    try {
        recorded = recordProductState({ workspace, product, payload, feedback, kind: 'auto' });
    } catch (error) {
        return failWithCode(context, { code: 'unexpected_response', message: messageOf(error) }, 2);
    }

    const shown = productFeedback(/** @type {any} */ (recorded.remote));

    if (options.json) {
        writeJson(stdout, {
            product: recorded.path,
            previous_product: product.path,
            slug: recorded.slug,
            version: recorded.version,
            previous_version: product.version,
            renamed: recorded.renamed,
            notes: recorded.notes,
            remote: recorded.remote,
            feedback: shown,
            git: recorded.git,
        });

        return 0;
    }

    const { remote } = recorded;
    const parts = [remote.status ?? 'unknown status', `live ${remote.live_version ?? 'none'}`];
    const draft = remote.draft;

    if (draft !== null) {
        parts.push(`draft ${draft.version ?? '?'} r${draft.revision ?? '?'}${draft.submitted ? ' in review' : ''}`);
    }

    if (typeof remote.latest_review?.decision === 'string') {
        parts.push(`review ${remote.latest_review.decision}`);
    }

    const review = reviewToAct(shown, draft?.submitted === true);
    const lines = [`${recorded.path}: recorded the marketplace state (${parts.join(', ')}).${recorded.renamed ? ` Renamed from ${product.path}.` : ''}`];

    if (recorded.message !== null) {
        lines.push(`Committed "${recorded.message}".`);
    }

    if (review !== null) {
        lines.push(`The reviewer ${review.decision === 'rejected' ? 'rejected' : 'asked for changes to'} ${review.version ?? recorded.version}${review.notes === null ? '.' : `: ${review.notes}`}`);
    }

    lines.push(`Run npx @rafflex/dev plan ${recorded.slug} to see what is left to push.`);
    stdout.write(`${lines.join('\n')}\n`);

    for (const note of recorded.notes) {
        stderr.write(`note: ${note}\n`);
    }

    return 0;
}
