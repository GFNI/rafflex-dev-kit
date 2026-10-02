import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * A temporary project with the given template and asset files.
 *
 * @param {{type?: string, template?: string, assets?: Record<string, string|Buffer>, config?: Record<string, unknown>}} [options]
 */
export function temporaryProject({ type = 'game', template = '<p>{{ play_count }}</p>\n', assets = {}, config = {} } = {}) {
    const directory = temporaryDirectory();

    writeFileSync(join(directory, 'rafflex.json'), JSON.stringify({ type, product: null, ...config }));
    writeFileSync(join(directory, 'template.twig'), template);
    mkdirSync(join(directory, 'assets'));

    for (const [name, contents] of Object.entries(assets)) {
        writeFileSync(join(directory, 'assets', name), contents);
    }

    return directory;
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
