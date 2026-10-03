import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileSize } from './assets.js';
import { contentMismatch, mismatchMessage } from './file-content.js';
import { defaultImageExtensions, imageRules, readListingImages } from './listing-images.js';
import { ListingError, parseListing, resolveListingCategories } from './listing.js';

/**
 * The listing as the marketplace would take it (PRD 45), checked before a
 * push: listing.md's frontmatter parses, its text fits the published
 * limits, its categories exist, and the cover and screenshots are images
 * the marketplace accepts. Every finding is the blocking `listing_invalid`,
 * because `update_product_details` or the upload refuses it.
 *
 * Each limit comes from rules.json (`listing.limits`, `listing.images`)
 * and is skipped quietly when an older marketplace does not publish it.
 */

export const listingInvalidCode = 'listing_invalid';

export const listingInvalidFix = 'Fix listing.md or the files in listing/ as the message says. The marketplace refuses the listing until then.';

/**
 * @typedef {import('./checker.js').Issue} Issue
 * @typedef {{file: string, message: string}} FileFinding
 */

/**
 * @param {any} rules
 * @param {string} code
 * @param {string} fallback
 */
export function fixFor(rules, code, fallback) {
    const entry = rules?.issue_codes?.[code];

    if (typeof entry === 'string' && entry !== '') {
        return entry;
    }

    return typeof entry?.fix === 'string' && entry.fix !== '' ? entry.fix : fallback;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isLimit(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Characters as the platform counts them (code points, not UTF-16 units).
 *
 * @param {string} text
 */
function characters(text) {
    return [...text].length;
}

/**
 * @param {string} url
 */
function isWebUrl(url) {
    try {
        const parsed = new URL(url);

        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.includes('.');
    } catch {
        return false;
    }
}

/**
 * The text and classification findings for parsed listing fields.
 *
 * @param {import('./listing.js').ListingFields} fields
 * @param {any} limits rules.listing.limits, or undefined.
 * @returns {string[]}
 */
export function listingLimitMessages(fields, limits) {
    /** @type {string[]} */
    const messages = [];
    const sections = /** @type {const} */ ([
        ['description', 'description', 'Description'],
        ['documentation', 'documentation', 'Documentation'],
        ['install_notes', 'install_notes', 'Install notes'],
    ]);

    for (const [field, limitKey, heading] of sections) {
        const limit = limits?.[limitKey];
        const length = characters(fields[field] ?? '');

        if (isLimit(limit) && length > limit) {
            messages.push(`The ${heading} section of listing.md is ${length} characters; the limit is ${limit}. Shorten it.`);
        }
    }

    const videoUrl = String(fields.video_url ?? '').trim();

    if (videoUrl !== '' && isLimit(limits?.video_url) && characters(videoUrl) > limits.video_url) {
        messages.push(`listing.md's video_url is ${characters(videoUrl)} characters; the limit is ${limits.video_url}. Use a shorter link.`);
    }

    if (videoUrl !== '' && !isWebUrl(videoUrl)) {
        messages.push(`listing.md's video_url "${videoUrl}" is not a web address. Use a full link starting with https://, or "" for none.`);
    }

    const tags = fields.tag_names ?? [];

    if (isLimit(limits?.max_tags) && tags.length > limits.max_tags) {
        messages.push(`listing.md has ${tags.length} tag_names; a product can have at most ${limits.max_tags}. Keep the ${limits.max_tags} that describe it best.`);
    }

    for (const tag of tags) {
        if (isLimit(limits?.tag_name) && characters(tag) > limits.tag_name) {
            messages.push(`The tag "${tag}" is ${characters(tag)} characters; a tag can be at most ${limits.tag_name}. Shorten it.`);
        }
    }

    return messages;
}

/**
 * The category findings: names or ids the marketplace's category list does
 * not hold, or names that could not be looked up.
 *
 * @param {import('./listing.js').ListingFields} fields
 * @param {any} categoriesDocument
 * @returns {string[]}
 */
export function categoryMessages(fields, categoriesDocument) {
    const resolved = resolveListingCategories(fields, categoriesDocument);

    if (resolved.unresolved.length > 0) {
        return [`listing.md names categories (${resolved.unresolved.join(', ')}), but the marketplace's category list could not be loaded to look them up. Connect to the internet and run again.`];
    }

    if (resolved.unknown.length === 0 || resolved.categories === null) {
        return [];
    }

    const valid = resolved.categories.map((category) => category.name).join(', ');

    return [`listing.md names ${resolved.unknown.length === 1 ? 'a category' : 'categories'} the marketplace does not have: ${resolved.unknown.join(', ')}. Use category names from this list: ${valid}.`];
}

/**
 * The findings for one listing image.
 *
 * @param {string} productDirectory
 * @param {import('./listing-images.js').LocalListingImage} image
 * @param {{max_bytes?: number, extensions?: string[]}} limits
 * @param {string} label "cover image" or "screenshot".
 * @returns {FileFinding[]}
 */
function imageMessages(productDirectory, image, limits, label) {
    const extensions = Array.isArray(limits.extensions) && limits.extensions.length > 0 ? limits.extensions : defaultImageExtensions;
    const finding = (/** @type {string} */ message) => ({ file: image.path, message });

    if (!extensions.includes(image.extension)) {
        return [finding(`${image.path} cannot be used as a ${label}. Allowed types: ${extensions.join(', ')}.`)];
    }

    /** @type {FileFinding[]} */
    const findings = [];

    if (isLimit(limits.max_bytes) && image.size > limits.max_bytes) {
        findings.push(finding(`${image.path} is ${fileSize(image.size)}; a ${label} can be at most ${fileSize(limits.max_bytes)}. Save it smaller (a JPEG, or fewer pixels).`));
    }

    const mismatch = contentMismatch(image.filename, readFileSync(join(productDirectory, image.path)));

    if (mismatch !== null) {
        findings.push(finding(mismatchMessage(image.path, mismatch)));
    }

    return findings;
}

/**
 * The findings for the cover and screenshots in listing/.
 *
 * @param {string} productDirectory
 * @param {any} rules
 * @param {import('./listing-images.js').LocalListingImages} [images]
 * @returns {FileFinding[]}
 */
export function listingImageFindings(productDirectory, rules, images = readListingImages(productDirectory)) {
    const coverRules = imageRules(rules, 'cover');
    const screenshotRules = imageRules(rules, 'screenshot');
    /** @type {FileFinding[]} */
    const findings = [];

    if (images.covers.length > 1) {
        findings.push({ file: 'listing/', message: `listing/ holds ${images.covers.length} cover images (${images.covers.map((image) => image.filename).join(', ')}). Keep one.` });
    }

    for (const cover of images.covers) {
        findings.push(...imageMessages(productDirectory, cover, coverRules, 'cover image'));
    }

    if (isLimit(screenshotRules.max_count) && images.screenshots.length > screenshotRules.max_count) {
        findings.push({ file: 'listing/screenshots/', message: `listing/screenshots holds ${images.screenshots.length} screenshots; a product shows at most ${screenshotRules.max_count}. Remove ${images.screenshots.length - screenshotRules.max_count} (they show in filename order).` });
    }

    for (const screenshot of images.screenshots) {
        findings.push(...imageMessages(productDirectory, screenshot, screenshotRules, 'screenshot'));
    }

    return findings;
}

/**
 * Every listing finding for a product as `listing_invalid` issues.
 *
 * @param {import('./workspace.js').Product} product
 * @param {{rules?: any, categories?: any}} documents
 * @returns {Issue[]}
 */
export function listingIssues(product, documents) {
    const rules = documents.rules ?? {};
    const fix = fixFor(rules, listingInvalidCode, listingInvalidFix);
    const issue = (/** @type {string} */ message, /** @type {string} */ file) => ({ code: listingInvalidCode, message, fix, file });
    /** @type {Issue[]} */
    const issues = [];
    /** @type {import('./listing.js').ListingFields|null} */
    let fields = null;

    try {
        fields = parseListing(existsSync(product.listingPath) ? readFileSync(product.listingPath, 'utf8') : '');
    } catch (error) {
        if (!(error instanceof ListingError)) {
            throw error;
        }

        issues.push(issue(error.message, 'listing.md'));
    }

    if (fields !== null) {
        for (const message of [...listingLimitMessages(fields, rules.listing?.limits), ...categoryMessages(fields, documents.categories)]) {
            issues.push(issue(message, 'listing.md'));
        }
    }

    for (const finding of listingImageFindings(product.directory, rules)) {
        issues.push(issue(finding.message, finding.file));
    }

    return issues;
}
