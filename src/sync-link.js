import { createReadStream, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { kitVersion } from './version.js';

/**
 * The sync link (PRD 45): a short lived link the creator's AI asks the
 * marketplace for with `request_sync`, and hands to `push`, `synced`, or
 * `release` as an argument. The kit reads the product's state from it
 * (GET), pushes to it (POST), and uploads each file to the upload link
 * the marketplace answers with (PUT).
 *
 * The link is a capability, so the kit treats it like a password: it is
 * never written to disk, never committed, and printed only with its
 * signature elided. The kit sends to the link's own origin, which must be
 * the marketplace the workspace uses, and to upload links on that origin
 * or the marketplace's known media origins. It never follows a redirect.
 */

const requestTimeoutMs = 30000;
const uploadTimeoutMs = 120000;
const maxResponseBytes = 32 * 1024 * 1024;

/** The sync document format this kit reads. */
export const SyncFormat = 1;

/** Headers the kit sets itself, or never forwards from an upload grant. */
const reservedHeaders = ['host', 'content-length', 'transfer-encoding', 'connection', 'authorization', 'cookie', 'proxy-authorization'];

/**
 * @typedef {{code: string, field?: string, message: string, line?: number, fix?: string}} SyncIssue
 */

export class SyncLinkError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {{exitCode?: number, issues?: SyncIssue[], retryAfterSeconds?: number|null, status?: number|null}} [details]
     */
    constructor(code, message, { exitCode = 2, issues, retryAfterSeconds = null, status = null } = {}) {
        super(message);
        this.name = 'SyncLinkError';
        this.code = code;
        this.exitCode = exitCode;
        this.issues = issues;
        this.retryAfterSeconds = retryAfterSeconds;
        this.status = status;
    }

    /**
     * The error as the commands' JSON reports it.
     *
     * @returns {{code: string, message: string, issues?: SyncIssue[], retry_after_seconds?: number}}
     */
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            ...(this.issues === undefined ? {} : { issues: this.issues }),
            ...(this.retryAfterSeconds === null ? {} : { retry_after_seconds: this.retryAfterSeconds }),
        };
    }
}

export const newLinkAdvice = 'Ask your AI for a new link with request_sync, then run the command again.';

/**
 * @typedef {{url: URL, origin: string, display: string}} SyncLink
 */

/**
 * The link with its query (the signature and expiry) elided, for output.
 *
 * @param {URL} url
 */
export function maskedLink(url) {
    return `${url.origin}${url.pathname}${url.search === '' ? '' : '?…'}`;
}

/**
 * Whether a command argument looks like a link rather than a product.
 *
 * @param {string|undefined} argument
 */
export function looksLikeLink(argument) {
    return typeof argument === 'string' && /^https?:\/\//i.test(argument);
}

/**
 * Split `<product> <sync_url>` positionals, where the product is optional
 * inside a product folder (`push "<sync_url>"`).
 *
 * @param {string[]} positionals
 * @returns {{name: string|undefined, link: string|undefined}}
 */
export function productAndLink(positionals) {
    if (positionals.length === 1 && looksLikeLink(positionals[0])) {
        return { name: undefined, link: positionals[0] };
    }

    return { name: positionals[0], link: positionals[1] };
}

/**
 * Parse and check a sync link: an http(s) URL with no user name or
 * password, on the marketplace this workspace uses.
 *
 * @param {string} raw
 * @param {string} baseUrl The workspace's marketplace.
 * @returns {SyncLink}
 */
export function parseSyncLink(raw, baseUrl) {
    /** @type {URL} */
    let url;

    try {
        url = new URL(String(raw).trim());
    } catch {
        throw new SyncLinkError('invalid_link', `That is not a link. ${newLinkAdvice}`);
    }

    if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
        throw new SyncLinkError('invalid_link', `That is not a sync link. ${newLinkAdvice}`);
    }

    const marketplace = new URL(baseUrl).origin;

    if (url.origin !== marketplace) {
        throw new SyncLinkError('invalid_link', `That link is not on ${marketplace}, the marketplace this workspace uses, so nothing was sent. ${newLinkAdvice}`);
    }

    url.hash = '';

    return { url, origin: url.origin, display: maskedLink(url) };
}

/**
 * The origins an upload link may point at: the sync link's own origin,
 * and the media origins the marketplace's published preview rules name
 * (where its uploads are served from).
 *
 * @param {SyncLink} link
 * @param {any} rules
 * @returns {Set<string>}
 */
