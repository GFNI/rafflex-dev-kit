/**
 * What a file holds, judged by its first bytes rather than its name, so
 * the kit can say before a push that an image or sound is not what its
 * extension claims (the platform inspects the content on receipt).
 */

/**
 * @typedef {'png'|'jpeg'|'webp'|'gif'|'mp3'|'glb'|'bmp'|'avif'|'heic'|'aac'|'wav'|'ogg'} ContentType
 * @typedef {'image'|'audio'|'model'} ContentKind
 */

/** @type {Record<ContentType, string>} */
export const contentLabels = {
    png: 'PNG image',
    jpeg: 'JPEG image',
    webp: 'WebP image',
    gif: 'GIF image',
    mp3: 'MP3 audio',
    glb: '3D model (.glb)',
    bmp: 'BMP image',
    avif: 'AVIF image',
    heic: 'HEIC image',
    aac: 'AAC audio',
    wav: 'WAV audio',
    ogg: 'Ogg audio',
};

/** @type {Record<ContentType, ContentKind>} */
export const contentKinds = {
    png: 'image',
    jpeg: 'image',
    webp: 'image',
    gif: 'image',
    bmp: 'image',
    avif: 'image',
    heic: 'image',
    mp3: 'audio',
    aac: 'audio',
    wav: 'audio',
    ogg: 'audio',
    glb: 'model',
};

/**
 * The content type each extension promises. Extensions not listed are not
 * inspected.
 *
 * @type {Record<string, ContentType>}
 */
export const contentByExtension = {
    png: 'png',
    jpg: 'jpeg',
    jpeg: 'jpeg',
    webp: 'webp',
    gif: 'gif',
    mp3: 'mp3',
    glb: 'glb',
    bmp: 'bmp',
    avif: 'avif',
    heic: 'heic',
    heif: 'heic',
};

/** The usual extension for each content type, for "rename it to" advice. */
/** @type {Record<ContentType, string>} */
export const extensionFor = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', mp3: 'mp3', glb: 'glb', bmp: 'bmp', avif: 'avif', heic: 'heic', aac: 'aac', wav: 'wav', ogg: 'ogg' };

/**
 * @param {Buffer} contents
 * @param {number} offset
 * @param {string} text
 */
function startsWithAt(contents, offset, text) {
    return contents.length >= offset + text.length && contents.toString('latin1', offset, offset + text.length) === text;
}

/**
 * The audio an MPEG style frame header at `offset` starts: ADTS (AAC) has
 * the layer bits 00, which MPEG audio reserves, so it is told apart from
 * MP3 (and MPEG layer I and II, which the platform also takes as MPEG
 * audio). Reserved version bits mean it is no frame at all.
 *
 * @param {Buffer} contents
 * @param {number} offset
 * @returns {'mp3'|'aac'|null}
 */
function frameAudioAt(contents, offset) {
    if (contents.length < offset + 2 || contents[offset] !== 0xff || (contents[offset + 1] & 0xe0) !== 0xe0) {
        return null;
    }

    const second = contents[offset + 1];

    if ((second & 0xf6) === 0xf0) {
        return 'aac';
    }

    const version = (second >> 3) & 0x03;
    const layer = (second >> 1) & 0x03;

    return version === 1 || layer === 0 ? null : 'mp3';
}

/**
 * The content type a file's bytes show, or null when they are none the
 * platform takes.
 *
 * An ID3 tag is skipped and the audio after it judged, as the platform
 * does (AAC behind an ID3 tag is still AAC). When what follows the tag is
 * not recognised the file counts as MP3, so the kit never refuses a file
 * the platform might take.
 *
 * @param {Buffer} contents
 * @returns {ContentType|null}
 */
