import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTagFor, fileSize, filenameStem } from './assets.js';
import { contentTypesFor, contentVerdict, contentVerdictMessage } from './file-content.js';
import { fixFor } from './listing-checks.js';
import { filenameRefusal } from './upload-filenames.js';

export { suggestedFilename } from './upload-filenames.js';
import { lockedAssetRefusals, lockedFix } from './push-plan.js';
import { compareWithRemote, readLocalState } from './sync-state.js';

/**
 * The upload refusals a push would meet, found before it (PRD 45). All
 * limits are optional `rules.upload_rules` keys, skipped quietly when an
 * older marketplace does not publish them:
 *
 * - `asset_filename`: a file the push uploads has a name the upload
 *   refuses (`filename_pattern`, `max_filename_length`). Files already on
 *   the marketplace are not uploaded again, so their names are left alone.
 * - `asset_duplicate`: two files in assets/ upload under the same name
 *   (the same file name in two folders, or names differing only in case),
 *   or two approved library files would take the same tag. Two files that
 *   only share a stem (images/win.png and sounds/win.mp3) are fine: the
 *   second takes the tag win-2, in the preview and on the marketplace.
 * - `asset_capacity`: the media in assets/, plus files still on the
 *   marketplace that assets/ no longer holds (a push never deletes them),
 *   is over the per product library capacity. Approved libraries take no
 *   space. A marketplace file counts only when the recorded state has its
 *   size (`size_bytes`, recorded since this kit version).
 * - `asset_content_mismatch`: a file the push uploads holds content the
 *   marketplace refuses for its extension (text named .png, AAC named
 *   .mp3). Another image type under an image extension is fine: the
 *   marketplace stores what the content is.
 *
 * - `asset_locked`: a changed file whose marketplace copy a submitted or
 *   published version uses, so the upload that would replace it is
 *   refused and the template would ship without the new bytes (plan lists
 *   it under `refusals` as well).
 *
 * Every one blocks, because the marketplace refuses the upload. One
 * warning sits beside them: `asset_content_warning`, content the
 * marketplace accepts but stores as another kind than the name says
 * (audio named .png), so the template gets a sound where it expects an
 * image.
 */

/** @type {Record<string, string>} */
export const mediaFixes = {
    asset_filename: 'Rename the file in assets/ as the message says. Its tag is the file name without the extension, so the template keeps working when only the punctuation changes.',
    asset_duplicate: 'Give each file in assets/ its own name, and update files[...] in the template to the new tag.',
    asset_capacity: 'Remove files the template no longer uses from assets/, or save images and sounds smaller.',
    asset_content_mismatch: 'Export the file again in the format its name says.',
    asset_locked: lockedFix,
    asset_content_warning: 'Rename the file to the extension its content has, or export it again in the format its name says.',
};

/** The extensions the media library takes when the rules do not say. */
const defaultUploadExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'glb', 'js'];

/**
 * @typedef {import('./checker.js').Issue} Issue
 */

/**
 * Every media finding for a product.
 *
 * @param {import('./workspace.js').Product} product
 * @param {{rules?: any, libraries?: any, categories?: any}} documents
 * @param {import('./sync-state.js').LocalState} [local]
 * @returns {Issue[]}
 */
