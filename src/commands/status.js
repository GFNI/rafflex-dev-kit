import { refreshAgentsMarkdown, serverAgentsMarkdown } from '../agents-md.js';
import { currentBranch, gitState } from '../git.js';
import { planListingImagesFor } from '../push-plan.js';
import { readCachedDocuments } from '../remote.js';
import { submissionLines, submissionStatus } from '../submission.js';
import { compareWithRemote, isRemoteStale, readLocalState } from '../sync-state.js';
import { loadWorkspace, selectProducts } from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

/**
 * @param {import('../workspace.js').ProductRemote|null} remote
 */
function remoteSummary(remote) {
    if (remote === null) {
        return null;
    }

    const draft = remote.draft ?? null;

    return {
        status: remote.status ?? null,
        live_version: remote.live_version ?? null,
        live_channel: remote.live_channel ?? null,
        draft: draft === null ? null : { version: draft.version ?? null, revision: draft.revision ?? null, submitted: draft.submitted === true },
        latest_review: remote.latest_review ?? null,
        synced_at: remote.synced_at ?? null,
    };
}

/**
 * @param {import('../workspace.js').Product} product
 * @param {{rules?: any, libraries?: any, categories?: any}} documents
 * @param {string|null} [branch] The branch the workspace is on, to warn when the last sync was recorded on another.
 */
export function productStatus(product, documents, branch = null) {
    const remote = product.manifest.remote;
    const local = readLocalState(product, documents);
    const changes = compareWithRemote(local, remote);
    const listingImages = planListingImagesFor(local, remote);
    const listingImagesChanged = listingImages.cover !== null || listingImages.screenshots.length > 0;
    /** @type {string[]} */
    const problems = [];

    if (local.template === null) {
        problems.push('template.twig is missing.');
    }

    for (const part of [local.options, local.listing]) {
        if ('error' in part) {
            problems.push(part.error);
        }
    }

    return {
        product: product.path,
        type: product.type,
        slug: product.slug,
        title: product.title,
        version: product.version,
        remote: remoteSummary(remote),
        stale_remote: isRemoteStale(remote),
        in_review: remote?.draft?.submitted === true,
        changes: {
            template: changes.template,
            options: changes.options,
            listing: changes.listing,
            assets: {
                new: changes.assets.new.map(({ path, tag }) => ({ path, tag })),
                changed: changes.assets.changed.map(({ path, tag }) => ({ path, tag })),
                removed: changes.assets.removed,
            },
            listing_images: { cover: listingImages.cover !== null, screenshots: listingImages.screenshots.length },
            any: changes.any || listingImagesChanged,
        },
        problems,
        warnings: branchWarnings(remote, branch),
        submission: submissionStatus(product, documents, local),
    };
}

/**
 * One draft per product means one line of history: warn when the
 * workspace is not on the branch the last sync was recorded on.
 *
 * @param {import('../workspace.js').ProductRemote|null} remote
 * @param {string|null} branch
 * @returns {string[]}
 */
function branchWarnings(remote, branch) {
    const syncedOn = /** @type {any} */ (remote)?.branch ?? null;

    if (syncedOn === null || branch === null || syncedOn === branch) {
        return [];
    }

    return [`The last sync was recorded on the ${syncedOn} branch, but the workspace is on ${branch}. Switch back before pushing, or read the product again with get_product and run synced.`];
}

/**
 * @param {ReturnType<typeof productStatus>} status
 * @returns {string[]}
 */
