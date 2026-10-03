import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { platformRound, renderTemplate } from '../src/twig-engine.js';
import { fixtureDocuments } from './helpers/project.js';

// Every expected value below was rendered by the platform.
const { rules } = fixtureDocuments();
const sandbox = rules.sandbox;

/**
 * @param {string} template
 * @param {Record<string, unknown>} [context]
 */
function render(template, context = {}) {
    return renderTemplate(template, context, sandbox);
}

describe('rounding as the platform rounds', () => {
    test('number_format and round give the platform output for every case in rounding.twig', () => {
        const template = readFileSync(new URL('./fixtures/parity/rounding.twig', import.meta.url), 'utf8');

        assert.equal(render(template), [
            '<p>1.67 1.72 3.97 7.32 7.52 14.02 14.42 15.27 15.67 </p>',
            '<p>0.16 0.22 0.4 0.46 0.55 0.67 0.79 0.91 1.21 1.24 1.45 1.48 </p>',
            '<p>1.01 1.01 0.29 -1.01 3 -3 1230 1300 1.4 1.5</p>',
            '<p>61,182,827,949,523.93 2,178,974,151,611.32812 38090991973.877 1,200</p>',
            '',
        ].join('\n'));
    });

    test('platformRound compares with the edge itself, past the representation error', () => {
        assert.equal(platformRound(2.01 / 1.2, 2), 1.67);
        assert.equal(platformRound(11 * 0.015, 2), 0.16);
        assert.equal(platformRound(-49496746063.23242, 5), -49496746063.23243);
        assert.equal(platformRound(0.285, 2), 0.29);
        assert.ok(Object.is(platformRound(-0.004, 2), -0));
        assert.equal(platformRound(1e17 + 0.5, 2), 1e17 + 0.5);
    });
});

describe('the date filter as the platform reads it', () => {
    const format = 'Y-m-d H:i:s e T P O p I Z U';

    test('false is now and true is the timestamp 1, so a toggle piped to date renders', () => {
        assert.equal(render("{{ false|date('Y') }}"), String(new Date().getUTCFullYear()));
        assert.equal(render("{{ options.t|date('Y') }}", { options: { t: false } }), String(new Date().getUTCFullYear()));
        assert.equal(render("{{ true|date('Y-m-d H:i:s') }}"), '1970-01-01 00:00:01');
    });

    test('negative timestamps in text, and floats read as the text they print as', () => {
        assert.equal(render("{{ '-86400'|date('Y-m-d H:i') }}"), '1969-12-31 00:00');
        assert.equal(render("{{ (1790000000.5)|date('Y-m-d H:i') }}"), '1789-11-30 00:05');
        assert.equal(render("{{ (1790000000 / 2)|date('Y-m-d H:i') }}"), '1998-05-12 19:06');
        assert.throws(() => render("{{ (12345.678)|date('Y-m-d') }}"), /Error: Failed to parse time string \(12345\.678\)/);
    });

    test('the time zone argument converts the time and names the zone', () => {
        assert.equal(render("{{ '2026-10-05 23:30'|date('Y-m-d H:i', 'Europe/London') }}"), '2026-10-06 00:30');
        assert.equal(render(`{{ '2026-10-05 23:30'|date('${format}', 'Europe/London') }}`), '2026-10-06 00:30:00 Europe/London BST +01:00 +0100 +01:00 1 3600 1791243000');
        assert.equal(render(`{{ '2026-01-05 23:30'|date('${format}', 'Europe/London') }}`), '2026-01-05 23:30:00 Europe/London GMT +00:00 +0000 +00:00 0 0 1767655800');
        assert.equal(render(`{{ '2026-10-05 23:30'|date('${format}', 'America/New_York') }}`), '2026-10-05 19:30:00 America/New_York EDT -04:00 -0400 -04:00 1 -14400 1791243000');
        assert.equal(render(`{{ '2026-10-05 23:30'|date('${format}', 'Pacific/Chatham') }}`), '2026-10-06 13:15:00 Pacific/Chatham +1345 +13:45 +1345 +13:45 1 49500 1791243000');
        assert.equal(render(`{{ '2026-10-05 23:30'|date('${format}', '+02:00') }}`), '2026-10-06 01:30:00 +02:00 GMT+0200 +02:00 +0200 +02:00 0 7200 1791243000');
        assert.equal(render(`{{ '2026-10-05 23:30'|date('${format}', 'BST') }}`), '2026-10-06 00:30:00 BST BST +01:00 +0100 +01:00 1 3600 1791243000');
        assert.equal(render(`{{ '2026-10-05 23:30'|date('${format}', options.zone) }}`, { options: { zone: 'europe/london' } }), '2026-10-06 00:30:00 europe/london BST +01:00 +0100 +01:00 1 3600 1791243000');
        assert.equal(render("{{ '2026-10-05 23:30'|date('c r', 'Europe/London') }}"), '2026-10-06T00:30:00+01:00 Tue, 06 Oct 2026 00:30:00 +0100');
    });

    test('false keeps the date in its own zone, and an unknown zone fails as it does there', () => {
        assert.equal(render(`{{ 1790000000|date('${format}', false) }}`), '2026-09-21 14:13:20 +00:00 GMT+0000 +00:00 +0000 Z 0 0 1790000000');
        assert.equal(render(`{{ '2026-10-05 23:30'|date('${format}', false) }}`), '2026-10-05 23:30:00 UTC UTC +00:00 +0000 Z 0 0 1791243000');
        assert.throws(() => render("{{ '2026-10-05 23:30'|date('Y', 'Mars/Base') }}"), /Unknown or bad timezone \(Mars\/Base\)/);
        assert.throws(() => render("{{ '2026-10-05 23:30'|date('Y', '') }}"), /Unknown or bad timezone \(\)/);
    });
});

