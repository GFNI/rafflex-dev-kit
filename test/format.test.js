import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as prettier from 'prettier';
import { rawFixtureContext } from '../src/context.js';
import { FormatError, formatTemplate, houseStyle, maskTwig, twigRegions } from '../src/format.js';
import { renderTemplate } from '../src/twig-engine.js';
import { run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { fixtureDocuments, temporaryProduct } from './helpers/project.js';

const documents = fixtureDocuments();
const fixturesDirectory = new URL('./fixtures/', import.meta.url);
const marketplaceFixtures = JSON.parse(readFileSync(new URL('endpoints/fixtures.json', fixturesDirectory), 'utf8')).fixtures;
const kitFixtures = JSON.parse(readFileSync(new URL('kit-fixtures.json', fixturesDirectory), 'utf8')).fixtures;

/**
 * @param {string} html
 */
async function canonical(html) {
    return prettier.format(html, houseStyle);
}

describe('the house style', () => {
    for (const fixture of [...marketplaceFixtures, ...kitFixtures]) {
        test(`${fixture.name} renders identically before and after formatting, and formatting twice is a no op`, async () => {
            const { formatted } = await formatTemplate(fixture.template);
            const again = await formatTemplate(formatted);
            const context = rawFixtureContext(documents.contexts, fixture);
            const before = renderTemplate(fixture.template, context, documents.rules.sandbox);
            const afterFormatting = renderTemplate(formatted, context, documents.rules.sandbox);

            assert.equal(again.changed, false);
            assert.deepEqual(twigRegions(formatted).map((region) => region.text), twigRegions(fixture.template).map((region) => region.text));
            assert.equal(await canonical(afterFormatting), await canonical(before));
        });
    }

    test('formats HTML, inline CSS, and inline JavaScript with the fixed configuration', async () => {
        const { formatted, changed } = await formatTemplate('<div><style>.a{color:red}</style><script>const a={b:1}\nif(a.b==1){go()}</script></div>');

        assert.equal(changed, true);
        assert.equal(formatted, `<div>
    <style>
        .a {
            color: red;
        }
    </style>
    <script>
        const a = { b: 1 };
        if (a.b == 1) {
            go();
        }
    </script>
</div>
`);
    });

    test('keeps the single quotes of an attribute that Twig prints JSON into', async () => {
        const template = `<div x-data='{ plays: {{ plays|json }} }' class="a   b"></div>`;
        const { formatted } = await formatTemplate(template, { type: 'game', documents });

        assert.equal(formatted, `<div x-data='{ plays: {{ plays|json }} }' class="a b"></div>\n`);
    });

    test('never changes Twig, byte for byte', async () => {
        const template = '<ul>{%- for p in plays   -%}<li class="{{ p.won ? \'win\' : \'lose\' }}">{{   p.prize.name|upper }}</li>{% endfor %}</ul>{# a  note #}';
        const { formatted } = await formatTemplate(template, { type: 'game', documents });

        assert.deepEqual(twigRegions(formatted).map((region) => region.text), twigRegions(template).map((region) => region.text));
    });

    test('masks every Twig region with an identifier', () => {
        const { masked, placeholders } = maskTwig("<p class='{{ a }}'>{% if b %}{{ c }}{% endif %}</p>");

        assert.equal(placeholders.length, 4);
        assert.match(placeholders[0].placeholder, /^rfxtw0"/);
        assert.match(placeholders[1].placeholder, /^rfxtw1x+$/);
        assert.doesNotMatch(masked, /\{\{|\{%/);
    });

    test('leaves a template it cannot read, or one using its placeholder prefix, untouched', async () => {
        await assert.rejects(formatTemplate('<p>rfxtw0x</p>'), FormatError);
        await assert.rejects(formatTemplate('<div></span>'), /Prettier could not read the template/);
    });
});

describe('format and check', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    test('format --check reports, format writes, and check warns about an unformatted template', async () => {
        const directory = temporaryProduct({ template: '<div><p data-rafflex-play data-rafflex-result>{{ plays|json }}</p></div>' });
        const templatePath = join(directory, 'template.twig');

        const checked = await runJson(['check'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(checked.code, 0);
        assert.deepEqual(checked.output.issues.map((/** @type {any} */ issue) => issue.code), ['unformatted']);

        const reported = await runJson(['format', '--check'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(reported.code, 1);
        assert.deepEqual(reported.output, { product: 'games/spin-to-win', formatted: false, changed: true, written: false, error: null });
        assert.equal(readFileSync(templatePath, 'utf8'), '<div><p data-rafflex-play data-rafflex-result>{{ plays|json }}</p></div>');

        const written = await run(['format'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(written.code, 0);
        assert.match(written.stdout, /games\/spin-to-win: formatted template\.twig\./);
        assert.equal(readFileSync(templatePath, 'utf8'), '<div><p data-rafflex-play data-rafflex-result>{{ plays|json }}</p></div>\n');
        assert.match((await run(['format'], { cwd: directory, baseUrl: server.baseUrl })).stdout, /already in the house style/);
        assert.deepEqual((await runJson(['check'], { cwd: directory, baseUrl: server.baseUrl })).output.issues, []);
    });

    test('format reports a template it cannot format and exits 1', async () => {
        const directory = temporaryProduct({ template: '<div></span>' });
        const { code, output } = await runJson(['format'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(code, 1);
        assert.match(output.error, /Prettier could not read the template/);

        writeFileSync(join(directory, 'template.twig'), '<p>{{ plays|json }}</p>\n');
        assert.equal((await runJson(['format'], { cwd: directory, baseUrl: server.baseUrl })).code, 0);
    });
});