function statusLines(status) {
    const lines = [`${status.product}  ${status.title} ${status.version}${status.slug === null ? ' (no slug yet)' : ` (${status.slug})`}`];
    const { remote } = status;

    if (remote === null) {
        lines.push(status.slug === null ? '  remote: not on the marketplace yet' : '  remote: never synced: read it with get_product and run synced before pushing');
    } else {
        const parts = [remote.status ?? 'unknown status', `live ${remote.live_version ?? 'none'}${remote.live_channel ? ` (${remote.live_channel})` : ''}`];

        if (remote.draft !== null) {
            parts.push(`draft ${remote.draft.version ?? '?'} r${remote.draft.revision ?? '?'}${remote.draft.submitted ? ' in review' : ''}`);
        }

        const decision = remote.latest_review?.decision ?? remote.latest_review?.status;

        if (typeof decision === 'string') {
            parts.push(`review ${decision}`);
        }

        parts.push(`synced ${remote.synced_at ?? 'never'}`);
        lines.push(`  remote: ${parts.join(', ')}`);

        if (status.stale_remote) {
            lines.push('  the remote snapshot is over a day old: read it again with get_product and run synced before pushing');
        }
    }

    const { changes } = status;
    const changed = [changes.template && 'template', changes.options && 'options', changes.listing && 'listing'].filter(Boolean);
    const assetParts = [
        changes.assets.new.length > 0 && `${changes.assets.new.length} new`,
        changes.assets.changed.length > 0 && `${changes.assets.changed.length} changed`,
        changes.assets.removed.length > 0 && `${changes.assets.removed.length} removed`,
    ].filter(Boolean);

    if (assetParts.length > 0) {
        changed.push(`assets (${assetParts.join(', ')})`);
    }

    if (changes.listing_images.cover || changes.listing_images.screenshots > 0) {
        changed.push('listing images');
    }

    if (remote === null) {
        lines.push('  local: nothing pushed yet');
    } else {
        lines.push(changed.length === 0 ? '  local: no changes since the last sync' : `  local: ${changed.join(', ')} changed since the last sync`);
    }

    for (const problem of status.problems) {
        lines.push(`  problem: ${problem}`);
    }

    for (const warning of status.warnings) {
        lines.push(`  warning: ${warning}`);
    }

    lines.push(...submissionLines(status.submission));

    return lines;
}

/**
 * `status [<product>]`: offline, per product: version, the remote state
 * recorded by the last `synced`, and what changed locally since then. The
 * product named, the one the command runs in, or every product.
 *
 * It also refreshes AGENTS.md when it is still the kit's generated copy
 * and the marketplace's guidance changed (see agents-md.js): the only
 * network request status makes, and it falls back to the cache.
 *
 * JSON: `{workspace, git: {installed, repository, branch}, agents_md, products: [...]}`;
 * each product carries `warnings` (for example a sync recorded on another branch).
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runStatusCommand(context) {
    const { cwd, stdout, options } = context;
    let workspace;
    let products;

    try {
        workspace = loadWorkspace(cwd);
        products = selectProducts(workspace, { names: options.positionals, cwd, fallback: 'all' });
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    const { documents } = readCachedDocuments(workspace.root, workspace.baseUrl, ['rules', 'libraries', 'categories']);
    const state = gitState(workspace.root);
    const branch = state.repository ? currentBranch(workspace.root) : null;
    const git = { ...state, branch };
    const statuses = products.map((product) => productStatus(product, documents, branch));
    let agentsMd;

    try {
        agentsMd = refreshAgentsMarkdown(workspace, await serverAgentsMarkdown(workspace));
    } catch {
        agentsMd = 'unknown';
    }

    if (options.json) {
        writeJson(stdout, { workspace: workspace.root, git, agents_md: agentsMd, products: statuses });

        return 0;
    }

    const lines = statuses.length === 0
        ? ['No products yet. Add one with npx @rafflex/dev new <game|block> "<title>".']
        : statuses.flatMap((status, index) => [...(index > 0 ? [''] : []), ...statusLines(status)]);

    if (agentsMd === 'updated') {
        lines.push('', "AGENTS.md was refreshed with the marketplace's latest guidance.");
    }

    if (!git.installed) {
        lines.push('', 'git is not installed: install it to keep the workspace history and roll back changes.');
    } else if (!git.repository) {
        lines.push('', 'This workspace is not a git repository: run git init to keep its history.');
    }

    stdout.write(`${lines.join('\n')}\n`);

    return 0;
}
