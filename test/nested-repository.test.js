import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureIgnored } from '../src/git.js';
import { bundleFile, bundleFixture, serveFixtureMedia } from './helpers/bundles.js';
import { isolatedGitEnv, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { startMediaServer } from './helpers/media-server.js';
import { temporaryDirectory, temporaryWorkspace } from './helpers/project.js';
import { marketplaceProduct, sha256, startFakeMarketplace } from './helpers/sync-server.js';

const template = '<p>{{ play_count }}</p>\n';
const png = (/** @type {string} */ text) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } }).trim();
}

/**
 * A repository whose workspace is two folders below its top, beside other
 * work, everything committed.
 *
 * @param {import('./helpers/project.js').ProductSpec[]} products
 */
function nestedWorkspace(products) {
    const outer = temporaryDirectory('rafflex-outer-');
    const workspace = join(outer, 'sites', 'rafflex');

    mkdirSync(join(outer, 'sites'), { recursive: true });
    cpSync(temporaryWorkspace({ products }), workspace, { recursive: true });
    ensureIgnored(workspace);
    writeFileSync(join(outer, 'README.md'), 'Other work\n');
    git(outer, ['init', '-q', '-b', 'main']);
    git(outer, ['add', '-A']);
    git(outer, ['commit', '-q', '-m', 'Scaffold']);

    return { outer, workspace, prefix: 'sites/rafflex' };
}

describe('a workspace inside a larger git repository', () => {
    /** @type {Awaited<ReturnType<typeof startFakeMarketplace>>} */
    let marketplace;

    before(async () => {
        marketplace = await startFakeMarketplace();
    });

    after(() => marketplace.close());

    const kit = (/** @type {string[]} */ args, /** @type {string} */ cwd) => runJson(args, { cwd, baseUrl: marketplace.baseUrl });

    test('synced, a partial push, restore, and release commit only inside the workspace', async () => {
        marketplace.seed(marketplaceProduct({ slug: 'nest', title: 'nest', draft: { version: '1.0.0', revision: 1, channel: 'stable', changelog: null, template, option_overrides: {}, submitted: false } }));

        const { outer, workspace, prefix } = nestedWorkspace([{ title: 'nest', slug: 'nest', template, changelog: '# Changelog\n\n## Unreleased\n\nNotes.\n' }]);
        const directory = join(workspace, 'games', 'nest');
        const synced = await kit(['synced', 'nest', marketplace.issueLink('nest')], workspace);

        assert.equal(synced.code, 0, JSON.stringify(synced.output));
        assert.equal(synced.output.git.committed, true);
        assert.equal(git(outer, ['status', '--porcelain']), '');

        writeFileSync(join(directory, 'assets', 'a.png'), png('a'));
        writeFileSync(join(directory, 'assets', 'b.png'), png('b'));
        git(outer, ['add', '-A']);
        git(outer, ['commit', '-q', '-m', 'Two images']);
        assert.equal((await kit(['push', 'games/nest', marketplace.issueLink('nest')], workspace)).code, 0);

        writeFileSync(join(directory, 'assets', 'b.png'), png('b2'));
        writeFileSync(join(directory, 'template.twig'), '<p>v3 {{ play_count }}</p>\n');
        marketplace.behaviour.failUploads.add('b.png');

        try {
            const partial = await kit(['push', 'games/nest', marketplace.issueLink('nest')], workspace);

            assert.equal(partial.code, 1);
            assert.equal(partial.output.commit_message, 'Push nest 1.0.0 (draft revision 2, 1 file not uploaded)');
        } finally {
            marketplace.behaviour.failUploads.clear();
        }

        const committedB = git(outer, ['rev-parse', `HEAD:${prefix}/games/nest/assets/b.png`]);

        assert.equal(git(outer, ['cat-file', '-p', committedB]), png('b').toString());
        assert.equal(git(outer, ['show', `HEAD:${prefix}/games/nest/template.twig`]), '<p>v3 {{ play_count }}</p>');
        assert.deepEqual(git(outer, ['ls-tree', '--name-only', 'HEAD']).split('\n').sort(), ['README.md', 'sites']);
        assert.equal(git(outer, ['diff', '--cached', '--name-only']), '');
        assert.equal(git(outer, ['status', '--porcelain', '--untracked-files=all']).split('\n').length, 1);
        assert.equal(git(outer, ['diff', '--name-only']), `${prefix}/games/nest/assets/b.png`);

        const asked = await kit(['restore', 'nest', 'last-push'], workspace);

        assert.deepEqual(asked.output.discarded, ['M assets/b.png']);

        const restored = await kit(['restore', 'nest', 'last-push', '--yes'], workspace);

        assert.equal(restored.code, 0);
        assert.deepEqual(readFileSync(join(directory, 'assets', 'b.png')), png('b'));
        assert.equal(git(outer, ['status', '--porcelain']), '');

        const product = /** @type {Record<string, any>} */ (marketplace.products.get('nest'));

        product.draft = { ...product.draft, submitted: true };

        const released = await kit(['release', 'nest', marketplace.issueLink('nest')], workspace);

        assert.equal(released.code, 0, JSON.stringify(released.output));
        assert.equal(git(outer, ['tag']), 'nest@1.0.0');
        assert.equal(git(outer, ['log', '-1', '--format=%s']), 'Release nest 1.0.0');
        assert.equal(git(outer, ['status', '--porcelain']), '');
        assert.equal(sha256(readFileSync(join(directory, 'assets', 'a.png'))), sha256(png('a')));
    });
});

describe('import inside a larger git repository', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let fixtures;
    /** @type {Awaited<ReturnType<typeof startMediaServer>>} */
    let media;

    before(async () => {
        fixtures = await startFixtureServer();
        media = await startMediaServer();
        serveFixtureMedia(media);
    });

    after(async () => {
        await fixtures.close();
        await media.close();
    });

    test('commits the imported product inside the workspace, and restore finds it', async () => {
        const { outer, workspace, prefix } = nestedWorkspace([]);
        const imported = await runJson(['import', bundleFile(bundleFixture('spin-to-win', media.baseUrl))], { cwd: workspace, baseUrl: fixtures.baseUrl });

        assert.equal(imported.code, 0, JSON.stringify(imported.output));
        assert.equal(git(outer, ['log', '-1', '--format=%s']), 'Import spin-to-win from the marketplace');
        assert.equal(git(outer, ['status', '--porcelain']), '');
        assert.ok(git(outer, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').includes(`${prefix}/games/spin-to-win/template.twig`));

        writeFileSync(join(workspace, 'games', 'spin-to-win', 'template.twig'), '<p>unpushed</p>\n');

        const restored = await runJson(['restore', 'spin-to-win', 'last-push', '--yes'], { cwd: workspace });

        assert.equal(restored.code, 0);
        assert.deepEqual(restored.output.discarded, ['M template.twig']);
        assert.equal(git(outer, ['status', '--porcelain']), '');
    });
});
