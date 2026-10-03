import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../src/dev-server.js';
import { feedbackLines, normaliseFeedback, productFeedback, statisticsLine } from '../src/feedback.js';
import { optionOverridesHash, templateHash } from '../src/sync-state.js';
import { loadWorkspace } from '../src/workspace.js';
import { fixtureDocuments, fixturePrompts, stubPrompts, temporaryWorkspace } from './helpers/project.js';

const documents = { ...fixtureDocuments(), categories: JSON.parse(readFileSync(new URL('./fixtures/endpoints/categories.json', import.meta.url), 'utf8')) };
const loaded = { documents, warnings: [], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' };
const html = readFileSync(new URL('../src/client/app.html', import.meta.url), 'utf8');
const template = '<p>{{ play_count }}</p>\n';

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
function getJson(url) {
    return new Promise((resolve, reject) => {
        request(url, (response) => {
            let text = '';

            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                text += chunk;
            });
            response.on('end', () => resolve(JSON.parse(text)));
        }).on('error', reject).end();
    });
}

/**
 * A remote state recorded by a sync, matching the product's files.
 *
 * @param {Record<string, any>} [overrides]
 */
function remote(overrides = {}) {
    return {
        synced_at: new Date().toISOString(),
        status: 'published',
        live_version: '1.0.0',
        live_channel: 'stable',
        draft: { version: '1.1.0', revision: 3, submitted: false, template_sha256: templateHash(template), option_overrides_sha256: optionOverridesHash({}) },
        listing_sha256: null,
        latest_review: null,
        media: [],
        ...overrides,
    };
}

const changesRequested = {
    review: { version: '1.1.0', decision: 'changes_requested', notes: 'Add an empty state.\n<img src=x onerror=alert(1)>', decided_at: '2026-10-02T10:00:00+00:00', failing_checks: ['A screenshot'] },
    open_bug_reports: 2,
    unanswered_questions: 1,
    statistics: { installs: 12, sales: 3, rating: 4.5, ratings_count: 4 },
};