export function sniffContent(contents) {
    if (startsWithAt(contents, 0, 'ID3')) {
        const tagEnd = contents.length >= 10
            ? 10 + ((contents[6] & 0x7f) << 21 | (contents[7] & 0x7f) << 14 | (contents[8] & 0x7f) << 7 | (contents[9] & 0x7f)) + ((contents[5] & 0x10) === 0 ? 0 : 10)
            : contents.length;

        return frameAudioAt(contents, tagEnd) ?? 'mp3';
    }

    if (startsWithAt(contents, 0, 'RIFF') && startsWithAt(contents, 8, 'WAVE')) {
        return 'wav';
    }

    if (startsWithAt(contents, 0, 'OggS')) {
        return 'ogg';
    }

    if (contents.length >= 8 && contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'png';
    }

    if (contents.length >= 3 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff) {
        return 'jpeg';
    }

    if (startsWithAt(contents, 0, 'RIFF') && startsWithAt(contents, 8, 'WEBP')) {
        return 'webp';
    }

    if (startsWithAt(contents, 0, 'GIF87a') || startsWithAt(contents, 0, 'GIF89a')) {
        return 'gif';
    }

    if (startsWithAt(contents, 0, 'glTF')) {
        return 'glb';
    }

    if (startsWithAt(contents, 0, 'BM') && contents.length >= 14) {
        return 'bmp';
    }

    if (startsWithAt(contents, 4, 'ftyp')) {
        const brand = contents.toString('latin1', 8, 12);

        if (brand === 'avif' || brand === 'avis') {
            return 'avif';
        }

        if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
            return 'heic';
        }
    }

    return frameAudioAt(contents, 0);
}

/**
 * Why a file's content does not match its extension, or null when it
 * does (or the extension is not one the kit inspects).
 *
 * @param {string} filename
 * @param {Buffer} contents
 * @returns {{expected: ContentType, found: ContentType|null}|null}
 */
export function contentMismatch(filename, contents) {
    const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
    const expected = contentByExtension[extension];

    if (expected === undefined) {
        return null;
    }

    const found = sniffContent(contents);

    return found === expected ? null : { expected, found };
}

/**
 * A plain sentence for a mismatch, naming the file and what to do.
 *
 * @param {string} path      The file as the creator sees it ("assets/wheel.png").
 * @param {{expected: ContentType, found: ContentType|null}} mismatch
 */
export function mismatchMessage(path, mismatch) {
    const name = path.split('/').pop() ?? path;
    const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;

    if (mismatch.found === null) {
        return `${path} is named as a ${contentLabels[mismatch.expected]} but its content is not one. Export it again as a real ${contentLabels[mismatch.expected]}.`;
    }

    return `${path} is named as a ${contentLabels[mismatch.expected]} but holds a ${contentLabels[mismatch.found]}. Rename it to ${stem}.${extensionFor[mismatch.found]}, or export it again as a ${contentLabels[mismatch.expected]}.`;
}

/**
 * The content types a list of accepted extensions stands for (the
 * platform builds its accepted MIME types from the extensions the same
 * way), so `["png", "jpg", "mp3"]` accepts PNG, JPEG, and MP3 content.
 *
 * @param {string[]} extensions
 * @returns {ContentType[]}
 */
export function contentTypesFor(extensions) {
    const lower = extensions.map((extension) => String(extension).toLowerCase());

    return [...new Set(lower.map((extension) => contentByExtension[extension]).filter((type) => type !== undefined))];
}

/**
 * @typedef {object} ContentVerdict
 * @property {ContentType} expected What the extension promises.
 * @property {ContentType|null} found What the bytes are, or null when the kit cannot tell.
 * @property {boolean} blocking True when the platform refuses the content.
 */

/**
 * How a file's content stands against its extension, judged as the
 * platform judges an upload: an image or audio extension takes any image
 * or audio content it accepts (a JPEG named hero.png is stored as the
 * JPEG it is), a .glb takes only a binary glTF model. Returns null when
 * the content is what the name says, or another type of the same kind
 * (browsers show any image whatever its extension).
 *
 * - `blocking: true` when the content is none the platform accepts for
 *   that extension (text named .png, AAC or WAV named .mp3).
 * - `blocking: false` when it is accepted but of another kind (audio
 *   named .png): the platform stores it as audio, so the template gets a
 *   sound where its name promises an image.
 *
 * @param {string} filename
 * @param {Buffer} contents
 * @param {ContentType[]} accepted The content types the destination takes.
 * @returns {ContentVerdict|null}
 */
