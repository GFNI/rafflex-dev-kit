import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { listingHash, optionOverridesHash, templateHash } from '../src/sync-state.js';
import { isolatedGitEnv, run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { addProduct, temporaryDirectory, temporaryWorkspace } from './helpers/project.js';

const skeletons = JSON.parse(readFileSync(new URL('./fixtures/endpoints/skeletons.json', import.meta.url), 'utf8'));

/**
 * @param {string} directory
 * @param {string[]} args
 */
function git(directory, args) {
    return spawnSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } });
}

const hasGit = git(temporaryDirectory(), ['--version']).status === 0;

/**
 * @param {string} directory
 */
function readJson(directory) {
    return JSON.parse(readFileSync(directory, 'utf8'));
}

describe('workspace commands', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    describe('init', () => {
        test('creates the workspace files and type folders, and commits them with git', { skip: !hasGit }, async () => {
            const directory = temporaryDirectory();
            const { code, output } = await runJson(['init'], { cwd: directory, baseUrl: server.baseUrl });

            assert.equal(code, 0);
            assert.equal(readFileSync(join(directory, 'rafflex.json'), 'utf8'), `{\n  "workspace": 1,\n  "agents_md_sha256": "${createHash('sha256').update(skeletons.workspace.agents_md).digest('hex')}"\n}\n`);
            assert.equal(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), skeletons.workspace.agents_md);
            assert.equal(readFileSync(join(directory, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
            assert.match(readFileSync(join(directory, '.gitignore'), 'utf8'), /^\.rafflex\/$/m);
            assert.ok(existsSync(join(directory, 'games', '.gitkeep')));
            assert.ok(existsSync(join(directory, 'blocks', '.gitkeep')));
            assert.deepEqual(output.created, ['rafflex.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore', 'games/', 'blocks/']);
            assert.deepEqual(output.git, { installed: true, initialised: true, committed: true, note: null });
            assert.equal(git(directory, ['log', '--format=%s']).stdout.trim(), 'Set up Rafflex workspace');
            assert.equal(git(directory, ['status', '--porcelain']).stdout, '');
            assert.equal(git(directory, ['ls-files', '.rafflex']).stdout, '', 'the cache is ignored');
        });

        test('leaves the scaffold uncommitted when git has no identity', { skip: !hasGit }, async () => {
            const directory = temporaryDirectory();
            const { code, output } = await runJson(['init'], {
                cwd: directory,
                baseUrl: server.baseUrl,
                env: { GIT_CONFIG_GLOBAL: join(temporaryDirectory(), 'none'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '', EMAIL: '' },
            });

            assert.equal(code, 0);
            assert.equal(output.git.initialised, true);
            assert.equal(output.git.committed, false);
            assert.match(output.git.note, /left uncommitted/);
            assert.ok(existsSync(join(directory, '.git')));
        });

        test('does not start a repository inside an existing one', { skip: !hasGit }, async () => {
            const repository = temporaryDirectory();

            git(repository, ['init', '-q']);
            mkdirSync(join(repository, 'rafflex'));

            const { output } = await runJson(['init'], { cwd: join(repository, 'rafflex'), baseUrl: server.baseUrl });

            assert.equal(output.git.initialised, false);
            assert.match(output.git.note, /already inside a git repository/);
        });

        test('is refused inside an existing workspace', async () => {
            const root = temporaryWorkspace();

            mkdirSync(join(root, 'games', 'x'), { recursive: true });

            const result = await run(['init'], { cwd: join(root, 'games', 'x'), baseUrl: server.baseUrl });

            assert.equal(result.code, 1);
            assert.match(result.stderr, /already a Rafflex workspace/);
            assert.equal(existsSync(join(root, 'games', 'x', 'rafflex.json')), false);
        });

        test('writes a stand in AGENTS.md when the marketplace predates the workspace guidance', async () => {
            const oldServer = await startFixtureServer();

            oldServer.changeDocument('skeletons', ({ workspace, ...rest }) => ({ ...rest, version: 'old-skeletons' }));

            try {
                const directory = temporaryDirectory();
                const { code, output } = await runJson(['init'], { cwd: directory, baseUrl: oldServer.baseUrl });

                assert.equal(code, 0);
                assert.match(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), /llms\.txt/);
                assert.ok(output.warnings.some((/** @type {string} */ warning) => /stand in/.test(warning)));
            } finally {
                await oldServer.close();
            }
        });

        test('works offline with the default type folders', async () => {
            const directory = temporaryDirectory();
            const { code, output } = await runJson(['init'], { cwd: directory });

            assert.equal(code, 0);
            assert.ok(existsSync(join(directory, 'games')));
            assert.ok(existsSync(join(directory, 'blocks')));
            assert.match(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), /llms\.txt/);
            assert.ok(output.warnings.some((/** @type {string} */ warning) => /Could not read/.test(warning)));
        });
    });

    describe('new', () => {
        test('adds a product folder from the starter template', async () => {
            const root = temporaryWorkspace();
            const { code, output } = await runJson(['new', 'block', 'Winner Wall!'], { cwd: root, baseUrl: server.baseUrl });
            const directory = join(root, 'blocks', 'winner-wall');

            assert.equal(code, 0);
            assert.equal(output.product, 'blocks/winner-wall');
            assert.equal(readFileSync(join(directory, 'product.json'), 'utf8'), '{\n  "type": "block",\n  "slug": null,\n  "title": "Winner Wall!",\n  "version": "1.0.0",\n  "remote": null\n}\n');
            assert.equal(readFileSync(join(directory, 'template.twig'), 'utf8'), skeletons.block);
            assert.equal(readFileSync(join(directory, 'options.json'), 'utf8'), '{}\n');
            assert.equal(readFileSync(join(directory, 'listing.md'), 'utf8'), '---\ncategory_ids: []\ntag_names: []\nvideo_url: ""\n---\n\n## Description\n\n## Documentation\n\n## Install notes\n');
            assert.equal(readFileSync(join(directory, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\n## Unreleased\n');
            assert.equal(readFileSync(join(directory, 'assets', '.gitkeep'), 'utf8'), '');
        });

        test('the platform starters come out formatted and with no issues', async () => {
            const root = temporaryWorkspace();

            await runJson(['new', 'game', 'Starter Game'], { cwd: root, baseUrl: server.baseUrl });
            await runJson(['new', 'block', 'Starter Block'], { cwd: root, baseUrl: server.baseUrl });

            const { code, output } = await runJson(['check', '--all'], { cwd: root, baseUrl: server.baseUrl });

            assert.equal(code, 0);
            assert.deepEqual(output.products.map((/** @type {{product: string, issues: {code: string}[]}} */ product) => [product.product, product.issues.map((issue) => issue.code)]), [
                ['games/starter-game', []],
                ['blocks/starter-block', []],
            ]);
        });

        test('takes --type and works from anywhere in the workspace', async () => {
            const root = temporaryWorkspace({ products: [{ title: 'Spin to Win' }] });
            const { code } = await runJson(['new', '--type', 'games', 'Scratch Card'], { cwd: join(root, 'games', 'spin-to-win'), baseUrl: server.baseUrl });

            assert.equal(code, 0);
            assert.equal(readFileSync(join(root, 'games', 'scratch-card', 'template.twig'), 'utf8'), skeletons.game);
        });

        test('refuses an existing folder, an unknown type, and a title with nothing to name a folder', async () => {
            const root = temporaryWorkspace({ products: [{ title: 'Spin to Win' }] });
            const existing = await runJson(['new', 'game', 'Spin to Win'], { cwd: root, baseUrl: server.baseUrl });
            const unknown = await runJson(['new', 'widget', 'X'], { cwd: root, baseUrl: server.baseUrl });
            const empty = await runJson(['new', 'game', '!!!'], { cwd: root, baseUrl: server.baseUrl });

            assert.equal(existing.code, 1);
            assert.match(existing.output.error, /games\/spin-to-win already exists/);
            assert.equal(unknown.code, 2);
            assert.match(unknown.output.error, /Use game or block/);
            assert.equal(empty.code, 2);
        });
    });

    describe('status', () => {
        test('reports every product offline, never synced and in sync', async () => {
            const template = '<p>{{ play_count }}</p>\n';
            const root = temporaryWorkspace({
                products: [
                    { title: 'Brand New' },
                    {
                        title: 'Spin to Win',
                        slug: 'spin-to-win',
                        version: '1.1.0',
                        template,
                        assets: { 'background.png': 'png' },
                        remote: {
                            synced_at: new Date().toISOString(),
                            status: 'published',
                            live_version: '1.0.0',
                            live_channel: 'stable',
                            draft: { version: '1.1.0', revision: 7, submitted: true, template_sha256: templateHash(template), option_overrides_sha256: optionOverridesHash({}) },
                            listing_sha256: listingHash({}),
                            latest_review: { decision: 'changes_requested', reasons: ['Fix the button'] },
                            media: [{ tag: 'background', filename: 'background.png', sha256: templateHash('png'), kind: 'image', library: null }],
                        },
                    },
                ],
            });
            const { code, output } = await runJson(['status'], { cwd: root });
            const [fresh, synced] = output.products;

            assert.equal(code, 0);
            assert.equal(output.workspace, realpathSync(root));
            assert.equal(typeof output.git.installed, 'boolean');
            assert.equal(output.git.repository, false);
            assert.equal(fresh.product, 'games/brand-new');
            assert.equal(fresh.remote, null);
            assert.equal(fresh.stale_remote, true);
            assert.equal(fresh.changes.template, true);
            assert.deepEqual(synced.remote, {
                status: 'published',
                live_version: '1.0.0',
                live_channel: 'stable',
                draft: { version: '1.1.0', revision: 7, submitted: true },
                latest_review: { decision: 'changes_requested', reasons: ['Fix the button'] },
                synced_at: synced.remote.synced_at,
            });
            assert.equal(synced.in_review, true);
            assert.equal(synced.stale_remote, false);
            assert.deepEqual(synced.changes, { template: false, options: false, listing: false, assets: { new: [], changed: [], removed: [] }, any: false });

            writeFileSync(join(root, 'games', 'spin-to-win', 'assets', 'logo.png'), 'logo');
            writeFileSync(join(root, 'games', 'spin-to-win', 'template.twig'), '<p>changed</p>');

            const human = await run(['status', 'spin-to-win'], { cwd: root });

            assert.match(human.stdout, /games\/spin-to-win {2}Spin to Win 1\.1\.0 \(spin-to-win\)/);
            assert.match(human.stdout, /remote: published, live 1\.0\.0 \(stable\), draft 1\.1\.0 r7 in review, review changes_requested/);
            assert.match(human.stdout, /local: template, assets \(1 new\) changed since the last sync/);
            assert.doesNotMatch(human.stdout, /Brand New/);
        });

        test('reports a broken listing as a problem without failing the others', async () => {
            const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', listing: '---\ncategory_ids: [x]\n---\n' }] });
            const { code, output } = await runJson(['status'], { cwd: root });

            assert.equal(code, 0);
            assert.equal(output.products[0].changes.listing, true);
            assert.match(output.products[0].problems[0], /category_ids/);
        });
    });

    describe('version', () => {
        test('bumps from the current version, inside the product or by name', async () => {
            const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win', version: '1.2.3' }] });
            const directory = join(root, 'games', 'spin-to-win');
            const minor = await runJson(['version', 'minor'], { cwd: directory });

            assert.equal(minor.code, 0);
            assert.deepEqual(minor.output, { product: 'games/spin-to-win', previous_version: '1.2.3', version: '1.3.0' });

            const major = await runJson(['version', 'spin-to-win', 'major'], { cwd: root });
            const explicit = await runJson(['version', 'spin-to-win', '2.0.5'], { cwd: root });

            assert.equal(major.output.version, '2.0.0');
            assert.equal(explicit.output.version, '2.0.5');
            assert.equal(readJson(join(directory, 'product.json')).version, '2.0.5');
            assert.ok(readFileSync(join(directory, 'product.json'), 'utf8').endsWith('}\n'));
        });

        test('refuses while in review, at or below the live version, and anything not a version', async () => {
            const remote = { synced_at: new Date().toISOString(), status: 'published', live_version: '1.2.0', live_channel: 'stable', draft: { version: '1.3.0', revision: 2, submitted: true }, listing_sha256: null, latest_review: null, media: [] };
            const root = temporaryWorkspace({
                products: [
                    { title: 'In Review', version: '1.3.0', remote },
                    { title: 'Drafting', version: '1.3.0', remote: { ...remote, draft: { ...remote.draft, submitted: false } } },
                ],
            });
            const inReview = await runJson(['version', 'in-review', 'patch'], { cwd: root });
            const belowLive = await runJson(['version', 'drafting', '1.1.9'], { cwd: root });
            const invalid = await runJson(['version', 'drafting', '1.3'], { cwd: root });

            assert.equal(inReview.code, 1);
            assert.match(inReview.output.error, /in review/);
            assert.equal(belowLive.code, 1);
            assert.match(belowLive.output.error, /not higher than the live version 1\.2\.0/);
            assert.equal(invalid.code, 2);
            assert.equal(readJson(join(root, 'games', 'in-review', 'product.json')).version, '1.3.0');
            assert.equal(readJson(join(root, 'games', 'drafting', 'product.json')).version, '1.3.0');
        });

        test('needs a product outside a product folder', async () => {
            const root = temporaryWorkspace();

            addProduct(root, { title: 'Spin to Win' });

            const result = await run(['version', 'patch'], { cwd: root });

            assert.equal(result.code, 2);
            assert.match(result.stderr, /Name a product/);
        });
    });
});
