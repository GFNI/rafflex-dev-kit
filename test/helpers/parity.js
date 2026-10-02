import { rawFixtureContext } from '../../src/context.js';
import { renderTemplate } from '../../src/twig-engine.js';

/**
 * Render a fixture with twig.js through the kit's engine, using the
 * context the platform rendered it with.
 *
 * @param {any} fixture
 * @param {any} contexts
 * @param {any} sandbox
 */
export function renderFixture(fixture, contexts, sandbox) {
    try {
        return renderTemplate(fixture.template, rawFixtureContext(contexts, fixture), sandbox);
    } catch (error) {
        return `RENDER ERROR: ${error.message}`;
    }
}

/**
 * Compare the kit's output with the platform's. Only a difference in
 * trailing newlines at the end of the document counts as insignificant.
 *
 * @param {string} actual
 * @param {string} expected
 * @returns {{equal: boolean, whitespaceOnly: boolean, report: string}}
 */
export function compareOutputs(actual, expected) {
    if (actual === expected) {
        return { equal: true, whitespaceOnly: false, report: '' };
    }

    if (actual.replace(/\n+$/, '') === expected.replace(/\n+$/, '')) {
        return { equal: true, whitespaceOnly: true, report: 'differs only in trailing newlines' };
    }

    let index = 0;

    while (index < actual.length && actual[index] === expected[index]) {
        index++;
    }

    const line = expected.slice(0, index).split('\n').length;
    const window = (/** @type {string} */ text) => JSON.stringify(text.slice(Math.max(0, index - 60), index + 80));

    return {
        equal: false,
        whitespaceOnly: false,
        report: `first difference at character ${index} (output line ${line})\n  twig.js:  ${window(actual)}\n  platform: ${window(expected)}`,
    };
}