export function uploadOrigins(link, rules) {
    const origins = new Set([link.origin]);
    const csp = rules?.preview_csp ?? {};

    for (const directive of ['img-src', 'media-src', 'script-src', 'connect-src']) {
        for (const source of Array.isArray(csp[directive]) ? csp[directive] : []) {
            try {
                const url = new URL(String(source));

                if (url.protocol === 'https:') {
                    origins.add(url.origin);
                }
            } catch {
                // A keyword such as 'self', not an origin.
            }
        }
    }

    return origins;
}

/**
 * Check an upload link before anything is sent to it.
 *
 * @param {unknown} putUrl
 * @param {Set<string>} allowed
 * @param {string} linkProtocol The sync link's protocol: an upload link is never less secure.
 * @returns {URL}
 */
export function checkedUploadUrl(putUrl, allowed, linkProtocol) {
    /** @type {URL} */
    let url;

    try {
        url = new URL(String(putUrl));
    } catch {
        throw new SyncLinkError('unexpected_response', 'The marketplace answered with an upload link that is not a URL, so nothing was sent.');
    }

    if (!allowed.has(url.origin) || url.username !== '' || url.password !== '' || (linkProtocol === 'https:' && url.protocol !== 'https:')) {
        throw new SyncLinkError('unexpected_response', `The upload link points at ${url.origin}, which is not the marketplace, so nothing was sent.`);
    }

    return url;
}

/**
 * @typedef {{status: number, headers: import('node:http').IncomingHttpHeaders, text: string}} RawResponse
 */

/**
 * One HTTP request without following redirects. The body is a string, or
 * a file streamed from disk with its exact size.
 *
 * @param {URL} url
 * @param {{method: string, headers?: Record<string, string>, body?: string, file?: {path: string, size: number}, timeoutMs?: number}} options
 * @returns {Promise<RawResponse>}
 */
