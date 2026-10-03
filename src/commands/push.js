import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBlocking } from '../checker.js';
import { productFeedback } from '../feedback.js';
import { readListingImages } from '../listing-images.js';
import { payloadMismatch, recordProductState, UnsafeSlugError } from '../record-sync.js';
import { loadDocuments } from '../remote.js';
import { submissionLines, submissionStatus } from '../submission.js';
import { batchSizeFrom, buildPushRequest, inBatches, PushRequestError, remoteForPlan, uploadKey } from '../push-request.js';
import { callSyncLink, checkedUploadUrl, parseSyncLink, productAndLink, SyncLinkError, uploadFile, uploadOrigins } from '../sync-link.js';
import { formatProductJson, loadWorkspace, readTemplate, resultsDirectoryName, selectProduct, withManifest, writeProductJson } from '../workspace.js';
import { optionOverridesHash, readLocalState, remoteFromProduct, templateHash } from '../sync-state.js';
import { assetDocuments, buildPlan } from './plan.js';
import { productFilesFingerprint, rulesFingerprint, saveVerifyResult, verifyProducts } from './verify.js';
import { messageOf, writeJson } from './output.js';

/**
 * `push <product> "<sync_url>"` (PRD 45): push a product to the marketplace
 * in one command, through the sync link the creator's AI asked for with
 * request_sync. The link is never written to disk.
 *
 * 1. Read the product's state from the link (GET).
 * 2. Refuse a link for an existing product when the folder was never
 *    pushed (`wrong_link`), and refuse when the draft changed on the
 *    marketplace since the last sync (another draft version, or another
 *    revision) and the folder's template or options differ from it
 *    (`conflict`).
 * 3. verify, reusing `.results/verify.json` only when no file in the
 *    folder was added, changed, or deleted since and the platform's rules
 *    and the kit are the ones it was made with; refuse while anything
 *    blocks.
 * 4. Plan against the state just read and POST only what changed: the
 *    template, option overrides, version, release notes, listing,
 *    approved libraries, `screenshots_keep`, and the files to upload.
 *    `create` on a product never pushed.
 * 5. PUT each file to the upload link the marketplace answered with, in
 *    batches of `max_files_per_batch` (each later batch is another POST
 *    with only its uploads).
 * 6. Read the state again and record it exactly as `synced` does, then
 *    commit the product folder as "Push <slug> <version> (draft revision
 *    <n>)", or "(draft revision <n>, <k> files not uploaded)" with those
 *    files kept out of the commit, so they still show as changes and
 *    `restore last-push` treats them as unpushed. A push that changed
 *    nothing on the marketplace makes no Push commit.
 *
 * Exit 0 when pushed or nothing to push; 1 when refused for a reason the
 * AI can fix or wait out (not_ready, conflict, in_review, wrong_link,
 * validation_failed, too_large, upload_failed, rate_limited, forbidden); 2 when it
 * cannot run (no_link, invalid_link, expired, unreachable, cannot_run,
 * unexpected_response, unsupported).
 *
 * JSON: `{product, renamed_from, pushed, created, nothing_to_push, slug,
 * version, revision, changed: {template, options, listing}, uploaded:
 * [{path, purpose, tag}], attached: [{library, tag}], removed_screenshots,
 * check, submission, suggested_version, feedback, not_uploaded, refusals,
 * notes, git, link, commit_message, error?: {code, message, issues?,
 * retry_after_seconds?}}`. An issue about a file to upload carries `path`,
 * the file in the product folder.
 */

/**
 * @typedef {object} PushResult
 * @property {string} product
 * @property {string|null} renamed_from  The product's path before this push renamed its folder to the slug.
 * @property {boolean} pushed
 * @property {boolean} created
 * @property {boolean} nothing_to_push
 * @property {string|null} slug
 * @property {string} version
 * @property {number|null} revision
 * @property {{template: boolean, options: boolean, listing: boolean}} changed
 * @property {{path: string, purpose: string, tag: string|null}[]} uploaded
 * @property {{library: string, tag: string}[]} attached
 * @property {number} removed_screenshots
 * @property {any} check
 * @property {import('../submission.js').SubmissionStatus|null} submission
 * @property {any} suggested_version
 * @property {import('../feedback.js').Feedback|null} feedback
 * @property {{path: string, purpose: string, tag: string|null, message: string}[]} not_uploaded
 * @property {any[]} refusals
 * @property {string[]} notes
 * @property {import('../git.js').ProductCommit|null} git
 * @property {string|null} link       The link with its signature elided.
 * @property {string|null} commit_message
 * @property {{code: string, message: string, issues?: any[]}} [error]
 */

