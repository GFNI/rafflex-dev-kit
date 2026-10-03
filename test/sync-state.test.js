import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { canonicalListing, formatListing, ListingError, parseListing, sortedJson } from '../src/listing.js';
import { compareWithRemote, isRemoteStale, listingHash, optionOverridesHash, readLocalState, templateHash } from '../src/sync-state.js';
import { loadWorkspace, selectProduct } from '../src/workspace.js';
import { fixtureDocuments, temporaryProduct } from './helpers/project.js';

const documents = fixtureDocuments();
const libraryBytes = readFileSync(new URL('./fixtures/lib/fake-three.module.js', import.meta.url));
const sha = (/** @type {string|Buffer} */ data) => createHash('sha256').update(data).digest('hex');

describe('listing.md', () => {
    const fields = {
        description: 'Spin the wheel.\n\n## How it plays\n\nOne spin per ticket.',
        documentation: 'Set the colours in the options.',
        install_notes: '',
        video_url: 'https://example.com/video',
        category_ids: [7, 3],
        tag_names: ['spin', 'arcade "classic"'],
    };

    test('round trips through format and parse, keeping headings inside a body', () => {
        assert.deepEqual(parseListing(formatListing(fields)), fields);
    });

    test('the new product template has the frontmatter and the three sections', () => {
        assert.equal(formatListing(), '---\ncategory_ids: []\ntag_names: []\nvideo_url: ""\n---\n\n## Description\n\n## Documentation\n\n## Install notes\n');
        assert.deepEqual(parseListing(formatListing()), { description: '', documentation: '', install_notes: '', video_url: '', category_ids: [], tag_names: [] });
    });

    test('reads block lists, bare and single quoted values, CRLF, and missing sections', () => {
        const parsed = parseListing("---\r\ncategory_ids:\r\n  - 4\r\n  - 5\r\ntag_names: [arcade, 'it''s']\r\nvideo_url: https://v.example\r\n---\r\n## Install notes\r\n\r\n  Indented.  \r\n");

        assert.deepEqual(parsed, { description: '', documentation: '', install_notes: '  Indented.', video_url: 'https://v.example', category_ids: [4, 5], tag_names: ['arcade', "it's"] });
    });

    test('refuses category ids that are not whole numbers', () => {
        assert.throws(() => parseListing('---\ncategory_ids: [2.5]\n---\n'), ListingError);
        assert.throws(() => parseListing('---\ncategory_ids: [-3]\n---\n'), ListingError);
    });

    test('reads category names beside ids, under category_ids or categories', () => {
        assert.deepEqual(parseListing('---\ncategory_ids: [3, "Instant win"]\n---\n').category_names, ['Instant win']);
        assert.deepEqual(parseListing('---\ncategory_ids: [3, "Instant win"]\n---\n').category_ids, [3]);
        assert.deepEqual(parseListing('---\ncategories:\n  - Arcade\n  - 12\n---\n'), { description: '', documentation: '', install_notes: '', video_url: '', category_ids: [12], tag_names: [], category_names: ['Arcade'] });
    });

    test('the canonical form sorts keys, ids, and tags and fills missing fields', () => {
        assert.equal(canonicalListing({ tag_names: ['b', 'a'], category_ids: [9, 2] }), '{"category_ids":[2,9],"description":"","documentation":"","install_notes":"","tag_names":["a","b"],"video_url":""}');
        assert.equal(listingHash(parseListing(formatListing(fields))), listingHash({ ...fields, category_ids: [3, 7] }));
    });
});

describe('hashes', () => {
    test('options hash sorted key JSON, with empty forms equal', () => {
        assert.equal(sortedJson({ b: 1, a: { d: 1, c: [2, { f: 1, e: 0 }] } }), '{"a":{"c":[2,{"e":0,"f":1}],"d":1},"b":1}');
        assert.equal(optionOverridesHash({ b: 1, a: 2 }), sha('{"a":2,"b":1}'));
        assert.equal(optionOverridesHash([]), optionOverridesHash({}));
        assert.equal(optionOverridesHash(null), sha('{}'));
    });

    test('options hash what the platform stores beside the template, so dropped entries never read as changed', () => {
        const template = '<h1>{{ options.heading }}</h1><i style="color: {{ options.accent_colour }}"></i>{% for slide in options.slides %}{{ slide.title }}{% endfor %}{% for category in options.categories %}{{ category }}{% endfor %}\n';
        const stored = { heading: { label: 'Title' }, accent_colour: { label: 'Accent' } };
        const written = {
            heading: { label: '  Title ' },
            accent_colour: { label: 'Accent', choices: ['Red', 'Blue'] },
            never_read: { label: 'Unused' },
            'slides.title': { label: 'Slide title' },
            categories: { label: 'Categories' },
        };

        assert.equal(optionOverridesHash(written, template, documents.contexts), optionOverridesHash(stored));
        assert.notEqual(optionOverridesHash(written), optionOverridesHash(stored));
        assert.equal(optionOverridesHash([{ label: 'A list' }], template, documents.contexts), optionOverridesHash({}));

        const directory = temporaryProduct({ template, options: written });
        const local = readLocalState(selectProduct(loadWorkspace(directory), undefined, directory), documents);
        const remote = /** @type {any} */ ({ draft: { template_sha256: templateHash(template), option_overrides_sha256: optionOverridesHash(stored) }, listing_sha256: null, media: [] });

        assert.equal(compareWithRemote(local, remote).options, false);
        assert.deepEqual(local.options, { sha256: optionOverridesHash(stored), value: written });
    });

    test('a template hashes as its exact text', () => {
        assert.equal(templateHash('<p>x</p>\n'), sha('<p>x</p>\n'));
    });

    test('a snapshot is stale when missing or over a day old', () => {
        const now = Date.parse('2026-10-02T12:00:00Z');

        assert.equal(isRemoteStale(null, now), true);
        assert.equal(isRemoteStale(/** @type {any} */ ({ synced_at: '2026-10-02T00:00:00Z' }), now), false);
        assert.equal(isRemoteStale(/** @type {any} */ ({ synced_at: '2026-10-01T11:00:00Z' }), now), true);
    });
});

