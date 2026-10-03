import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { contentMismatch, contentTypesFor, contentVerdict, imageDimensions, mismatchMessage, sniffContent } from '../src/file-content.js';
import { listingImagesPresent, planListingImages, readListingImages, recordedListingImages, remoteListingImagesFrom } from '../src/listing-images.js';
import { resolveListingCategories } from '../src/listing.js';
import { remoteFromProduct } from '../src/sync-state.js';
import { normaliseProductJson } from '../src/workspace.js';
import { bundleFixture } from './helpers/bundles.js';
import { temporaryDirectory } from './helpers/project.js';

const sha = (/** @type {string|Buffer} */ data) => createHash('sha256').update(data).digest('hex');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG header with an IHDR of the given size, enough for the sniffer and
 * the dimension reader.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} [tail]
 */
function png(width, height, tail = '') {
    const ihdr = Buffer.alloc(17);

    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'latin1');
    ihdr.writeUInt32BE(width, 8);
    ihdr.writeUInt32BE(height, 12);

    return Buffer.concat([pngSignature, ihdr.subarray(0, 16), Buffer.from(tail)]);
}

/**
 * @param {Record<string, string|Buffer>} files Paths inside listing/.
 */
function productWithListing(files) {
    const directory = temporaryDirectory('rafflex-listing-');

    for (const [path, contents] of Object.entries(files)) {
        mkdirSync(join(directory, 'listing', path, '..'), { recursive: true });
        writeFileSync(join(directory, 'listing', path), contents);
    }

    return directory;
}

