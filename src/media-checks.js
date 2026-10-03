import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTagFor, fileSize, filenameStem } from './assets.js';
import { contentMismatch, mismatchMessage } from './file-content.js';
import { fixFor } from './listing-checks.js';
import { compareWithRemote, readLocalState } from './sync-state.js';

/**
 * The upload refusals a push would meet, found before it (PRD 45). All
 * limits are optional `rules.upload_rules` keys, skipped quietly when an
 * older marketplace does not publish them:
 *
 * - `asset_filename`: a file the push uploads has a name the upload
 *   refuses (`filename_pattern`, `max_filename_length`). Files already on
 *   the marketplace are not uploaded again, so their names are left alone.
 * - `asset_duplicate`: two files in assets/ upload under the same name or
 *   would take the same tag (the kit would otherwise suffix one -2).
 * - `asset_capacity`: the media in assets/ is over the per product
 *   library capacity. Approved libraries take no space.
 * - `asset_content_mismatch`: a file the push uploads holds content that
 *   does not match its extension (a JPEG named .png).
 *
 * Every one blocks, because the marketplace refuses the upload.
 */

/** @type {Record<string, string>} */
export const mediaFixes = {
    asset_filename: 'Rename the file in assets/ as the message says. Its tag is the file name without the extension, so the template keeps working when only the punctuation changes.',
    asset_duplicate: 'Give each file in assets/ its own name, and update files[...] in the template to the new tag.',
    asset_capacity: 'Remove files the template no longer uses from assets/, or save images and sounds smaller.',
    asset_content_mismatch: 'Rename the file to the extension its content has, or export it again in the format its name says.',
};

/**
 * @typedef {import('./checker.js').Issue} Issue
 */

/**
 * A name the upload takes, as close to `filename` as possible: every run
 * of characters outside the pattern becomes a hyphen, so the derived tag
 * stays the same in the common case of spaces.
 *
 * @param {string} filename
 * @param {RegExp|null} pattern
 * @param {number|null} maxLength
 */
export function suggestedFilename(filename, pattern, maxLength) {
    const dot = filename.lastIndexOf('.');
    const extension = dot > 0 ? filename.slice(dot).toLowerCase() : '';
    let stem = (dot > 0 ? filename.slice(0, dot) : filename)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[.-]+|-+$/g, '');

    if (stem === '') {
        stem = 'file';
    }

    if (maxLength !== null && stem.length + extension.length > maxLength) {
        stem = stem.slice(0, Math.max(1, maxLength - extension.length));
    }

    const suggestion = `${stem}${extension}`;

    return pattern === null || pattern.test(suggestion) ? suggestion : `file${extension}`;
}

/**
 * @param {any} uploadRules
 * @returns {RegExp|null}
 */
function filenamePattern(uploadRules) {
    const published = uploadRules?.filename_pattern;

    if (typeof published?.pattern !== 'string' || published.js_compatible === false) {
        return null;
    }

    try {
        return new RegExp(published.pattern, String(published.flags ?? '').replace('g', ''));
    } catch {
        return null;
    }
}

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
    const uploads = [...changes.assets.new, ...changes.assets.changed].filter((asset) => asset.library === null);
    const pattern = filenamePattern(uploadRules);
    const maxLength = typeof uploadRules.max_filename_length === 'number' ? uploadRules.max_filename_length : null;
    /** @type {Issue[]} */
    const issues = [];

    for (const asset of uploads) {
        const tooLong = maxLength !== null && asset.filename.length > maxLength;
        const refused = pattern !== null && !pattern.test(asset.filename);

        if (!tooLong && !refused) {
            continue;
        }

        const reason = refused
            ? String(refusals.invalid_filename ?? 'Use letters, numbers, dots, hyphens, and underscores only in file names.')
            : `File names can be at most ${maxLength} characters.`;
        const suggestion = suggestedFilename(asset.filename, pattern, maxLength);
        const folder = asset.path.slice(0, asset.path.length - asset.filename.length);

        issues.push(issue('asset_filename', `${asset.path} cannot be uploaded under this name. ${reason} Rename it to ${folder}${suggestion}${defaultTagFor(suggestion) === asset.tag ? ` (its tag stays ${asset.tag})` : ` and use files['${defaultTagFor(suggestion)}'] in the template`}.`, asset.path));
    }

    issues.push(...duplicateIssues(local.assets, issue));

    const capacity = uploadRules.library_capacity_bytes;
    const used = local.assets.filter((asset) => asset.library === null).reduce((total, asset) => total + asset.size, 0);

    if (typeof capacity === 'number' && used > capacity) {
        const full = typeof refusals.over_capacity === 'string' ? `${refusals.over_capacity} ` : '';

        issues.push(issue('asset_capacity', `${full}The files in assets/ add up to ${fileSize(used)}, over the ${fileSize(capacity)} a product's media library holds.`, 'assets/'));
    }

    for (const asset of uploads) {
        const mismatch = contentMismatch(asset.filename, readFileSync(join(product.directory, asset.path)));

        if (mismatch !== null) {
            issues.push(issue('asset_content_mismatch', mismatchMessage(asset.path, mismatch), asset.path));
        }
    }

    return issues;
}

/**
 * Two files that upload under the same name (in different folders, or
 * differing only in case), or that would take the same tag.
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
        }

        const baseTag = asset.library === null ? defaultTagFor(asset.filename) : asset.tag.replace(/-\d+$/, '');

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
