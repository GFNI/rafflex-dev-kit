import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { blockContext } from '../src/context.js';
import { comparableKeys, droppedOptionKeys } from '../src/options/check.js';
import { applyOverrides, defaultCategoriesField, defaultConventions, defaultWarnings, inferOptions } from '../src/options/infer.js';
import { defaultLimits, tickedCategorySlugs, narrowCatalogue, resolveOptions, valueLimits, valuesFromQuery } from '../src/options/values.js';
import { suggestVersion } from '../src/options/version-suggestion.js';
import { fixtureDocuments } from './helpers/project.js';

// The option fixture suite recorded from the platform: for each template,
// the fields and warnings its options inferrer reports, and the options a
// render receives with nothing set and with each set of values (coerced as
// the platform coerces a site owner's), held field for field.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/endpoints/platform-options.json', import.meta.url), 'utf8'));
const { contexts } = fixtureDocuments();
const files = { hero: recorded.allowed_image_urls[0] };

/**
 * The platform has one array type, so an empty map encodes as [].
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function asPlatformJson(value) {
    if (Array.isArray(value)) {
        return value.map(asPlatformJson);
    }

    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value);

        return entries.length === 0 ? [] : Object.fromEntries(entries.map(([key, entry]) => [key, asPlatformJson(entry)]));
    }

    return value;
}

/**
 * @param {any[]} competitions
 */
function ids(competitions) {
    return competitions.map((competition) => competition.id);
}

describe('the options inferrer matches the platform', () => {
    for (const fixture of recorded.fixtures) {
        describe(fixture.name, () => {
            const inferred = inferOptions(fixture.template, contexts);
            const fields = applyOverrides(inferred.fields, fixture.overrides);

            test('fields, field for field', () => {
                assert.equal(inferred.fields.length, fixture.fields.length, inferred.fields.map((field) => field.key).join(', '));

                for (const [index, expected] of fixture.fields.entries()) {
                    assert.deepEqual(asPlatformJson(inferred.fields[index]), asPlatformJson(expected), expected.key);
                }
            });

            test('warnings', () => {
                assert.deepEqual(inferred.warnings, fixture.warnings);
            });

            if (fixture.fields_with_overrides !== null) {
                test('fields with the overrides applied', () => {
                    assert.deepEqual(asPlatformJson(fields), asPlatformJson(fixture.fields_with_overrides));
                });
            }

            test('resolved values in every case', () => {
                for (const recordedCase of fixture.cases) {
                    const resolved = resolveOptions(fields, recordedCase.values, recorded.allowed_image_urls);

                    assert.deepEqual(asPlatformJson(resolved), asPlatformJson(recordedCase.resolved), recordedCase.name);
                    assert.deepEqual(tickedCategorySlugs(fields, recordedCase.values, contexts.shared.categories), recordedCase.category_slugs, recordedCase.name);
                }
            });

            test('a render context carries the same options and narrowed catalogue', () => {
                for (const recordedCase of fixture.cases) {
                    const context = blockContext(contexts, { files, template: fixture.template, options: recordedCase.values, overrides: fixture.overrides });

                    assert.deepEqual(asPlatformJson(context.options), asPlatformJson(recordedCase.resolved), recordedCase.name);

                    if (recordedCase.catalogue === null) {
                        assert.deepEqual(context.competitions, contexts.shared.competitions, recordedCase.name);
                        continue;
                    }

                    const narrowed = narrowCatalogue(contexts.shared, recordedCase.category_slugs);

                    assert.deepEqual(Object.fromEntries(Object.entries(context.competitions).map(([list, entries]) => [list, ids(entries)])), recordedCase.catalogue.competitions, recordedCase.name);
                    assert.deepEqual(context.categories.map((category) => ({ ...category, competitions: ids(category.competitions) })), recordedCase.catalogue.categories, recordedCase.name);
                    assert.deepEqual(ids(context.products), recordedCase.catalogue.products, recordedCase.name);
                    assert.deepEqual(narrowed.categories, context.categories);
                }
            });
        });
    }
});

