import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../src/dev-server.js';
import { imageDimensions, placeholderPng, placeholderShape, withBuyerImages } from '../src/options/buyer-images.js';
import { optionIssues, sampleValueSets } from '../src/options/check.js';
import { inferOptions } from '../src/options/infer.js';
import { normaliseOverrides, overrideProblems } from '../src/options/overrides.js';
import { tokenizeTemplate, TemplateTokenError } from '../src/options/twig-tokens.js';
import { resolveOptions, valueLimits, valuesFromQuery } from '../src/options/values.js';
import { suggestVersion, versionSuggestionLines } from '../src/options/version-suggestion.js';
import { launchChromium, loadPlaywright } from '../src/playwright.js';
import { optionOverridesHash, readLocalState } from '../src/sync-state.js';
import { loadWorkspace, selectProduct } from '../src/workspace.js';
import { run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { fixtureDocuments, stubPrompts, temporaryProduct, temporaryWorkspace } from './helpers/project.js';

const documents = fixtureDocuments();

/**
 * A minimal PNG header of a size.
 *
 * @param {number} width
 * @param {number} height
 */
function pngOf(width, height) {
    return placeholderPng(width, height);
}

/**
 * @param {string} url
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer}>}
 */
function get(url) {
    return new Promise((resolve, reject) => {
        request(url, (response) => {
            /** @type {Buffer[]} */
            const chunks = [];

            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject).end();
    });
}

describe('published option rules', () => {
    const published = documents.contexts.block.options_defaults;
    /**
     * @param {Record<string, unknown>} changes
     */
    const contextsWith = (changes) => ({ ...documents.contexts, block: { ...documents.contexts.block, options_defaults: { ...published, ...changes } } });

    test('the published conventions, Categories field, and warnings win over the kit\'s fallbacks', () => {
        const contexts = contextsWith({
            conventions: { order: ['textarea'], types: { textarea: { names: ['headline'], prefixes: [], suffixes: [] } } },
            categories_field: { label: 'Filter', help: null, variables: ['raffles'] },
            warnings: { ...published.warnings, different_defaults: 'Two defaults for :key.' },
        });
        const inferred = inferOptions('{{ options.headline|default("a") }}{{ options.headline|default("b") }}{{ options.show_title }}{{ raffles|length }}{{ competitions|length }}', contexts);

        assert.deepEqual(inferred.fields.map((field) => [field.key, field.type, field.label]), [['headline', 'textarea', 'Headline'], ['show_title', 'text', 'Show title'], ['categories', 'categories', 'Filter']]);
        assert.deepEqual(inferred.warnings, ['Two defaults for headline.']);
        assert.deepEqual(inferOptions('{{ competitions|length }}', contexts).fields, []);
    });

    test('without published rules the kit\'s fallbacks apply', () => {
        const inferred = inferOptions('{{ options.headline }}{{ options.show_title }}{{ competitions|length }}', { block: {} });

        assert.deepEqual(inferred.fields.map((field) => [field.key, field.type]), [['headline', 'text'], ['show_title', 'toggle'], ['categories', 'categories']]);
        assert.deepEqual(valueLimits({}), valueLimits(documents.contexts));
    });

    test('the published value caps win', () => {
        const limits = valueLimits(contextsWith({ max_text_length: 3, max_long_text_length: 4, max_query_bytes: 20, max_query_depth: 2 }));
        const fields = inferOptions('{{ options.heading }}{{ options.intro }}').fields;

        assert.deepEqual(resolveOptions(fields, { heading: 'Hello', intro: 'Welcome' }, null, limits), { heading: 'Hel', intro: 'Welc' });
        assert.deepEqual(valuesFromQuery('{"heading":"a long enough value"}', limits), {});
        assert.deepEqual(valuesFromQuery('{"a":{"b":1}}', limits), {});
        assert.deepEqual(valuesFromQuery('{"a":1}', limits), { a: 1 });
    });
});

describe('the template tokenizer', () => {
    test('refuses what the platform refuses, so such a template declares no options', () => {
        for (const template of ['{{ options.a|default( }}', '{{ options.a }}{# open', '{{ options.a ', '{% verbatim %}{{ options.a }}', '{{ options.a ] }}']) {
            assert.throws(() => tokenizeTemplate(template), TemplateTokenError, template);
            assert.deepEqual(inferOptions(template).fields, [], template);
        }
    });

    test('reads word operators only where the platform does', () => {
        const values = tokenizeTemplate("{{ options.in }}{% if 'x' not in options.list %}{% endif %}").map((token) => `${token.type}:${token.value}`);

        assert.ok(values.includes('name:in'));
        assert.ok(values.includes('operator:not in'));
        assert.deepEqual(inferOptions("{{ options.in }}{% if 'x' not in options.list %}{% endif %}").fields.map((field) => field.key), ['in', 'list']);
    });
});

describe('options.json', () => {
    const fields = inferOptions('{{ options.heading }} {{ options.size }} {{ options.show_title }} {{ options.accent_colour }} {% for competition in competitions.all %}{% endfor %}').fields;
    const rules = { ...documents.rules, option_overrides: { max_label_length: 60, max_help_length: 200, max_choices: 20 } };

    test('normalises as the marketplace stores it', () => {
        assert.deepEqual(normaliseOverrides({
            heading: { label: '  Title  ', help: '' },
            size: { choices: ['Small, Medium', 'Large', ' Large ', ''] },
            show_title: { choices: ['x'] },
            missing: { label: 'Dropped' },
            accent_colour: {},
        }, fields), {
            heading: { label: 'Title' },
            size: { choices: ['Small', 'Medium', 'Large'] },
        });
    });

    test('hashes the same as the copy the marketplace sends back after a push', () => {
        const written = { heading: { label: ' Title ', help: '', placeholder: 'x' }, size: { choices: ['Small, Large'] }, empty: {} };
        const stored = { heading: { label: 'Title' }, size: { choices: ['Small', 'Large'] } };

        assert.equal(optionOverridesHash(written), optionOverridesHash(stored));
        assert.notEqual(optionOverridesHash({ heading: { label: 'Other' } }), optionOverridesHash(stored));
    });

    test('a local options.json hashes as its stored form, so plan settles after a push', () => {
        const directory = temporaryProduct({ template: '{{ options.heading }}', options: { heading: { label: 'Title ', choices: ['A,B'] } } });
        const local = readLocalState(selectProduct(loadWorkspace(directory), undefined, directory), documents);

        assert.equal('sha256' in local.options && local.options.sha256, optionOverridesHash({ heading: { label: 'Title', choices: ['A', 'B'] } }));
    });

    test('reports what the marketplace refuses apart from what it drops', () => {
        const problems = overrideProblems({
            heading: { label: 'x'.repeat(61), help: 7 },
            size: { choices: Array.from({ length: 21 }, (_, index) => `Size ${index}`) },
            show_title: { choices: ['On'] },
            accent_colour: { label: 'Accent', placeholder: '#fff' },
            missing: { label: 'Nobody reads me' },
            categories: { label: 'Kinds' },
            broken: 'not an object',
        }, fields, rules);
        const refused = problems.filter((problem) => problem.refused).map((problem) => problem.message);
        const dropped = problems.filter((problem) => !problem.refused).map((problem) => problem.message);

        assert.deepEqual(refused, [
            'options.json "heading" label is 61 characters; the marketplace allows 60.',
            'options.json "heading" help must be text.',
            'options.json "size" has 21 choices; the marketplace allows 20.',
            'options.json "broken" must be an object with label, help, or choices.',
        ]);
        assert.equal(dropped.length, 4);
        assert.match(dropped[0], /show_title is a toggle option and only text options take choices/);
        assert.match(dropped[1], /"accent_colour" has "placeholder"/);
        assert.match(dropped[2], /never reads options\.missing/);
        assert.match(dropped[3], /category filter/);
    });

    test('override text passes the banned patterns, as the marketplace checks it', () => {
        const problems = overrideProblems({ heading: { help: 'Visit javascript:alert(1)' } }, fields, documents.rules);

        assert.equal(problems.length, 1);
        assert.equal(problems[0].refused, true);
        assert.match(problems[0].message, /^In the option labels: /);
    });

    test('override text problems use the platform\'s wording when published, and the kit\'s otherwise', () => {
        const unpublished = { ...documents.rules, option_overrides: { ...documents.rules.option_overrides, violation_message: undefined } };
        const reworded = { ...documents.rules, option_overrides: { ...documents.rules.option_overrides, violation_message: 'Option text :violation (fix it)' } };
        const overrides = { heading: { help: 'Visit javascript:alert(1)' } };
        const [kitWording] = overrideProblems(overrides, fields, unpublished);
        const [published] = overrideProblems(overrides, fields, reworded);

        assert.match(kitWording.message, /^options\.json: /);
        assert.equal(published.message, `Option text ${kitWording.message.slice('options.json: '.length)} (fix it)`);
    });

    test('limits are checked only when rules.json publishes them', () => {
        assert.deepEqual(overrideProblems({ heading: { label: 'x'.repeat(100) } }, fields, documents.rules.option_overrides === undefined ? documents.rules : { ...documents.rules, option_overrides: undefined }), []);
    });
});

describe('option checks', () => {
    const scenarios = ['mixed', 'no_plays'];

    test('sample values follow each type, flip toggles, and take each choice in turn', () => {
        const { fields } = inferOptions('{{ options.heading }}{{ options.show_title|default(true) }}{{ options.is_new }}{{ options.count }}{% for slide in options.slides %}{{ slide.title }}{% endfor %}');
        const withChoices = fields.map((field) => (field.key === 'heading' ? { ...field, choices: ['A', 'B'] } : field));
        const sets = sampleValueSets(withChoices, { images: [], categories: ['tech'], limits: valueLimits(documents.contexts) });

        assert.equal(sets.length, 2);
        assert.deepEqual(sets.map((values) => values.heading), ['A', 'B']);
        assert.equal(sets[0].show_title, false);
        assert.equal(sets[0].is_new, true);
        assert.equal(sets[0].count, 1000000);
        assert.equal(/** @type {unknown[]} */ (sets[0].slides).length, 20);
    });

    test('a render that fails only once a buyer sets an option blocks, once', () => {
        const template = '<p>{{ 3.14159|number_format(options.decimals|default(2)) }}</p>';
        const issues = optionIssues({ template, files: {}, overrides: null, documents, playCount: 5, scenarios });

        assert.deepEqual(issues.map((issue) => [issue.code, issue.scenario]), [['option_render_error', 'mixed']]);
        assert.match(issues[0].message, /^With every option set as a buyer may set it: /);
        assert.equal(optionIssues({ template: '<p>{{ options.heading }}</p>', files: {}, overrides: null, documents, playCount: 5, scenarios }).length, 0);
    });

    test('warns when this version stops reading an option the live version reads', () => {
        const issues = optionIssues({ template: '{{ options.heading }}', files: {}, overrides: null, remote: { live_version: '1.2.0', live_option_keys: ['heading', 'subtitle'] }, documents, playCount: 5, scenarios });

        assert.deepEqual(issues.map((issue) => issue.code), ['option_warning']);
        assert.match(issues[0].message, /^The live version 1\.2\.0 reads options\.subtitle, which this version no longer reads\./);
    });

    test('check reports option warnings, refused overrides, and render errors with sample values', async () => {
        const server = await startFixtureServer();

        try {
            const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', template: '<p>{{ options.heading|default("A") }}{{ options.heading|default("B") }}</p><p>{{ 3.14159|number_format(options.decimals|default(2)) }}</p>\n', options: { heading: { label: 'x'.repeat(61) }, gone: { label: 'Gone' } } }] });
            const { code, output } = await runJson(['check', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl });
            const codes = output.issues.map((/** @type {any} */ issue) => issue.code);

            assert.equal(code, 1);
            assert.ok(codes.includes('option_warning'));
            assert.ok(output.issues.some((/** @type {any} */ issue) => issue.code === 'option_warning' && issue.message === 'options.heading has different defaults in different places; the first one is used.'));
            assert.ok(output.issues.some((/** @type {any} */ issue) => issue.code === 'option_override_invalid' && issue.file === 'options.json'));
            assert.ok(output.issues.some((/** @type {any} */ issue) => issue.code === 'option_warning' && /never reads options\.gone/.test(issue.message)));
            assert.ok(codes.includes('option_render_error'));

            const human = await run(['check', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl });

            assert.match(human.stdout, /error {3}\[option_override_invalid\] options\.json/);
            assert.match(human.stdout, /warning \[option_warning\]/);
        } finally {
            await server.close();
        }
    });
});

describe('version suggestion', () => {
    const fields = inferOptions('{{ options.heading }}{{ options.footer }}').fields;

    test('major when a live option is gone, minor when one is added, patch otherwise', () => {
        assert.equal(suggestVersion({ liveVersion: '1.2.3', liveOptionKeys: ['heading', 'footer', 'subtitle'], fields })?.version, '2.0.0');
        assert.deepEqual(suggestVersion({ liveVersion: '1.2.3', liveOptionKeys: ['heading'], fields }), { version: '1.3.0', bump: 'minor', reason: 'This version adds Footer (options.footer), so it is a minor release.' });
        assert.equal(suggestVersion({ liveVersion: '1.2.3', liveOptionKeys: ['footer', 'heading'], fields })?.bump, 'patch');
    });

    test('nothing to suggest without a live version or its option keys', () => {
        assert.equal(suggestVersion({ liveVersion: null, liveOptionKeys: ['heading'], fields }), null);
        assert.equal(suggestVersion({ liveVersion: '1.0.0', liveOptionKeys: undefined, fields }), null);
        assert.equal(suggestVersion({ liveVersion: 'beta', liveOptionKeys: [], fields }), null);
    });

    test('repeater item fields and the Categories filter compare as the platform compares them', () => {
        const repeater = inferOptions('{% for slide in options.slides %}{{ slide.title }}{% endfor %}').fields;
        const catalogue = inferOptions('{{ options.heading }}{{ competitions.all|length }}').fields;

        assert.equal(suggestVersion({ liveVersion: '1.0.0', liveOptionKeys: ['slides', 'slides.title', 'slides.image'], fields: repeater })?.bump, 'major');
        assert.equal(suggestVersion({ liveVersion: '1.0.0', liveOptionKeys: ['slides', 'slides.title'], fields: repeater })?.bump, 'patch');
        assert.deepEqual(suggestVersion({ liveVersion: '1.0.0', liveOptionKeys: ['slides'], fields: repeater }), { version: '1.1.0', bump: 'minor', reason: 'This version adds Slides: Title (options.slides.title), so it is a minor release.' });
        assert.equal(suggestVersion({ liveVersion: '1.0.0', liveOptionKeys: ['heading'], fields: catalogue })?.bump, 'minor');
        assert.equal(suggestVersion({ liveVersion: '1.0.0', liveOptionKeys: ['heading', 'categories'], fields: catalogue })?.bump, 'patch');
    });

    test('the plan warns when the version in progress is lower', () => {
        const suggestion = suggestVersion({ liveVersion: '1.2.3', liveOptionKeys: ['heading', 'footer', 'subtitle'], fields });

        assert.match(versionSuggestionLines({ version: '1.3.0', suggested_version: suggestion, product: 'games/spin' })[0], /^ {2}Version 1\.3\.0 is lower than the major release the marketplace expects \(2\.0\.0\)\. .* Set it with npx @rafflex\/dev version games\/spin 2\.0\.0\.$/);
        assert.deepEqual(versionSuggestionLines({ version: '2.0.0', suggested_version: suggestion, product: 'games/spin' }), []);
    });

    test('plan --json carries suggested_version from the live option keys synced', async () => {
        const server = await startFixtureServer();

        try {
            const remote = { synced_at: new Date().toISOString(), status: 'published', live_version: '1.0.0', live_channel: 'stable', live_option_keys: ['heading', 'subtitle'], draft: null, listing_sha256: null, latest_review: null, media: [] };
            const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', slug: 'spin-to-win', version: '1.1.0', remote, template: '<p>{{ options.heading }}</p>\n' }] });
            const { output } = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl });

            assert.deepEqual(output.suggested_version, { version: '2.0.0', bump: 'major', reason: 'Sites on 1.0.0 may have set options.subtitle, which this version no longer reads, so it is a major release.' });

            const human = await run(['plan', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl });

            assert.match(human.stdout, /Version 1\.1\.0 is lower than the major release the marketplace expects \(2\.0\.0\)/);
        } finally {
            await server.close();
        }
    });
});

