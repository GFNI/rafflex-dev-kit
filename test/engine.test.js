import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { phpJsonEncode } from '../src/php-json.js';
import { compileTemplate, phpNumberToString, renderTemplate, TemplateRenderError } from '../src/twig-engine.js';
import { lintTemplate } from '../src/twig-lint.js';
import { fixtureDocuments } from './helpers/project.js';

const { rules } = fixtureDocuments();
const sandbox = rules.sandbox;

/**
 * @param {string} template
 */
function lint(template) {
    return lintTemplate(compileTemplate(template).tokens, template, sandbox);
}

describe('whitelist lint', () => {
    test('passes templates that stay inside the whitelist', () => {
        assert.deepEqual(lint('{% set x = plays|length %}{% for p in plays %}{% if p.won %}{{ p.prize.name|upper }}{% elseif x %}{% else %}{% endif %}{% else %}none{% endfor %}{% set y %}a{% endset %}{{ x is defined and plays is empty ? files|json : "" }}'), []);
    });

    test('catches a disallowed tag with its line', () => {
        assert.deepEqual(lint('<p>\n{% include "x" %}'), [{ kind: 'tag', name: 'include', line: 2, message: 'Tag "include" is not allowed' }]);
    });

    test('catches a disallowed filter, including inside nested blocks and arguments', () => {
        const violations = lint('{% for p in plays %}\n{% if p.won %}\n{{ p.prize.name|raw }}\n{% endif %}{% endfor %}\n{{ plays|slice(0, plays|reverse|length) }}');

        assert.deepEqual(violations.map((violation) => [violation.kind, violation.name, violation.line]), [['filter', 'raw', 3], ['filter', 'reverse', 5]]);
    });

    test('catches a function', () => {
        assert.deepEqual(lint('{{ dump(plays) }}').map((violation) => violation.message), ['Function "dump" is not allowed']);
    });

    test('catches a test the rules do not list', () => {
        const restricted = { ...sandbox, tests: ['defined'] };
        const template = '{{ plays is empty }}';

        assert.deepEqual(lintTemplate(compileTemplate(template).tokens, template, restricted).map((violation) => violation.name), ['empty']);
        assert.deepEqual(lint('{{ 4 is divisible by(2) }}{{ 1 is same as(1) }}'), []);
    });

    test('a render refuses with the platform style message and line', () => {
        assert.throws(() => renderTemplate('a\n{{ plays|raw }}', { plays: [] }, sandbox), (error) => {
            assert.ok(error instanceof TemplateRenderError);
            assert.equal(error.message, 'Filter "raw" is not allowed in "template.twig" at line 2.');
            assert.equal(error.line, 2);
            assert.equal(error.sandbox, true);

            return true;
        });
    });
});

describe('platform pre render checks and caps', () => {
    test('the range operator and range() are refused', () => {
        assert.throws(() => renderTemplate('{% for i in 1..5 %}{% endfor %}', {}, sandbox), /Range operator \(\.\.\) is not allowed in templates/);
        assert.throws(() => renderTemplate('{{ range(1, 3)|length }}', {}, sandbox), /The range\(\) function is not allowed/);
    });

    test('more for loops than the cap are refused', () => {
        const template = '{% for a in plays %}{% endfor %}'.repeat(sandbox.max_for_loops + 1);

        assert.throws(() => renderTemplate(template, { plays: [] }, sandbox), new RegExp(`Too many nested for loops \\(maximum: ${sandbox.max_for_loops}, found: ${sandbox.max_for_loops + 1}\\)`));
    });

    test('collections are capped per collection', () => {
        const items = Array.from({ length: sandbox.max_iterations + 5 }, (value, index) => index);

        assert.equal(renderTemplate('{{ items|length }}', { items }, sandbox), String(sandbox.max_iterations));
    });

    test('the total iteration budget stops runaway loops', () => {
        const items = Array.from({ length: 1000 }, (value, index) => index);
        const template = '{% for a in items %}{% for b in items %}{% endfor %}{% endfor %}';

        assert.throws(() => renderTemplate(template, { items }, sandbox), /Template rendering exceeded the iteration budget \(maximum: 25000\)/);
    });
});