export function contentVerdict(filename, contents, accepted) {
    const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
    const expected = contentByExtension[extension];

    if (expected === undefined) {
        return null;
    }

    const found = sniffContent(contents);

    if (found === expected) {
        return null;
    }

    const takes = contentKinds[expected] === 'model'
        ? accepted.filter((type) => type === expected)
        : accepted.filter((type) => contentKinds[type] !== 'model');

    if (found === null || !takes.includes(found)) {
        return { expected, found, blocking: true };
    }

    return contentKinds[found] === contentKinds[expected] ? null : { expected, found, blocking: false };
}

/**
 * @param {ContentType} type
 */
function withArticle(type) {
    return contentKinds[type] === 'audio' ? contentLabels[type] : `a ${contentLabels[type]}`;
}

/**
 * A plain sentence for a content verdict, naming the file and what to do.
 *
 * @param {string} path      The file as the creator sees it ("assets/wheel.png").
 * @param {ContentVerdict} verdict
 * @param {string} [tag]     The tag a media library file takes, for the warning.
 */
export function contentVerdictMessage(path, verdict, tag) {
    const name = path.split('/').pop() ?? path;
    const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
    const named = `${path} is named as ${withArticle(verdict.expected)}`;

    if (verdict.found === null) {
        return `${named} but its content is not one the marketplace can identify. Export it again as ${withArticle(verdict.expected)}.`;
    }

    if (verdict.blocking) {
        return `${named} but holds ${withArticle(verdict.found)}, which the marketplace does not accept here. Export it again as ${withArticle(verdict.expected)}.`;
    }

    const kind = contentKinds[verdict.found] === 'audio' ? 'a sound' : `an ${contentKinds[verdict.found]}`;
    const reference = tag === undefined ? 'the file' : `files['${tag}']`;

    return `${named} but holds ${withArticle(verdict.found)}. The marketplace stores it as what it is, so ${reference} is ${kind}, not ${contentKinds[verdict.expected] === 'audio' ? 'a sound' : `an ${contentKinds[verdict.expected]}`}. Rename it to ${stem}.${extensionFor[verdict.found]} if that is intended.`;
}

/**
 * The pixel size of a PNG, JPEG, GIF, or WebP image, or null.
 *
 * @param {Buffer} contents
 * @returns {{width: number, height: number}|null}
 */
export function imageDimensions(contents) {
    const type = sniffContent(contents);

    if (type === 'png' && contents.length >= 24) {
        return { width: contents.readUInt32BE(16), height: contents.readUInt32BE(20) };
    }

    if (type === 'gif' && contents.length >= 10) {
        return { width: contents.readUInt16LE(6), height: contents.readUInt16LE(8) };
    }

    if (type === 'webp' && contents.length >= 30) {
        const chunk = contents.toString('latin1', 12, 16);

        if (chunk === 'VP8X') {
            return { width: 1 + contents.readUIntLE(24, 3), height: 1 + contents.readUIntLE(27, 3) };
        }

        if (chunk === 'VP8 ') {
            return { width: contents.readUInt16LE(26) & 0x3fff, height: contents.readUInt16LE(28) & 0x3fff };
        }

        if (chunk === 'VP8L') {
            const bits = contents.readUInt32LE(21);

            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
    }

    if (type === 'jpeg') {
        let offset = 2;

        while (offset + 9 < contents.length) {
            if (contents[offset] !== 0xff) {
                offset++;
                continue;
            }

            const marker = contents[offset + 1];
            const length = contents.readUInt16BE(offset + 2);

            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { width: contents.readUInt16BE(offset + 7), height: contents.readUInt16BE(offset + 5) };
            }

            offset += 2 + length;
        }
    }

    return null;
}