describe('buyer images', () => {
    test('reads image sizes from PNG, GIF, JPEG, and WebP headers', () => {
        const gif = Buffer.from('474946383961' + '2c01' + 'c800', 'hex');
        const jpeg = Buffer.from('ffd8' + 'ffe00010' + '4a46494600010100000100010000' + 'ffc0001108' + '00c8' + '012c' + '03012200', 'hex');
        const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(8), Buffer.from([0x2b, 0x01, 0x00, 0xc7, 0x00, 0x00])]);

        assert.deepEqual(imageDimensions(pngOf(300, 200)), { width: 300, height: 200 });
        assert.deepEqual(imageDimensions(gif), { width: 300, height: 200 });
        assert.deepEqual(imageDimensions(jpeg), { width: 300, height: 200 });
        assert.deepEqual(imageDimensions(webp), { width: 300, height: 200 });
        assert.equal(imageDimensions(Buffer.from('not an image')), null);
    });

    test('a placeholder has another shape than the image it replaces', () => {
        assert.ok(placeholderShape({ width: 1600, height: 400 }).height > placeholderShape({ width: 1600, height: 400 }).width);
        assert.ok(placeholderShape({ width: 400, height: 400 }).width > placeholderShape({ width: 400, height: 400 }).height);
        assert.ok(placeholderShape(null).width > placeholderShape(null).height);
    });

    test('every key pointing at a replaced file follows it', () => {
        const files = { hero: '/assets/hero.png', other: '/assets/other.png', alias: '/assets/hero.png' };

        assert.deepEqual(withBuyerImages(files, [{ tag: 'hero', url: '/assets/hero.png', width: 1, height: 1, placeholder_url: '/assets/.rafflex/buyer-image/hero.png' }]), {
            hero: '/assets/.rafflex/buyer-image/hero.png',
            other: '/assets/other.png',
            alias: '/assets/.rafflex/buyer-image/hero.png',
        });
    });
});