describe('PHP Twig behaviour', () => {
    test('default keeps false but replaces empty values', () => {
        const template = '{{ t|default("d") ? "y" : "n" }}{{ f|default(true) ? "y" : "n" }}{{ e|default("d") }}{{ a|default("d") }}{{ m|default("d") }}';

        assert.equal(renderTemplate(template, { t: true, f: false, e: '', a: [] }, sandbox), 'ynddd');
    });

    test('scalars print as PHP prints them', () => {
        assert.equal(renderTemplate('[{{ true }}][{{ false }}][{{ null }}][{{ 0.1 + 0.2 }}][{{ 2.5 }}]', {}, sandbox), '[1][][][0.3][2.5]');
        assert.equal(phpNumberToString(1e25), '1.0E+25');
        assert.equal(phpNumberToString(0.00001), '1.0E-5');
    });

    test('string literals unescape like PHP Twig and print unescaped', () => {
        assert.equal(renderTemplate('{{ "a \\"q\\" \\\\ <b>" }}', {}, sandbox), 'a "q" \\ <b>');
    });

    test('variables are autoescaped for HTML', () => {
        assert.equal(renderTemplate('{{ v }}', { v: '<b>"&\'' }, sandbox), '&lt;b&gt;&quot;&amp;&#039;');
    });

    test('a missing key is undefined, not null', () => {
        assert.equal(renderTemplate("{{ files['x'] is defined ? 'y' : 'n' }}{{ files['x'] is null ? 'y' : 'n' }}", { files: { a: 'b' } }, sandbox), 'ny');
    });

    test('the newline after a comment is dropped', () => {
        assert.equal(renderTemplate('{{ 1 }}{# c #}\nx', {}, sandbox), '1x');
    });

    test('trim takes characters and a side', () => {
        assert.equal(renderTemplate("[{{ '  left  '|trim(' ', 'left') }}][{{ '--x--'|trim('-') }}]", {}, sandbox), '[left  ][x]');
    });

    test('number_format rounds half away from zero', () => {
        assert.equal(renderTemplate('{{ 1.005|number_format(2) }} {{ -2.5|number_format }} {{ 1234567.891|number_format(2, ",", ".") }}', {}, sandbox), '1.01 -3 1.234.567,89');
    });
});

describe('json filter', () => {
    // Expected strings are PHP json_encode output with JSON_HEX_TAG |
    // JSON_HEX_APOS | JSON_HEX_AMP | JSON_HEX_QUOT, as the platform's filter.
    test('escapes slashes, HTML significant characters, and non ASCII', () => {
        assert.equal(phpJsonEncode('Tom\'s <b>"q"</b> & café £5 / 😀 \\'), '"Tom\\u0027s \\u003Cb\\u003E\\u0022q\\u0022\\u003C\\/b\\u003E \\u0026 caf\\u00e9 \\u00a35 \\/ \\ud83d\\ude00 \\\\"');
    });

    test('encodes control characters as PHP does', () => {
        assert.equal(phpJsonEncode('a\nb\tc\u0001'), '"a\\nb\\tc\\u0001"');
    });

    test('encodes numbers, booleans, and null', () => {
        assert.equal(phpJsonEncode([1, 2.5, -3, 0, 1000000, true, false, null]), '[1,2.5,-3,0,1000000,true,false,null]');
        assert.equal(phpJsonEncode(1e25), '1.0e+25');
    });

    test('empty maps and lists encode as []', () => {
        assert.equal(phpJsonEncode({}), '[]');
        assert.equal(phpJsonEncode([]), '[]');
        assert.equal(phpJsonEncode({ 0: 'a', 1: 'b' }), '["a","b"]');
    });

    test('maps keep their key order', () => {
        assert.equal(phpJsonEncode({ a: 1, 'b-c': 'x/y' }), '{"a":1,"b-c":"x\\/y"}');
        assert.equal(renderTemplate('{{ {b: 1, a: 2}|json }}', {}, sandbox), '{"b":1,"a":2}');
    });

    test('the filter output is not escaped again', () => {
        assert.equal(renderTemplate('{{ v|json }}', { v: '<' }, sandbox), '"\\u003C"');
    });
});
