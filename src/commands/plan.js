import { existsSync, readFileSync } from 'node:fs';
import { isBlocking } from '../checker.js';
import { lockedAssetRefusals, planListingImageLines, planListingImagesFor } from '../push-plan.js';
import { loadDocuments, readCachedDocuments } from '../remote.js';
import { submissionLines, submissionStatus } from '../submission.js';
import { compareWithRemote, isRemoteStale, readLocalState } from '../sync-state.js';
import { loadWorkspace, selectProduct, withManifest } from '../workspace.js';
import { verifyProducts } from './verify.js';
import { unreleasedNotes } from './release.js';
import { fail, messageOf, writeJson } from './output.js';

/**
 * The rules and approved libraries for tagging assets as the studio would:
 * fresh when the marketplace answers, else the cache, else none (every
 * file tagged by its filename, libraries unrecognised).
 *
 * @param {import('../workspace.js').Workspace} workspace
 * @returns {Promise<{documents: {rules?: any, libraries?: any}, warnings: string[]}>}
 */
export async function assetDocuments(workspace) {
    try {
        const loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl, names: ['rules', 'libraries', 'categories'] });

        return { documents: loaded.documents, warnings: loaded.warnings };
    } catch (error) {
        const { documents } = readCachedDocuments(workspace.root, workspace.baseUrl, ['rules', 'libraries', 'categories']);

        return { documents, warnings: [`Could not load the platform's upload rules (${messageOf(error)}); assets are tagged by filename and approved libraries are not recognised.`] };
    }
}

/**
 * The push plan for a product, in the contract's `plan --json` shape.
 *
 * @param {import('../workspace.js').Product} product
 * @param {{rules?: any, libraries?: any, categories?: any}} documents
 * @param {number} [now]
 */
export function buildPlan(product, documents, now = Date.now()) {
    const remote = product.manifest.remote;
    const local = readLocalState(product, documents);

    if (local.template === null) {
        throw new Error(`${product.path}/template.twig is missing.`);
    }

    for (const part of [local.options, local.listing]) {
        if ('error' in part) {
            throw new Error(`${product.path}: ${part.error}`);
        }
    }

    const changes = compareWithRemote(local, remote);
    const locked = lockedAssetRefusals(changes, remote, documents.rules);

    changes.assets.changed = changes.assets.changed.filter((asset) => !locked.some((refusal) => refusal.path === asset.path));

    const listingImages = planListingImagesFor(local, remote);
    const options = /** @type {{sha256: string, value: Record<string, any>}} */ (local.options);
    const listing = /** @type {{sha256: string, fields: import('../listing.js').ListingFields}} */ (local.listing);
    const assets = [
        ...changes.assets.new.map((asset) => ({ asset, change: 'new' })),
        ...changes.assets.changed.map((asset) => ({ asset, change: 'changed' })),
    ]
        .sort((first, second) => first.asset.path.localeCompare(second.asset.path))
        .map(({ asset, change }) => ({
            path: asset.path,
            filename: asset.filename,
            tag: asset.tag,
            kind: asset.kind,
            size: asset.size,
            mime_type: asset.mime_type,
            sha256: asset.sha256,
            change,
            ...(asset.library === null ? {} : { library: asset.library }),
        }));
    const changelog = existsSync(product.changelogPath) ? readFileSync(product.changelogPath, 'utf8') : '';

    return {
        plan: {
            product: product.path,
            slug: product.slug,
            nothing_to_push: !changes.template && !changes.options && !changes.listing && assets.length === 0 && listingImages.cover === null && listingImages.screenshots.length === 0,
            stale_remote: isRemoteStale(remote, now),
            template: { changed: changes.template },
            options: changes.options ? { changed: true, option_overrides: options.value } : { changed: false },
            listing: changes.listing ? { changed: true, fields: listing.fields } : { changed: false },
            assets,
            removed_assets: changes.assets.removed,
            release_notes: unreleasedNotes(changelog),
            version: product.version,
            listing_images: listingImages,
            refusals: locked,
            submission: submissionStatus(product, documents, local),
        },
        refusals: local.refusals,
    };
}

