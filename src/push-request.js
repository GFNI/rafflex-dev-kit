import { join } from 'node:path';
import { remoteFromProduct } from './sync-state.js';

/**
 * What one `push` sends through a sync link (PRD 45), built from the push
 * plan compared with the marketplace's state read from the link a moment
 * before: only the parts that changed, every file to upload with its
 * purpose, and the approved libraries to attach. Uploads go out in
 * batches of the marketplace's `max_files_per_batch`; the first request
 * carries everything else, and each later one only its uploads.
 */

/** The batch size when the rules do not publish one (the marketplace's own). */
export const defaultBatchSize = 10;

/**
 * @typedef {{filename: string, size_bytes: number, mime_type: string, purpose: 'library'|'cover'|'screenshot', tag?: string, description?: string|null, sha256: string}} UploadRequest
 * @typedef {{request: UploadRequest, path: string, file: string}} PlannedUpload  `path` is relative to the product folder, `file` absolute.
 * @typedef {{name: string, version?: string, tag: string, path: string}} PlannedLibrary
 *
 * @typedef {object} PushRequest
 * @property {Record<string, any>} body       The first request, without its uploads.
 * @property {PlannedUpload[]} uploads        Every file to upload, in order.
 * @property {PlannedLibrary[]} libraries
 * @property {{template: boolean, options: boolean, listing: boolean, version: boolean, release_notes: boolean}} changed
 * @property {boolean} created
 * @property {number} removedScreenshots
 * @property {boolean} nothingToPush
 */

/**
 * The batch size the marketplace publishes, else its default.
 *
 * @param {any} rules
 */
