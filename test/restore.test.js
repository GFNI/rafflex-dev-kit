import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureIgnored } from '../src/git.js';
import { isolatedGitEnv, run, runJson } from './helpers/cli.js';
import { temporaryWorkspace } from './helpers/project.js';
import { marketplaceProduct, startFakeMarketplace } from './helpers/sync-server.js';

const template = '<p>{{ play_count }}</p>\n';

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } }).trim();
}

describe('restore last-push never rolls back the recorded marketplace state', () => {
    /** @type {Awaited<ReturnType<typeof startFakeMarketplace>>} */
    let marketplace;

    before(async () => {
        marketplace = await startFakeMarketplace();
    });

    after(() => marketplace.close());

    /**
     * A git workspace whose product was pushed with a changed template,
     * then recorded in review by a state only sync.
     *
     * @param {string} slug
     */
    async function pushedThenInReview(slug) {
        marketplace.seed(marketplaceProduct({ slug, title: slug }));

        const root = temporaryWorkspace({ products: [{ title: slug, slug, template }] });
        const directory = join(root, 'games', slug);
        const kit = (/** @type {string[]} */ args) => runJson(args, { cwd: root, baseUrl: marketplace.baseUrl });

        ensureIgnored(root);
        git(root, ['init', '-q', '-b', 'main']);
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'Scaffold']);
        assert.equal((await kit(['synced', slug, marketplace.issueLink(slug)])).code, 0);
        writeFileSync(join(directory, 'template.twig'), '<p>v2 {{ play_count }}</p>\n');
        assert.equal((await kit(['push', `games/${slug}`, marketplace.issueLink(slug)])).code, 0);

        const product = /** @type {Record<string, any>} */ (marketplace.products.get(slug));

        product.draft = { ...product.draft, submitted: true };
        assert.equal((await kit(['synced', slug, marketplace.issueLink(slug)])).code, 0);
        assert.match(git(root, ['log', '-1', '--format=%s']), /^Sync /);

        return { root, directory, kit, productJson: () => readFileSync(join(directory, 'product.json'), 'utf8') };
    }

    test('after a state only sync there is nothing to restore, and --yes leaves product.json alone', async () => {
        const { directory, kit, productJson } = await pushedThenInReview('in-review');
        const recorded = productJson();
        const asked = await kit(['restore', 'in-review', 'last-push']);

        assert.equal(asked.code, 0);
        assert.deepEqual(asked.output.discarded, []);
        assert.equal(asked.output.needs_confirmation, false);

        const confirmed = await kit(['restore', 'in-review', 'last-push', '--yes']);

        assert.equal(confirmed.code, 0);
        assert.equal(productJson(), recorded);
        assert.equal(JSON.parse(productJson()).remote.draft.submitted, true);
        assert.equal(readFileSync(join(directory, 'template.twig'), 'utf8'), '<p>v2 {{ play_count }}</p>\n');
    });

    test('unpushed work goes back, the recorded state stays, and the preview never lists product.json', async () => {
        const { root, directory, kit, productJson } = await pushedThenInReview('work');
        const recorded = productJson();

        writeFileSync(join(directory, 'template.twig'), '<p>unpushed</p>\n');
        writeFileSync(join(directory, 'listing.md'), 'changed\n');

        const asked = await kit(['restore', 'work', 'last-push']);

        assert.equal(asked.code, 1);
        assert.deepEqual(asked.output.discarded.sort(), ['M listing.md', 'M template.twig']);
        assert.equal(asked.output.version, null);

        const confirmed = await kit(['restore', 'work', 'last-push', '--yes']);

        assert.equal(confirmed.code, 0);
        assert.equal(readFileSync(join(directory, 'template.twig'), 'utf8'), '<p>v2 {{ play_count }}</p>\n');
        assert.equal(productJson(), recorded);
        assert.equal(git(root, ['status', '--porcelain']), '');
    });

    test('an unpushed version bump goes back to the recorded version, keeping the rest of product.json', async () => {
        const { root, kit, productJson } = await pushedThenInReview('bumped');
        const recorded = productJson();

        writeFileSync(join(root, 'games', 'bumped', 'product.json'), recorded.replace('"version": "1.0.0"', '"version": "1.1.0"'));

        const asked = await kit(['restore', 'bumped', 'last-push']);

        assert.equal(asked.code, 1);
        assert.deepEqual(asked.output.discarded, []);
        assert.deepEqual(asked.output.version, { from: '1.1.0', to: '1.0.0' });
        assert.match((await run(['restore', 'bumped', 'last-push'], { cwd: root })).stdout, /version 1\.1\.0 \(back to 1\.0\.0\)/);

        const confirmed = await kit(['restore', 'bumped', 'last-push', '--yes']);

        assert.equal(confirmed.code, 0);
        assert.equal(productJson(), recorded);
    });
});