/**
 * @param {ReturnType<typeof buildPlan>['plan']} plan
 * @param {import('../workspace.js').Product} product
 * @returns {string[]}
 */
function planLines(plan, product) {
    const remote = product.manifest.remote;
    const lines = [`${plan.product}  ${product.title} ${plan.version}${plan.slug === null ? ' (no slug yet)' : ` (${plan.slug})`}`];

    if (plan.stale_remote) {
        lines.push(remote === null
            ? (plan.slug === null ? '  Not on the marketplace yet.' : '  Never synced: read it with get_product and pipe the result to synced before pushing.')
            : '  The remote snapshot is over a day old: read it with get_product and pipe the result to synced before pushing.');
    }

    if (remote?.draft?.submitted === true) {
        lines.push(`  ${remote.draft.version ?? plan.version} is in review and cannot be changed until the decision.`);
    }

    if (plan.nothing_to_push) {
        lines.push('  Nothing to push.', ...removedAssetLines(plan.removed_assets), ...planListingImageLines(plan).notes, ...submissionLines(plan.submission));

        return lines;
    }

    const steps = [];
    const revision = remote?.draft?.revision;

    if (plan.slug === null) {
        steps.push(`create_product (type ${product.type}, title "${product.title}", the template), then get_product | npx @rafflex/dev synced ${plan.product}`);
    }

    if (plan.template.changed || plan.options.changed) {
        const parts = [plan.template.changed && 'template', plan.options.changed && 'option_overrides'].filter(Boolean).join(' and ');

        steps.push(`update_draft: ${parts}, version_number ${plan.version}${Number.isInteger(revision) ? `, base_revision ${revision}` : ''}${plan.release_notes === null ? '' : ', changelog from Unreleased'}`);
    }

    if (plan.listing.changed) {
        steps.push('update_product_details: description, documentation, install_notes, video_url, category_ids, tag_names from listing.md');
    }

    for (const asset of plan.assets) {
        steps.push(asset.kind === 'library' && 'library' in asset
            ? `attach_approved_library: ${asset.library} as ${asset.tag} (${asset.change})`
            : `request_media_upload: ${asset.path} as ${asset.tag}, ${asset.mime_type}, ${asset.size} bytes (${asset.change})`);
    }

    const listingImageLines = planListingImageLines(plan);

    steps.push(...listingImageLines.steps);
    steps.push(`get_product, then pipe it to npx @rafflex/dev synced ${plan.product}`);
    lines.push(...steps.map((step, index) => `  ${index + 1}. ${step}`), ...removedAssetLines(plan.removed_assets), ...listingImageLines.notes, ...submissionLines(plan.submission));

    return lines;
}

/**
 * Media on the marketplace with no file in assets/. The kit never removes
 * media (deleting stays in the browser), so the AI tells the creator.
 *
 * @param {{tag: string, filename: string}[]} removed
 * @returns {string[]}
 */
function removedAssetLines(removed) {
    if (removed.length === 0) {
        return [];
    }

    return [
        `  On the marketplace but not in assets/: ${removed.map((entry) => `${entry.filename} (${entry.tag})`).join(', ')}.`,
        '  Nothing removes them from here. If they should go, tell the creator to remove them from the product\'s media in the browser.',
    ];
}

/**
 * @typedef {{ready: boolean, browser_tests: 'passed'|'failed'|'skipped'|null, blocking_issues: (import('../checker.js').Issue & {screenshot?: string})[], warning_count: number, error?: string}} PlanVerify
 */

/**
 * Run verify on the product before planning (PRD 41): the product is not
 * ready while anything blocks, and plan says so.
 *
 * @param {import('../workspace.js').Workspace} workspace
 * @param {import('../workspace.js').Product} product
 * @returns {Promise<PlanVerify>}
 */