/**
 * The saved verify result when it still holds: no file in the folder was
 * added, changed, or deleted since it was written (outside `.results/` and
 * product.json), and it was judged against the same platform rules and
 * kit (`rules`). Otherwise null, and push runs verify again.
 *
 * @param {import('../workspace.js').Product} product
 * @param {string} rules The current rules fingerprint (rulesFingerprint).
 * @returns {any}
 */
export function freshVerifyResult(product, rules) {
    const path = join(product.directory, resultsDirectoryName, 'verify.json');

    try {
        const result = JSON.parse(readFileSync(path, 'utf8'));
        const against = result?.verified_against;

        if (typeof result?.ready !== 'boolean' || !Array.isArray(result.issues) || against === null || typeof against !== 'object') {
            return null;
        }

        if (against.rules !== rules || against.files !== productFilesFingerprint(product.directory)) {
            return null;
        }

        return result;
    } catch {
        return null;
    }
}

/**
 * @typedef {{ready: boolean, reused: boolean, browser_tests: string|null, blocking_issues: any[], warning_count: number, error?: string}} PushVerify
 */

/**
 * verify before a push: the saved result when it is fresh, otherwise a
 * new run (saved for the app and the next push).
 *
 * @param {import('../workspace.js').Workspace} workspace
 * @param {import('../workspace.js').Product} product
 * @param {(line: string) => void} progress
 * @returns {Promise<PushVerify>}
 */
async function verifyForPush(workspace, product, progress) {
    try {
        const loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl });
        const saved = freshVerifyResult(product, rulesFingerprint(loaded));

        if (saved !== null) {
            const blocking = saved.issues.filter(isBlocking);

            return { ready: saved.ready && blocking.length === 0, reused: true, browser_tests: saved.browser_tests ?? null, blocking_issues: blocking, warning_count: saved.issues.length - blocking.length };
        }

        progress(`Verifying ${product.path}`);

        const [result] = await verifyProducts({ workspace: withManifest(workspace, loaded.manifest), loaded, products: [product] });

        saveVerifyResult(product, result, loaded);

        if (result.check.error !== undefined) {
            return { ready: false, reused: false, browser_tests: null, blocking_issues: [], warning_count: 0, error: result.check.error };
        }

        return { ready: result.ready, reused: false, browser_tests: result.browser_tests, blocking_issues: result.issues.filter(isBlocking), warning_count: result.warnings };
    } catch (error) {
        return { ready: false, reused: false, browser_tests: null, blocking_issues: [], warning_count: 0, error: `verify could not run: ${messageOf(error)}` };
    }
}

/**
 * Whether the folder's template and options differ from a draft read from
 * the marketplace. The draft's overrides are filtered against the draft's
 * own template, as the folder's are against the folder's, so an override
 * the platform still stores for a key its template no longer reads does
 * not read as a difference.
 *
 * @param {import('../workspace.js').Product} product
 * @param {Record<string, any>} draft
 */
function differsFromDraft(product, draft) {
    const local = readLocalState(product, null);

    return local.template === null
        || typeof draft.template !== 'string'
        || local.template.sha256 !== templateHash(draft.template)
        || !('sha256' in local.options)
        || local.options.sha256 !== optionOverridesHash(draft.option_overrides, draft.template);
}

/**
 * One issue line, the way check prints issues.
 *
 * @param {{code: string, field?: string, path?: string, line?: number, message: string, fix?: string, severity?: string, blocking?: boolean}} issue
 * @returns {string[]}
 */
function issueLines(issue) {
    const where = [issue.path ?? issue.field, issue.line ? `line ${issue.line}` : null].filter(Boolean).join(', ');
    const label = issue.severity === 'warning' || issue.blocking === false ? 'warning' : 'error  ';

    return [`  ${label} [${issue.code}]${where === '' ? '' : ` ${where}`}: ${issue.message}`, ...(issue.fix ? [`          Fix: ${issue.fix}`] : [])];
}

