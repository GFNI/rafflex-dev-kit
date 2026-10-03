import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const endpointsDirectory = new URL('../fixtures/endpoints/', import.meta.url);

/**
 * The contract fixture documents, as the kit loads them.
 */
export function fixtureDocuments() {
    const read = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`${name}.json`, endpointsDirectory), 'utf8'));

    return { rules: read('rules'), contexts: read('contexts'), skeletons: read('skeletons'), libraries: read('libraries'), fixtures: read('fixtures') };
}

/**
 * A temporary folder.
 *
 * @param {string} [prefix]
 */
export function temporaryDirectory(prefix = 'rafflex-dev-') {
    return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @typedef {object} ProductSpec
 * @property {string} [type]       game or block (default game).
 * @property {string} [folder]     Folder name (default from the title).
 * @property {string} [title]
 * @property {string|null} [slug]
 * @property {string} [version]
 * @property {any} [remote]
 * @property {string} [template]
 * @property {Record<string, string|Buffer>} [assets]
 * @property {unknown} [options]   options.json contents (default {}).
 * @property {string} [listing]    listing.md contents.
 * @property {string} [changelog]
 */

const typeFolders = /** @type {Record<string, string>} */ ({ game: 'games', block: 'blocks' });

/**
 * Add a product folder to a workspace, as `new` would lay it out.
 *
 * @param {string} root
 * @param {ProductSpec} spec
 * @returns {string} The product folder.
 */
export function addProduct(root, { type = 'game', title = 'Spin to Win', folder, slug = null, version = '1.0.0', remote = null, template = '<p>{{ play_count }}</p>\n', assets = {}, options = {}, listing, changelog = '# Changelog\n\n## Unreleased\n' } = {}) {
    const name = folder ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const directory = join(root, typeFolders[type] ?? `${type}s`, name);

    mkdirSync(join(directory, 'assets'), { recursive: true });
    writeFileSync(join(directory, 'product.json'), `${JSON.stringify({ type, slug, title, version, remote }, null, 2)}\n`);
    writeFileSync(join(directory, 'template.twig'), template);
    writeFileSync(join(directory, 'options.json'), `${JSON.stringify(options)}\n`);
    writeFileSync(join(directory, 'listing.md'), listing ?? '---\ncategory_ids: []\ntag_names: []\nvideo_url: ""\n---\n\n## Description\n\n## Documentation\n\n## Install notes\n');
    writeFileSync(join(directory, 'CHANGELOG.md'), changelog);

    for (const [file, contents] of Object.entries(assets)) {
        mkdirSync(dirname(join(directory, 'assets', file)), { recursive: true });
        writeFileSync(join(directory, 'assets', file), contents);
    }

    return directory;
}

/**
 * A temporary workspace with the given products.
 *
 * @param {{products?: ProductSpec[], config?: Record<string, unknown>}} [options]
 * @returns {string} The workspace root.
 */
export function temporaryWorkspace({ products = [], config = {} } = {}) {
    const root = temporaryDirectory();

    writeFileSync(join(root, 'rafflex.json'), `${JSON.stringify({ workspace: 1, ...config }, null, 2)}\n`);
    mkdirSync(join(root, 'games'));
    mkdirSync(join(root, 'blocks'));

    for (const product of products) {
        addProduct(root, product);
    }

    return root;
}

/**
 * A temporary workspace holding one product; returns the product folder.
 *
 * @param {ProductSpec} [spec]
 */
export function temporaryProduct(spec = {}) {
    return addProduct(temporaryWorkspace(), spec);
}

/**
 * A minimal valid binary glTF 2.0 file.
 *
 * @param {Record<string, unknown>} [gltf]
 */
export function glbBuffer(gltf = { asset: { version: '2.0' } }) {
    let json = JSON.stringify(gltf);

    while (json.length % 4 !== 0) {
        json += ' ';
    }

    const chunk = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(20);

    header.write('glTF', 0, 'latin1');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + chunk.length, 8);
    header.writeUInt32LE(chunk.length, 12);
    header.write('JSON', 16, 'latin1');

    return Buffer.concat([header, chunk]);
}