describe('local changes against the remote snapshot', () => {
    const template = '<p>{{ play_count }} {{ options.heading }}</p>\n';
    const directory = temporaryProduct({
        template,
        options: { heading: { label: 'Title' } },
        assets: { 'background.png': 'png v1', 'three.module.min.js': libraryBytes, 'sounds/Win Jingle.mp3': 'mp3' },
    });
    const product = selectProduct(loadWorkspace(directory), undefined, directory);
    const local = readLocalState(product, documents);
    const remote = /** @type {any} */ ({
        synced_at: new Date().toISOString(),
        status: 'published',
        live_version: '1.0.0',
        live_channel: 'stable',
        draft: { version: '1.1.0', revision: 4, submitted: false, template_sha256: templateHash(template), option_overrides_sha256: optionOverridesHash({ heading: { label: 'Title' } }) },
        listing_sha256: listingHash({}),
        latest_review: null,
        media: [
            { tag: 'background', filename: 'background.png', sha256: sha('png v1'), kind: 'image', library: null },
            { tag: 'three', filename: 'three.module.min.js', sha256: documents.libraries.libraries[0].sha256, kind: 'library', library: 'three.js' },
            { tag: 'win-jingle', filename: 'Win Jingle.mp3', sha256: sha('mp3'), kind: 'audio', library: null },
        ],
    });

    test('reads every asset with its tag, kind, size, MIME type, and hash', () => {
        assert.deepEqual(local.assets.map(({ path, tag, kind, mime_type, size, library }) => ({ path, tag, kind, mime_type, size, library })), [
            { path: 'assets/background.png', tag: 'background', kind: 'image', mime_type: 'image/png', size: 6, library: null },
            { path: 'assets/sounds/Win Jingle.mp3', tag: 'win-jingle', kind: 'audio', mime_type: 'audio/mpeg', size: 3, library: null },
            { path: 'assets/three.module.min.js', tag: 'three', kind: 'library', mime_type: 'text/javascript', size: libraryBytes.length, library: 'three.js' },
        ]);
        assert.equal(local.assets[0].sha256, sha('png v1'));
    });

    test('nothing changed when the files match the snapshot', () => {
        assert.deepEqual(compareWithRemote(local, remote), { template: false, options: false, listing: false, assets: { new: [], changed: [], removed: [] }, any: false });
    });

    test('flags a changed template, options, listing, and new, changed, and removed assets', () => {
        const changed = compareWithRemote({ ...local, template: { text: 'x', sha256: templateHash('x') }, options: { value: {}, sha256: optionOverridesHash({}) }, listing: { fields: /** @type {any} */ ({}), sha256: listingHash({ description: 'New' }) } }, {
            ...remote,
            media: [
                { ...remote.media[0], sha256: sha('png v0') },
                remote.media[1],
                { tag: 'logo', filename: 'logo.png', sha256: 'x', kind: 'image', library: null },
            ],
        });

        assert.deepEqual([changed.template, changed.options, changed.listing, changed.any], [true, true, true, true]);
        assert.deepEqual(changed.assets.new.map((asset) => asset.tag), ['win-jingle']);
        assert.deepEqual(changed.assets.changed.map((asset) => asset.tag), ['background']);
        assert.deepEqual(changed.assets.removed, [{ tag: 'logo', filename: 'logo.png' }]);
    });

    test('a remote file without a hash counts as changed, and a product never synced as all new', () => {
        assert.deepEqual(compareWithRemote(local, { ...remote, media: [{ ...remote.media[0], sha256: null }, ...remote.media.slice(1)] }).assets.changed.map((asset) => asset.tag), ['background']);

        const never = compareWithRemote(local, null);

        assert.deepEqual([never.template, never.options, never.listing], [true, true, true]);
        assert.equal(never.assets.new.length, 3);
    });

    test('a library matches by hash under any tag, and by name when its build changed', () => {
        const libraryEntry = remote.media[1];
        const customTag = compareWithRemote(local, { ...remote, media: [remote.media[0], { ...libraryEntry, tag: 'threejs' }, remote.media[2]] });

        assert.deepEqual(customTag.assets, { new: [], changed: [], removed: [] });
        assert.equal(customTag.any, false);

        const otherBuild = compareWithRemote(local, { ...remote, media: [remote.media[0], { ...libraryEntry, tag: 'threejs', sha256: sha('older build') }, remote.media[2]] });

        assert.deepEqual(otherBuild.assets.changed.map((asset) => [asset.path, asset.tag, asset.library]), [['assets/three.module.min.js', 'threejs', 'three.js']]);
        assert.deepEqual([otherBuild.assets.new, otherBuild.assets.removed], [[], []]);
    });

    test('a library tag held by a different file on the marketplace does not hide the library', () => {
        const swapped = compareWithRemote(local, { ...remote, media: [remote.media[0], { tag: 'three', filename: 'three.png', sha256: sha('a picture'), kind: 'image', library: null }, remote.media[2]] });

        assert.deepEqual(swapped.assets.new.map((asset) => asset.tag), ['three']);
        assert.deepEqual(swapped.assets.removed, [{ tag: 'three', filename: 'three.png' }]);
    });

    test('without cached rules the assets are still read and tagged', () => {
        assert.deepEqual(readLocalState(product, null).assets.map((asset) => asset.tag), ['background', 'win-jingle']);
    });
});
