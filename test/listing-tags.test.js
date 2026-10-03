import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureIgnored } from '../src/git.js';
import { listingFromProduct, listingHash } from '../src/sync-state.js';
import { formatProductJson } from '../src/workspace.js';
import { isolatedGitEnv, runJson } from './helpers/cli.js';
import { temporaryWorkspace } from './helpers/project.js';
import { marketplaceProduct, startFakeMarketplace } from './helpers/sync-server.js';

const template = '<p>{{ play_count }}</p>\n';

/**
 * @param {string[]} tags
 */
function listingWith(tags) {
    return `---\ncategory_ids: []\ntag_names: ${JSON.stringify(tags)}\nvideo_url: ""\n---\n\n## Description\n\nIt spins.\n`;
}

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } }).trim();
}

describe('listing tags the platform keys differently from the kit', () => {
    /** @type {Awaited<ReturnType<typeof startFakeMarketplace>>} */
    let marketplace;

    before(async () => {
        marketplace = await startFakeMarketplace();
        // Tags are shared by every product: a CJK or emoji only name keys to
        // the empty slug there, and £5 to "ps5", so they come back spelled
        // as another product first created them.
        marketplace.tags.set('', '🎈');
        marketplace.tags.set('5-prizes', 'PS5 Prizes');
        marketplace.tags.set('wheel', 'wheel');
    });

    after(() => marketplace.close());

    const kit = (/** @type {string[]} */ args, /** @type {string} */ cwd) => runJson(args, { cwd, baseUrl: marketplace.baseUrl });

    /**
     * @param {string} slug
     * @param {string[]} tags
     */
    async function pushedWithTags(slug, tags) {
        marketplace.seed(marketplaceProduct({ slug, title: slug }));

        const root = temporaryWorkspace({ products: [{ title: slug, slug, template, listing: listingWith(tags) }] });

        ensureIgnored(root);
        git(root, ['init', '-q', '-b', 'main']);
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'Scaffold']);
        assert.equal((await kit(['synced', slug, marketplace.issueLink(slug)], root)).code, 0);

        const first = await kit(['push', `games/${slug}`, marketplace.issueLink(slug)], root);

        assert.equal(first.code, 0, JSON.stringify(first.output));
        assert.equal(first.output.changed.listing, true);

        return { root, directory: join(root, 'games', slug) };
    }

    test('a CJK tag, an emoji tag, £5 Prizes, and WHEEL read as unchanged after the push that sent them', async () => {
        const tags = ['日本', '🎉', '£5 Prizes', 'WHEEL'];
        const { root, directory } = await pushedWithTags('tags', tags);
        const remote = JSON.parse(readFileSync(join(directory, 'product.json'), 'utf8')).remote;

        assert.deepEqual(marketplace.products.get('tags')?.tags, ['🎈', 'PS5 Prizes', 'wheel']);
        assert.deepEqual(remote.listing_tag_names, ['WHEEL', '£5 Prizes', '日本', '🎉']);
        assert.deepEqual(remote.listing_marketplace_tags, ['PS5 Prizes', 'wheel', '🎈']);

        const pushes = marketplace.pushes().length;
        const second = await kit(['push', 'games/tags', marketplace.issueLink('tags')], root);

        assert.equal(second.code, 0, JSON.stringify(second.output));
        assert.equal(second.output.nothing_to_push, true);
        assert.equal(marketplace.pushes().length, pushes);
        assert.equal((await kit(['plan', 'tags'], root)).output.listing.changed, false);

        writeFileSync(join(directory, 'listing.md'), listingWith(['🎉', ' WHEEL', '日本', '£5 Prizes', '日本']));
        assert.equal((await kit(['plan', 'tags'], root)).output.listing.changed, false, 'order, spacing, and repeats do not count');

        writeFileSync(join(directory, 'listing.md'), listingWith(['日本', '£5 Prizes', 'WHEEL']));
        assert.equal((await kit(['plan', 'tags'], root)).output.listing.changed, true, 'a tag removed counts');
    });

    test('a sync keeps the record while the marketplace holds the same tags, and drops it once they change there', async () => {
        const { root, directory } = await pushedWithTags('kept', ['日本', 'WHEEL']);

        assert.equal((await kit(['synced', 'kept', marketplace.issueLink('kept')], root)).code, 0);
        assert.deepEqual(JSON.parse(readFileSync(join(directory, 'product.json'), 'utf8')).remote.listing_tag_names, ['WHEEL', '日本']);
        assert.equal((await kit(['plan', 'kept'], root)).output.listing.changed, false);

        const product = /** @type {Record<string, any>} */ (marketplace.products.get('kept'));

        product.tags = ['wheel', 'Arcade'];
        assert.equal((await kit(['synced', 'kept', marketplace.issueLink('kept')], root)).code, 0);
        assert.equal(JSON.parse(readFileSync(join(directory, 'product.json'), 'utf8')).remote.listing_tag_names, undefined);
        assert.equal((await kit(['plan', 'kept'], root)).output.listing.changed, true);
    });

    test('without a record (an older product.json) tags compare by slug, as before', async () => {
        const { root, directory } = await pushedWithTags('older', ['WHEEL', 'Spin It']);
        const path = join(directory, 'product.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        const { listing_tag_names: names, listing_marketplace_tags: marketplaceTags, ...remote } = manifest.remote;

        assert.deepEqual([names, marketplaceTags], [['Spin It', 'WHEEL'], ['Spin It', 'wheel']]);

        // What an older kit recorded: the marketplace's listing hashed with tags by slug.
        const older = { ...remote, listing_sha256: listingHash(listingFromProduct(/** @type {Record<string, any>} */ (marketplace.products.get('older')))) };

        writeFileSync(path, formatProductJson({ ...manifest, remote: older }));
        assert.equal((await kit(['plan', 'older'], root)).output.listing.changed, false);

        writeFileSync(join(directory, 'listing.md'), listingWith(['WHEEL']));
        assert.equal((await kit(['plan', 'older'], root)).output.listing.changed, true);
    });
});
