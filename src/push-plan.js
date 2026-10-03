import { defaultTagFor, filenameStem } from './assets.js';
import { listingImagesUnknown, planListingImages, recordedListingImages } from './listing-images.js';

/**
 * The parts of a push plan added by PRD 45: listing images to upload, and
 * files the marketplace will not take again (`asset_locked`).
 */

export const lockedFix = 'Save the new version under a new filename in assets/ and use its tag in the template. The old file stays, because a submitted or published version uses it.';

/**
 * @typedef {{code: 'asset_locked', path: string, filename: string, tag: string, message: string, fix: string}} PlanRefusal
 */

/**
 * A name for the new copy of a locked file, and the tag it takes.
 *
 * @param {string} filename
 * @param {string[]} takenTags
 */
function renamedCopy(filename, takenTags) {
    const stem = filenameStem(filename);
    const extension = filename.slice(stem.length);
    let suffix = 2;

    while (takenTags.includes(defaultTagFor(`${stem}-${suffix}${extension}`))) {
        suffix++;
    }

    const name = `${stem}-${suffix}${extension}`;

    return { name, tag: defaultTagFor(name) };
}

/**
 * Changed files whose marketplace copy is locked (a submitted or published
 * version uses it): an upload under the same name is refused, so the plan
 * does not list them and says how to ship the change instead.
 *
 * @param {import('./sync-state.js').LocalChanges} changes
 * @param {import('./workspace.js').ProductRemote|null} remote
 * @param {any} rules
 * @returns {PlanRefusal[]}
 */
export function lockedAssetRefusals(changes, remote, rules) {
    const media = Array.isArray(remote?.media) ? remote.media : [];
    const takenTags = media.map((entry) => entry.tag);
    const published = rules?.upload_rules?.refusals?.locked;
    /** @type {PlanRefusal[]} */
    const refusals = [];

    for (const asset of changes.assets.changed) {
        const entry = media.find((candidate) => candidate.tag === asset.tag);

        if (entry?.locked !== true || asset.library !== null) {
            continue;
        }

        const filename = entry.filename !== '' ? entry.filename : asset.filename;
        const reason = typeof published === 'string'
            ? published.replaceAll(':filename', filename)
            : `${filename} is used by a submitted or published version and cannot be overwritten.`;
        const copy = renamedCopy(asset.filename, takenTags);
        const folder = asset.path.slice(0, asset.path.length - asset.filename.length);

        refusals.push({
            code: 'asset_locked',
            path: asset.path,
            filename: asset.filename,
            tag: asset.tag,
            message: `${reason} Save your change as ${folder}${copy.name} (restore ${asset.path} from git) and use files['${copy.tag}'] in the template.`,
            fix: lockedFix,
        });
    }

    return refusals;
}

/**
 * The listing images part of the plan.
 *
 * @param {import('./sync-state.js').LocalState} local
 * @param {import('./workspace.js').ProductRemote|null} remote
 */
export function planListingImagesFor(local, remote) {
    if (listingImagesUnknown(remote)) {
        return { cover: null, screenshots: [], removed_screenshots: [], remote_unknown: /** @type {true} */ (true) };
    }

    return planListingImages(local.listing_images, recordedListingImages(remote));
}

/**
 * The plan's prose for listing images and refusals: one upload step per
 * image, and notes for screenshots to remove and locked files.
 *
 * @param {{product: string, slug: string|null, listing_images: import('./listing-images.js').ListingImagesPlan, refusals: PlanRefusal[]}} plan
 * @returns {{steps: string[], notes: string[]}}
 */
export function planListingImageLines(plan) {
    const images = plan.listing_images;
    const steps = [
        ...(images.cover === null ? [] : [images.cover]).map((cover) => `request_media_upload: ${cover.path} as filename ${cover.upload_filename} with purpose cover, ${cover.mime_type}, ${cover.size} bytes (${cover.change})`),
        ...images.screenshots.map((screenshot) => `request_media_upload: ${screenshot.path} as filename ${screenshot.upload_filename} with purpose screenshot, ${screenshot.mime_type}, ${screenshot.size} bytes (${screenshot.change})`),
    ];
    /** @type {string[]} */
    const notes = [];
    const moved = images.screenshots.filter((screenshot) => screenshot.change === 'moved').length;
    const removedCount = images.removed_screenshots.length + moved;

    if (images.remote_unknown === true) {
        notes.push(`  Listing images are not planned: the recorded state does not say which the marketplace has. Refresh it first: call request_sync with slug ${plan.slug ?? plan.product}, then run npx @rafflex/dev synced ${plan.slug ?? plan.product} "<sync_url>".`);
    }

    if (images.removed_screenshots.length > 0) {
        notes.push(`  ${images.removed_screenshots.length} ${images.removed_screenshots.length === 1 ? 'screenshot is' : 'screenshots are'} on the marketplace but not in listing/screenshots/; push removes ${images.removed_screenshots.length === 1 ? 'it' : 'them'}.`);
    }

    if (moved > 0) {
        notes.push(`  ${moved} ${moved === 1 ? 'screenshot is' : 'screenshots are'} on the marketplace in another order than listing/screenshots/; push removes ${moved === 1 ? 'it' : 'them'} there and uploads ${moved === 1 ? 'it' : 'them'} again, so the listing shows the folder's filename order.`);
    }

    if (removedCount > 0) {
        notes.push('  When this shell cannot reach the marketplace, tell the creator to remove those screenshots in the browser before the uploads.');
    }

    for (const refusal of plan.refusals) {
        notes.push(`  Not planned [${refusal.code}] ${refusal.path}: ${refusal.message}`);
    }

    return { steps, notes };
}

/** The line that introduces the tool by tool route in the plan's prose. */
export const toolRouteHeading = '  When this shell cannot reach the marketplace (a sandbox without network access), call these marketplace tools in order instead:';

/**
 * The plan's push steps for an AI with a shell: ask for a sync link with
 * request_sync, then run push, which sends exactly what the plan lists.
 *
 * @param {{slug: string|null, product: string}} plan
 * @param {{type: string}} product
 * @returns {string[]}
 */
export function pushStepLines(plan, product) {
    const request = plan.slug === null ? `request_sync with no slug (a new ${product.type})` : `request_sync with slug ${plan.slug}`;

    return [
        `  To push: call ${request}, then run npx @rafflex/dev push ${plan.slug ?? plan.product} "<sync_url>".`,
        '  push sends only what is listed here, uploads the files, and records the result.',
    ];
}