describe('file content', () => {
    test('recognises each type the platform takes by its first bytes', () => {
        assert.equal(sniffContent(png(2, 1)), 'png');
        assert.equal(sniffContent(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
        assert.equal(sniffContent(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
        assert.equal(sniffContent(Buffer.from('GIF89a', 'latin1')), 'gif');
        assert.equal(sniffContent(Buffer.from('ID3\x04', 'latin1')), 'mp3');
        assert.equal(sniffContent(Buffer.from([0xff, 0xfb, 0x90])), 'mp3');
        assert.equal(sniffContent(Buffer.from('glTF', 'latin1')), 'glb');
        assert.equal(sniffContent(Buffer.from('not an image')), null);
    });

    test('a mismatch names what the file holds and what to rename it to', () => {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

        assert.equal(contentMismatch('wheel.png', png(1, 1)), null);
        assert.equal(contentMismatch('notes.txt', Buffer.from('x')), null);
        assert.deepEqual(contentMismatch('wheel.png', jpeg), { expected: 'png', found: 'jpeg' });
        assert.equal(mismatchMessage('assets/wheel.png', { expected: 'png', found: 'jpeg' }), 'assets/wheel.png is named as a PNG image but holds a JPEG image. Rename it to wheel.jpg, or export it again as a PNG image.');
        assert.match(mismatchMessage('assets/jingle.mp3', { expected: 'mp3', found: null }), /is named as a MP3 audio but its content is not one/);
    });

    test('tells MPEG audio from AAC, WAV, and an ID3 tag over either, as the platform does', () => {
        const id3 = (/** @type {number[]} */ frame) => Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x02', 'latin1'), Buffer.from([0, 0]), Buffer.from(frame)]);

        assert.equal(sniffContent(Buffer.from([0xff, 0xfb, 0x50, 0xc4])), 'mp3');
        assert.equal(sniffContent(Buffer.from([0xff, 0xf3, 0x70, 0xc0])), 'mp3');
        assert.equal(sniffContent(Buffer.from([0xff, 0xe3, 0x38, 0xc0])), 'mp3');
        assert.equal(sniffContent(Buffer.from([0xff, 0xfd, 0xe0, 0xc4])), 'mp3');
        assert.equal(sniffContent(Buffer.from([0xff, 0xf1, 0x50, 0x40])), 'aac');
        assert.equal(sniffContent(Buffer.from([0xff, 0xf9, 0x60, 0x60])), 'aac');
        assert.equal(sniffContent(id3([0xff, 0xfb, 0x50, 0xc4])), 'mp3');
        assert.equal(sniffContent(id3([0xff, 0xf1, 0x50, 0x40])), 'aac');
        assert.equal(sniffContent(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1')), 'wav');
    });

    test('takes any image the platform accepts under an image name, and refuses what it refuses', () => {
        const library = contentTypesFor(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'glb', 'js']);
        const cover = contentTypesFor(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'avif', 'heic', 'heif']);
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
        const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8L', 'latin1');
        const bmp = Buffer.from('BM6\x03\0\0\0\0\0\0\x36\0\0\0', 'latin1');
        const mp3 = Buffer.from([0xff, 0xfb, 0x50, 0xc4]);

        assert.equal(contentVerdict('hero.png', jpeg, library), null);
        assert.equal(contentVerdict('hero.png', webp, library), null);
        assert.equal(contentVerdict('hero.gif', webp, library), null);
        assert.equal(contentVerdict('cover.png', webp, cover), null);
        assert.equal(contentVerdict('cover.png', bmp, cover), null);
        assert.equal(contentVerdict('win.mp3', png(1, 1), library)?.blocking, false);
        assert.deepEqual(contentVerdict('win.png', mp3, library), { expected: 'png', found: 'mp3', blocking: false });
        assert.deepEqual(contentVerdict('hero.png', bmp, library), { expected: 'png', found: 'bmp', blocking: true });
        assert.deepEqual(contentVerdict('win.mp3', Buffer.from([0xff, 0xf1, 0x50, 0x40]), library), { expected: 'mp3', found: 'aac', blocking: true });
        assert.deepEqual(contentVerdict('cover.png', mp3, cover), { expected: 'png', found: 'mp3', blocking: true });
        assert.deepEqual(contentVerdict('model.glb', jpeg, library), { expected: 'glb', found: 'jpeg', blocking: true });
        assert.deepEqual(contentVerdict('hero.png', Buffer.from('glTF', 'latin1'), library), { expected: 'png', found: 'glb', blocking: true });
        assert.deepEqual(contentVerdict('hero.png', Buffer.from('text'), library), { expected: 'png', found: null, blocking: true });
        assert.equal(contentVerdict('notes.txt', Buffer.from('text'), library), null);
    });

    test('reads the pixel size of a PNG and a JPEG', () => {
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x04, 0xb0, 0x03, 0x01, 0x22, 0x00]);

        assert.deepEqual(imageDimensions(png(1200, 600)), { width: 1200, height: 600 });
        assert.deepEqual(imageDimensions(jpeg), { width: 1200, height: 600 });
        assert.equal(imageDimensions(Buffer.from('nope')), null);
    });
});

describe('listing images', () => {
    test('reads the cover and the screenshots in filename order, ignoring hidden files', () => {
        const directory = productWithListing({
            'cover.png': png(1200, 600),
            'screenshots/02-win.png': png(10, 10, 'b'),
            'screenshots/01-ready.png': png(10, 10, 'a'),
            'screenshots/.DS_Store': 'x',
            'notes.txt': 'not an image',
        });
        const images = readListingImages(directory);

        assert.equal(images.cover?.path, 'listing/cover.png');
        assert.equal(images.cover?.mime_type, 'image/png');
        assert.equal(images.cover?.sha256, sha(png(1200, 600)));
        assert.deepEqual(images.screenshots.map((image) => image.path), ['listing/screenshots/01-ready.png', 'listing/screenshots/02-win.png']);
        assert.deepEqual(readListingImages(temporaryDirectory()), { covers: [], cover: null, screenshots: [] });
    });

    test('records the marketplace images with their hashes, and the old shape with none', () => {
        assert.deepEqual(remoteListingImagesFrom({ cover_image_url: 'https://m.example/c.png', cover_image_sha256: 'ABC', screenshots: [{ url: 'https://m.example/1.png', sha256: 'DEF' }], screenshot_urls: ['https://m.example/1.png'] }), {
            cover: { url: 'https://m.example/c.png', sha256: 'abc' },
            screenshots: [{ url: 'https://m.example/1.png', sha256: 'def' }],
        });
        assert.deepEqual(remoteListingImagesFrom({ cover_image_url: null, screenshot_urls: ['https://m.example/1.png'] }), { cover: null, screenshots: [{ url: 'https://m.example/1.png', sha256: null }] });
        assert.equal(remoteListingImagesFrom({ slug: 'x' }), undefined);
    });

    test('synced keeps them and the media lock in product.json', () => {
        const product = bundleFixture('spin-to-win', 'https://media.example').product;
        const remote = remoteFromProduct({
            ...product,
            cover_image_url: 'https://media.example/cover.png',
            cover_image_sha256: 'aa',
            screenshots: [{ url: 'https://media.example/s1.png', sha256: 'bb' }],
            media: product.media.map((/** @type {any} */ entry, /** @type {number} */ index) => ({ ...entry, locked: index === 0 })),
        });

        assert.deepEqual(remote.listing_images, { cover: { url: 'https://media.example/cover.png', sha256: 'aa' }, screenshots: [{ url: 'https://media.example/s1.png', sha256: 'bb' }] });
        assert.deepEqual(remote.media.map((entry) => entry.locked), [true, false, false, false]);
        assert.deepEqual(Object.keys(normaliseProductJson({ type: 'game', title: 'x', version: '1.0.0', remote }).remote ?? {}).slice(0, 9), ['synced_at', 'status', 'live_version', 'live_channel', 'draft', 'listing_sha256', 'latest_review', 'media', 'listing_images']);
        assert.equal(Object.hasOwn(remoteFromProduct({ slug: 'x', type: 'game', media: [{ tag: 'a', filename: 'a.png' }] }).media[0], 'locked'), false);
    });

    test('plans a new cover, a changed cover, new screenshots, and the screenshots to remove', () => {
        const directory = productWithListing({ 'cover.png': png(4, 2), 'screenshots/01.png': png(1, 1, 'one'), 'screenshots/02.png': png(1, 1, 'two') });
        const local = readListingImages(directory);
        const one = sha(png(1, 1, 'one'));

        const fresh = planListingImages(local, null);

        assert.equal(fresh.cover?.change, 'new');
        assert.deepEqual(fresh.screenshots.map((image) => [image.path, image.change]), [['listing/screenshots/01.png', 'new'], ['listing/screenshots/02.png', 'new']]);
        assert.deepEqual(fresh.removed_screenshots, []);

        const synced = planListingImages(local, { cover: { url: null, sha256: sha(png(4, 2)) }, screenshots: [{ url: null, sha256: one }, { url: null, sha256: 'gone' }] });

        assert.equal(synced.cover, null);
        assert.deepEqual(synced.screenshots.map((image) => image.path), ['listing/screenshots/02.png']);
        assert.deepEqual(synced.removed_screenshots, ['gone']);

        const hashless = planListingImages(local, { cover: { url: 'https://m.example/c.png', sha256: null }, screenshots: [] });

        assert.equal(hashless.cover?.change, 'changed');
        assert.deepEqual(planListingImages(readListingImages(temporaryDirectory()), { cover: null, screenshots: [{ url: null, sha256: one }] }).removed_screenshots, []);
    });

    test('a product has its images when the folder or the marketplace holds them', () => {
        const empty = readListingImages(temporaryDirectory());

        assert.deepEqual(listingImagesPresent(empty, null), { cover: false, screenshots: false });
        assert.deepEqual(listingImagesPresent(empty, recordedListingImages(/** @type {any} */ ({ listing_images: { cover: { url: 'x', sha256: null }, screenshots: [{ url: 'y', sha256: null }] } }))), { cover: true, screenshots: true });
    });
});

describe('category names', () => {
    const categories = { categories: [{ id: 3, name: 'Wheels', slug: 'wheels' }, { id: 12, name: 'Instant win', slug: 'instant-win' }] };

    test('resolve case insensitively by name or slug, beside ids', () => {
        const resolved = resolveListingCategories({ description: '', documentation: '', install_notes: '', video_url: '', tag_names: [], category_ids: [3], category_names: ['instant WIN', 'wheels'] }, categories);

        assert.deepEqual(resolved.fields.category_ids, [3, 12]);
        assert.equal(Object.hasOwn(resolved.fields, 'category_names'), false);
        assert.deepEqual(resolved.unknown, []);
    });

    test('report unknown names and ids, and names that cannot be looked up offline', () => {
        const fields = { description: '', documentation: '', install_notes: '', video_url: '', tag_names: [], category_ids: [99], category_names: ['Racing'] };

        assert.deepEqual(resolveListingCategories(fields, categories).unknown, ['99', 'Racing']);
        assert.deepEqual(resolveListingCategories(fields, null).unresolved, ['Racing']);
        assert.deepEqual(resolveListingCategories(fields, null).unknown, []);
    });
});