/**
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runPushCommand(context) {
    const { cwd, stdout, stderr, options } = context;
    const { name, link: rawLink } = productAndLink(options.positionals);
    const progress = (/** @type {string} */ line) => {
        stderr.write(`${line}\n`);
    };
    /** @type {string[]} */
    const lines = [];
    let workspace;
    let product;

    try {
        workspace = loadWorkspace(cwd);
        product = selectProduct(workspace, name, cwd);
    } catch (error) {
        return report(context, null, { code: 'cannot_run', message: messageOf(error) }, 2, lines);
    }

    /** @type {PushResult} */
    const result = {
        product: product.path,
        renamed_from: null,
        pushed: false,
        created: false,
        nothing_to_push: false,
        slug: product.slug,
        version: product.version,
        revision: null,
        changed: { template: false, options: false, listing: false },
        uploaded: [],
        attached: [],
        removed_screenshots: 0,
        check: null,
        submission: null,
        suggested_version: null,
        feedback: null,
        not_uploaded: [],
        refusals: [],
        notes: [],
        git: null,
        link: null,
        commit_message: null,
    };
    const label = product.slug ?? product.path;

    if (rawLink === undefined) {
        return report(context, result, { code: 'no_link', message: `push needs a sync link. Ask your AI to call request_sync${product.slug === null ? ' (no slug: this product is new)' : ` with slug ${product.slug}`}, then run npx @rafflex/dev push ${label} "<sync_url>".` }, 2, lines);
    }

    /** @type {import('../sync-link.js').SyncLink} */
    let link;

    try {
        link = parseSyncLink(rawLink, workspace.baseUrl);
    } catch (error) {
        return reportLinkError(context, result, error, lines);
    }

    result.link = link.display;

    const { documents, warnings } = await assetDocuments(workspace);

    result.notes.push(...warnings);

    // 1. Read the marketplace's state.
    let state;

    try {
        progress(`Reading ${link.display}`);
        state = await callSyncLink(link, 'GET');
    } catch (error) {
        return reportLinkError(context, result, error, lines);
    }

    const payload = state.product;

    if (payload === null && product.slug !== null) {
        return report(context, result, { code: 'wrong_link', message: `That link is for a new product, but ${product.path} is already on the marketplace as ${product.slug}, so nothing was sent. Ask your AI to call request_sync with slug ${product.slug}, then run the command again.` }, 1, lines);
    }

    if (payload !== null && product.slug === null) {
        return report(context, result, {
            code: 'wrong_link',
            message: `That link is for ${payload.slug}, which is already on the marketplace, but ${product.path} has never been pushed, so nothing was sent. To create a new product from ${product.path}, ask your AI to call request_sync with no slug and push with that link. To work on ${payload.slug} here instead, bring it local with export_product and npx @rafflex/dev import "<bundle_url>". Only if ${product.path} really is ${payload.slug}, record that first with npx @rafflex/dev synced ${product.path} "<sync_url>", then push.`,
        }, 1, lines);
    }

    if (payload !== null) {
        const mismatch = payloadMismatch(product, payload, 'That link');

        if (mismatch !== null) {
            return report(context, result, { code: 'wrong_link', message: `${mismatch.message} Nothing was sent.` }, mismatch.exitCode, lines);
        }
    }

    const freshDraft = payload?.draft !== null && typeof payload?.draft === 'object' ? payload.draft : null;

    if (freshDraft?.submitted === true) {
        return report(context, result, { code: 'in_review', message: `${payload?.slug} ${freshDraft.version ?? ''} is in review, and cannot be changed until the decision. Nothing was sent. Record the decision later with npx @rafflex/dev synced ${label} "<sync_url>".` }, 1, lines);
    }

    // 2. Refuse to overwrite a draft changed elsewhere. Revisions restart
    // at 1 for every new draft, so the version and the revision together
    // name the draft this workspace last saw.
    const recordedDraft = product.manifest.remote?.draft ?? null;

    if (freshDraft !== null && draftChangedElsewhere(recordedDraft, freshDraft) && differsFromDraft(product, freshDraft)) {
        const otherVersion = recordedDraft !== null && recordedDraft.version !== freshDraft.version;
        const since = recordedDraft === null || recordedDraft.revision === null
            ? 'which this workspace has never recorded'
            : `and this workspace last recorded revision ${recordedDraft.revision}${otherVersion ? ` of ${recordedDraft.version}` : ''}`;

        return report(context, result, {
            code: 'conflict',
            message: `The draft of ${payload?.slug} on the marketplace is at revision ${freshDraft.revision}${otherVersion ? ` of ${freshDraft.version}` : ''}, ${since}, and ${product.path} has a different template or options, so nothing was sent. Commit your work first, then bring the marketplace's draft here with export_product and npx @rafflex/dev import "<bundle_url>" --force, apply your change on top, and push again.`,
        }, 1, lines);
    }

    // 3. verify.
    const verify = await verifyForPush(workspace, product, progress);

    if (verify.error !== undefined) {
        return report(context, result, { code: 'not_ready', message: `Not pushed: ${verify.error}. Run npx @rafflex/dev verify ${label} once it can run.` }, 1, lines);
    }

    if (!verify.ready) {
        lines.push(...verify.blocking_issues.flatMap((issue) => issueLines(issue)));

        return report(context, result, { code: 'not_ready', message: `Not pushed: verify found ${verify.blocking_issues.length} blocking ${verify.blocking_issues.length === 1 ? 'issue' : 'issues'}. Fix them, run npx @rafflex/dev verify ${label}, then push again.`, issues: verify.blocking_issues }, 1, lines);
    }

    // 4. Plan against the state just read, and build the request.
    const planned = { ...product, manifest: { ...product.manifest, remote: remoteForPlan(payload) } };
    let built;
    let request;

    try {
        built = buildPlan(planned, documents);
        request = buildPushRequest({ product, payload, plan: built.plan, template: readTemplate(product), listingImages: readListingImages(product.directory), documents });
    } catch (error) {
        if (error instanceof PushRequestError) {
            return report(context, result, { code: 'not_ready', message: `Not pushed: ${error.message}` }, 1, lines);
        }

        return report(context, result, { code: 'cannot_run', message: messageOf(error) }, 2, lines);
    }

    const plan = /** @type {any} */ (built.plan);

    result.refusals = plan.refusals;
    result.suggested_version = plan.suggested_version ?? null;
    result.created = request.created;
    result.changed = { template: request.changed.template, options: request.changed.options, listing: request.changed.listing };

    for (const refusal of built.refusals) {
        result.notes.push(`${refusal.file} was left out: ${refusal.message}`);
    }

    for (const refusal of plan.refusals) {
        result.notes.push(`Not pushed [${refusal.code}] ${refusal.path}: ${refusal.message}`);
    }

    if (plan.removed_assets.length > 0) {
        result.notes.push(`On the marketplace but not in assets/: ${plan.removed_assets.map((/** @type {any} */ entry) => entry.filename).join(', ')}. The kit never removes media; tell the creator to remove it in the browser if it should go.`);
    }

    if (request.nothingToPush) {
        result.nothing_to_push = true;

        if (payload !== null) {
            const recorded = recordProductState({ workspace, product, payload, feedback: state.feedback, kind: 'auto' });

            finishFromRecord(result, recorded, documents, product.path);
        }

        return report(context, result, null, 0, lines);
    }

    // 5. POST, then PUT each batch of files.
    const batches = inBatches(request.uploads, batchSizeFrom(documents.rules));
    const allowed = uploadOrigins(link, documents.rules);
    /** @type {Record<string, any>|null} */
    let latest = null;
    /** @type {any} */
    let latestFeedback = state.feedback;
    let stopped = false;

    for (const [index, batch] of (batches.length === 0 ? [[]] : batches).entries()) {
        const body = index === 0
            ? { ...request.body, ...(batch.length === 0 ? {} : { uploads: batch.map((upload) => upload.request) }) }
            : { base_revision: Number.isInteger(latest?.draft?.revision) ? latest?.draft.revision : null, uploads: batch.map((upload) => upload.request) };
        /** @type {import('../sync-link.js').SyncDocument} */
        let answer;

        try {
            progress(index === 0 ? `Pushing ${product.path}` : `Requesting upload links (batch ${index + 1} of ${batches.length})`);
            answer = await callSyncLink(link, 'POST', body);
        } catch (error) {
            const issues = error instanceof SyncLinkError && error.issues !== undefined ? withUploadPaths(error.issues, batch) : [];

            if (index === 0) {
                if (error instanceof SyncLinkError && error.issues !== undefined) {
                    error.issues = issues;
                }

                return reportLinkError(context, result, error, lines);
            }

            result.notes.push(`The upload links for the remaining files were refused: ${messageOf(error)}`);
            result.not_uploaded.push(...batches.slice(index).flat().map((upload) => ({
                path: upload.path,
                purpose: upload.request.purpose,
                tag: upload.request.tag ?? null,
                message: issues.filter((issue) => issue.path === upload.path).map((issue) => issue.message).join(' ') || 'not sent',
            })));
            stopped = true;
            break;
        }

        if (index === 0) {
            result.pushed = true;
            result.attached = request.libraries.map((library) => ({ library: library.name, tag: library.tag }));
            result.removed_screenshots = request.removedScreenshots;

            // A product created by this push keeps its slug even if a later step fails.
            if (product.slug === null && answer.product !== null) {
                writeProductJson(product.directory, { ...product.manifest, slug: answer.product.slug });
            }
        }

        latest = answer.product ?? latest;
        latestFeedback = answer.feedback ?? latestFeedback;
        result.check = answer.check ?? result.check;

        const grants = Array.isArray(answer.uploads) ? answer.uploads : [];

        for (const upload of batch) {
            const grant = grants.find((candidate) => uploadKey(candidate) === uploadKey(upload.request)) ?? null;
            const entry = { path: upload.path, purpose: upload.request.purpose, tag: upload.request.tag ?? null };
            let failure = null;

            if (grant === null || typeof grant.put_url !== 'string' || String(grant.method ?? 'PUT').toUpperCase() !== 'PUT') {
                failure = 'the marketplace gave no upload link for it';
            } else {
                try {
                    const url = checkedUploadUrl(grant.put_url, allowed, link.url.protocol);

                    progress(`Uploading ${upload.path}`);
                    failure = await uploadFile(url, { path: upload.file, size: upload.request.size_bytes, headers: grant.headers });
                } catch (error) {
                    failure = messageOf(error);
                }
            }

            if (failure === null) {
                result.uploaded.push(entry);
            } else {
                result.not_uploaded.push({ ...entry, message: failure });
            }
        }

        if (result.not_uploaded.length > 0) {
            result.not_uploaded.push(...batches.slice(index + 1).flat().map((upload) => ({ path: upload.path, purpose: upload.request.purpose, tag: upload.request.tag ?? null, message: 'not sent' })));
            stopped = true;
            break;
        }
    }

    // 6. Read the state again and record it.
    let finalProduct = latest;

    try {
        const final = await callSyncLink(link, 'GET');

        finalProduct = final.product ?? latest;
        latestFeedback = final.feedback ?? latestFeedback;
    } catch (error) {
        result.notes.push(`Could not read the product again (${messageOf(error)}), so the state the push answered with is recorded. Run npx @rafflex/dev synced ${label} "<sync_url>" to refresh it.`);
    }

    result.check = withoutLandedFileTags(result.check, [
        ...result.uploaded.filter((entry) => entry.purpose === 'library').map((entry) => entry.tag),
        ...result.attached.map((entry) => entry.tag),
    ]);

    if (finalProduct !== null) {
        // A push the marketplace answered with exactly the state it had
        // before changed nothing, so it is not a new restore point.
        const landed = payload === null || sameRemoteState(payload, finalProduct) === false;
        const notUploaded = [...result.not_uploaded.map((entry) => entry.path), ...plan.refusals.map((/** @type {any} */ refusal) => refusal.path)];

        try {
            const recorded = recordProductState({ workspace, product, payload: finalProduct, feedback: latestFeedback, kind: landed ? 'push' : 'auto', notUploaded: landed ? notUploaded : [] });

            finishFromRecord(result, recorded, documents, product.path);
        } catch (error) {
            if (!(error instanceof UnsafeSlugError)) {
                throw error;
            }

            return report(context, result, { code: 'unexpected_response', message: messageOf(error) }, 2, lines);
        }

        if (!landed) {
            result.notes.push('The marketplace already had everything this push sent, so nothing changed there.');
        }
    }

    result.suggested_version = result.suggested_version ?? result.check?.suggested_version ?? null;

    if (stopped || result.not_uploaded.length > 0) {
        return report(context, result, {
            code: 'upload_failed',
            message: `The draft was pushed, but ${result.not_uploaded.length} ${result.not_uploaded.length === 1 ? 'file was' : 'files were'} not uploaded: ${result.not_uploaded.map((entry) => `${entry.path} (${entry.message})`).join('; ')}. They still show as changes, and the commit says so. Fix them, then run npx @rafflex/dev push ${result.slug ?? label} "<sync_url>" again (the same link while it works, or a new one from request_sync): it sends only what is still missing.`,
        }, 1, lines);
    }

    return report(context, result, null, 0, lines);
}