export function mediaIssues(product, documents, local = readLocalState(product, documents)) {
    const rules = documents.rules ?? {};
    const uploadRules = rules.upload_rules ?? {};
    const refusals = uploadRules.refusals ?? {};
    const issue = (/** @type {string} */ code, /** @type {string} */ message, /** @type {string} */ file) => ({ code, message, fix: fixFor(rules, code, mediaFixes[code]), file });
    const changes = compareWithRemote(local, product.manifest.remote);
    const locked = lockedAssetRefusals(changes, product.manifest.remote, rules);
    const uploads = [...changes.assets.new, ...changes.assets.changed]
        .filter((asset) => asset.library === null && !locked.some((refusal) => refusal.path === asset.path));
    /** @type {Issue[]} */
    const issues = [];

    for (const asset of uploads) {
        const refusal = filenameRefusal(asset.filename, uploadRules);

        if (refusal === null) {
            continue;
        }

        const { reason, suggestion } = refusal;
        const folder = asset.path.slice(0, asset.path.length - asset.filename.length);

        issues.push(issue('asset_filename', `${asset.path} cannot be uploaded under this name. ${reason} Rename it to ${folder}${suggestion}${defaultTagFor(suggestion) === defaultTagFor(asset.filename) ? ` (its tag stays ${asset.tag})` : ` and use files['${defaultTagFor(suggestion)}'] in the template`}.`, asset.path));
    }

    for (const refusal of locked) {
        issues.push(issue('asset_locked', refusal.message, refusal.path));
    }

    issues.push(...duplicateIssues(local.assets, issue));

    const capacity = uploadRules.library_capacity_bytes;
    const localBytes = local.assets.filter((asset) => asset.library === null).reduce((total, asset) => total + asset.size, 0);
    const remoteMedia = Array.isArray(product.manifest.remote?.media) ? product.manifest.remote.media : [];
    const stillThere = changes.assets.removed
        .map((removed) => remoteMedia.find((entry) => entry.tag === removed.tag))
        .filter((entry) => entry !== undefined && (entry.library === null || entry.library === undefined) && entry.kind !== 'library');
    const remoteBytes = stillThere.reduce((total, entry) => total + (Number.isInteger(entry?.size_bytes) ? Number(entry?.size_bytes) : 0), 0);
    const used = localBytes + remoteBytes;

    if (typeof capacity === 'number' && used > capacity) {
        const full = typeof refusals.over_capacity === 'string' ? `${refusals.over_capacity} ` : '';
        const kept = remoteBytes === 0 ? '' : ` (${fileSize(remoteBytes)} of it in files still on the marketplace but no longer in assets/; remove them in the browser to free the space)`;

        issues.push(issue('asset_capacity', `${full}The files in assets/ add up to ${fileSize(used)}${kept}, over the ${fileSize(capacity)} a product's media library holds.`, 'assets/'));
    }

    const accepted = contentTypesFor(Array.isArray(uploadRules.extensions) ? uploadRules.extensions : defaultUploadExtensions);

    for (const asset of uploads) {
        const verdict = contentVerdict(asset.filename, readFileSync(join(product.directory, asset.path)), accepted);

        if (verdict !== null) {
            issues.push(issue(verdict.blocking ? 'asset_content_mismatch' : 'asset_content_warning', contentVerdictMessage(asset.path, verdict, asset.tag), asset.path));
        }
    }

    return issues;
}

/**
 * Two files that upload under the same name (in different folders, or
 * differing only in case), or two approved libraries that would take the
 * same tag. Media files that only share a stem take suffixed tags (win,
 * win-2) and the push sends each tag, so the marketplace holds the same
 * tags the preview uses.
 *
 * @param {import('./sync-state.js').LocalAsset[]} assets
 * @param {(code: string, message: string, file: string) => Issue} issue
 * @returns {Issue[]}
 */
function duplicateIssues(assets, issue) {
    /** @type {Issue[]} */
    const issues = [];
    /** @type {Map<string, import('./sync-state.js').LocalAsset[]>} */
    const byFilename = new Map();
    /** @type {Map<string, import('./sync-state.js').LocalAsset[]>} */
    const byTag = new Map();

    for (const asset of assets) {
        if (asset.library === null) {
            const key = asset.filename.toLowerCase();

            byFilename.set(key, [...(byFilename.get(key) ?? []), asset]);
            continue;
        }

        const baseTag = asset.tag.replace(/-\d+$/, '');

        byTag.set(baseTag, [...(byTag.get(baseTag) ?? []), asset]);
    }

    /** @type {Set<string>} */
    const reported = new Set();

    for (const group of byFilename.values()) {
        if (group.length > 1) {
            group.forEach((asset) => reported.add(asset.path));
            issues.push(issue('asset_duplicate', `${group.map((asset) => asset.path).join(' and ')} upload under the same name, so one would replace the other. Rename one, for example to ${filenameStem(group[1].filename)}-2${group[1].filename.slice(filenameStem(group[1].filename).length)}.`, group[1].path));
        }
    }

    for (const [tag, group] of byTag) {
        if (group.length > 1 && !group.every((asset) => reported.has(asset.path))) {
            issues.push(issue('asset_duplicate', `${group.map((asset) => asset.path).join(' and ')} would all take the tag ${tag}. Rename all but one, because files['${tag}'] can only mean one file.`, group[1].path));
        }
    }

    return issues;
}
