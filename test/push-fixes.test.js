import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { download, fetchBundleText, parseBundle } from '../src/commands/import.js';
import { draftChangedElsewhere, freshVerifyResult, withoutLandedFileTags, withUploadPaths } from '../src/commands/push.js';
import { rulesFingerprint, saveVerifyResult } from '../src/commands/verify.js';
import { ensureIgnored } from '../src/git.js';
import { canonicalListing } from '../src/listing.js';
import { recordProductState, UnsafeSlugError } from '../src/record-sync.js';
import { confinedWritePath } from '../src/safe-paths.js';
import { refusalFrom } from '../src/sync-link.js';
import { loadWorkspace, selectProduct } from '../src/workspace.js';
import { isolatedGitEnv, run, runJson } from './helpers/cli.js';
import { temporaryDirectory, temporaryWorkspace } from './helpers/project.js';
import { marketplaceProduct, startFakeMarketplace } from './helpers/sync-server.js';

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
 * @param {import('./helpers/project.js').ProductSpec[]} products
 */
function gitWorkspace(products) {
    const root = temporaryWorkspace({ products });

    ensureIgnored(root);
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'Scaffold']);

    return root;
}

/**
 * @param {string} root
 * @param {string} path
 */
function productJson(root, path) {
    return JSON.parse(readFileSync(join(root, path, 'product.json'), 'utf8'));
}

/**
 * A local server answering every request with `handler`.
 *
 * @param {import('node:http').RequestListener} handler
 * @returns {Promise<{url: string, close: () => void}>}
 */
function serve(handler) {
    return new Promise((resolve) => {
        const server = createServer(handler);

        server.listen(0, '127.0.0.1', () => {
            const address = /** @type {import('node:net').AddressInfo} */ (server.address());

            resolve({ url: `http://127.0.0.1:${address.port}`, close: () => { server.closeAllConnections(); server.close(); } });
        });
    });
}

const fixtures = new URL('./fixtures/endpoints/', import.meta.url);