describe('the preview with options', () => {
    /** @type {Awaited<ReturnType<typeof startDevServer>>} */
    let server;
    /** @type {string} */
    let gameUrl;
    /** @type {string} */
    let blockUrl;

    before(async () => {
        const root = temporaryWorkspace({
            products: [
                {
                    folder: 'spin-to-win',
                    template: '<h2>{{ options.heading|default("Spin") }}</h2><p>{{ options.size|default("Medium") }}</p><p>{{ options.show_title ? "shown" : "hidden" }}</p><img src="{{ files[\'wheel\'] }}" alt=""><img src="{{ files[\'logo\'] }}" alt="">\n',
                    options: { heading: { label: 'Title', help: 'Above the wheel' }, size: { choices: ['Small', 'Large'] } },
                    assets: { 'wheel.png': pngOf(400, 400), 'logo.png': pngOf(900, 200), 'unused.png': pngOf(10, 10) },
                },
                { type: 'block', title: 'Wall', folder: 'wall', template: '{% for category in categories %}<b>{{ category.slug }}</b>{% endfor %}{{ options.heading }}\n' },
            ],
        });
        const workspace = loadWorkspace(root);

        server = await startDevServer({ workspace, loaded: { documents, warnings: [], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' }, port: 0, prompts: stubPrompts(), detect: () => [], watchFiles: false });
        gameUrl = `${server.url}p/games/spin-to-win/`;
        blockUrl = `${server.url}p/blocks/wall/`;
    });

    after(() => server.close());

    test('the options form is the inferred fields with options.json applied', async () => {
        const form = JSON.parse((await get(`${gameUrl}__rafflex/options`)).body.toString());

        assert.deepEqual(form.fields.map((/** @type {any} */ field) => [field.key, field.type, field.label, field.help, field.choices, field.starts]), [
            ['heading', 'text', 'Title', 'Above the wheel', [], null],
            ['size', 'text', 'Size', null, ['Small', 'Large'], null],
            ['show_title', 'toggle', 'Show title', null, [], false],
        ]);
        assert.deepEqual(form.images.map((/** @type {any} */ image) => image.tag).sort(), ['logo', 'unused', 'wheel']);
        assert.deepEqual(form.buyer_images.map((/** @type {any} */ image) => [image.tag, image.width, image.height]), [['wheel', 400, 400], ['logo', 900, 200]]);
        assert.ok(form.categories.length > 0);
    });

    test('the frame renders with values coerced as a site owner\'s, choices from options.json applied', async () => {
        const options = encodeURIComponent(JSON.stringify({ heading: '  Win big  ', size: 'Medium', show_title: 'yes' }));
        const frame = (await get(`${gameUrl}frame?scenario=mixed&play_count=5&options=${options}`)).body.toString();

        assert.match(frame, /<h2>Win big<\/h2>/);
        assert.match(frame, /<p>Medium<\/p>/, 'a value outside the choices stays unset');
        assert.match(frame, /<p>shown<\/p>/);
        assert.match((await get(`${gameUrl}frame?options=${encodeURIComponent(JSON.stringify({ size: 'Large' }))}`)).body.toString(), /<p>Large<\/p>/);
        assert.match((await get(`${gameUrl}frame?options=not-json`)).body.toString(), /<h2>Spin<\/h2>/);
    });

    test('ticked categories narrow the catalogue', async () => {
        const all = (await get(`${blockUrl}frame`)).body.toString();
        const first = documents.contexts.shared.categories[0].slug;
        const narrowed = (await get(`${blockUrl}frame?options=${encodeURIComponent(JSON.stringify({ categories: [first] }))}`)).body.toString();

        assert.ok((all.match(/<b>/g) ?? []).length > 1);
        assert.deepEqual([...narrowed.matchAll(/<b>([^<]+)<\/b>/g)].map((match) => match[1]), [first]);
    });

    test('buyer images swap each image the template uses for a placeholder of another shape, under the preview CSP', async () => {
        const response = await get(`${gameUrl}frame?buyer_images=1`);
        const frame = response.body.toString();
        const sources = [...frame.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, '&'));
        const csp = String(response.headers['content-security-policy']);

        assert.deepEqual(sources, ['/p/games/spin-to-win/assets/.rafflex/buyer-image/wheel.png?w=960&h=320', '/p/games/spin-to-win/assets/.rafflex/buyer-image/logo.png?w=480&h=720']);
        assert.ok(csp.includes(`${gameUrl}assets/`), csp);

        const placeholder = await get(`${server.url}${sources[1].slice(1)}`);

        assert.equal(placeholder.status, 200, sources[1]);
        assert.equal(placeholder.headers['content-type'], 'image/png');
        assert.deepEqual(imageDimensions(placeholder.body), { width: 480, height: 720 });
        assert.equal((await get(`${gameUrl}assets/wheel.png`)).status, 200, 'the creator file itself still serves');
        assert.equal((await get(`${gameUrl}assets/.rafflex/buyer-image/x.svg`)).status, 404);
        assert.match((await get(`${blockUrl}frame?buyer_images=1`)).body.toString(), /<b>/, 'a block ignores buyer images');
    });
});

const playwright = await loadPlaywright(temporaryWorkspace());
const launched = playwright === null ? { browser: null } : await launchChromium(playwright);
const browserAvailable = launched.browser !== null;

describe('options in the browser', { skip: browserAvailable ? false : 'Chromium is not available here' }, () => {
    after(() => launched.browser?.close());

    test('the app\'s Options panel re renders the frame, and Reset returns to the defaults', async () => {
        const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', template: '<h2 id="heading">{{ options.heading|default("Spin") }}</h2>\n', options: { heading: { label: 'Title' } } }] });
        const server = await startDevServer({ workspace: loadWorkspace(root), loaded: { documents, warnings: [], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' }, port: 0, prompts: stubPrompts(), detect: () => [], watchFiles: false });
        const context = await launched.browser.newContext();

        try {
            const page = await context.newPage();

            await page.goto(`${server.url}p/games/spin-to-win/`);
            await page.locator('details.options summary').click();
            await page.getByText('Title', { exact: true }).waitFor();

            const field = page.locator('details.options input[type="text"]').first();

            await field.fill('Win big');
            await field.press('Enter');
            await page.frameLocator('.frame iframe').locator('#heading', { hasText: 'Win big' }).waitFor({ timeout: 10000 });
            assert.match(await page.locator('.frame iframe').getAttribute('src') ?? '', /options=/);

            await page.getByRole('button', { name: 'Reset' }).click();
            await page.frameLocator('.frame iframe').locator('#heading', { hasText: 'Spin' }).waitFor({ timeout: 10000 });
        } finally {
            await context.close();
            await server.close();
        }
    });

    test('the browser run adds buyer image screenshots, and specs open a scenario with options', async () => {
        const fixtures = await startFixtureServer();

        try {
            const template = '<div><h2 id="heading">{{ options.heading|default("Spin") }}</h2><img src="{{ files[\'wheel\'] }}" alt="Wheel"></div>\n';
            const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', template, assets: { 'wheel.png': pngOf(400, 400) } }] });
            const tests = join(root, 'games', 'spin-to-win', 'tests');

            mkdirSync(tests);
            writeFileSync(join(tests, 'options.spec.mjs'), `export default async ({ open, page, assert }) => {
    await open('mixed', { options: { heading: 'From a spec' } });
    assert.equal(await page.locator('#heading').textContent(), 'From a spec');
};
`);

            const { output } = await runJson(['test', 'spin-to-win'], { cwd: root, baseUrl: fixtures.baseUrl, env: { RAFFLEX_NO_PLAYWRIGHT: '0' } });

            assert.deepEqual(output.creator_tests.map((/** @type {any} */ spec) => spec.passed), [true], JSON.stringify(output.creator_tests));
            assert.deepEqual(output.buyer_images.map((/** @type {any} */ runRecord) => runRecord.device), ['phone', 'desktop']);

            for (const device of ['phone', 'desktop']) {
                assert.ok(existsSync(join(root, 'games', 'spin-to-win', '.results', 'screenshots', `buyer-images-${device}.png`)), device);
            }

            assert.ok(output.runs.some((/** @type {any} */ runRecord) => runRecord.scenario === 'buyer_images'));
            assert.equal(JSON.parse(readFileSync(join(root, 'games', 'spin-to-win', '.results', 'last-run.json'), 'utf8')).buyer_images.length, 2);
        } finally {
            await fixtures.close();
        }
    });
});
