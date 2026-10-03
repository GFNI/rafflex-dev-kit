import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../src/dev-server.js';
import { frameDocument, localCspDirectives } from '../src/preview.js';
import { loadWorkspace, selectProduct } from '../src/workspace.js';
import { fixtureDocuments, glbBuffer, stubPrompts, temporaryProduct } from './helpers/project.js';

const documents = fixtureDocuments();
const libraryBytes = readFileSync(new URL('./fixtures/lib/fake-three.module.js', import.meta.url));

describe('frame theme', () => {
    test('the frame carries the published theme variables and html class, like the studio frame', () => {
        const { theme } = documents.contexts;
        const frame = frameDocument({ html: '<p>x</p>', error: null, background: '#111827', theme });

        assert.equal(theme.html_class, 'dark');
        assert.match(frame, /<html lang="en" class="dark">/);
        assert.ok(frame.includes(theme.css), 'theme css is injected');
        assert.ok(frame.includes('--gray-color-950: #030712;'));
        assert.match(frame, /body \{ background: var\(--gray-color-950\);/);
    });

    test('a light theme drops the dark class, and contexts without a theme fall back to the sample background', () => {
        assert.match(frameDocument({ html: '', error: null, theme: { css: ':root { --gray-color-950: #ffffff; }', html_class: '' } }), /<html lang="en">/);

        const legacy = frameDocument({ html: '', error: null, background: '#ffffff' });

        assert.match(legacy, /<html lang="en">/);
        assert.match(legacy, /body \{ background: #ffffff;/);
    });
});

describe('preview CSP', () => {
    test('maps origin and path media sources to the product assets path and keeps the libraries path', () => {
        const assets = 'http://127.0.0.1:5173/p/games/spin-to-win/assets/';
        const directives = localCspDirectives({
            sandbox: ['allow-scripts'],
            'default-src': ["'none'"],
            'script-src': ["'self'", "'unsafe-inline'", 'https://marketplace.rafflex.io/media/libraries/'],
            'img-src': ["'self'", 'data:', 'blob:', 'https://static.rafflex.io'],
            'media-src': ["'self'", 'https://static.rafflex.io', 'https://marketplace.rafflex.io/media/audio/'],
            'connect-src': ['https://marketplace.rafflex.io/media/models/', 'blob:'],
            'form-action': ["'none'"],
            'base-uri': ["'none'"],
        }, assets);

        assert.deepEqual(directives, {
            sandbox: ['allow-scripts'],
            'default-src': ["'none'"],
            'script-src': ["'self'", "'unsafe-inline'", 'https://marketplace.rafflex.io/media/libraries/'],
            'img-src': ["'self'", 'data:', 'blob:', assets],
            'media-src': ["'self'", assets],
            'connect-src': [assets, 'blob:'],
            'form-action': ["'none'"],
            'base-uri': ["'none'"],
        });
    });

    test('never adds the local server or a product assets path to script-src', () => {
        const directives = localCspDirectives({ 'script-src': ["'self'"] }, 'http://127.0.0.1:5173/p/games/spin-to-win/assets/');

        assert.deepEqual(directives, { 'script-src': ["'self'"] });
    });
});

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: string}>}
 */
function get(url, headers = {}) {
    return new Promise((resolve, reject) => {
        request(url, { headers }, (response) => {
            let body = '';

            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        }).on('error', reject).end();
    });
}

describe('dev server', () => {
    /** @type {string} */
    let directory;
    /** @type {Awaited<ReturnType<typeof startDevServer>>} */
    let server;
    /** @type {string} */
    let productUrl;

    before(async () => {
        directory = temporaryProduct({
            template: `<p>{{ play_count }} plays</p><img src="{{ files['background'] }}"><script type="module">import * as THREE from "{{ files['three'] }}";</script>`,
            assets: { 'background.png': 'png bytes', 'three.module.min.js': libraryBytes, 'prize-box.glb': glbBuffer() },
        });
        const workspace = loadWorkspace(directory);

        server = await startDevServer({ workspace, loaded: { documents, warnings: ['a warning'], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' }, port: 0, prompts: stubPrompts(), detect: () => [] });
        productUrl = server.urlFor(selectProduct(workspace, undefined, directory));
    });

    after(() => server.close());

    test('serves the controls page', async () => {
        const page = await get(productUrl);

        assert.equal(productUrl, `${server.url}p/games/spin-to-win/`);
        assert.equal(page.status, 200);
        assert.match(page.body, /<iframe title="Preview" sandbox="allow-scripts" :src="frameUrl"><\/iframe>/);
    });

    test('renders the frame for a scenario and play count under the mapped preview CSP', async () => {
        const frame = await get(`${productUrl}frame?scenario=all_win&play_count=3`);
        const csp = String(frame.headers['content-security-policy']);
        const origin = server.url.replace(/\/$/, '');
        const assets = `${productUrl}assets/`;
        const scriptSources = (csp.split('; ').find((directive) => directive.startsWith('script-src ')) ?? '').split(' ').slice(1);
        const librariesSource = documents.rules.preview_csp['script-src'].find((source) => source.endsWith('/media/libraries/'));

        assert.equal(frame.status, 200);
        assert.match(frame.body, /<p>3 plays<\/p>/);
        assert.ok(frame.body.includes(documents.contexts.theme.css), 'the frame carries the theme variables');
        assert.match(frame.body, /<img src="\/p\/games\/spin-to-win\/assets\/background\.png">/);
        assert.match(frame.body, new RegExp(`import \\* as THREE from "${documents.libraries.libraries[0].url.replace(/[.]/g, '\\.')}"`));
        assert.match(csp, /^sandbox allow-scripts; default-src 'none'/);
        assert.match(csp, /form-action 'none'/);
        assert.match(csp, /base-uri 'none'/);
        assert.ok(csp.includes(`img-src 'self' data: blob: ${assets};`), csp);
        assert.ok(csp.includes(`connect-src ${assets} blob:`), csp);
        assert.ok(csp.includes(`${origin}/__rafflex/alpine.js`), csp);
        assert.ok(scriptSources.some((source) => documents.libraries.libraries[0].url.startsWith(source)), csp);
        assert.ok(scriptSources.includes(librariesSource), csp);
        assert.equal(scriptSources.includes(assets), false, csp);
        assert.equal(csp.includes('/media/models/'), false, csp);
        assert.equal(csp.replace(librariesSource, '').includes('marketplace.rafflex.io.test'), false, csp);
    });

    test('shows a render error inside the frame', async () => {
        writeFileSync(join(directory, 'template.twig'), '{{ plays|raw }}');

        try {
            const frame = await get(`${productUrl}frame`);

            assert.match(frame.body, /<strong>Preview error:<\/strong> Filter &quot;raw&quot; is not allowed in &quot;template\.twig&quot; at line 1\./);
        } finally {
            writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} plays</p>');
        }
    });

    test('reports problems with the verdict note and the rules warnings', async () => {
        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }}</p><script>fetch("/x")</script>');

        try {
            const problems = JSON.parse((await get(`${productUrl}__rafflex/problems?scenario=mixed&play_count=5`)).body);

            assert.deepEqual(problems.issues.filter((issue) => !problems.warning_codes.includes(issue.code)).map((issue) => issue.message), ['External network calls are not allowed (fetch).']);
            assert.ok(problems.issues.some((issue) => issue.code === 'unformatted'));
            assert.ok(problems.issues.some((issue) => issue.code === 'game_twig_logic' && issue.line === 1));
            assert.deepEqual(problems.warnings, ['a warning']);
            assert.equal(problems.note, "The marketplace's own check is the final verdict.");
            assert.deepEqual(problems.files.map((file) => file.tag).sort(), ['background', 'prize-box', 'three']);
        } finally {
            writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} plays</p>');
        }
    });

    test('serves assets with CORS for the opaque origin frame, and nothing outside assets/', async () => {
        const model = await get(`${productUrl}assets/prize-box.glb`);

        assert.equal(model.status, 200);
        assert.equal(model.headers['content-type'], 'model/gltf-binary');
        assert.equal(model.headers['access-control-allow-origin'], '*');
        assert.equal((await get(`${productUrl}assets/..%2Fproduct.json`)).status, 404);
        assert.equal((await get(`${productUrl}assets/%2E%2E/template.twig`)).status, 404);
    });

    test('refuses requests for another host name', async () => {
        assert.equal((await get(server.url, { Host: 'attacker.example' })).status, 403);
    });

    test('streams a reload event when a project file changes', async () => {
        const reload = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('no reload event')), 5000);

            request(`${productUrl}__rafflex/events`, (response) => {
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    if (chunk.includes('event: reload')) {
                        clearTimeout(timeout);
                        response.destroy();
                        resolve(true);
                    }
                });
            }).on('error', () => {}).end();
        });

        setTimeout(() => writeFileSync(join(directory, 'template.twig'), '<p>changed</p>'), 200);

        assert.equal(await reload, true);
    });
});
