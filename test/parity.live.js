import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareOutputs, renderFixture } from './helpers/parity.js';

// The shared fixture suite against a live marketplace: every template the
// platform renders in /dev-kit/fixtures.json must render identically
// through twig.js. Run with RAFFLEX_BASE_URL set, for example
// RAFFLEX_BASE_URL=https://marketplace.rafflex.io npm run test:parity
const baseUrl = process.env.RAFFLEX_BASE_URL?.replace(/\/+$/, '');

/**
 * @param {string} name
 */
async function fetchDocument(name) {
    const response = await fetch(`${baseUrl}/dev-kit/${name}.json`, { headers: { Accept: 'application/json' } });

    assert.equal(response.status, 200, `${name}.json answered ${response.status}`);

    return response.json();
}

describe('fixture parity with the live marketplace', { skip: baseUrl ? false : 'RAFFLEX_BASE_URL is not set' }, async () => {
    if (!baseUrl) {
        return;
    }

    const [rules, contexts, fixtures] = await Promise.all([fetchDocument('rules'), fetchDocument('contexts'), fetchDocument('fixtures')]);

    test('the suite is not empty', () => {
        assert.ok(fixtures.fixtures.length > 0);
    });

    for (const fixture of fixtures.fixtures) {
        test(fixture.name, (context) => {
            const comparison = compareOutputs(renderFixture(fixture, contexts, rules.sandbox), fixture.expected_html);

            if (comparison.whitespaceOnly) {
                context.diagnostic(`${fixture.name}: ${comparison.report}`);
            }

            assert.ok(comparison.equal, `${fixture.name}: ${comparison.report}`);
        });
    }
});