describe('names from outside never leave the workspace', () => {
    test('import refuses a bundle whose media tag or file name is a path, and writes nothing', async () => {
        let downloads = 0;
        const media = await serve((request, response) => {
            downloads++;
            response.end('PWNED');
        });

        try {
            const root = temporaryWorkspace({});
            const product = marketplaceProduct({ slug: 'evil', title: 'Evil', draft: null, versions: [] });

            for (const entry of [{ tag: '../../../escaped', filename: '' }, { tag: 'fine', filename: '../../../escaped.png' }]) {
                const bundle = { format: 1, product, files: { 'template.twig': '<p></p>' }, media: [{ ...entry, url: `${media.url}/x`, sha256: null, kind: 'image', library: null }] };

                writeFileSync(join(root, 'bundle.json'), JSON.stringify(bundle));

                const { code, output } = await runJson(['import', 'bundle.json'], { cwd: root, baseUrl: media.url });

                assert.equal(code, 2);
                assert.match(output.error, /is not a (valid tag|plain file name)/);
                assert.match(output.error, /so nothing was written/);
            }

            assert.equal(downloads, 0);
            assert.equal(existsSync(join(root, 'escaped')), false);
            assert.equal(existsSync(join(dirname(root), 'escaped')), false);
            assert.equal(existsSync(join(root, 'games', 'evil')), false);
        } finally {
            media.close();
        }
    });

    test('parseBundle checks the slug and the type as names', () => {
        const valid = { format: 1, product: { slug: 'ok', type: 'game' }, files: {}, media: [] };

        assert.throws(() => parseBundle(JSON.stringify({ ...valid, product: { slug: 'ok', type: '../games' } })), /not a valid type/);
        assert.throws(() => parseBundle(JSON.stringify({ ...valid, media: [{ tag: 'a', filename: 'x\\y.png' }] })), /not a plain file name/);
        assert.equal(parseBundle(JSON.stringify({ ...valid, media: [{ tag: 'win-jingle', filename: 'Win Jingle.mp3' }] })).media.length, 1);
    });

    test('a write path must stay inside its folder, also through a linked folder', () => {
        const base = temporaryDirectory('rafflex-confined-');
        const outside = temporaryDirectory('rafflex-outside-');

        symlinkSync(outside, join(base, 'linked'));

        assert.equal(confinedWritePath(base, 'assets/a.png'), join(base, 'assets', 'a.png'));
        assert.throws(() => confinedWritePath(base, '../escaped'), /outside/);
        assert.throws(() => confinedWritePath(base, 'linked/escaped'), /points outside/);
    });

    test('a hostile slug in a push answer is refused before any folder moves', async () => {
        let created = false;
        /** @type {{url: string, close: () => void}} */
        let server;
        const hostile = () => marketplaceProduct({ slug: '../../../outside', title: 'Lucky' });

        server = await serve((request, response) => {
            let body = '';

            request.on('data', (chunk) => { body += chunk; });
            request.on('end', () => {
                response.setHeader('Content-Type', 'application/json');

                const document = (request.url ?? '').match(/^\/dev-kit\/([a-z]+)\.json$/);

                if (document !== null) {
                    try {
                        const text = readFileSync(new URL(`${document[1]}.json`, fixtures), 'utf8').replaceAll('__BASE_URL__', server.url);

                        response.setHeader('ETag', `"${JSON.parse(text).version}"`);
                        response.end(text);
                    } catch {
                        response.statusCode = 404;
                        response.end();
                    }

                    return;
                }

                if (request.method === 'POST') {
                    created = true;
                    response.end(JSON.stringify({ sync: 1, product: hostile(), feedback: null, check: null, uploads: [] }));

                    return;
                }

                response.end(JSON.stringify({ sync: 1, product: created ? hostile() : null, feedback: null }));
            });
        });

        try {
            const root = temporaryWorkspace({ products: [{ title: 'Lucky', folder: 'lucky' }] });
            const { code, output } = await runJson(['push', 'lucky', `${server.url}/mcp/sync/abc?signature=x`], { cwd: root, baseUrl: server.url });

            assert.equal(code, 2);
            assert.equal(output.error.code, 'unexpected_response');
            assert.match(output.error.message, /not a valid slug/);
            assert.equal(existsSync(join(root, 'games', 'lucky', 'product.json')), true);
            assert.equal(productJson(root, 'games/lucky').slug, null);
            assert.deepEqual(readdirSync(join(root, 'games')), ['lucky']);

            const synced = await runJson(['synced', 'lucky', `${server.url}/mcp/sync/abc?signature=x`], { cwd: root, baseUrl: server.url });

            assert.equal(synced.code, 2);
            assert.equal(synced.output.error.code, 'unexpected_response');
        } finally {
            server.close();
        }
    });

    test('recording a state refuses a slug that is not a slug, before writing', () => {
        const root = temporaryWorkspace({ products: [{ title: 'Lucky', folder: 'lucky' }] });
        const workspace = loadWorkspace(root);
        const product = selectProduct(workspace, 'lucky', root);
        const before = readFileSync(join(root, 'games', 'lucky', 'product.json'), 'utf8');

        assert.throws(() => recordProductState({ workspace, product, payload: marketplaceProduct({ slug: '../outside' }), kind: 'none' }), UnsafeSlugError);
        assert.equal(readFileSync(join(root, 'games', 'lucky', 'product.json'), 'utf8'), before);
    });
});

describe('downloads give up', () => {
    test('a bundle or a media file that never arrives times out with a clear message', async () => {
        const silent = await serve(() => {});
        const stalled = await serve((request, response) => {
            response.writeHead(200, { 'Content-Length': '100' });
            response.write('partial');
        });

        try {
            await assert.rejects(fetchBundleText(`${silent.url}/bundle.json`, 300), /took longer than 1 second, so the import stopped and nothing was written/);
            await assert.rejects(download(`${stalled.url}/image.png`, 300), /took longer than 1 second/);
        } finally {
            silent.close();
            stalled.close();
        }
    });
});

