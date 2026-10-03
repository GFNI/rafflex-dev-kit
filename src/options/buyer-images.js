import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { referencedFileKeys } from '../checker.js';

/**
 * A buyer who sets up a game may replace every image its template uses
 * (each `files['tag']` the template reads that is an image), with an image
 * of any shape. The kit stands in for a buyer's upload with a placeholder
 * of a different shape (a wide image becomes tall, anything else becomes
 * wide), so the preview and the browser run show whether a game survives
 * that. Placeholders are PNGs drawn here, with no dependency, and served
 * under the product's own assets path, so the preview CSP applies to them
 * exactly as to the creator's files.
 */

/** Below the product's assets path; hidden, so no creator file can collide. */
export const buyerImagePath = '.rafflex/buyer-image/';

const wide = { width: 960, height: 320 };
const tall = { width: 480, height: 720 };

/**
 * @typedef {{tag: string, url: string, width: number, height: number, placeholder_url: string}} BuyerImage
 */

/**
 * The width and height in an image file's header (PNG, GIF, JPEG, WebP),
 * or null.
 *
 * @param {Buffer} bytes
 * @returns {{width: number, height: number}|null}
 */
export function imageDimensions(bytes) {
    if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }

    if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }

    if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = bytes.toString('ascii', 12, 16);

        if (chunk === 'VP8X') {
            return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
        }

        if (chunk === 'VP8L') {
            const bits = bytes.readUInt32LE(21);

            return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }

        if (chunk === 'VP8 ') {
            return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
        }

        return null;
    }

    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;

        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) {
                return null;
            }

            const marker = bytes[offset + 1];
            const length = bytes.readUInt16BE(offset + 2);

            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
            }

            offset += 2 + length;
        }
    }

    return null;
}

/**
 * The first bytes of a file, enough for its dimensions.
 *
 * @param {string} path
 */
function headOf(path) {
    const descriptor = openSync(path, 'r');

    try {
        const buffer = Buffer.alloc(64 * 1024);
        const read = readSync(descriptor, buffer, 0, buffer.length, 0);

        return buffer.subarray(0, read);
    } finally {
        closeSync(descriptor);
    }
}

/**
 * A shape unlike the original's: tall for a wide image, wide otherwise.
 *
 * @param {{width: number, height: number}|null} original
 */
export function placeholderShape(original) {
    return original !== null && original.width > original.height * 1.2 ? tall : wide;
}

/**
 * The images a buyer may replace: each image file the template reads
 * through the files map, in the template's order, once each.
 *
 * @param {string} template
 * @param {{tag: string, kind: string, url: string, path: string}[]} assets
 * @param {string} assetsDirectory
 * @param {string} assetsUrl The product's assets URL path, ending in a slash.
 * @returns {BuyerImage[]}
 */
export function buyerImages(template, assets, assetsDirectory, assetsUrl) {
    /** @type {BuyerImage[]} */
    const images = [];

    for (const tag of referencedFileKeys(template)) {
        const asset = assets.find((candidate) => candidate.tag === tag && candidate.kind === 'image');

        if (asset === undefined) {
            continue;
        }

        let original = null;

        try {
            original = imageDimensions(headOf(join(assetsDirectory, asset.path)));
        } catch {
            original = null;
        }

        const shape = placeholderShape(original);

        images.push({
            tag,
            url: asset.url,
            width: original?.width ?? 0,
            height: original?.height ?? 0,
            placeholder_url: `${assetsUrl}${buyerImagePath}${encodeURIComponent(tag)}.png?w=${shape.width}&h=${shape.height}`,
        });
    }

    return images;
}

/**
 * The files map with every replaceable image pointing at its placeholder;
 * any other key that pointed at the same file follows it, as the
 * platform's merge does.
 *
 * @param {Record<string, string>} files
 * @param {BuyerImage[]} images
 * @returns {Record<string, string>}
 */
export function withBuyerImages(files, images) {
    /** @type {Record<string, string>} */
    const merged = { ...files };

    for (const image of images) {
        for (const [key, url] of Object.entries(files)) {
            if (url === image.url) {
                merged[key] = image.placeholder_url;
            }
        }
    }

    return merged;
}

/** @type {number[]} */
const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;

    for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    return value >>> 0;
});

/**
 * @param {Buffer} bytes
 */
function crc32(bytes) {
    let crc = 0xffffffff;

    for (const byte of bytes) {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
    const length = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);

    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));

    return Buffer.concat([length, body, crc]);
}

/**
 * A placeholder PNG: diagonal stripes inside a dark border, plainly not
 * the creator's art.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function placeholderPng(width, height) {
    const safeWidth = Math.max(8, Math.min(2000, Math.round(width) || wide.width));
    const safeHeight = Math.max(8, Math.min(2000, Math.round(height) || wide.height));
    const border = Math.max(4, Math.round(Math.min(safeWidth, safeHeight) / 40));
    const rows = [];

    for (let y = 0; y < safeHeight; y++) {
        const row = Buffer.alloc(1 + safeWidth * 3);

        for (let x = 0; x < safeWidth; x++) {
            const edge = x < border || y < border || x >= safeWidth - border || y >= safeHeight - border;
            const stripe = Math.floor((x + y) / 24) % 2 === 0;
            const [red, green, blue] = edge ? [23, 23, 23] : stripe ? [244, 114, 182] : [253, 224, 71];
            const offset = 1 + x * 3;

            row[offset] = red;
            row[offset + 1] = green;
            row[offset + 2] = blue;
        }

        rows.push(row);
    }

    const header = Buffer.alloc(13);

    header.writeUInt32BE(safeWidth, 0);
    header.writeUInt32BE(safeHeight, 4);
    header[8] = 8;
    header[9] = 2;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