/**
 * Whether the draft read from the marketplace changed since this
 * workspace recorded it: another draft (a new version, or a draft where
 * none was recorded) or another revision of the same one.
 *
 * @param {{version?: string|null, revision?: number|null}|null} recorded
 * @param {Record<string, any>} fresh
 */
export function draftChangedElsewhere(recorded, fresh) {
    if (recorded === null) {
        return true;
    }

    return (recorded.version ?? null) !== (fresh.version ?? null) || (recorded.revision ?? null) !== (fresh.revision ?? null);
}

/**
 * Whether two get_product payloads record the same marketplace state.
 *
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 */
function sameRemoteState(before, after) {
    const at = new Date(0);

    return formatProductJson({ remote: remoteFromProduct(before, at) }) === formatProductJson({ remote: remoteFromProduct(after, at) });
}

/**
 * The marketplace's issues with each one about a file to upload
 * (`uploads.<n>…`, numbered within the request) pointing at that file in
 * the product folder.
 *
 * @param {import('../sync-link.js').SyncIssue[]} issues
 * @param {import('../push-request.js').PlannedUpload[]} batch
 * @returns {(import('../sync-link.js').SyncIssue & {path?: string})[]}
 */
export function withUploadPaths(issues, batch) {
    return issues.map((issue) => {
        const match = typeof issue.field === 'string' ? issue.field.match(/^uploads\.(\d+)(?:\.|$)/) : null;
        const upload = match === null ? undefined : batch[Number(match[1])];

        return upload === undefined ? issue : { ...issue, path: upload.path };
    });
}

