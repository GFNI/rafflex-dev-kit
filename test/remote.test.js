import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadDocuments, resolveBaseUrl, RulesUnavailableError, SupportedContract } from '../src/remote.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { temporaryDirectory } from './helpers/project.js';

describe('rules and data from the marketplace', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    test('fetches the manifest and documents, caches them, and sends nothing but GETs', async () => {
        const directory = temporaryDirectory();
        const loaded = await loadDocuments({ workspaceDirectory: directory, baseUrl: server.baseUrl });

        assert.equal(loaded.offline, false);
        assert.deepEqual(loaded.warnings, []);
        assert.deepEqual(Object.keys(loaded.documents), ['rules', 'contexts', 'skeletons', 'libraries', 'categories']);
        assert.equal(loaded.documents.categories.categories.length > 0, true);
        assert.ok(existsSync(join(loaded.cacheDirectory, 'rules.json')));
        assert.ok(server.requests.every((request) => request.method === 'GET' && request.headers.authorization === undefined && request.headers.cookie === undefined));
    });

    test('refuses a rules contract newer than the kit understands', async () => {
        const directory = temporaryDirectory();

        server.changeManifest((manifest) => ({ ...manifest, contract: SupportedContract + 1, version: 'contract-next' }));

        try {
            await assert.rejects(
                loadDocuments({ workspaceDirectory: directory, baseUrl: server.baseUrl }),
                (error) => error instanceof RulesUnavailableError && /npx @rafflex\/dev@latest/.test(error.message),
            );
        } finally {
            server.changeManifest((manifest) => ({ ...manifest, contract: SupportedContract }));
        }
    });

    test('reuses the cache when the manifest versions match, without refetching documents', async () => {
        const directory = temporaryDirectory();

        await loadDocuments({ workspaceDirectory: directory, baseUrl: server.baseUrl });
        server.requests.length = 0;
        await loadDocuments({ workspaceDirectory: directory, baseUrl: server.baseUrl });

        assert.deepEqual(server.requests.map((request) => request.url), ['/dev-kit/manifest.json']);
        assert.match(server.requests[0].ifNoneMatch ?? '', /^".+"$/);
    });

    test('refreshes a document whose version changed', async () => {
        const directory = temporaryDirectory();

        await loadDocuments({ workspaceDirectory: directory, baseUrl: server.baseUrl });
        server.changeDocument('rules', (rules) => ({ ...rules, version: 'changed00001', template_max_bytes: 10 }));

        const loaded = await loadDocuments({ workspaceDirectory: directory, baseUrl: server.baseUrl });

        assert.equal(loaded.documents.rules.template_max_bytes, 10);
        assert.deepEqual(loaded.warnings, []);
    });

    test('warns when the cached rules are older than the marketplace and cannot be refreshed', async () => {
        const directory = temporaryDirectory();

        await loadDocuments({ workspaceDirectory: directory, baseUrl: server.baseUrl });
        server.changeDocument('rules', (rules) => ({ ...rules, version: 'changed00002' }));
        server.failing.add('rules');

        try {
            const loaded = await loadDocuments({ workspaceDirectory: directory, baseUrl: server.baseUrl });

            assert.equal(loaded.documents.rules.version === 'changed00002', false);
            assert.equal(loaded.warnings.length, 1);
            assert.match(loaded.warnings[0], /^Your cached rules are older than the marketplace's \(rules\.json could not be refreshed\)/);
        } finally {
            server.failing.delete('rules');
        }
    });

    test('works offline from the cache', async () => {
        const directory = temporaryDirectory();
        const offlineServer = await startFixtureServer();

        await loadDocuments({ workspaceDirectory: directory, baseUrl: offlineServer.baseUrl });
        await offlineServer.close();

        const loaded = await loadDocuments({ workspaceDirectory: directory, baseUrl: offlineServer.baseUrl });

        assert.equal(loaded.offline, true);
        assert.ok(loaded.documents.rules.sandbox);
        assert.match(loaded.warnings[0], /^Working offline with the cached rules/);
    });

    test('explains what to do with neither network nor cache', async () => {
        const offlineServer = await startFixtureServer();

        await offlineServer.close();

        await assert.rejects(
            loadDocuments({ workspaceDirectory: temporaryDirectory(), baseUrl: offlineServer.baseUrl }),
            (error) => error instanceof RulesUnavailableError && /no cached copy of rules\.json/.test(error.message) && /Connect to the internet/.test(error.message),
        );
    });

    test('the base URL comes from RAFFLEX_BASE_URL, then rafflex.json, then production', () => {
        assert.equal(resolveBaseUrl({ base_url: 'https://a.test/' }, { RAFFLEX_BASE_URL: 'https://b.test' }), 'https://b.test');
        assert.equal(resolveBaseUrl({ base_url: 'https://a.test/' }, {}), 'https://a.test');
        assert.equal(resolveBaseUrl(null, {}), 'https://marketplace.rafflex.io');
    });
});