describe('comparisons as the platform compares', () => {
    const table = JSON.parse(readFileSync(new URL('./fixtures/comparisons.json', import.meta.url), 'utf8'));

    test('every pair of null, booleans, numbers, and text gives the platform result for each operator', () => {
        const pairs = table.values.flatMap((/** @type {unknown} */ left) => table.values.map((/** @type {unknown} */ right) => ({ a: left, b: right })));
        const template = "{% for p in options.pairs %}{{ (p.a == p.b) ? 'T' : 'F' }}{{ (p.a != p.b) ? 'T' : 'F' }}{{ (p.a < p.b) ? 'T' : 'F' }}{{ (p.a > p.b) ? 'T' : 'F' }}{{ (p.a <= p.b) ? 'T' : 'F' }}{{ (p.a >= p.b) ? 'T' : 'F' }}{{ (p.a in [p.b]) ? 'T' : 'F' }} {% endfor %}";
        /** @type {string[]} */
        const actual = [];

        for (let start = 0; start < pairs.length; start += 300) {
            actual.push(...render(template, { options: { pairs: pairs.slice(start, start + 300) } }).trim().split(' '));
        }

        table.values.forEach((/** @type {unknown} */ left, /** @type {number} */ row) => {
            assert.equal(actual.slice(row * table.values.length, (row + 1) * table.values.length).join(' '), table.results[row], `left value ${JSON.stringify(left)}`);
        });
    });

    test('an unset option is 0, below 1, and empty, so if takes the branch the live site takes', () => {
        const template = "{{ (options.missing == 0) ? 'T' : 'F' }}{{ (options.missing < 1) ? 'T' : 'F' }}{{ (options.missing == '') ? 'T' : 'F' }}{{ (null == 0) ? 'T' : 'F' }}{{ (0 == '') ? 'T' : 'F' }}{{ (0 in [null]) ? 'T' : 'F' }}{{ ('a' in 'abc') ? 'T' : 'F' }}";

        assert.equal(render(template, { options: {} }), 'TTTTFTT');
        assert.equal(render('{% if options.count > 0 %}some{% else %}none{% endif %}', { options: {} }), 'none');
    });
});

describe('arithmetic the platform refuses', () => {
    test('text with a number and more after it fails, as the platform fails on it', () => {
        assert.throws(() => render("{{ '5 apples' + 1 }}"), /Error: A non-numeric value encountered/);
        assert.throws(() => render('{{ options.price * 2 }}', { options: { price: '£5' } }), /Error: Unsupported operand types: string \* int/);
        assert.throws(() => render('{{ (1000|number_format) + 1 }}'), /Error: A non-numeric value encountered/);
        assert.throws(() => render("{{ '5 apples' * 'abc' }}"), /Error: A non-numeric value encountered/);
        assert.equal(render("{{ ' 5' + 1 }} {{ '5 ' + 1 }} {{ '.5' + 1 }} {{ '1e3' + 1 }} {{ (5|json) + 1 }}"), '6 6 1.5 1001 6');
    });

    test('captured text and lists are refused', () => {
        assert.throws(() => render('{% set x %}5{% endset %}{{ x + 1 }}'), /Error: Unsupported operand types: markup \+ int/);
        assert.throws(() => render('{{ options.list + 1 }}', { options: { list: [1, 2] } }), /Error: Unsupported operand types: array \+ int/);
        assert.throws(() => render("{{ '' + 1 }}"), /Error: Unsupported operand types: string \+ int/);
    });
});
