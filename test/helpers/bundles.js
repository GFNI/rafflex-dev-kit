import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './project.js';

const bundlesDirectory = new URL('../fixtures/bundles/', import.meta.url);

/**
 * An export bundle fixture with its media URLs pointing at `mediaBaseUrl`.
 *
 * @param {string} name spin-to-win (a game with a draft) or winner-wall (a live only block)
 * @param {string} mediaBaseUrl
 * @returns {any}
 */
export function bundleFixture(name, mediaBaseUrl) {
    return JSON.parse(readFileSync(new URL(`${name}.json`, bundlesDirectory), 'utf8').replaceAll('__MEDIA_URL__', mediaBaseUrl));
}

/**
 * Write a bundle to a temporary file and return its path.
 *
 * @param {unknown} bundle
 */
export function bundleFile(bundle) {
    const path = join(temporaryDirectory('rafflex-bundle-'), 'bundle.json');

    writeFileSync(path, JSON.stringify(bundle));

    return path;
}

/**
 * Serve every fixture media file and the approved library from a media
 * server, at the paths the bundles reference.
 *
 * @param {{serve: (path: string, body: string|Buffer, status?: number) => string}} server
 */
export function serveFixtureMedia(server) {
    for (const file of readdirSync(new URL('media/', bundlesDirectory))) {
        server.serve(`/media/${file}`, readFileSync(new URL(`media/${file}`, bundlesDirectory)));
    }

    server.serve('/libraries/three.module.min.js', readFileSync(new URL('../fixtures/lib/fake-three.module.js', import.meta.url)));
}
