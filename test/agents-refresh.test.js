import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { refreshAgentsMarkdown } from '../src/agents-md.js';
import { loadWorkspace } from '../src/workspace.js';
import { runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { temporaryDirectory, temporaryWorkspace } from './helpers/project.js';

const skeletons = JSON.parse(readFileSync(new URL('./fixtures/endpoints/skeletons.json', import.meta.url), 'utf8'));

/**
 * @param {string} text
 */
function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * @param {string} path
 */
function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

describe('AGENTS.md refresh on status', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    /**
     * A workspace made by init against the fixture marketplace.
     */
    async function initialisedWorkspace(baseUrl = server.baseUrl) {
        const directory = temporaryDirectory();
        const init = await runJson(['init'], { cwd: directory, baseUrl });

        assert.equal(init.code, 0);

        return directory;
    }

    test('init records the hash of the AGENTS.md it wrote, and status reports it current', async () => {
        const directory = await initialisedWorkspace();
        const agents = readFileSync(join(directory, 'AGENTS.md'), 'utf8');
        const status = await runJson(['status'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(readJson(join(directory, 'rafflex.json')).agents_md_sha256, sha256(agents));
        assert.equal(status.code, 0);
        assert.equal(status.output.agents_md, 'current');
        assert.equal(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), agents);
    });

    test("rewrites the kit's own AGENTS.md when the marketplace's guidance changes", async () => {
        const directory = await initialisedWorkspace();

        server.changeDocument('skeletons', (skeletons) => ({ ...skeletons, version: `${skeletons.version}-agents`, workspace: { ...skeletons.workspace, agents_md: '# New guidance\n' } }));

        try {
            const status = await runJson(['status'], { cwd: directory, baseUrl: server.baseUrl });
            const again = await runJson(['status'], { cwd: directory, baseUrl: server.baseUrl });

            assert.equal(status.output.agents_md, 'updated');
            assert.equal(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), '# New guidance\n');
            assert.equal(readJson(join(directory, 'rafflex.json')).agents_md_sha256, sha256('# New guidance\n'));
            assert.equal(readJson(join(directory, 'rafflex.json')).workspace, 1);
            assert.equal(again.output.agents_md, 'current');
        } finally {
            server.changeDocument('skeletons', () => skeletons);
        }
    });

    test('leaves an AGENTS.md the creator edited alone', async () => {
        const directory = await initialisedWorkspace();

        writeFileSync(join(directory, 'AGENTS.md'), '# My own rules\n');

        const status = await runJson(['status'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(status.output.agents_md, 'customised');
        assert.equal(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), '# My own rules\n');
    });

    test('reports unknown offline with no cached guidance', async () => {
        const root = temporaryWorkspace();

        writeFileSync(join(root, 'AGENTS.md'), '# Rafflex\n');

        const status = await runJson(['status'], { cwd: root });

        assert.equal(status.code, 0);
        assert.equal(status.output.agents_md, 'unknown');
    });

    test('uses the cached guidance offline', async () => {
        const marketplace = await startFixtureServer();
        const directory = await initialisedWorkspace(marketplace.baseUrl);

        await marketplace.close();
        writeFileSync(join(directory, 'AGENTS.md'), '# Old kit copy\n');
        writeFileSync(join(directory, 'rafflex.json'), `${JSON.stringify({ workspace: 1, agents_md_sha256: sha256('# Old kit copy\n') }, null, 2)}\n`);

        const status = await runJson(['status'], { cwd: directory, baseUrl: marketplace.baseUrl });

        assert.equal(status.output.agents_md, 'updated');
        assert.equal(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), skeletons.workspace.agents_md);
    });

    test('a missing AGENTS.md is the creator\'s choice and is not recreated', () => {
        const root = temporaryWorkspace();

        rmSync(join(root, 'AGENTS.md'), { force: true });

        assert.equal(refreshAgentsMarkdown(loadWorkspace(root), '# Guidance\n'), 'customised');
        assert.equal(refreshAgentsMarkdown(loadWorkspace(root), null), 'unknown');
    });
});