describe('push and release against the marketplace', () => {
    /** @type {Awaited<ReturnType<typeof startFakeMarketplace>>} */
    let marketplace;

    before(async () => {
        marketplace = await startFakeMarketplace();
    });

    after(() => marketplace.close());

    /**
     * @param {string[]} args
     * @param {string} cwd
     */
    const kit = (args, cwd) => runJson(args, { cwd, baseUrl: marketplace.baseUrl });

    /**
     * @param {string} slug
     * @param {Record<string, any>} [overrides]
     * @param {Partial<import('./helpers/project.js').ProductSpec>} [spec]
     */
    async function syncedProduct(slug, overrides = {}, spec = {}) {
        marketplace.seed(marketplaceProduct({ slug, title: slug, ...overrides }));

        const root = gitWorkspace([{ title: slug, slug, template, ...spec }]);
        const link = marketplace.issueLink(slug);
        const synced = await kit(['synced', slug, link], root);

        assert.equal(synced.code, 0, JSON.stringify(synced.output));

        return { root, link, path: `games/${slug}`, directory: join(root, 'games', slug) };
    }

    test('release with a link changes nothing until the version is in review', async () => {
        const changelog = '# Changelog\n\n## Unreleased\n\nNotes.\n';
        const { root, path, directory } = await syncedProduct('rel', {}, { changelog });
        const head = git(root, ['rev-parse', 'HEAD']);
        const refused = await kit(['release', 'rel', marketplace.issueLink('rel')], root);

        assert.equal(refused.code, 1);
        assert.equal(refused.output.error.code, 'not_submitted');
        assert.match(refused.output.error.message, /call submit_for_review for rel/);
        assert.equal(readFileSync(join(directory, 'CHANGELOG.md'), 'utf8'), changelog);
        assert.equal(git(root, ['rev-parse', 'HEAD']), head);
        assert.equal(git(root, ['tag']), '');
        assert.equal(git(root, ['status', '--porcelain']), '');

        const product = /** @type {Record<string, any>} */ (marketplace.products.get('rel'));

        product.draft = { ...product.draft, submitted: true };

        const released = await kit(['release', 'rel', marketplace.issueLink('rel')], root);

        assert.equal(released.code, 0, JSON.stringify(released.output));
        assert.equal(released.output.in_review, true);
        assert.equal(git(root, ['tag']), 'rel@1.0.0');
        assert.equal(productJson(root, path).remote.draft.submitted, true);
    });

    test('tags compare as the marketplace keys them, so a second push has nothing to send', async () => {
        marketplace.tags.set('wheel', 'wheel');

        const listing = '---\ncategory_ids: []\ntag_names: ["WHEEL", "Spin It"]\nvideo_url: ""\n---\n\n## Description\n\nIt spins.\n';
        const { root, link, path } = await syncedProduct('tagged', {}, { listing });

        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '--allow-empty', '-m', 'Listing']);

        const first = await kit(['push', path, link], root);

        assert.equal(first.code, 0, JSON.stringify(first.output));
        assert.equal(first.output.changed.listing, true);
        assert.deepEqual(marketplace.products.get('tagged')?.tags, ['wheel', 'Spin It']);

        const head = git(root, ['rev-parse', 'HEAD']);
        const pushes = marketplace.pushes().length;
        const second = await kit(['push', path, link], root);

        assert.equal(second.code, 0, JSON.stringify(second.output));
        assert.equal(second.output.nothing_to_push, true);
        assert.equal(marketplace.pushes().length, pushes);
        assert.equal(git(root, ['rev-parse', 'HEAD']), head);
        assert.equal(git(root, ['status', '--porcelain']), '');
        assert.equal(canonicalListing({ tag_names: ['Wheel', ' wheel ', 'WHEEL', 'spin_it'] }), canonicalListing({ tag_names: ['spin-it', 'wheel'] }));
    });

    test('a push the marketplace answers with the same state makes no Push commit', async () => {
        const { root, link, path, directory } = await syncedProduct('unchanged');

        writeFileSync(join(directory, 'listing.md'), '---\ncategory_ids: []\ntag_names: []\nvideo_url: ""\n---\n\n## Description\n\nNew words.\n');
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'Describe it']);

        const head = git(root, ['rev-parse', 'HEAD']);

        marketplace.behaviour.validate = (body) => {
            delete body.listing;

            return null;
        };

        try {
            const { code, output } = await kit(['push', path, link], root);

            assert.equal(code, 0, JSON.stringify(output));
            assert.equal(output.pushed, true);
            assert.equal(output.commit_message, null);
            assert.equal(git(root, ['rev-parse', 'HEAD']), head);
            assert.equal(git(root, ['status', '--porcelain']), '');
        } finally {
            marketplace.behaviour.validate = null;
        }
    });

    test('a never pushed folder refuses a link for an existing product', async () => {
        marketplace.seed(marketplaceProduct({ slug: 'spin-to-win', title: 'Spin to Win', status: 'published', description: 'The real one', draft: null, versions: [{ version: '1.0.0', channel: 'stable', template_sha256: 'x' }] }));

        const root = temporaryWorkspace({ products: [{ title: 'Lucky Dip', template: '<p>LUCKY DIP {{ play_count }}</p>\n' }] });
        const before = marketplace.pushes().length;
        const { code, output } = await kit(['push', 'lucky-dip', marketplace.issueLink('spin-to-win')], root);

        assert.equal(code, 1);
        assert.equal(output.error.code, 'wrong_link');
        assert.match(output.error.message, /That link is for spin-to-win/);
        assert.match(output.error.message, /request_sync with no slug/);
        assert.match(output.error.message, /export_product and npx @rafflex\/dev import "<bundle_url>"/);
        assert.equal(marketplace.pushes().length, before);
        assert.equal(marketplace.products.get('spin-to-win')?.draft, null);
        assert.equal(existsSync(join(root, 'games', 'lucky-dip')), true);
    });

    test('a new draft at the same revision number is a conflict; the kit\'s own push is not', async () => {
        const { root, link, path, directory } = await syncedProduct('cf');

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} local1</p>\n');

        const own = await kit(['push', path, link], root);

        assert.equal(own.code, 0, JSON.stringify(own.output));
        assert.equal(own.output.revision, 2);

        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} local2</p>\n');

        const again = await kit(['push', path, link], root);

        assert.equal(again.code, 0, JSON.stringify(again.output));
        assert.equal(again.output.revision, 3);

        const product = /** @type {Record<string, any>} */ (marketplace.products.get('cf'));

        product.versions = [{ version: '1.0.0', channel: 'stable', template: product.draft.template }];
        product.draft = { version: '1.1.0', revision: 3, channel: 'stable', changelog: null, template: '<p>{{ play_count }} STUDIO EDIT</p>\n', option_overrides: {}, submitted: false, submitted_at: null, suggested_version: null };
        writeFileSync(join(directory, 'template.twig'), '<p>{{ play_count }} local3</p>\n');

        const conflicted = await kit(['push', path, link], root);

        assert.equal(conflicted.code, 1);
        assert.equal(conflicted.output.error.code, 'conflict');
        assert.match(conflicted.output.error.message, /revision 3 of 1\.1\.0, and this workspace last recorded revision 3 of 1\.0\.0/);
        assert.equal(marketplace.products.get('cf')?.draft.template, '<p>{{ play_count }} STUDIO EDIT</p>\n');
        assert.equal(draftChangedElsewhere({ version: '1.0.0', revision: 2 }, { version: '1.1.0', revision: 2 }), true);
        assert.equal(draftChangedElsewhere({ version: '1.0.0', revision: 2 }, { version: '1.0.0', revision: 2 }), false);
    });

    test('a refused upload names the file in the product folder, not its place in the request', async () => {
        const { root, link, path, directory } = await syncedProduct('named-upload');

        writeFileSync(join(directory, 'assets', 'star.png'), png('star'));
        marketplace.behaviour.validate = (body) => (body.uploads ? [{ code: 'invalid_argument', field: 'uploads.0.mime_type', message: 'The file type is not accepted.' }] : null);

        try {
            const json = await kit(['push', path, link], root);

            assert.equal(json.code, 1);
            assert.deepEqual(json.output.error.issues, [{ code: 'invalid_argument', field: 'uploads.0.mime_type', path: 'assets/star.png', message: 'The file type is not accepted.' }]);

            const prose = await run(['push', path, link], { cwd: root, baseUrl: marketplace.baseUrl });

            assert.match(prose.stderr, /\[invalid_argument\] assets\/star\.png: The file type is not accepted\./);
            assert.doesNotMatch(prose.stderr, /uploads\.0/);
        } finally {
            marketplace.behaviour.validate = null;
        }

        const screenshot = 'listing/screenshots/Screenshot 2026-10-03 at 12.00.00.png';
        const mapped = withUploadPaths([{ code: 'invalid_argument', field: 'uploads.1.filename', message: 'Use letters, numbers, dots, hyphens, and underscores only in file names.' }, { code: 'invalid_argument', field: 'listing.video_url', message: 'Bad.' }], /** @type {any} */ ([{ path: 'assets/a.png' }, { path: screenshot }]));

        assert.equal(mapped[0].path, screenshot);
        assert.equal('path' in mapped[1], false);
    });

    test('the stand in marketplace refuses what the real one refuses', async () => {
        marketplace.seed(marketplaceProduct({ slug: 'strict', versions: [{ version: '1.0.0', channel: 'stable', template }] }));

        const link = marketplace.issueLink('strict');
        const post = async (/** @type {any} */ body) => {
            const response = await fetch(link, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

            return { status: response.status, body: await response.json() };
        };
        const badName = await post({ base_revision: 1, uploads: [{ filename: 'Screenshot 2026-10-03 at 12.00.00.png', size_bytes: 3, mime_type: 'image/png', purpose: 'screenshot' }] });

        assert.equal(badName.status, 422);
        assert.equal(badName.body.error.issues[0].field, 'uploads.0.filename');

        const released = await post({ base_revision: 1, version: '1.0.0', template: '<p>again</p>' });

        assert.equal(released.status, 422);
        assert.equal(released.body.error.issues[0].field, 'version');
    });

    test('a partial push says so, and the files that did not upload stay changes', async () => {
        const { root, link, path, directory } = await syncedProduct('partial');

        writeFileSync(join(directory, 'assets', 'a.png'), png('a'));
        writeFileSync(join(directory, 'assets', 'b.png'), png('b'));
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'Add two images']);
        marketplace.behaviour.failUploads.add('b.png');

        try {
            const failed = await kit(['push', path, link], root);

            assert.equal(failed.code, 1);
            assert.equal(failed.output.error.code, 'upload_failed');
            assert.equal(failed.output.commit_message, 'Push partial 1.0.0 (draft revision 1, 1 file not uploaded)');
            assert.equal(git(root, ['log', '-1', '--format=%s']), 'Push partial 1.0.0 (draft revision 1, 1 file not uploaded)');
        } finally {
            marketplace.behaviour.failUploads.clear();
        }

        assert.equal(git(root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', `${path}/assets`]).split('\n').filter((file) => file.endsWith('.png')).join(','), `${path}/assets/a.png`);
        assert.match(git(root, ['status', '--porcelain']), /\?\? games\/partial\/assets\/b\.png/);

        const restore = await kit(['restore', 'partial', 'last-push'], root);

        assert.equal(restore.output.subject, 'Push partial 1.0.0 (draft revision 1, 1 file not uploaded)');
        assert.deepEqual(restore.output.discarded, ['A assets/b.png']);

        const status = await kit(['status', 'partial'], root);

        assert.deepEqual(status.output.products[0].changes.assets.new.map((/** @type {any} */ asset) => asset.path), ['assets/b.png']);
    });

    test('the check a push answers with drops unknown_file_tag for files that landed', async () => {
        const { root, link, path, directory } = await syncedProduct('landed');

        writeFileSync(join(directory, 'assets', 'star.png'), png('star'));
        marketplace.behaviour.check = () => ({
            passed: true,
            issues: [
                { code: 'unknown_file_tag', message: 'The template references files[\'star\'], but no uploaded file has that tag.' },
                { code: 'unknown_file_tag', message: 'The template references files[\'moon\'], but no uploaded file has that tag.' },
            ],
            suggested_version: null,
        });

        try {
            const { code, output } = await kit(['push', path, link], root);

            assert.equal(code, 0, JSON.stringify(output));
            assert.deepEqual(output.check.issues.map((/** @type {any} */ issue) => issue.message), ['The template references files[\'moon\'], but no uploaded file has that tag.']);
        } finally {
            marketplace.behaviour.check = null;
        }

        assert.deepEqual(withoutLandedFileTags({ passed: false, issues: [{ code: 'unknown_file_tag', message: 'files[\'a\']' }] }, ['a']), { passed: true, issues: [] });
    });

    test('synced commits only product.json when the state but not the draft changed, and rereading writes nothing', async () => {
        const { root, path } = await syncedProduct('reviewing');
        const product = /** @type {Record<string, any>} */ (marketplace.products.get('reviewing'));

        product.draft = { ...product.draft, submitted: true };

        const first = await kit(['synced', 'reviewing', marketplace.issueLink('reviewing')], root);

        assert.equal(first.code, 0, JSON.stringify(first.output));
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Sync reviewing (in review)');
        assert.equal(git(root, ['show', '--name-only', '--format=', 'HEAD']), `${path}/product.json`);
        assert.equal(git(root, ['status', '--porcelain']), '');

        const head = git(root, ['rev-parse', 'HEAD']);
        const second = await kit(['synced', 'reviewing', marketplace.issueLink('reviewing')], root);

        assert.equal(second.output.git.committed, false);
        assert.equal(git(root, ['rev-parse', 'HEAD']), head);
        assert.equal(git(root, ['status', '--porcelain']), '');
    });

    test('a sync that changes nothing still clears stale_remote, outside git; a fresh clone falls back to product.json', async () => {
        const { root, path, directory } = await syncedProduct('fresh-read');
        const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const manifest = productJson(root, path);

        writeFileSync(join(directory, 'product.json'), `${JSON.stringify({ ...manifest, remote: { ...manifest.remote, synced_at: old } }, null, 2)}\n`);
        rmSync(join(root, '.rafflex', 'sync-times.json'), { force: true });
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'An old snapshot']);

        const before = await kit(['status', 'fresh-read'], root);

        assert.equal(before.output.products[0].stale_remote, true);

        const head = git(root, ['rev-parse', 'HEAD']);
        const synced = await kit(['synced', 'fresh-read', marketplace.issueLink('fresh-read')], root);

        assert.equal(synced.code, 0, JSON.stringify(synced.output));
        assert.equal(git(root, ['rev-parse', 'HEAD']), head);
        assert.equal(git(root, ['status', '--porcelain']), '');
        assert.equal(productJson(root, path).remote.synced_at, old);

        const after = await kit(['status', 'fresh-read'], root);

        assert.equal(after.output.products[0].stale_remote, false);
        assert.ok(Date.parse(after.output.products[0].remote.synced_at) > Date.parse(old));

        const plan = await kit(['plan', 'fresh-read'], root);

        assert.equal(plan.output.stale_remote, false);

        const clone = temporaryDirectory('rafflex-clone-');

        execFileSync('git', ['clone', '-q', root, clone], { env: { ...process.env, ...isolatedGitEnv } });

        const cloned = await kit(['status', 'fresh-read'], clone);

        assert.equal(cloned.output.products[0].stale_remote, true);
        assert.equal(cloned.output.products[0].remote.synced_at, old);
    });

    test('a folder renamed by its first push is still found by its old path', async () => {
        const root = gitWorkspace([{ title: 'Docs Check', folder: 'docs-check-draft', template }]);
        const pushed = await kit(['push', 'docs-check-draft', marketplace.issueLink(null)], root);

        assert.equal(pushed.code, 0, JSON.stringify(pushed.output));
        assert.equal(pushed.output.product, 'games/docs-check');
        assert.equal(pushed.output.renamed_from, 'games/docs-check-draft');
        assert.deepEqual(productJson(root, 'games/docs-check').previous_paths, ['games/docs-check-draft']);

        const status = await kit(['status', 'games/docs-check-draft'], root);

        assert.equal(status.code, 0, JSON.stringify(status.output));
        assert.equal(status.output.products[0].product, 'games/docs-check');
        assert.match(status.stderr, /now games\/docs-check/);
    });
});