/**
 * The marketplace's check of the draft, answered before the files were
 * uploaded, without the unknown_file_tag warnings for tags this push
 * uploaded or attached: those files are there now.
 *
 * @param {any} check
 * @param {(string|null)[]} landedTags
 * @returns {any}
 */
export function withoutLandedFileTags(check, landedTags) {
    if (check === null || typeof check !== 'object' || !Array.isArray(check.issues) || landedTags.length === 0) {
        return check;
    }

    const issues = check.issues.filter((/** @type {any} */ issue) => {
        const key = issue?.code === 'unknown_file_tag' ? String(issue.message ?? '').match(/files\['([^']+)'\]/)?.[1] : undefined;

        return key === undefined || !landedTags.includes(key);
    });
    const blocks = (/** @type {any} */ issue) => (typeof issue?.blocking === 'boolean' ? issue.blocking : isBlocking(issue));

    return { ...check, issues, passed: check.passed === false && issues.every((/** @type {any} */ issue) => !blocks(issue)) ? true : check.passed };
}

/**
 * Fill the result from the recorded state.
 *
 * @param {PushResult} result
 * @param {import('../record-sync.js').RecordedState} recorded
 * @param {{rules?: any, libraries?: any, categories?: any}} documents
 * @param {string} startedAs The product's path when the push started.
 */
