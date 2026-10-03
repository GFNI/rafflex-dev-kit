import { defaultTagFor, filenameStem } from './assets.js';
import { planListingImages, recordedListingImages } from './listing-images.js';

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
    return planListingImages(local.listing_images, recordedListingImages(remote));
}

/**
 * The plan's prose for listing images and refusals: one upload step per
 * image, and notes for screenshots to remove and locked files.
 *
 * @param {{listing_images: import('./listing-images.js').ListingImagesPlan, refusals: PlanRefusal[]}} plan
 * @returns {{steps: string[], notes: string[]}}
 */
export function planListingImageLines(plan) {
    const images = plan.listing_images;
    const steps = [
        ...(images.cover === null ? [] : [images.cover]).map((cover) => `request_media_upload: ${cover.path} with purpose cover, ${cover.mime_type}, ${cover.size} bytes (${cover.change})`),
        ...images.screenshots.map((screenshot) => `request_media_upload: ${screenshot.path} with purpose screenshot, ${screenshot.mime_type}, ${screenshot.size} bytes (new)`),
    ];
    /** @type {string[]} */
    const notes = [];

    if (images.removed_screenshots.length > 0) {
        notes.push(`  ${images.removed_screenshots.length} ${images.removed_screenshots.length === 1 ? 'screenshot is' : 'screenshots are'} on the marketplace but not in listing/screenshots/. Tell the creator to remove ${images.removed_screenshots.length === 1 ? 'it' : 'them'} in the browser.`);
    }

    for (const refusal of plan.refusals) {
        notes.push(`  Not planned [${refusal.code}] ${refusal.path}: ${refusal.message}`);
    }

    return { steps, notes };
}