describe('saved verify results', () => {
    test('are reused only for the same files and the same rules', () => {
        const root = temporaryWorkspace({ products: [{ title: 'Kept', folder: 'kept', template }] });
        const product = selectProduct(loadWorkspace(root), 'kept', root);
        const loaded = { documents: { rules: { version: 'a' }, contexts: { version: 'b' } } };
        const result = /** @type {any} */ ({ product: 'games/kept', ready: true, issues: [] });

        writeFileSync(join(product.directory, 'notes.txt'), 'top level');
        saveVerifyResult(product, result, loaded);

        assert.notEqual(freshVerifyResult(product, rulesFingerprint(loaded)), null);
        assert.equal(freshVerifyResult(product, rulesFingerprint({ documents: { rules: { version: 'changed' }, contexts: { version: 'b' } } })), null);

        rmSync(join(product.directory, 'notes.txt'));
        assert.equal(freshVerifyResult(product, rulesFingerprint(loaded)), null);

        saveVerifyResult(product, result, loaded);
        mkdirSync(join(product.directory, 'tests'), { recursive: true });
        writeFileSync(join(product.directory, 'tests', 'new.spec.js'), '');
        assert.equal(freshVerifyResult(product, rulesFingerprint(loaded)), null);
        assert.deepEqual(readdirSync(join(product.directory, '.results')), ['verify.json']);
    });
});

