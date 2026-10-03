import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { batchSizeFrom, inBatches } from '../src/push-request.js';
import { checkedUploadUrl, maskedLink, parseSyncLink, productAndLink, refusalFrom, uploadOrigins } from '../src/sync-link.js';
import { fixtureDocuments } from './helpers/project.js';

const base = 'https://marketplace.rafflex.io';
const raw = `${base}/mcp/sync/0f6c?expires=1790000000&signature=abcdef0123456789`;

describe('sync link', () => {
    test('is accepted only on the workspace\'s marketplace, and printed without its signature', () => {
        const link = parseSyncLink(raw, base);

        assert.equal(link.display, `${base}/mcp/sync/0f6c?…`);
        assert.equal(maskedLink(new URL(`${base}/x`)), `${base}/x`);
        assert.throws(() => parseSyncLink('https://elsewhere.example/mcp/sync/0f6c?signature=x', base), /not on https:\/\/marketplace\.rafflex\.io/);
        assert.throws(() => parseSyncLink('https://user:pass@marketplace.rafflex.io/mcp/sync/0f6c', base), /not a sync link/);
        assert.throws(() => parseSyncLink('ftp://marketplace.rafflex.io/x', base), /not a sync link/);
        assert.throws(() => parseSyncLink('not a link', base), /not a link/);
    });

    test('takes the product from the folder when only a link is given', () => {
        assert.deepEqual(productAndLink([raw]), { name: undefined, link: raw });
        assert.deepEqual(productAndLink(['spin-to-win', raw]), { name: 'spin-to-win', link: raw });
        assert.deepEqual(productAndLink(['spin-to-win']), { name: 'spin-to-win', link: undefined });
    });

    test('upload links must be on the marketplace or its media origins, over https', () => {
        const link = parseSyncLink(raw, base);
        const allowed = uploadOrigins(link, fixtureDocuments().rules);

        assert.ok(allowed.has(base));
        assert.ok(allowed.has('https://static.rafflex.io'));
        assert.equal(checkedUploadUrl(`${base}/mcp/uploads/1?signature=y`, allowed, 'https:').origin, base);
        assert.throws(() => checkedUploadUrl('https://elsewhere.example/upload', allowed, 'https:'), /not the marketplace/);
        assert.throws(() => checkedUploadUrl('http://marketplace.rafflex.io/upload', allowed, 'https:'), /not the marketplace/);
    });

    test('turns each refusal into what to do next', () => {
        const answer = (/** @type {number} */ status, /** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) => refusalFrom({ status, headers, text: JSON.stringify(body) });

        assert.equal(answer(410, {}).exitCode, 2);
        assert.match(answer(410, {}).message, /request_sync/);
        assert.equal(answer(429, { error: { code: 'rate_limited' } }, { 'retry-after': '7' }).retryAfterSeconds, 7);
        assert.equal(answer(409, { error: { code: 'conflict', message: 'In review.' } }).exitCode, 1);
        assert.match(answer(409, { error: { code: 'conflict', message: 'In review.' } }).message, /export_product/);
        assert.deepEqual(answer(422, { error: { code: 'validation_failed', message: 'No.', issues: [{ code: 'invalid_argument', field: 'version', message: 'Taken.' }] } }).issues, [{ code: 'invalid_argument', field: 'version', message: 'Taken.' }]);
        assert.equal(answer(302, {}).code, 'unexpected_response');
    });

    test('batches uploads by the published limit', () => {
        assert.equal(batchSizeFrom({ upload_rules: { max_files_per_batch: 3 } }), 3);
        assert.equal(batchSizeFrom({}), 10);
        assert.deepEqual(inBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    });
});