async function verifyBeforePlan(workspace, product) {
    try {
        const loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl });
        const [result] = await verifyProducts({ workspace: withManifest(workspace, loaded.manifest), loaded, products: [product] });

        if (result.check.error !== undefined) {
            return { ready: false, browser_tests: null, blocking_issues: [], warning_count: 0, error: result.check.error };
        }

        return { ready: result.ready, browser_tests: result.browser_tests, blocking_issues: result.issues.filter(isBlocking), warning_count: result.warnings };
    } catch (error) {
        return { ready: false, browser_tests: null, blocking_issues: [], warning_count: 0, error: `verify could not run: ${messageOf(error)}` };
    }
}

/**
 * @param {PlanVerify} verify
 * @param {string} name
 * @returns {string[]}
 */
function verifyPlanLines(verify, name) {
    if (verify.error !== undefined) {
        return [`  Not ready to push: ${verify.error}. Run npx @rafflex/dev verify ${name} once it can run.`];
    }

    if (!verify.ready) {
        return [
            `  Not ready to push: ${verify.blocking_issues.length} blocking ${verify.blocking_issues.length === 1 ? 'issue' : 'issues'}. Fix them, then run plan again:`,
            ...verify.blocking_issues.map((issue) => `    [${issue.code}]${issue.line ? ` line ${issue.line}` : ''}${issue.scenario ? ` scenario ${issue.scenario}` : ''}: ${issue.message}`),
        ];
    }

    const browser = verify.browser_tests === 'skipped' ? 'browser tests skipped, install Playwright with npx @rafflex/dev test --install after asking' : 'browser tests passed';

    return [`  Verified: ready to push (${browser}${verify.warning_count > 0 ? `, ${verify.warning_count} ${verify.warning_count === 1 ? 'warning' : 'warnings'} to review with verify` : ''}).`];
}

/**
 * `plan <product>`: what to push, as data, compared with the remote
 * snapshot `synced` last recorded. The AI carries it out through the
 * marketplace tools, then reads the product again and runs `synced`.
 *
 * JSON: `{product, slug, nothing_to_push, stale_remote, template: {changed},
 * options: {changed, option_overrides?}, listing: {changed, fields?},
 * assets: [{path, filename, tag, kind, size, mime_type, sha256, change, library?}],
 * removed_assets: [{tag, filename}], release_notes, version}`.
 * `removed_assets` is media on the marketplace with no local file; the
 * kit never removes it and `nothing_to_push` ignores it.
 *
 * verify runs first (format, check, test), so its formatting is part of
 * the plan. The JSON adds `ready` and `verify: {ready, browser_tests,
 * blocking_issues, warning_count, error?}`; while not ready the prose
 * lists the blocking issues instead of the steps, and the exit code is 1.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runPlanCommand(context) {
    const { cwd, stdout, stderr, options } = context;
    let workspace;
    let product;

    try {
        workspace = loadWorkspace(cwd);
        product = selectProduct(workspace, options.positionals[0], cwd);
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    const verify = await verifyBeforePlan(workspace, product);
    const { documents, warnings } = await assetDocuments(workspace);
    let built;

    try {
        built = buildPlan(product, documents);
    } catch (error) {
        return fail(context, messageOf(error), 1);
    }

    for (const warning of warnings) {
        stderr.write(`note: ${warning}\n`);
    }

    for (const refusal of built.refusals) {
        stderr.write(`warning: ${refusal.file} is left out of the plan: ${refusal.message}\n`);
    }

    if (options.json) {
        writeJson(stdout, { ...built.plan, ready: verify.ready, verify });

        return verify.ready ? 0 : 1;
    }

    const lines = planLines(built.plan, product);

    if (verify.ready) {
        lines.splice(1, 0, ...verifyPlanLines(verify, product.slug ?? product.path));
    } else {
        lines.splice(1, lines.length - 1, ...lines.slice(1).filter((line) => !/^ {2}\d+\. /.test(line)), ...verifyPlanLines(verify, product.slug ?? product.path));
    }

    stdout.write(`${lines.join('\n')}\n`);

    return verify.ready ? 0 : 1;
}
