import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { compareOutputs, renderFixture } from './helpers/parity.js';
import { fixtureDocuments } from './helpers/project.js';

// The same templates rendered by the platform's TwigRenderer (recorded in
// test/fixtures by scripts/generate-test-fixtures.php) and by the kit.
// `npm run test:parity` runs the marketplace's live suite.
const { rules, contexts, fixtures } = fixtureDocuments();
const kitFixtures = JSON.parse(readFileSync(new URL('./fixtures/kit-fixtures.json', import.meta.url), 'utf8')).fixtures;

for (const [suite, cases] of [['marketplace fixtures', fixtures.fixtures], ['kit fixtures', kitFixtures]]) {
    describe(`twig.js matches the platform renderer: ${suite}`, () => {
        for (const fixture of cases) {
            test(fixture.name, () => {
                const comparison = compareOutputs(renderFixture(fixture, contexts, rules.sandbox), fixture.expected_html);

                assert.ok(comparison.equal, comparison.report);
            });
        }
    });
}
