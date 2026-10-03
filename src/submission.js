import { existsSync, readFileSync } from 'node:fs';
import { unreleasedNotes } from './commands/release.js';
import { listingImageFindings, listingLimitMessages } from './listing-checks.js';
import { listingImagesPresent, listingImagesUnknown, recordedListingImages, refreshListingImagesMessage } from './listing-images.js';
import { readLocalState } from './sync-state.js';

/**
 * What review still needs before a version can be submitted (PRD 45),
 * read from the platform's published requirements
 * (`rules.submission.requirements`, each `{key, applies, message}`) and the
 * product's local files and last synced remote state:
 *
 * - description: listing.md's Description section is not empty;
 * - categories: listing.md names at least one category;
 * - cover_image and screenshots: listing/ holds them, or the marketplace
 *   already has them. When the recorded state does not say which images
 *   the marketplace has (synced by an older kit), the fix is to refresh
 *   that state with `synced`, not to capture images it may already have;
 * - changelog (`applies: "update"`, once a version is live): the Unreleased
 *   notes in CHANGELOG.md.
 *
 * The listing limits come last as `listing_invalid`, because review cannot
 * take a listing the marketplace refuses.
 *
 * A requirement the kit does not know is skipped, and without published
 * requirements (an older marketplace) nothing is reported. None of this
 * blocks pushing a draft: it is what review still needs.
 */

/**
 * @typedef {{key: string, message: string, fix?: string}} MissingRequirement
 * @typedef {{ready: boolean, missing: MissingRequirement[]}} SubmissionStatus
 */

/**
 * @param {import('./workspace.js').Product} product
 * @param {{rules?: any, libraries?: any, categories?: any}} documents
 * @param {import('./sync-state.js').LocalState} [local]
 * @returns {SubmissionStatus}
 */
export function submissionStatus(product, documents, local = readLocalState(product, documents)) {
    const requirements = Array.isArray(documents.rules?.submission?.requirements) ? documents.rules.submission.requirements : [];
    const remote = product.manifest.remote;
    const fields = 'fields' in local.listing ? local.listing.fields : null;
    const images = listingImagesPresent(local.listing_images, recordedListingImages(remote));
    const unknownImages = listingImagesUnknown(remote);
    const liveVersion = remote?.live_version ?? null;
    const name = product.slug ?? product.path;
    /** @type {MissingRequirement[]} */
    const missing = [];

    for (const requirement of requirements) {
        if (typeof requirement?.key !== 'string' || typeof requirement.message !== 'string') {
            continue;
        }

        if (requirement.applies === 'update' && (liveVersion === null || liveVersion === product.version)) {
            continue;
        }

        const entry = { key: requirement.key, message: requirement.message };

        switch (requirement.key) {
            case 'description':
                if (fields === null || fields.description.trim() === '') {
                    missing.push(entry);
                }

                break;
            case 'categories':
                if (fields === null || (fields.category_ids.length === 0 && local.listing.unresolved_categories?.length === 0)) {
                    missing.push(entry);
                }

                break;
            case 'cover_image':
            case 'screenshots':
                if (requirement.key === 'cover_image' ? images.cover : images.screenshots) {
                    break;
                }

                missing.push(unknownImages
                    ? { ...entry, message: `${requirement.message} ${refreshListingImagesMessage(name)}`, fix: `npx @rafflex/dev synced ${name} "<sync_url>"` }
                    : { ...entry, fix: `npx @rafflex/dev capture ${name}` });

                break;
            case 'changelog':
                if (unreleasedNotes(existsSync(product.changelogPath) ? readFileSync(product.changelogPath, 'utf8') : '') === null) {
                    missing.push(entry);
                }

                break;
            default:
                break;
        }
    }

    if (requirements.length > 0) {
        const limits = fields === null ? [] : listingLimitMessages(fields, documents.rules?.listing?.limits);
        const imageFindings = listingImageFindings(product.directory, documents.rules ?? {}, local.listing_images).map((finding) => finding.message);

        for (const message of [...limits, ...imageFindings]) {
            missing.push({ key: 'listing_invalid', message });
        }
    }

    return { ready: missing.length === 0, missing };
}

/**
 * The short "Before review" list for prose output, or nothing when ready.
 *
 * @param {SubmissionStatus} submission
 * @param {string} [indent]
 * @returns {string[]}
 */
export function submissionLines(submission, indent = '  ') {
    if (submission.ready) {
        return [];
    }

    return [
        `${indent}Before review (a draft can be pushed without these):`,
        ...submission.missing.map((entry) => `${indent}  - ${entry.message}${entry.fix === undefined || !entry.fix.includes(' capture ') ? '' : ` Run ${entry.fix} to make listing images from the preview.`}`),
    ];
}
