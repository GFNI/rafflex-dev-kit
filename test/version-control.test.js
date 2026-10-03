import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureIgnored } from '../src/git.js';
import { bundleFile, bundleFixture, serveFixtureMedia } from './helpers/bundles.js';
import { isolatedGitEnv, run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { startMediaServer } from './helpers/media-server.js';
import { temporaryDirectory, temporaryWorkspace } from './helpers/project.js';

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } }).trim();
}

/**
 * @param {string} root
 */
function initRepository(root) {
    ensureIgnored(root);
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'Scaffold']);
}

describe('version control', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let marketplace;
    /** @type {Awaited<ReturnType<typeof startMediaServer>>} */
    let media;

    before(async () => {
        marketplace = await startFixtureServer();
        media = await startMediaServer();
        serveFixtureMedia(media);
    });

    after(async () => {
        await marketplace.close();
        await media.close();
    });

    /**
     * A git workspace with spin-to-win imported from the marketplace.
     */
    async function importedWorkspace() {
        const root = temporaryWorkspace();

        initRepository(root);

        const bundle = bundleFixture('spin-to-win', media.baseUrl);
        const imported = await runJson(['import', bundleFile(bundle)], { cwd: root, baseUrl: marketplace.baseUrl });

        return { root, bundle, imported, directory: join(root, 'games', 'spin-to-win') };
    }

    test('import commits the product as "Import <slug> from the marketplace"', async () => {
        const { root, imported } = await importedWorkspace();

        assert.equal(imported.output.git.committed, true);
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Import spin-to-win from the marketplace');
        assert.equal(git(root, ['status', '--porcelain']), '');
    });

    test('importing a reverted draft commits it as a revert, and keeps tests/', async () => {
        const { root, bundle, directory } = await importedWorkspace();

        mkdirSync(join(directory, 'tests'));
        writeFileSync(join(directory, 'tests', 'reveal.spec.mjs'), 'export default () => {};\n');
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'Add a spec']);

        const reverted = { ...bundle, product: { ...bundle.product, draft: { ...bundle.product.draft, version: '3.0.1', reverted_from: '2.0.0' } } };
        const { output } = await runJson(['import', bundleFile(reverted), '--force'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(output.git.committed, true);
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Revert spin-to-win to 2.0.0 as 3.0.1');
        assert.equal(readFileSync(join(directory, 'tests', 'reveal.spec.mjs'), 'utf8'), 'export default () => {};\n');
    });

    test('synced commits only the product folder after a push, with the draft revision', async () => {
        const { root, bundle, directory } = await importedWorkspace();

        writeFileSync(join(root, 'notes.txt'), 'unrelated work');
        writeFileSync(join(directory, 'template.twig'), '<p>pushed</p>\n');

        const pushed = { ...bundle.product, draft: { ...bundle.product.draft, template: '<p>pushed</p>\n', revision: 8 } };
        const synced = await runJson(['synced', 'spin-to-win'], { cwd: root, input: JSON.stringify(pushed) });

        assert.equal(synced.output.git.committed, true);
        assert.equal(synced.output.remote.branch, 'main');
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Push spin-to-win 1.3.0 (draft revision 8)');
        assert.equal(git(root, ['status', '--porcelain']), '?? notes.txt');

        const again = await runJson(['synced', 'spin-to-win'], { cwd: root, input: JSON.stringify(pushed) });

        assert.equal(again.output.git.committed, false);
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Push spin-to-win 1.3.0 (draft revision 8)');
    });

    test('status warns when the workspace is not on the branch the last sync was recorded on', async () => {
        const { root, bundle } = await importedWorkspace();

        await runJson(['synced', 'spin-to-win'], { cwd: root, input: JSON.stringify({ ...bundle.product, draft: { ...bundle.product.draft, revision: 8 } }) });
        git(root, ['checkout', '-q', '-b', 'experiment']);

        const { output } = await runJson(['status', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(output.git.branch, 'experiment');
        assert.deepEqual(output.products[0].warnings, ['The last sync was recorded on the main branch, but the workspace is on experiment. Switch back before pushing, or record the product again with request_sync and synced.']);
        assert.match((await run(['status'], { cwd: root, baseUrl: marketplace.baseUrl })).stdout, /warning: The last sync was recorded on the main branch/);
    });

    test('restore last-push lists what it discards, then returns the product to its last push, keeping tests/', async () => {
        const { root, directory } = await importedWorkspace();
        const original = readFileSync(join(directory, 'template.twig'), 'utf8');

        writeFileSync(join(directory, 'template.twig'), '<p>unpushed</p>\n');
        writeFileSync(join(directory, 'assets', 'extra.png'), 'extra');
        mkdirSync(join(directory, 'tests'));
        writeFileSync(join(directory, 'tests', 'mine.spec.mjs'), 'export default () => {};\n');

        const asked = await runJson(['restore', 'spin-to-win', 'last-push'], { cwd: root });

        assert.equal(asked.code, 1);
        assert.equal(asked.output.needs_confirmation, true);
        assert.equal(asked.output.subject, 'Import spin-to-win from the marketplace');
        assert.deepEqual(asked.output.discarded.sort(), ['A assets/extra.png', 'M template.twig']);
        assert.equal(readFileSync(join(directory, 'template.twig'), 'utf8'), '<p>unpushed</p>\n');

        const restored = await runJson(['restore', 'spin-to-win', 'last-push', '--yes'], { cwd: root });

        assert.equal(restored.code, 0);
        assert.equal(restored.output.restored, true);
        assert.equal(readFileSync(join(directory, 'template.twig'), 'utf8'), original);
        assert.equal(existsSync(join(directory, 'assets', 'extra.png')), false);
        assert.equal(readFileSync(join(directory, 'tests', 'mine.spec.mjs'), 'utf8'), 'export default () => {};\n');
        assert.match((await run(['restore', 'spin-to-win', 'last-push'], { cwd: root })).stdout, /already matches its last push/);
    });

    test('restore without git explains the export_product and import route', async () => {
        const root = temporaryWorkspace({ products: [{ folder: 'spin-to-win', slug: 'spin-to-win' }] });
        const { code, output } = await runJson(['restore', 'spin-to-win', 'last-push'], { cwd: root });

        assert.equal(code, 1);
        assert.equal(output.restored, false);
        assert.match(output.export_fallback, /export_product, then run npx @rafflex\/dev import <bundle_url> --force/);
        assert.match((await run(['restore', 'spin-to-win', 'earlier'], { cwd: root })).stderr, /use revert_to_version on the marketplace/);
    });

    test('tests/ and .results/ are never in a push plan', async () => {
        const { root, directory } = await importedWorkspace();

        mkdirSync(join(directory, 'tests'));
        writeFileSync(join(directory, 'tests', 'mine.spec.mjs'), 'export default () => {};\n');
        mkdirSync(join(directory, '.results', 'screenshots'), { recursive: true });
        writeFileSync(join(directory, '.results', 'screenshots', 'mixed-phone.png'), 'png');

        const { output } = await runJson(['plan', 'spin-to-win'], { cwd: root, baseUrl: marketplace.baseUrl });

        assert.equal(output.nothing_to_push, true, JSON.stringify(output));
        assert.deepEqual(output.assets, []);
    });

    test('the workspace ignores the kit cache and every .results folder', async () => {
        const directory = temporaryDirectory();

        await runJson(['init'], { cwd: directory, baseUrl: marketplace.baseUrl });

        const ignore = readFileSync(join(directory, '.gitignore'), 'utf8');

        assert.match(ignore, /^\.rafflex\/$/m);
        assert.match(ignore, /^\.results\/$/m);
        assert.deepEqual(ensureIgnored(directory), { created: false, added: [] });

        writeFileSync(join(directory, '.gitignore'), 'node_modules/\n.rafflex/\n');
        assert.deepEqual(ensureIgnored(directory), { created: false, added: ['.results/'] });
    });
});
