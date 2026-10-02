import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../src/dev-server.js';
import { localCspDirectives } from '../src/preview.js';
import { loadProject } from '../src/project.js';
import { fixtureDocuments, glbBuffer, temporaryProject } from './helpers/project.js';

const documents = fixtureDocuments();
const libraryBytes = readFileSync(new URL('./fixtures/lib/fake-three.module.js', import.meta.url));

describe('preview CSP', () => {
    test('maps the uploads origin to the local server and keeps the libraries path', () => {
        const directives = localCspDirectives({
            sandbox: ['allow-scripts'],
            'default-src': ["'none'"],
            'script-src': ["'self'", "'unsafe-inline'", 'https://static.rafflex.io/marketplace/libraries/'],
            'img-src': ["'self'", 'data:', 'blob:', 'https://static.rafflex.io'],
            'connect-src': ['https://static.rafflex.io', 'blob:'],
            'form-action': ["'none'"],
            'base-uri': ["'none'"],
        }, 'http://127.0.0.1:5173', ['https://static.rafflex.io/marketplace/libraries/three/1/three.js']);

        assert.deepEqual(directives, {
            sandbox: ['allow-scripts'],
            'default-src': ["'none'"],
            'script-src': ["'self'", "'unsafe-inline'", 'https://static.rafflex.io/marketplace/libraries/', 'http://127.0.0.1:5173', 'https://static.rafflex.io/marketplace/libraries/three/1/three.js'],
            'img-src': ["'self'", 'data:', 'blob:', 'http://127.0.0.1:5173'],
            'connect-src': ['http://127.0.0.1:5173', 'blob:'],
            'form-action': ["'none'"],
            'base-uri': ["'none'"],
        });
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

    before(async () => {
        directory = temporaryProject({
            template: `<p>{{ play_count }} plays</p><img src="{{ files['background'] }}"><script type="module">import * as THREE from "{{ files['three'] }}";</script>`,
            assets: { 'background.png': 'png bytes', 'three.module.min.js': libraryBytes, 'prize-box.glb': glbBuffer() },
        });
        server = await startDevServer({ project: loadProject(directory), loaded: { documents, warnings: ['a warning'], offline: false, baseUrl: 'https://marketplace.rafflex.io', manifest: null, cacheDirectory: '' }, port: 0 });
    });

    after(() => server.close());

    test('serves the controls page', async () => {
        const page = await get(server.url);

        assert.equal(page.status, 200);
        assert.match(page.body, /<iframe id="preview" title="Template preview" sandbox="allow-scripts">/);
    });

    test('renders the frame for a scenario and play count under the mapped preview CSP', async () => {
        const frame = await get(`${server.url}frame?scenario=all_win&play_count=3`);
        const csp = String(frame.headers['content-security-policy']);
        const origin = server.url.replace(/\/$/, '');

        assert.equal(frame.status, 200);
        assert.match(frame.body, /<p>3 plays<\/p>/);
        assert.match(frame.body, /<img src="\/assets\/background\.png">/);
        assert.match(frame.body, new RegExp(`import \\* as THREE from "${documents.libraries.libraries[0].url.replace(/[.]/g, '\\.')}"`));
        assert.match(csp, /^sandbox allow-scripts; default-src 'none'/);
        assert.match(csp, /form-action 'none'/);
        assert.match(csp, /base-uri 'none'/);
        assert.ok(csp.includes(`img-src 'self' data: blob: ${origin}`), csp);
        assert.ok(csp.includes(`connect-src ${origin} blob:`), csp);
        assert.ok(csp.includes(documents.libraries.libraries[0].url), csp);
        assert.equal(csp.includes('marketplace.rafflex.io.test'), false);
    });

    test('shows a render error inside the frame', async () => {
        writeFileSync(join(directory, 'template.twig'), '{{ plays|raw }}');

        try {
            const frame = await get(`${server.url}frame`);

            assert.match(frame.body, /<strong>Preview error:<\/strong> Filter &quot;raw&quot; is not allowed in &quot;template\.twig&quot; at line 1\./);
        } finally {
            writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} plays</p>');
        }
    });

    test('reports problems with the verdict note and the rules warnings', async () => {
        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }}</p><script>fetch("/x")</script>');

        try {
            const problems = JSON.parse((await get(`${server.url}__rafflex/problems?scenario=mixed&play_count=5`)).body);

            assert.deepEqual(problems.issues.map((issue) => issue.message), ['External network calls are not allowed (fetch).']);
            assert.deepEqual(problems.warnings, ['a warning']);
            assert.equal(problems.note, "The marketplace's own check is the final verdict.");
            assert.deepEqual(problems.files.map((file) => file.tag).sort(), ['background', 'prize-box', 'three']);
        } finally {
            writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} plays</p>');
        }
    });

    test('serves assets with CORS for the opaque origin frame, and nothing outside assets/', async () => {
        const model = await get(`${server.url}assets/prize-box.glb`);

        assert.equal(model.status, 200);
        assert.equal(model.headers['content-type'], 'model/gltf-binary');
        assert.equal(model.headers['access-control-allow-origin'], '*');
        assert.equal((await get(`${server.url}assets/..%2Frafflex.json`)).status, 404);
        assert.equal((await get(`${server.url}assets/%2E%2E/template.twig`)).status, 404);
    });

    test('refuses requests for another host name', async () => {
        assert.equal((await get(server.url, { Host: 'attacker.example' })).status, 403);
    });

    test('streams a reload event when a project file changes', async () => {
        const reload = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('no reload event')), 5000);

            request(`${server.url}__rafflex/events`, (response) => {
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