function finishFromRecord(result, recorded, documents, startedAs) {
    result.product = recorded.path;
    result.renamed_from = recorded.path === startedAs ? null : startedAs;
    result.slug = recorded.slug;
    result.version = recorded.version;
    result.revision = Number.isInteger(recorded.remote.draft?.revision) ? recorded.remote.draft.revision : null;
    result.feedback = productFeedback(/** @type {any} */ (recorded.remote));
    result.git = recorded.git;
    result.commit_message = recorded.message;
    result.notes.push(...recorded.notes);

    try {
        const workspace = loadWorkspace(recorded.directory);
        const product = selectProduct(workspace, recorded.path, workspace.root);

        result.submission = submissionStatus(product, documents);
    } catch {
        result.submission = null;
    }
}

/**
 * @param {import('../cli.js').CommandContext} context
 * @param {PushResult|null} result
 * @param {unknown} error
 * @param {string[]} lines
 */
function reportLinkError(context, result, error, lines) {
    if (!(error instanceof SyncLinkError)) {
        return report(context, result, { code: 'cannot_run', message: messageOf(error) }, 2, lines);
    }

    if (error.issues !== undefined) {
        lines.push(...error.issues.flatMap((issue) => issueLines(issue)));
    }

    return report(context, result, error.toJSON(), error.exitCode, lines);
}

