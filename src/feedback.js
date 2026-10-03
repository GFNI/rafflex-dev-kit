/**
 * What the marketplace tells a workspace about a product (PRD 45): the
 * latest staff review with its notes and the submission checks the draft
 * still fails, how many bug reports are open and questions unanswered, and
 * the headline numbers. A sync link carries it; product.json records it in
 * the remote state as `feedback`.
 *
 * Counts only: what buyers write stays behind the marketplace's
 * list_bug_reports and list_questions tools, which mark it as untrusted.
 * Review notes are written by the marketplace's staff.
 */

/**
 * @typedef {{version: string|null, decision: string, notes: string|null, decided_at: string|null, failing_checks: string[]}} FeedbackReview
 * @typedef {{installs: number|null, sales: number|null, rating: number|null, ratings_count: number|null}} FeedbackStatistics
 * @typedef {{review: FeedbackReview|null, open_bug_reports: number|null, unanswered_questions: number|null, statistics: FeedbackStatistics|null}} Feedback
 */

/** The decisions that send a version back to the creator. */
export const sentBackDecisions = Object.freeze(['changes_requested', 'rejected']);

/**
 * @param {unknown} value
 */
function count(value) {
    return Number.isInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function text(value) {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * @param {unknown} value
 * @returns {FeedbackReview|null}
 */
function normaliseReview(value) {
    const review = /** @type {any} */ (value);

    if (review === null || typeof review !== 'object' || typeof review.decision !== 'string' || review.decision === '') {
        return null;
    }

    return {
        version: text(review.version),
        decision: review.decision,
        notes: text(review.notes),
        decided_at: text(review.decided_at),
        failing_checks: Array.isArray(review.failing_checks) ? review.failing_checks.filter((check) => typeof check === 'string' && check !== '') : [],
    };
}

/**
 * The sync link's feedback in the shape product.json records, every field
 * optional (an older marketplace sends less), or null when there is none.
 *
 * @param {unknown} value
 * @returns {Feedback|null}
 */
export function normaliseFeedback(value) {
    const feedback = /** @type {any} */ (value);

    if (feedback === null || typeof feedback !== 'object' || Array.isArray(feedback)) {
        return null;
    }

    const statistics = feedback.statistics !== null && typeof feedback.statistics === 'object' ? feedback.statistics : null;

    return {
        review: normaliseReview(feedback.review),
        open_bug_reports: count(feedback.open_bug_reports),
        unanswered_questions: count(feedback.unanswered_questions),
        statistics: statistics === null ? null : {
            installs: count(statistics.installs),
            sales: count(statistics.sales),
            rating: Number.isFinite(statistics.rating) ? Number(statistics.rating) : null,
            ratings_count: count(statistics.ratings_count),
        },
    };
}

/**
 * The feedback to show for a product: the recorded feedback, with the
 * review taken from the product's latest review whenever the last sync
 * recorded one (a get_product result piped to synced carries the review
 * but no counts). The failing checks stay only when they belong to that
 * same review. Null when nothing was ever recorded.
 *
 * @param {import('./workspace.js').ProductRemote|null|undefined} remote
 * @returns {Feedback|null}
 */
export function productFeedback(remote) {
    if (remote === null || remote === undefined) {
        return null;
    }

    const recorded = normaliseFeedback(/** @type {any} */ (remote).feedback);
    const latest = normaliseReview(remote.latest_review);
    let review = recorded?.review ?? null;

    if (latest !== null) {
        const same = review !== null && review.version === latest.version && review.decision === latest.decision;

        review = { ...latest, failing_checks: same && review !== null ? review.failing_checks : [] };
    }

    if (recorded === null && review === null) {
        return null;
    }

    return {
        review,
        open_bug_reports: recorded?.open_bug_reports ?? null,
        unanswered_questions: recorded?.unanswered_questions ?? null,
        statistics: recorded?.statistics ?? null,
    };
}

/**
 * The review a creator still has to act on: the latest decision when it
 * sent the version back and nothing has been submitted since.
 *
 * @param {Feedback|null} feedback
 * @param {boolean} inReview
 * @returns {FeedbackReview|null}
 */
export function reviewToAct(feedback, inReview) {
    const review = feedback?.review ?? null;

    if (inReview || review === null || !sentBackDecisions.includes(review.decision)) {
        return null;
    }

    return review;
}

/**
 * @param {number} value
 * @param {string} singular
 * @param {string} plural
 */
export function counted(value, singular, plural) {
    return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * One quiet line of headline numbers, or null when none are known.
 *
 * @param {FeedbackStatistics|null} statistics
 * @returns {string|null}
 */
export function statisticsLine(statistics) {
    if (statistics === null) {
        return null;
    }

    const parts = [
        statistics.installs === null ? null : counted(statistics.installs, 'install', 'installs'),
        statistics.sales === null ? null : counted(statistics.sales, 'sale', 'sales'),
        statistics.rating === null
            ? (statistics.ratings_count === 0 ? 'no ratings yet' : null)
            : `rated ${statistics.rating.toFixed(1)}${statistics.ratings_count === null ? '' : ` (${counted(statistics.ratings_count, 'rating', 'ratings')})`}`,
    ].filter((part) => part !== null);

    return parts.length === 0 ? null : parts.join(', ');
}

/**
 * The feedback for status' prose: the review decision with its notes and
 * failing checks, then the counts.
 *
 * @param {Feedback|null} feedback
 * @param {string} [indent]
 * @returns {string[]}
 */
export function feedbackLines(feedback, indent = '  ') {
    if (feedback === null) {
        return [];
    }

    /** @type {string[]} */
    const lines = [];
    const { review } = feedback;

    if (review !== null && review.decision !== 'approved') {
        lines.push(`${indent}review: ${review.decision.replaceAll('_', ' ')}${review.version === null ? '' : ` on ${review.version}`}${review.notes === null ? '' : `. Notes: ${review.notes.replace(/\s*\n\s*/g, ' ')}`}`);

        if (review.failing_checks.length > 0) {
            lines.push(`${indent}still failing: ${review.failing_checks.join('; ')}`);
        }
    }

    const counts = [
        feedback.open_bug_reports === null || feedback.open_bug_reports === 0 ? null : `${counted(feedback.open_bug_reports, 'open bug report', 'open bug reports')} (read them with list_bug_reports)`,
        feedback.unanswered_questions === null || feedback.unanswered_questions === 0 ? null : `${counted(feedback.unanswered_questions, 'unanswered question', 'unanswered questions')} (read them with list_questions)`,
    ].filter((part) => part !== null);

    if (counts.length > 0) {
        lines.push(`${indent}buyers: ${counts.join(', ')}`);
    }

    const numbers = statisticsLine(feedback.statistics);

    if (numbers !== null) {
        lines.push(`${indent}numbers: ${numbers}`);
    }

    return lines;
}
