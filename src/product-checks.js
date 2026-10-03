import { listingIssues } from './listing-checks.js';
import { mediaIssues } from './media-checks.js';
import { readLocalState } from './sync-state.js';

/**
 * The checks on a product's files beyond its template (PRD 45): the
 * listing (`listing_invalid`) and the media a push would upload
 * (`asset_filename`, `asset_duplicate`, `asset_capacity`,
 * `asset_content_mismatch`). Each is blocking, and each skips what the
 * marketplace's rules do not publish.
 *
 * An unreadable options.json or a missing template is reported by the
 * template check, so this never throws for them.
 *
 * @param {import('./workspace.js').Product} product
 * @param {{rules?: any, libraries?: any, categories?: any}} documents
 * @returns {import('./checker.js').Issue[]}
 */
export function productFileIssues(product, documents) {
    const local = readLocalState(product, documents);

    return [...listingIssues(product, documents), ...mediaIssues(product, documents, local)];
}