/**
 * Print the result: the JSON document, or prose with the error on stderr.
 *
 * @param {import('../cli.js').CommandContext} context
 * @param {PushResult|null} result
 * @param {{code: string, message: string, issues?: any[]}|null} error
 * @param {number} code
 * @param {string[]} issueLinesBefore Issue lines to print under the error.
 * @returns {number}
 */
function report({ stdout, stderr, options }, result, error, code, issueLinesBefore) {
    if (options.json) {
        writeJson(stdout, result === null ? { error } : { ...result, ...(error === null ? {} : { error }) });

        return code;
    }

    if (result !== null && (result.pushed || result.nothing_to_push)) {
        stdout.write(`${pushedLines(result).join('\n')}\n`);
    }

    if (error !== null) {
        stderr.write(`${[error.message, ...issueLinesBefore].join('\n')}\n`);
    }

    for (const note of result?.notes ?? []) {
        stderr.write(`note: ${note}\n`);
    }

    return code;
}

/**
 * @param {PushResult} result
 * @returns {string[]}
 */
function pushedLines(result) {
    if (result.nothing_to_push) {
        return [`${result.product}: nothing to push. The marketplace already has everything${result.revision === null ? '' : ` (draft revision ${result.revision})`}.`, ...submissionLines(result.submission ?? { ready: true, missing: [] })];
    }

    const sent = [
        result.created && `created ${result.slug}`,
        result.changed.template && 'template',
        result.changed.options && 'options',
        result.changed.listing && 'listing',
    ].filter(Boolean);
    const lines = [`${result.product}: pushed ${result.version}${result.revision === null ? '' : ` (draft revision ${result.revision})`} through ${result.link}.`];

    if (sent.length > 0) {
        lines.push(`  sent: ${sent.join(', ')}`);
    }

    for (const entry of result.uploaded) {
        lines.push(`  uploaded ${entry.path} (${entry.purpose === 'library' ? `as ${entry.tag}` : entry.purpose})`);
    }

    for (const entry of result.attached) {
        lines.push(`  attached ${entry.library} as ${entry.tag}`);
    }

    if (result.removed_screenshots > 0) {
        lines.push(`  removed ${result.removed_screenshots} ${result.removed_screenshots === 1 ? 'screenshot' : 'screenshots'} no longer in listing/screenshots/`);
    }

    if (result.check !== null && typeof result.check === 'object') {
        const issues = Array.isArray(result.check.issues) ? result.check.issues : [];

        lines.push(result.check.passed === false ? '  marketplace check: not passed' : `  marketplace check: passed${issues.length > 0 ? ` with ${issues.length} ${issues.length === 1 ? 'warning' : 'warnings'}` : ''}`);
        lines.push(...issues.flatMap((/** @type {any} */ issue) => issueLines(issue)));
    }

    if (result.commit_message !== null) {
        lines.push(`Committed "${result.commit_message}".`);
    }

    lines.push(...submissionLines(result.submission ?? { ready: true, missing: [] }));

    if (result.not_uploaded.length === 0) {
        lines.push(`Next: when the creator says go, call submit_for_review for ${result.slug}, then run npx @rafflex/dev release ${result.slug}.`);
    }

    return lines;
}
