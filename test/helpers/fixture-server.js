import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const endpointsDirectory = new URL('../fixtures/endpoints/', import.meta.url);

/**
 * A stand in marketplace serving the contract fixtures in
 * test/fixtures/endpoints, with ETags and 304s like the real endpoints.
 * Tests can replace a document, take the server offline, or make a
 * document fail, and read the request log.
 */
export async function startFixtureServer() {
    /** @type {Record<string, string>} */
    const overrides = {};
    /** @type {Set<string>} */
    const failing = new Set();
    /** @type {{method: string, url: string, ifNoneMatch: string|undefined, headers: Record<string, unknown>}[]} */
    const requests = [];
    let baseUrl = '';

    const documentBody = (/** @type {string} */ name) => {
        const body = overrides[name] ?? readFileSync(new URL(`${name}.json`, endpointsDirectory), 'utf8');

        return body.replaceAll('__BASE_URL__', baseUrl);
    };

    const server = createServer((request, response) => {
        requests.push({ method: request.method ?? '', url: request.url ?? '', ifNoneMatch: request.headers['if-none-match'], headers: request.headers });

        const match = (request.url ?? '').match(/^\/dev-kit\/([a-z]+)\.json$/);

        if (match === null || failing.has(match[1])) {
            response.writeHead(match === null ? 404 : 503).end();

            return;
        }

        let body;

        try {
            body = documentBody(match[1]);
        } catch {
            response.writeHead(404).end();

            return;
        }

        const etag = `"${JSON.parse(body).version}"`;

        if (request.headers['if-none-match'] === etag) {
            response.writeHead(304, { ETag: etag }).end();

            return;
        }

        response.writeHead(200, { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'max-age=300, public' }).end(body);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();

    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

    return {
        baseUrl,
        requests,
        failing,
        /**
         * @param {string} name
         * @param {(document: any) => any} change
         */
        changeDocument(name, change) {
            const document = change(JSON.parse(documentBody(name)));
            const manifest = JSON.parse(documentBody('manifest'));

            overrides[name] = JSON.stringify(document);
            manifest.versions[name] = document.version;
            manifest.version = `${manifest.version}-changed`;
            overrides.manifest = JSON.stringify(manifest);
        },
        /**
         * @param {(manifest: any) => any} change
         */
        changeManifest(change) {
            overrides.manifest = JSON.stringify(change(JSON.parse(documentBody('manifest'))));
        },
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
        }),
    };
}