describe('exit codes and JSON errors', () => {
    test('a refusal the AI can act on exits 1; a link that cannot work exits 2', () => {
        const answer = (/** @type {number} */ status) => refusalFrom({ status, headers: {}, text: JSON.stringify({ error: { code: 'x', message: 'Refused.' } }) });

        assert.equal(answer(403).exitCode, 1);
        assert.equal(answer(429).exitCode, 1);
        assert.equal(answer(409).exitCode, 1);
        assert.equal(answer(422).exitCode, 1);
        assert.equal(answer(410).exitCode, 2);
    });

    test('a usage error with --json prints {error: {code, message}}', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win' }] });
        const unknown = await runJson(['bogus'], { cwd: root });

        assert.equal(unknown.code, 2);
        assert.equal(unknown.output.error.code, 'usage');
        assert.match(unknown.output.error.message, /Unknown command bogus/);

        const missing = await runJson(['import'], { cwd: root });

        assert.equal(missing.output.error.code, 'usage');
    });

    test('check refuses a play count outside the platform\'s range', async () => {
        /** @type {{url: string, close: () => void}} */
        let fixture;

        fixture = await serve((request, response) => {
            const document = (request.url ?? '').match(/^\/dev-kit\/([a-z]+)\.json$/);

            if (document === null) {
                response.writeHead(404).end();

                return;
            }

            response.writeHead(200, { 'Content-Type': 'application/json' }).end(readFileSync(new URL(`${document[1]}.json`, fixtures), 'utf8').replaceAll('__BASE_URL__', fixture.url));
        });

        try {
            const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', template }] });
            const tooMany = await runJson(['check', 'spin-to-win', '--play-count', '999'], { cwd: root, baseUrl: fixture.url });

            assert.equal(tooMany.code, 2);
            assert.match(tooMany.output.error, /--play-count must be from 1 to 25/);

            const fine = await runJson(['check', 'spin-to-win', '--play-count', '3'], { cwd: root, baseUrl: fixture.url });

            assert.equal(fine.output.checked.play_count, 3);
        } finally {
            fixture.close();
        }
    });
});
