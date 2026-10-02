import { createServer } from 'node:http';

/**
 * A stand in for the marketplace's public media URLs and the signed
 * export link: serves the bodies registered with `serve`, answers 404 for
 * anything else, and a registered status code instead of a body.
 */
export async function startMediaServer() {
    /** @type {Map<string, {status: number, body: string|Buffer}>} */
    const routes = new Map();
    /** @type {string[]} */
    const requests = [];

    const server = createServer((request, response) => {
        const path = decodeURIComponent((request.url ?? '').split('?')[0]);
        const route = routes.get(path);

        requests.push(path);

        if (route === undefined) {
            response.writeHead(404).end();

            return;
        }

        response.writeHead(route.status).end(route.body);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

    return {
        baseUrl,
        requests,
        /**
         * @param {string} path
         * @param {string|Buffer} body
         * @param {number} [status]
         */
        serve(path, body, status = 200) {
            routes.set(path, { status, body });

            return `${baseUrl}${path}`;
        },
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
        }),
    };
}