describe('the options query parameter decodes as the platform decodes it', () => {
    for (const { query, values } of recorded.queries) {
        test(JSON.stringify(query), () => {
            assert.deepEqual(asPlatformJson(valuesFromQuery(query, valueLimits(contexts))), asPlatformJson(values));
        });
    }
});

describe('the version suggestion matches the platform\'s', () => {
    for (const pair of recorded.version_bumps) {
        test(pair.name, () => {
            const liveFields = applyOverrides(inferOptions(pair.live_template, contexts).fields, pair.live_overrides);
            const draftFields = applyOverrides(inferOptions(pair.draft_template, contexts).fields, pair.draft_overrides);
            const suggestion = suggestVersion({ liveVersion: pair.live_version, liveOptionKeys: pair.option_keys, fields: draftFields });
            const expected = pair.suggested_version;

            assert.deepEqual(comparableKeys(liveFields), pair.option_keys, 'the released version\'s keys, as get_product publishes them');
            assert.deepEqual(suggestion === null ? null : { version: suggestion.version, bump: suggestion.bump }, expected === null ? null : { version: expected.version, bump: expected.bump });
            assert.equal(droppedOptionKeys(draftFields, pair.option_keys).length > 0, expected?.bump === 'major');
        });
    }
});

describe('the kit\'s fallbacks are the values the platform publishes', () => {
    const published = contexts.block.options_defaults;

    test('naming conventions, in the order they are tried', () => {
        const filled = Object.fromEntries(Object.entries(defaultConventions.types).map(([type, convention]) => [type, { names: [], prefixes: [], suffixes: [], ...convention }]));

        assert.deepEqual(defaultConventions.order, published.conventions.order);
        assert.deepEqual(filled, published.conventions.types);
    });

    test('value caps, the Categories field, and the warnings', () => {
        assert.deepEqual(valueLimits(contexts), defaultLimits);
        assert.deepEqual(defaultCategoriesField, published.categories_field);
        assert.deepEqual(defaultWarnings, published.warnings);
    });
});

describe('the suite covers what the port relies on', () => {
    test('every field type, a warning of each kind, repeaters, categories, and a sweep', () => {
        const types = new Set(recorded.fixtures.flatMap((fixture) => fixture.fields.flatMap((field) => [field.type, ...field.fields.map((child) => child.type)])));
        const warnings = recorded.fixtures.flatMap((fixture) => fixture.warnings);

        assert.deepEqual([...types].sort(), ['categories', 'colour', 'image', 'number', 'repeater', 'text', 'textarea', 'toggle', 'url']);
        assert.ok(warnings.some((warning) => warning.startsWith('options.categories ')));
        assert.ok(warnings.some((warning) => warning.includes('different defaults')));
        assert.ok(recorded.fixtures.some((fixture) => fixture.cases.length > 50), 'the coercion sweep');
        assert.ok(recorded.fixtures.some((fixture) => fixture.cases.some((recordedCase) => recordedCase.catalogue !== null)), 'a narrowed catalogue');
        assert.ok(recorded.fixtures.some((fixture) => fixture.fields.length === 0 && fixture.template.includes('options.')), 'a template that does not tokenize');
        assert.deepEqual(new Set(recorded.version_bumps.map((/** @type {any} */ pair) => pair.suggested_version?.bump ?? null)), new Set(['major', 'minor', 'patch', null]), 'every bump');
        assert.ok(recorded.version_bumps.some((/** @type {any} */ pair) => pair.option_keys.some((/** @type {string} */ key) => key.includes('.'))), 'repeater item keys');
        assert.ok(recorded.version_bumps.some((/** @type {any} */ pair) => pair.option_keys.includes('categories')), 'the Categories filter');
    });
});
