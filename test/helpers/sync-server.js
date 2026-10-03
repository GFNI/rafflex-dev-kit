import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const endpointsDirectory = new URL('../fixtures/endpoints/', import.meta.url);

/**
 * @param {string|Buffer} data
 */
export function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

/**
 * A product in the get_product shape, as the marketplace answers.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
export function marketplaceProduct(overrides = {}) {
    return {
        slug: 'spin-to-win',
        title: 'Spin to Win',
        type: 'game',
        status: 'draft',
        description: null,
        documentation: null,
        install_notes: null,
        video_url: null,
        cover_image_url: null,
        cover_image_sha256: null,
        screenshot_urls: [],
        screenshots: [],
        categories: [],
        tags: [],
        draft: { version: '1.0.0', revision: 1, channel: 'stable', changelog: null, template: '<p>{{ play_count }}</p>\n', option_overrides: {}, submitted: false, submitted_at: null, suggested_version: null },
        versions: [],
        media: [],
        latest_review: null,
        ...overrides,
    };
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Buffer>}
 */
function readBody(request) {
    return new Promise((resolve, reject) => {
        /** @type {Buffer[]} */
        const chunks = [];

        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

/**
 * @param {string} filename
 */
function kindOf(filename) {
    const extension = filename.split('.').pop()?.toLowerCase() ?? '';

    return { mp3: 'audio', glb: 'model', js: 'library' }[extension] ?? 'image';
}

/**
 * A stand in marketplace for the sync loop: the public /dev-kit documents
 * (from test/fixtures/endpoints), sync links (GET reads a product, POST
 * pushes to it) and upload links (PUT stores a file), with the response
 * shapes and refusals of the real one. Tests issue links, seed products,
 * make a link expire or a step fail, and read the request log.
 */
export async function startFakeMarketplace() {
    /** @type {Map<string, Record<string, any>>} */
    const products = new Map();
    /** @type {Map<string, {slug: string|null, type?: string, expired: boolean}>} */
    const links = new Map();
    /** @type {Map<string, {slug: string, filename: string, purpose: string, tag: string|null, description: string|null, size_bytes: number, mime_type: string, used: boolean}>} */
    const grants = new Map();
    /** @type {{method: string, path: string, query: string, headers: import('node:http').IncomingHttpHeaders, body: any, bytes: number}[]} */
    const requests = [];
    const behaviour = {
        /** @type {number|null} Seconds a 429 asks to wait, or null for no rate limit. */
        rateLimited: /** @type {number|null} */ (null),
        /** @type {Set<string>} Filenames whose upload answers with an error. */
        failUploads: new Set(),
        /** @type {((body: any) => any[]|null)|null} Return issues to refuse a push with a 422. */
        validate: /** @type {((body: any) => any[]|null)|null} */ (null),
        /** @type {string|null} An origin to hand out upload links on instead of this one. */
        uploadOrigin: /** @type {string|null} */ (null),
        /** @type {number|null} A status every GET answers with instead (for redirects). */
        getStatus: /** @type {number|null} */ (null),
        /** @type {Record<string, any>|null} Feedback for every product. */
        feedback: /** @type {Record<string, any>|null} */ (null),
    };
    let baseUrl = '';

    const send = (/** @type {import('node:http').ServerResponse} */ response, /** @type {number} */ status, /** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
    };
    const refuse = (/** @type {import('node:http').ServerResponse} */ response, /** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message, /** @type {Record<string, any>} */ extra = {}, /** @type {Record<string, string>} */ headers = {}) => {
        send(response, status, { error: { code, message, ...extra } }, headers);
    };
    const feedbackFor = (/** @type {Record<string, any>|null} */ product) => (product === null ? null : behaviour.feedback ?? { review: null, open_bug_reports: 0, unanswered_questions: 0, statistics: { installs: 0, sales: 0, rating: null, ratings_count: 0 } });
    const clone = (/** @type {any} */ value) => (value === null ? null : JSON.parse(JSON.stringify(value)));

    /**
     * @param {Record<string, any>} product
     * @param {any} body
     */
    const writesDraft = (product, body) => {
        if ('template' in body || 'option_overrides' in body) {
            return true;
        }

        if (product.draft !== null) {
            return 'version' in body || 'release_notes' in body;
        }

        return typeof body.version === 'string' && !product.versions.some((/** @type {any} */ entry) => entry.version === body.version);
    };

    /**
     * @param {import('node:http').ServerResponse} response
     * @param {{slug: string|null, type?: string, expired: boolean}} link
     * @param {any} body
     */
    const push = (response, link, body) => {
        let product = link.slug === null ? null : products.get(link.slug) ?? null;
        let created = false;

        if (Array.isArray(body.uploads) && body.uploads.length > 10) {
            refuse(response, 422, 'validation_failed', 'The push was refused, and nothing changed.', { issues: [{ code: 'invalid_argument', field: 'uploads', message: 'Send at most 10 files per push.' }] });

            return;
        }

        const issues = behaviour.validate?.(body) ?? null;

        if (issues !== null && issues.length > 0) {
            refuse(response, 422, 'validation_failed', 'The push was refused, and nothing changed. Fix every issue and push again.', { issues });

            return;
        }

        if (product === null) {
            if (body.create === undefined) {
                refuse(response, 422, 'validation_failed', 'The push was refused.', { issues: [{ code: 'invalid_argument', field: 'create', message: 'This link is for a new product. Send create with its type and title in the first push.' }] });

                return;
            }

            const slug = String(body.create.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

            product = marketplaceProduct({ slug, title: body.create.title, type: body.create.type, draft: { version: '1.0.0', revision: 1, channel: 'stable', changelog: null, template: body.template ?? '', option_overrides: {}, submitted: false, submitted_at: null, suggested_version: null } });
            created = true;
        } else if (product.draft !== null) {
            if (product.draft.submitted) {
                refuse(response, 409, 'conflict', 'This version is in review and cannot be changed until the decision.');

                return;
            }

            const base = body.base_revision ?? null;

            if (base !== product.draft.revision && (base !== null || writesDraft(product, body))) {
                refuse(response, 409, 'conflict', `The draft on the marketplace is at revision ${product.draft.revision}, which this push was not made from, so nothing was applied. Bring the product local again with export_product and npx @rafflex/dev import, apply your change on top, then push again.`);

                return;
            }
        }

        if (writesDraft(product, body)) {
            const draft = product.draft ?? { version: body.version, revision: 0, channel: 'stable', changelog: null, template: product.versions[0]?.template ?? '', option_overrides: {}, submitted: false, submitted_at: null, suggested_version: null };

            if (!created && ('template' in body || 'option_overrides' in body)) {
                draft.revision += 1;
            }

            if (draft.revision === 0) {
                draft.revision = 1;
            }

            for (const [key, field] of [['template', 'template'], ['option_overrides', 'option_overrides'], ['version', 'version'], ['release_notes', 'changelog']]) {
                if (key in body) {
                    draft[field] = body[key];
                }
            }

            product.draft = draft;
        }

        if (body.listing !== undefined) {
            const listing = body.listing;

            for (const field of ['description', 'documentation', 'install_notes', 'video_url']) {
                if (field in listing) {
                    product[field] = listing[field];
                }
            }

            if (Array.isArray(listing.category_ids)) {
                product.categories = listing.category_ids.map((/** @type {number} */ id) => ({ id, name: `Category ${id}` }));
            }

            if (Array.isArray(listing.tag_names)) {
                product.tags = listing.tag_names;
            }
        }

        const libraries = JSON.parse(readFileSync(new URL('libraries.json', endpointsDirectory), 'utf8')).libraries;

        for (const entry of body.libraries ?? []) {
            const library = libraries.find((/** @type {any} */ candidate) => candidate.name === entry.name);

            product.media = product.media.filter((/** @type {any} */ media) => media.tag !== entry.tag);
            product.media.push({ tag: entry.tag, filename: library.url.split('/').pop(), kind: 'library', mime_type: 'text/javascript', size_bytes: 134, sha256: library.sha256, description: null, url: library.url, library: { name: library.name, version: library.version }, locked: false });
        }

        if (Array.isArray(body.screenshots_keep) && body.screenshots_keep.length > 0) {
            product.screenshots = product.screenshots.filter((/** @type {any} */ entry) => entry.sha256 === null || body.screenshots_keep.includes(entry.sha256));
            product.screenshot_urls = product.screenshots.map((/** @type {any} */ entry) => entry.url);
        }

        products.set(product.slug, product);
        link.slug = product.slug;

        const uploads = (body.uploads ?? []).map((/** @type {any} */ upload) => {
            const id = randomUUID();

            grants.set(id, { slug: product.slug, filename: upload.filename, purpose: upload.purpose ?? 'library', tag: upload.tag ?? null, description: upload.description ?? null, size_bytes: upload.size_bytes, mime_type: upload.mime_type, used: false });

            return {
                filename: upload.filename,
                purpose: upload.purpose ?? 'library',
                tag: upload.tag ?? null,
                description: upload.description ?? null,
                size_bytes: upload.size_bytes,
                mime_type: upload.mime_type,
                put_url: `${behaviour.uploadOrigin ?? baseUrl}/mcp/uploads/${id}?signature=put-${id}`,
                method: 'PUT',
                headers: { 'Content-Type': upload.mime_type },
                expires_at: '2026-10-03T12:00:00+00:00',
            };
        });

        send(response, 200, { sync: 1, product: clone(product), feedback: feedbackFor(product), check: product.draft === null ? null : { passed: true, issues: [], suggested_version: null }, uploads });
    };

    /**
     * @param {import('node:http').ServerResponse} response
     * @param {string} id
     * @param {Buffer} bytes
     */
    const receive = (response, id, bytes) => {
        const grant = grants.get(id);

        if (grant === undefined) {
            refuse(response, 403, 'forbidden', 'Invalid signature.');

            return;
        }

        if (grant.used) {
            refuse(response, 409, 'conflict', 'This upload has already been received. Ask your AI for a new upload link.');

            return;
        }

        if (behaviour.failUploads.has(grant.filename)) {
            refuse(response, 415, 'unsupported_type', `${grant.filename} is not a file type the media library accepts.`);

            return;
        }

        if (bytes.length !== grant.size_bytes) {
            refuse(response, 413, 'too_large', `The file is not the ${grant.size_bytes} bytes declared for ${grant.filename}.`);

            return;
        }

        grant.used = true;

        const product = /** @type {Record<string, any>} */ (products.get(grant.slug));
        const hash = sha256(bytes);
        const url = `${baseUrl}/media/${hash}/${grant.filename}`;

        if (grant.purpose === 'cover') {
            product.cover_image_url = url;
            product.cover_image_sha256 = hash;
        } else if (grant.purpose === 'screenshot') {
            product.screenshots.push({ url, sha256: hash });
            product.screenshot_urls = product.screenshots.map((/** @type {any} */ entry) => entry.url);
        } else {
            product.media = product.media.filter((/** @type {any} */ entry) => entry.tag !== grant.tag);
            product.media.push({ tag: grant.tag, filename: grant.filename, kind: kindOf(grant.filename), mime_type: grant.mime_type, size_bytes: bytes.length, sha256: hash, description: grant.description, url, library: null, locked: false });
        }

        send(response, 201, { stored: { filename: grant.filename, purpose: grant.purpose, tag: grant.tag } });
    };

    const server = createServer(async (request, response) => {
        const [path, query = ''] = (request.url ?? '').split('?');
        const bytes = await readBody(request);
        let body = null;

        try {
            body = bytes.length > 0 && request.method === 'POST' ? JSON.parse(bytes.toString('utf8')) : null;
        } catch {
            body = null;
        }

        requests.push({ method: request.method ?? '', path, query, headers: request.headers, body, bytes: bytes.length });

        const document = path.match(/^\/dev-kit\/([a-z]+)\.json$/);

        if (document !== null) {
            try {
                const text = readFileSync(new URL(`${document[1]}.json`, endpointsDirectory), 'utf8').replaceAll('__BASE_URL__', baseUrl);

                response.writeHead(200, { 'Content-Type': 'application/json', ETag: `"${JSON.parse(text).version}"` }).end(text);
            } catch {
                response.writeHead(404).end();
            }

            return;
        }

        const sync = path.match(/^\/mcp\/sync\/([a-z0-9-]+)$/);

        if (sync !== null) {
            const link = links.get(sync[1]);

            if (link === undefined || new URLSearchParams(query).get('signature') !== `sig-${sync[1]}`) {
                refuse(response, 403, 'forbidden', 'Invalid signature.');

                return;
            }

            if (link.expired) {
                refuse(response, 410, 'expired', 'This sync link has expired. Call request_sync again for a new one.');

                return;
            }

            if (behaviour.rateLimited !== null) {
                refuse(response, 429, 'rate_limited', 'Too many requests.', { retry_after_seconds: behaviour.rateLimited }, { 'Retry-After': String(behaviour.rateLimited) });

                return;
            }

            if (request.method === 'GET') {
                if (behaviour.getStatus !== null) {
                    response.writeHead(behaviour.getStatus, { Location: 'https://elsewhere.example/steal' }).end();

                    return;
                }

                const product = link.slug === null ? null : products.get(link.slug) ?? null;

                send(response, 200, { sync: 1, product: clone(product), feedback: feedbackFor(product) });

                return;
            }

            if (request.method === 'POST') {
                push(response, link, body ?? {});

                return;
            }
        }

        const upload = path.match(/^\/mcp\/uploads\/([a-z0-9-]+)$/);

        if (upload !== null && request.method === 'PUT') {
            receive(response, upload[1], bytes);

            return;
        }

        response.writeHead(404).end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();

    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

    return {
        baseUrl,
        requests,
        behaviour,
        products,
        /**
         * Seed a product the marketplace holds.
         *
         * @param {Record<string, any>} product
         */
        seed(product) {
            products.set(product.slug, clone(product));

            return product;
        },
        /**
         * Issue a sync link, as request_sync does: for a product, or for
         * one new product when the slug is null.
         *
         * @param {string|null} slug
         */
        issueLink(slug) {
            const id = randomUUID();

            links.set(id, { slug, expired: false });

            return `${baseUrl}/mcp/sync/${id}?expires=1790000000&signature=sig-${id}`;
        },
        /**
         * @param {string} url
         */
        expire(url) {
            const id = new URL(url).pathname.split('/').pop() ?? '';
            const link = links.get(id);

            if (link !== undefined) {
                link.expired = true;
            }
        },
        /** The push requests (POST) made so far. */
        pushes() {
            return requests.filter((entry) => entry.method === 'POST');
        },
        /** The uploads (PUT) made so far. */
        uploads() {
            return requests.filter((entry) => entry.method === 'PUT');
        },
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
        }),
    };
}