describe('feedback in the app', () => {
    /** @type {Awaited<ReturnType<typeof startDevServer>>} */
    let server;
    /** @type {Awaited<ReturnType<typeof startDevServer>>} */
    let bare;

    before(async () => {
        const root = temporaryWorkspace({
            products: [
                { title: 'Sent Back', slug: 'sent-back', version: '1.1.0', template, remote: remote({ latest_review: { version: '1.1.0', decision: 'changes_requested', notes: changesRequested.review.notes, decided_at: changesRequested.review.decided_at }, feedback: changesRequested }) },
                { title: 'Taken Down', slug: 'taken-down', version: '1.1.0', template, remote: remote({ status: 'removed', feedback: changesRequested }) },
                { title: 'Quiet', slug: 'quiet', version: '1.1.0', template, remote: remote({ feedback: { review: null, open_bug_reports: 0, unanswered_questions: 0, statistics: { installs: 1, sales: 0, rating: null, ratings_count: 0 } } }) },
            ],
        });
        const prompts = fixturePrompts();
        const withoutKeys = { ...prompts, prompts: Object.fromEntries(Object.entries(prompts.prompts).filter(([key]) => !['fix_review', 'bug_reports', 'questions'].includes(key))) };

        server = await startDevServer({ workspace: loadWorkspace(root), loaded, port: 0, watchFiles: false, prompts: stubPrompts(), detect: () => [] });
        bare = await startDevServer({ workspace: loadWorkspace(root), loaded, port: 0, watchFiles: false, prompts: stubPrompts(withoutKeys), detect: () => [] });
    });

    after(async () => {
        await server.close();
        await bare.close();
    });

    test('a product sent back shows the decision, the notes, what is still missing, and the fix_review prompt', async () => {
        const product = await getJson(`${server.url}p/games/sent-back/__rafflex/product`);

        assert.equal(product.state.label, 'Changes requested');
        assert.equal(product.review.label, 'Changes requested');
        assert.equal(product.review.version, '1.1.0');
        assert.equal(product.review.notes, changesRequested.review.notes);
        assert.deepEqual(product.review.failing_checks, ['A screenshot']);
        assert.equal(product.review.prompt.key, 'fix_review');
        assert.match(product.review.prompt.text, /request_sync` for sent-back/);
        assert.deepEqual(product.feedback, changesRequested);
    });

    test('open bug reports and questions are badges with prompts that call the tools, and a live product has one numbers line', async () => {
        const product = await getJson(`${server.url}p/games/sent-back/__rafflex/product`);

        assert.deepEqual(product.feedback_badges.map((/** @type {any} */ badge) => [badge.key, badge.label]), [['bug_reports', '2 open bug reports'], ['questions', '1 unanswered question']]);
        assert.match(product.feedback_badges[0].prompt.text, /list_bug_reports` for sent-back/);
        assert.match(product.feedback_badges[1].prompt.text, /list_questions` for sent-back/);
        assert.equal(product.statistics, '12 installs, 3 sales, rated 4.5 (4 ratings)');

        const index = await getJson(`${server.url}__rafflex/products`);
        const listed = index.products.find((/** @type {any} */ entry) => entry.path === 'games/sent-back');
        const quiet = index.products.find((/** @type {any} */ entry) => entry.path === 'games/quiet');

        assert.deepEqual(listed.feedback_badges.map((/** @type {any} */ badge) => badge.label), ['2 open bug reports', '1 unanswered question']);
        assert.deepEqual(quiet.feedback_badges, []);
        assert.equal(quiet.review, null);
        assert.equal(quiet.statistics, '1 install, 0 sales, no ratings yet');
    });

    test('a product staff removed shows Removed, not Live, and no review panel', async () => {
        const product = await getJson(`${server.url}p/games/taken-down/__rafflex/product`);

        assert.equal(product.state.key, 'removed');
        assert.equal(product.state.label, 'Removed');
        assert.equal(product.publish.state.label, 'Removed');
        assert.equal(product.publish.prompt, null);
        assert.match(product.publish.next, /support@rafflex\.io/);
        assert.equal(product.review, null);

        const index = await getJson(`${server.url}__rafflex/products`);

        assert.equal(index.products.find((/** @type {any} */ entry) => entry.path === 'games/taken-down').state.label, 'Removed');
    });

    test('a prompt key missing from the marketplace\'s prompts hides that action quietly', async () => {
        const product = await getJson(`${bare.url}p/games/sent-back/__rafflex/product`);

        assert.equal(product.review.notes, changesRequested.review.notes);
        assert.equal(product.review.prompt, null);
        assert.deepEqual(product.feedback_badges.map((/** @type {any} */ badge) => badge.prompt), [null, null]);
    });

    test('the page renders the review as text above the tabs, with one primary action', () => {
        const productView = html.slice(html.indexOf('<!-- Product -->'), html.indexOf('<!-- New product -->'));
        const review = productView.slice(productView.indexOf('<!-- Review -->'), productView.indexOf('class="tabs"'));

        assert.ok(productView.indexOf('<!-- Review -->') > 0);
        assert.ok(productView.indexOf('<!-- Review -->') < productView.indexOf('class="tabs"'));
        assert.match(review, /x-if="product\.review"/);
        assert.match(review, /x-text="product\.review\.notes/);
        assert.match(review, /x-if="product\.review\.prompt"/);
        assert.doesNotMatch(html, /x-html/);
        assert.doesNotMatch(review, /button primary/);
        assert.match(productView, /x-for="badge in product\.feedback_badges/);
        assert.match(productView, /x-text="product\.statistics/);
        assert.match(productView, /x-for="badge in \(product\.feedback_badges \?\? \[\]\)\.filter\(\(entry\) => entry\.prompt\)"/);

        const listView = html.slice(html.indexOf('<!-- Products -->'), html.indexOf('<!-- Product -->'));

        assert.match(listView, /x-for="badge in product\.feedback_badges/);
    });
});

describe('feedback', () => {
    test('normalises what a marketplace sends, every field optional', () => {
        assert.equal(normaliseFeedback(null), null);
        assert.deepEqual(normaliseFeedback({}), { review: null, open_bug_reports: null, unanswered_questions: null, statistics: null });
        assert.deepEqual(normaliseFeedback({ review: { decision: 'approved', version: '1.0.0' }, open_bug_reports: -1, statistics: { installs: 3, rating: 'high' } }), {
            review: { version: '1.0.0', decision: 'approved', notes: null, decided_at: null, failing_checks: [] },
            open_bug_reports: null,
            unanswered_questions: null,
            statistics: { installs: 3, sales: null, rating: null, ratings_count: null },
        });
    });

    test('takes the review from the latest review a later sync recorded, keeping counts', () => {
        const recorded = /** @type {any} */ ({ latest_review: { version: '1.2.0', decision: 'approved', notes: null }, feedback: changesRequested });

        assert.deepEqual(productFeedback(recorded)?.review, { version: '1.2.0', decision: 'approved', notes: null, decided_at: null, failing_checks: [] });
        assert.equal(productFeedback(recorded)?.open_bug_reports, 2);
        assert.equal(productFeedback(/** @type {any} */ ({ latest_review: null })), null);
        assert.equal(productFeedback(null), null);
    });

    test('prints one quiet numbers line and the review for status', () => {
        assert.equal(statisticsLine({ installs: 1, sales: 1, rating: 5, ratings_count: 1 }), '1 install, 1 sale, rated 5.0 (1 rating)');
        assert.equal(statisticsLine(null), null);
        assert.deepEqual(feedbackLines({ review: { version: '1.0.0', decision: 'approved', notes: null, decided_at: null, failing_checks: [] }, open_bug_reports: 0, unanswered_questions: 0, statistics: null }), []);
        assert.equal(feedbackLines(changesRequested)[0], '  review: changes requested on 1.1.0. Notes: Add an empty state. <img src=x onerror=alert(1)>');
    });
});
