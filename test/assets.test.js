import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { defaultTagFor, glbRefusal, scanAssets, slugify } from '../src/assets.js';
import { fixtureDocuments, glbBuffer, temporaryProduct } from './helpers/project.js';

const { rules, libraries } = fixtureDocuments();
const libraryBytes = readFileSync(new URL('./fixtures/lib/fake-three.module.js', import.meta.url));
const urlFor = (/** @type {string} */ path) => `/assets/${path}`;

describe('tags', () => {
    // Expected values are the platform's slugs for the same stems.
    for (const [filename, tag] of [
        ['Win Jingle!.mp3', 'win-jingle'],
        ['café_crème (1).png', 'cafe-creme-1'],
        ['Ünïcödé Straße.webp', 'unicode-strasse'],
        ['3D @ model.glb', '3d-at-model'],
        ['--x--.png', 'x'],
        ['£5 prize.png', 'ps5-prize'],
        ['My.File.v2.png', 'myfilev2'],
        ['background.png', 'background'],
    ]) {
        test(`${filename} becomes ${tag}`, () => {
            assert.equal(defaultTagFor(filename), tag);
        });
    }

    test('a stem with nothing left gets a stable file- tag', () => {
        const tag = defaultTagFor('日本語.png');

        assert.match(tag, /^file-[0-9a-f]{6}$/);
        assert.equal(defaultTagFor('日本語.png'), tag);
    });

    test('slugify collapses separators', () => {
        assert.equal(slugify('  a__b - c  '), 'a-b-c');
    });
});

describe('scanAssets', () => {
    test('maps files to tags, suffixing clashes, and builds the files map', () => {
        const directory = temporaryProduct({ assets: { 'Background.png': 'png', 'background.jpg': 'jpg', 'win-jingle.mp3': 'mp3' } });
        const scan = scanAssets(join(directory, 'assets'), rules, libraries.libraries, urlFor);

        assert.deepEqual(scan.files, {
            background: '/assets/Background.png',
            'background-2': '/assets/background.jpg',
            'win-jingle': '/assets/win-jingle.mp3',
        });
        assert.deepEqual(scan.refusals, []);
    });

    test('an approved library maps to its shared URL and default tag', () => {
        const directory = temporaryProduct({ assets: { 'three.module.min.js': libraryBytes } });
        const scan = scanAssets(join(directory, 'assets'), rules, libraries.libraries, urlFor);

        assert.deepEqual(scan.files, { three: libraries.libraries[0].url });
        assert.equal(scan.assets[0].library?.name, 'three.js');
    });

    test('any other JavaScript is refused with the platform message', () => {
        const directory = temporaryProduct({ assets: { 'game.js': 'console.log(1)' } });
        const scan = scanAssets(join(directory, 'assets'), rules, libraries.libraries, urlFor);

        assert.deepEqual(scan.files, {});
        assert.deepEqual(scan.refusals, [{ file: 'assets/game.js', message: rules.upload_rules.refusals.unapproved_library }]);
    });

    test('blend, gltf, and unknown types are refused with the published messages', () => {
        const directory = temporaryProduct({ assets: { 'scene.blend': 'x', 'scene.gltf': '{}', 'notes.txt': 'x' } });
        const messages = scanAssets(join(directory, 'assets'), rules, [], urlFor).refusals.map((refusal) => refusal.message);

        assert.deepEqual(messages, [
            rules.upload_rules.refusals.unsupported_type.replace(':filename', 'notes.txt'),
            rules.upload_rules.refusals.blend,
            rules.upload_rules.refusals.gltf,
        ]);
    });

    test('a file over its kind limit is refused', () => {
        const smallRules = structuredClone(rules);

        smallRules.upload_rules.max_bytes_by_kind.image = 2;

        const directory = temporaryProduct({ assets: { 'big.png': 'xyz' } });
        const [refusal] = scanAssets(join(directory, 'assets'), smallRules, [], urlFor).refusals;

        assert.equal(refusal.message, rules.upload_rules.refusals.too_large.image.replace(':filename', 'big.png'));
    });

    test('dotfiles such as .gitkeep are ignored', () => {
        const directory = temporaryProduct({ assets: { '.gitkeep': '' } });

        assert.deepEqual(scanAssets(join(directory, 'assets'), rules, [], urlFor), { assets: [], refusals: [], files: {} });
    });
});

describe('glb validation', () => {
    test('accepts binary glTF 2.0', () => {
        assert.equal(glbRefusal(glbBuffer()), null);
    });

    test('refuses a file without the glTF header', () => {
        assert.equal(glbRefusal(Buffer.from('not a model at all, honestly')), 'invalid_model');
    });

    test('refuses glTF version 1', () => {
        const buffer = glbBuffer();

        buffer.writeUInt32LE(1, 4);
        assert.equal(glbRefusal(buffer), 'invalid_model');
    });

    test('refuses a declared length that does not match', () => {
        assert.equal(glbRefusal(Buffer.concat([glbBuffer(), Buffer.from('    ')])), 'invalid_model');
    });

    test('refuses compressed models', () => {
        assert.equal(glbRefusal(glbBuffer({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] })), 'compressed_model');
    });

    test('scanAssets reports model refusals with the published messages', () => {
        const directory = temporaryProduct({ assets: { 'prize-box.glb': 'nope', 'packed.glb': glbBuffer({ asset: { version: '2.0' }, extensionsRequired: ['EXT_meshopt_compression'] }) } });
        const published = { ...rules, upload_rules: { ...rules.upload_rules, refusals: { ...rules.upload_rules.refusals, invalid_model: 'Not a model: :filename', compressed_model: 'Too squashed.' } } };
        const scan = scanAssets(join(directory, 'assets'), published, [], urlFor);

        assert.deepEqual(scan.refusals.map((refusal) => refusal.message).sort(), ['Not a model: prize-box.glb', 'Too squashed.']);
    });

    test('rules cached before the model refusals were published keep the platform wording', () => {
        const { invalid_model: invalidModel, compressed_model: compressedModel, ...legacyRefusals } = rules.upload_rules.refusals;
        const legacy = { ...rules, upload_rules: { ...rules.upload_rules, refusals: legacyRefusals } };
        const directory = temporaryProduct({ assets: { 'prize-box.glb': 'nope' } });

        assert.equal(scanAssets(join(directory, 'assets'), legacy, [], urlFor).refusals[0].message, invalidModel.replace(':filename', 'prize-box.glb'));
        assert.ok(compressedModel.startsWith('Compressed models'));
    });

    test('scanAssets reports an invalid model with the platform wording', () => {
        const directory = temporaryProduct({ assets: { 'prize-box.glb': 'nope', 'ok.glb': glbBuffer() } });
        const scan = scanAssets(join(directory, 'assets'), rules, [], urlFor);

        assert.deepEqual(Object.keys(scan.files), ['ok']);
        assert.equal(scan.refusals[0].message, 'prize-box.glb is not a valid .glb file. Export it from Blender as glTF 2.0, format glTF Binary.');
    });
});
