import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

/**
 * Characters Laravel's Str::ascii (English) transliterates to more than
 * their accent stripped form. Anything else non ASCII that does not
 * decompose is dropped, as it is there.
 *
 * @type {Record<string, string>}
 */
const transliterations = {
    ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', œ: 'oe', Œ: 'OE', ł: 'l', Ł: 'L',
    đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'TH', ı: 'i', '£': 'PS', '€': 'EUR',
    '©': '(c)', '®': '(r)', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"',
};

/**
 * Laravel's Str::slug, which the studio uses for a new upload's default
 * tag: transliterate to ASCII, underscores and whitespace become hyphens,
 * `@` becomes `at`, everything other than letters, numbers, and hyphens is
 * removed, and the result is lower case with no leading or trailing hyphen.
 *
 * @param {string} title
 */
export function slugify(title) {
    let ascii = '';

    for (const character of title.normalize('NFKD')) {
        if (/\p{M}/u.test(character)) {
            continue;
        }

        if (transliterations[character] !== undefined) {
            ascii += transliterations[character];
            continue;
        }

        if (character.charCodeAt(0) < 0x80) {
            ascii += character;
        }
    }

    return ascii
        .replace(/_+/g, '-')
        .replaceAll('@', '-at-')
        .toLowerCase()
        .replace(/[^-a-z0-9\s]+/g, '')
        .replace(/[-\s]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * The filename without its last extension, as PHP's pathinfo reads it.
 *
 * @param {string} filename
 */
export function filenameStem(filename) {
    const lastDot = filename.lastIndexOf('.');

    return lastDot === -1 ? filename : filename.slice(0, lastDot);
}

/**
 * The tag the studio would give an upload with this filename: the
 * slugified stem, or `file-` and a short suffix when nothing is left. The
 * studio's suffix is random; the kit's is derived from the filename so it
 * is stable between runs (rename such a file to choose a real tag).
 *
 * @param {string} filename
 */
export function defaultTagFor(filename) {
    const tag = slugify(filenameStem(filename));

    if (tag !== '') {
        return tag;
    }

    return `file-${createHash('sha1').update(filename).digest('hex').slice(0, 6)}`;
}

/**
 * The media kind a file is stored as, from the published
 * kinds_by_extension when given, else the platform's own mapping.
 *
 * @param {string} filename
 * @param {Record<string, string>} [kindsByExtension]
 * @returns {string}
 */
export function kindOf(filename, kindsByExtension) {
    const extension = extname(filename).slice(1).toLowerCase();

    if (kindsByExtension?.[extension] !== undefined) {
        return kindsByExtension[extension];
    }

    switch (extension) {
        case 'glb':
            return 'model';
        case 'js':
            return 'library';
        case 'mp3':
            return 'audio';
        default:
            return 'image';
    }
}

/** @type {Record<string, string>} */
const kindLabels = { image: 'image', audio: 'audio', model: '3D model', library: 'library' };

/**
 * Laravel's Number::fileSize with no decimals, as the upload refusals
 * print limits.
 *
 * @param {number} bytes
 */
export function fileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${Math.round(value)} ${units[unit]}`;
}

/**
 * @param {string} template
 * @param {Record<string, string>} replacements
 */
function fillMessage(template, replacements) {
    return template.replace(/:([a-z_]+)/g, (placeholder, name) => replacements[name] ?? placeholder);
}

const compressionExtensions = ['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression'];

/**
 * The platform's .glb refusals (MediaUploadRules::modelRefusal), published
 * as upload_rules.refusals.invalid_model and compressed_model. These are
 * used only when cached rules predate those two keys.
 *
 * @type {Record<string, string>}
 */
const fallbackRefusals = {
    invalid_model: ':filename is not a valid .glb file. Export it from Blender as glTF 2.0, format glTF Binary.',
    compressed_model: 'Compressed models need decoders the platform does not ship yet. Export without Draco, KTX2, or meshopt compression.',
};

/**
 * Why a .glb is not a model the platform accepts: binary glTF 2.0 (the
 * glTF magic, version 2, a declared length matching the file, a JSON
 * first chunk) that does not ask for a compression extension. Returns the
 * refusal key or null.
 *
 * @param {Buffer} contents
 * @returns {'invalid_model'|'compressed_model'|null}
 */
export function glbRefusal(contents) {
    if (contents.length < 20) {
        return 'invalid_model';
    }

    if (contents.toString('latin1', 0, 4) !== 'glTF' || contents.readUInt32LE(4) !== 2 || contents.readUInt32LE(8) !== contents.length) {
        return 'invalid_model';
    }

    const chunkLength = contents.readUInt32LE(12);

    if (contents.toString('latin1', 16, 20) !== 'JSON') {
        return 'invalid_model';
    }

    let gltf;

    try {
        gltf = JSON.parse(contents.toString('utf8', 20, 20 + chunkLength));
    } catch {
        return 'invalid_model';
    }

    if (gltf === null || typeof gltf !== 'object') {
        return 'invalid_model';
    }

    const declared = [
        ...(Array.isArray(gltf.extensionsRequired) ? gltf.extensionsRequired : []),
        ...(Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed : []),
    ];

    return declared.some((extension) => compressionExtensions.includes(extension)) ? 'compressed_model' : null;
}

/**
 * @typedef {{name: string, version: string, url: string, sha256: string, licence?: string, contents?: string, default_tag?: string}} ApprovedLibrary
 * @typedef {{path: string, filename: string, tag: string, kind: string, size: number, url: string, library?: ApprovedLibrary}} ProjectAsset
 * @typedef {{file: string, message: string}} AssetRefusal
 * @typedef {{assets: ProjectAsset[], refusals: AssetRefusal[], files: Record<string, string>}} AssetScan
 */

/**
 * @param {string} directory
 * @returns {string[]}
 */
function listFiles(directory) {
    /** @type {string[]} */
    let entries;

    try {
        entries = readdirSync(directory);
    } catch {
        return [];
    }

    /** @type {string[]} */
    const files = [];

    for (const entry of entries.sort()) {
        if (entry.startsWith('.')) {
            continue;
        }

        const path = join(directory, entry);
        const stats = statSync(path);

        if (stats.isDirectory()) {
            files.push(...listFiles(path));
            continue;
        }

        if (stats.isFile()) {
            files.push(path);
        }
    }

    return files;
}

/**
 * Read the project's assets folder as the studio would take the uploads:
 * each accepted file gets its default tag (suffixed -2, -3 when taken),
 * approved libraries map to their shared URL, and everything the media
 * library would refuse is reported with the platform's own message.
 *
 * @param {string} assetsDirectory
 * @param {{upload_rules: {extensions: string[], kinds_by_extension?: Record<string, string>, max_bytes_by_kind: Record<string, number>, max_tag_length?: number, tag_pattern?: {pattern: string, flags?: string}, refusals: Record<string, any>}}} rules
 * @param {ApprovedLibrary[]} libraries
 * @param {(relativePath: string) => string} urlFor The local URL a file is served at.
 * @returns {AssetScan}
 */
export function scanAssets(assetsDirectory, rules, libraries, urlFor) {
    const uploadRules = rules.upload_rules;
    const refusalMessages = uploadRules.refusals ?? {};
    /** @type {ProjectAsset[]} */
    const assets = [];
    /** @type {AssetRefusal[]} */
    const refusals = [];
    /** @type {Record<string, string>} */
    const files = {};
    const takenTags = new Set();
    const tagPattern = uploadRules.tag_pattern ? new RegExp(uploadRules.tag_pattern.pattern, (uploadRules.tag_pattern.flags ?? '').replace('g', '')) : /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const maxTagLength = uploadRules.max_tag_length ?? 64;

    for (const path of listFiles(assetsDirectory)) {
        const relativePath = relative(assetsDirectory, path).split(sep).join('/');
        const filename = relativePath.split('/').pop() ?? relativePath;
        const extension = extname(filename).slice(1).toLowerCase();
        const kind = kindOf(filename, uploadRules.kinds_by_extension);
        const size = statSync(path).size;
        const file = `assets/${relativePath}`;
        const refuse = (/** @type {string} */ key, /** @type {Record<string, string>} */ replacements = {}) => {
            const published = refusalMessages[key];
            const message = (typeof published === 'object' && published !== null ? published[kind] : published)
                ?? fallbackRefusals[key]
                ?? `${filename} cannot be uploaded (${key}).`;

            refusals.push({ file, message: fillMessage(message, { filename, ...replacements }) });
        };

        if (extension === 'blend' || extension === 'gltf') {
            refuse(extension);
            continue;
        }

        if (!uploadRules.extensions.includes(extension)) {
            refuse('unsupported_type', { extensions: uploadRules.extensions.join(', ') });
            continue;
        }

        const maxBytes = uploadRules.max_bytes_by_kind?.[kind];

        if (maxBytes !== undefined && size > maxBytes) {
            refuse('too_large', { max: fileSize(maxBytes), kind: kindLabels[kind] });
            continue;
        }

        /** @type {ApprovedLibrary|undefined} */
        let library;

        if (kind === 'library') {
            const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');

            library = libraries.find((candidate) => candidate.sha256.toLowerCase() === sha256);

            if (library === undefined) {
                refuse('unapproved_library');
                continue;
            }
        }

        if (kind === 'model') {
            const refusal = glbRefusal(readFileSync(path));

            if (refusal !== null) {
                refuse(refusal);
                continue;
            }
        }

        const baseTag = library?.default_tag ?? defaultTagFor(filename);
        let tag = baseTag;
        let suffix = 1;

        while (takenTags.has(tag)) {
            suffix++;
            tag = `${baseTag}-${suffix}`;
        }

        if (tag.length > maxTagLength || !tagPattern.test(tag)) {
            refuse('invalid_tag');
            continue;
        }

        takenTags.add(tag);

        const url = library?.url ?? urlFor(relativePath);

        assets.push({ path: relativePath, filename, tag, kind, size, url, library });
        files[tag] = url;
    }

    return { assets, refusals, files };
}