export function batchSizeFrom(rules) {
    const size = rules?.upload_rules?.max_files_per_batch;

    return Number.isInteger(size) && size > 0 ? size : defaultBatchSize;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function inBatches(items, size) {
    /** @type {T[][]} */
    const batches = [];

    for (let start = 0; start < items.length; start += size) {
        batches.push(items.slice(start, start + size));
    }

    return batches;
}

/** A push the kit refuses to build; the message says what to do instead. */
export class PushRequestError extends Error {
    name = 'PushRequestError';
}

/**
 * The most screenshots a listing shows, as the rules publish it, or null
 * when they do not.
 *
 * @param {any} rules
 * @returns {number|null}
 */
export function maxScreenshotsFrom(rules) {
    const maximum = rules?.listing?.images?.screenshot?.max_count;

    return Number.isInteger(maximum) && maximum > 0 ? maximum : null;
}

/**
 * @param {string} value
 */
function emptyAsNull(value) {
    return value.trim() === '' ? null : value;
}

/**
 * Build the push from the plan.
 *
 * @param {object} options
 * @param {import('./workspace.js').Product} options.product
 * @param {Record<string, any>|null} options.payload   The product as the link read it, null for a new product link.
 * @param {ReturnType<typeof import('./commands/plan.js').buildPlan>['plan']} options.plan  Planned against `payload`.
 * @param {string} options.template                    The template text to send when it changed.
 * @param {import('./listing-images.js').LocalListingImages} options.listingImages
 * @param {{rules?: any, libraries?: any}} options.documents
 * @returns {PushRequest}
 */
export function buildPushRequest({ product, payload, plan, template, listingImages, documents }) {
    const created = payload === null;
    const draft = payload?.draft !== null && typeof payload?.draft === 'object' ? payload.draft : null;
    const released = (Array.isArray(payload?.versions) ? payload.versions : []).map((/** @type {any} */ entry) => entry?.version);
    const remoteMedia = Array.isArray(payload?.media) ? payload.media : [];
    /** @type {Record<string, any>} */
    const body = {};

    if (created) {
        body.create = { type: product.type, title: product.title };
    }

    body.base_revision = Number.isInteger(draft?.revision) ? draft.revision : null;

    if (created || plan.template.changed) {
        body.template = template;
    }

    if (plan.options.changed && 'option_overrides' in plan.options && !(created && Object.keys(plan.options.option_overrides ?? {}).length === 0)) {
        body.option_overrides = plan.options.option_overrides;
    }

    const notes = typeof plan.release_notes === 'string' && plan.release_notes.trim() !== '' ? plan.release_notes : null;
    const versionChanged = draft === null ? !released.includes(product.version) : draft.version !== product.version;
    const notesChanged = notes !== null && (draft === null || String(draft.changelog ?? '').trim() !== notes.trim());
    const writesDraft = created || 'template' in body || 'option_overrides' in body || (draft !== null && (versionChanged || notesChanged));

    if (writesDraft) {
        body.version = product.version;

        if (notes !== null && (draft === null || notesChanged)) {
            body.release_notes = notes;
        }
    }

    const fields = plan.listing.changed && 'fields' in plan.listing ? plan.listing.fields : undefined;
    const emptyListing = fields !== undefined && [fields.description, fields.documentation, fields.install_notes, fields.video_url].every((value) => value.trim() === '')
        && fields.category_ids.length === 0 && fields.tag_names.length === 0;

    // A new product with nothing in listing.md has no listing to send yet.
    if (fields !== undefined && !(created && emptyListing)) {
        body.listing = {
            description: emptyAsNull(fields.description),
            documentation: emptyAsNull(fields.documentation),
            install_notes: emptyAsNull(fields.install_notes),
            video_url: emptyAsNull(fields.video_url),
            category_ids: fields.category_ids,
            tag_names: fields.tag_names,
        };
    }

    /** @type {PlannedLibrary[]} */
    const libraries = [];
    /** @type {PlannedUpload[]} */
    const uploads = [];
    const approved = Array.isArray(documents.libraries?.libraries) ? documents.libraries.libraries : [];

    for (const asset of plan.assets) {
        if ('library' in asset && typeof asset.library === 'string') {
            const build = approved.find((/** @type {any} */ entry) => String(entry?.sha256 ?? '').toLowerCase() === asset.sha256);

            libraries.push({ name: asset.library, ...(typeof build?.version === 'string' ? { version: build.version } : {}), tag: asset.tag, path: asset.path });
            continue;
        }

        const existing = remoteMedia.find((/** @type {any} */ entry) => entry?.tag === asset.tag);

        uploads.push({
            request: {
                filename: asset.filename,
                size_bytes: asset.size,
                mime_type: asset.mime_type,
                purpose: 'library',
                tag: asset.tag,
                description: typeof existing?.description === 'string' && existing.description !== '' ? existing.description : null,
                sha256: asset.sha256,
            },
            path: asset.path,
            file: join(product.directory, asset.path),
        });
    }

    const images = plan.listing_images;

    // Under the generated name the plan gives each image, never the
    // creator's own filename; screenshots in the folder's filename order.
    for (const image of [...(images.cover === null ? [] : [images.cover]), ...images.screenshots]) {
        const purpose = image === images.cover ? 'cover' : 'screenshot';

        uploads.push({
            request: { filename: image.upload_filename, size_bytes: image.size, mime_type: image.mime_type, purpose, sha256: image.sha256 },
            path: image.path,
            file: join(product.directory, image.path),
        });
    }

    if (libraries.length > 0) {
        body.libraries = libraries.map(({ name, version, tag }) => ({ name, ...(version === undefined ? {} : { version }), tag }));
    }

    if (listingImages.screenshots.length > 0) {
        // A moved screenshot is removed there and uploaded again in its place.
        const moved = new Set(images.screenshots.filter((image) => image.change === 'moved').map((image) => image.sha256));
        const keep = [...new Set(listingImages.screenshots.map((image) => image.sha256))].filter((hash) => !moved.has(hash));
        const maximum = maxScreenshotsFrom(documents.rules);

        // check blocks more screenshots than the listing shows, so this
        // only guards a push planned around that check.
        if (maximum !== null && keep.length > maximum) {
            throw new PushRequestError(`listing/screenshots/ holds ${keep.length} different screenshots; a listing shows at most ${maximum}. Keep at most ${maximum} (they show in filename order), run npx @rafflex/dev verify ${product.slug ?? product.path}, then push again.`);
        }

        body.screenshots_keep = keep;
    }

    const changed = {
        template: 'template' in body,
        options: 'option_overrides' in body,
        listing: 'listing' in body,
        version: 'version' in body && (created || versionChanged),
        release_notes: 'release_notes' in body,
    };
    const removedScreenshots = 'screenshots_keep' in body ? images.removed_screenshots.length : 0;

    return {
        body,
        uploads,
        libraries,
        changed,
        created,
        removedScreenshots,
        nothingToPush: !created && !writesDraft && !changed.listing && uploads.length === 0 && libraries.length === 0 && removedScreenshots === 0,
    };
}

/**
 * The remote state to plan a push against: the product as the link read
 * it, or nothing for a product not created yet.
 *
 * @param {Record<string, any>|null} payload
 */
export function remoteForPlan(payload) {
    return payload === null ? null : remoteFromProduct(payload);
}

/**
 * The key an upload grant is matched to its file by.
 *
 * @param {{purpose?: unknown, filename?: unknown, tag?: unknown}} entry
 */
export function uploadKey(entry) {
    return `${String(entry.purpose ?? 'library')}\n${String(entry.filename ?? '')}\n${entry.purpose === 'library' || entry.purpose === undefined ? String(entry.tag ?? '') : ''}`;
}