export function sendRequest(url, { method, headers = {}, body, file, timeoutMs = requestTimeoutMs }) {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    /** @type {Record<string, string|number>} */
    const outgoingHeaders = { 'User-Agent': `rafflex-dev/${kitVersion}`, ...headers };

    if (body !== undefined) {
        outgoingHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    if (file !== undefined) {
        outgoingHeaders['Content-Length'] = file.size;
    }

    return new Promise((resolve, reject) => {
        const outgoing = send(url, { method, headers: outgoingHeaders, timeout: timeoutMs }, (response) => {
            /** @type {Buffer[]} */
            const chunks = [];
            let received = 0;

            response.on('data', (chunk) => {
                received += chunk.length;

                if (received > maxResponseBytes) {
                    response.destroy(new Error('the answer was too large'));

                    return;
                }

                chunks.push(chunk);
            });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
            response.on('error', reject);
        });

        outgoing.on('timeout', () => outgoing.destroy(new Error('the request timed out')));
        outgoing.on('error', reject);

        if (file !== undefined) {
            const stream = createReadStream(file.path);

            stream.on('error', (error) => outgoing.destroy(error));
            stream.pipe(outgoing);

            return;
        }

        outgoing.end(body);
    });
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * The wait a 429 asks for, from the error body or the Retry-After header.
 *
 * @param {any} error
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {number|null}
 */
function retryAfter(error, headers) {
    if (Number.isFinite(error?.retry_after_seconds)) {
        return Math.max(0, Math.ceil(Number(error.retry_after_seconds)));
    }

    const header = Number(headers['retry-after']);

    return Number.isFinite(header) ? Math.max(0, Math.ceil(header)) : null;
}

/**
 * The marketplace's issues, in the shape the kit prints like check's.
 *
 * @param {unknown} issues
 * @returns {SyncIssue[]}
 */
function normaliseIssues(issues) {
    if (!Array.isArray(issues)) {
        return [];
    }

    return issues
        .filter((issue) => issue !== null && typeof issue === 'object')
        .map((issue) => ({
            code: typeof issue.code === 'string' ? issue.code : 'invalid_argument',
            ...(typeof issue.field === 'string' ? { field: issue.field } : {}),
            message: String(issue.message ?? ''),
            ...(Number.isInteger(issue.line) ? { line: issue.line } : {}),
            ...(typeof issue.fix === 'string' ? { fix: issue.fix } : {}),
        }));
}

/**
 * Turn a refused or failed answer into a SyncLinkError the commands can
 * report: what happened and what to do next.
 *
 * @param {RawResponse} response
 * @returns {SyncLinkError}
 */
export function refusalFrom(response) {
    const error = parseJson(response.text)?.error ?? null;
    const message = typeof error?.message === 'string' && error.message !== '' ? error.message : null;
    const { status } = response;

    if (status >= 300 && status < 400) {
        return new SyncLinkError('unexpected_response', `The marketplace answered with a redirect, which the kit never follows, so nothing more was sent. ${newLinkAdvice}`, { status });
    }

    if (status === 410) {
        return new SyncLinkError('expired', 'The sync link has expired (it works for 15 minutes). Ask your AI for a new link with request_sync, then run the command again.', { status });
    }

    if (status === 403 || status === 401) {
        return new SyncLinkError('forbidden', `${message ?? 'The marketplace refused this link.'} ${newLinkAdvice}`, { status });
    }

    if (status === 429) {
        const seconds = retryAfter(error, response.headers);
        const wait = seconds === null ? 'a minute' : `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;

        return new SyncLinkError('rate_limited', `The marketplace is limiting how often this account pushes. Wait ${wait}, then run the command again (the same link works until it expires, or ask for a new one with request_sync).`, { status, retryAfterSeconds: seconds });
    }

    if (status === 409) {
        const text = message ?? 'The draft on the marketplace changed since this workspace last read it, so nothing was applied.';
        const route = /export_product/.test(text) ? '' : ' Commit your work, bring the product local again with export_product and npx @rafflex/dev import <bundle_url> --force, apply your change on top, then push again.';

        return new SyncLinkError('conflict', `${text}${route}`, { exitCode: 1, status });
    }

    if (status === 422) {
        return new SyncLinkError('validation_failed', message ?? 'The marketplace refused the push, and nothing changed.', { exitCode: 1, status, issues: normaliseIssues(error?.issues) });
    }

    return new SyncLinkError(typeof error?.code === 'string' ? error.code : 'unexpected_response', `${message ?? `The marketplace answered ${status}.`} Try again in a minute; if it persists, contact support@rafflex.io.`, { status });
}

/**
 * @typedef {{sync: number, product: Record<string, any>|null, feedback: Record<string, any>|null, check?: any, uploads?: any[]}} SyncDocument
 */

/**
 * GET or POST the sync link and return its document.
 *
 * @param {SyncLink} link
 * @param {'GET'|'POST'} method
 * @param {Record<string, any>} [payload]
 * @returns {Promise<SyncDocument>}
 */
export async function callSyncLink(link, method, payload) {
    /** @type {RawResponse} */
    let response;

    try {
        response = await sendRequest(link.url, {
            method,
            headers: { Accept: 'application/json', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: payload === undefined ? undefined : JSON.stringify(payload),
        });
    } catch (error) {
        throw new SyncLinkError('unreachable', `Could not reach the marketplace (${/** @type {Error} */ (error).message}). Check the connection and run the command again; the link works for 15 minutes.`);
    }

    if (response.status !== 200) {
        throw refusalFrom(response);
    }

    const document = parseJson(response.text);

    if (document === null || typeof document !== 'object' || !Number.isInteger(document.sync)) {
        throw new SyncLinkError('unexpected_response', `The link did not answer with a product's state. ${newLinkAdvice}`);
    }

    if (document.sync > SyncFormat) {
        throw new SyncLinkError('unsupported', `The marketplace sent sync format ${document.sync}, newer than this kit reads (${SyncFormat}). Run the command with npx @rafflex/dev@latest.`);
    }

    const product = document.product !== null && typeof document.product === 'object' && typeof document.product.slug === 'string' && typeof document.product.type === 'string'
        ? document.product
        : null;

    return {
        ...document,
        product,
        feedback: document.feedback !== null && typeof document.feedback === 'object' ? document.feedback : null,
    };
}

/**
 * PUT one file to its upload link, streamed from disk. Resolves with
 * null when the marketplace stored it, or the reason it did not.
 *
 * @param {URL} url
 * @param {{path: string, size: number, headers?: Record<string, unknown>}} file
 * @returns {Promise<string|null>}
 */
export async function uploadFile(url, file) {
    let size;

    try {
        size = statSync(file.path).size;
    } catch {
        return 'the file is gone';
    }

    if (size !== file.size) {
        return 'the file changed after the push was planned';
    }

    /** @type {Record<string, string>} */
    const headers = {};

    for (const [name, value] of Object.entries(file.headers ?? {})) {
        if (typeof value === 'string' && !reservedHeaders.includes(name.toLowerCase())) {
            headers[name] = value;
        }
    }

    let response;

    try {
        response = await sendRequest(url, { method: 'PUT', headers: { Accept: 'application/json', ...headers }, file: { path: file.path, size }, timeoutMs: uploadTimeoutMs });
    } catch (error) {
        return `could not reach the upload link (${/** @type {Error} */ (error).message})`;
    }

    if (response.status >= 200 && response.status < 300) {
        return null;
    }

    const message = parseJson(response.text)?.error?.message;

    return typeof message === 'string' && message !== '' ? message : `the marketplace answered ${response.status}`;
}
