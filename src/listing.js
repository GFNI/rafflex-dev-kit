/**
 * listing.md: the product's listing as one Markdown file.
 *
 *   ---
 *   category_ids: [3, 7]
 *   tag_names: ["arcade", "spin"]
 *   video_url: ""
 *   ---
 *
 *   ## Description
 *
 *   <description>
 *
 *   ## Documentation
 *
 *   <documentation>
 *
 *   ## Install notes
 *
 *   <install notes>
 *
 * The frontmatter is a small YAML subset (flow lists, quoted or bare
 * scalars, and `- item` block lists). The three headings split the body at
 * their first occurrence in that order, so a body may hold its own `##`
 * headings. A body is the text between its heading and the next one with
 * surrounding blank lines and trailing whitespace removed (the platform
 * trims these fields on save too).
 */

export const listingSections = /** @type {const} */ ([
    ['description', 'Description'],
    ['documentation', 'Documentation'],
    ['install_notes', 'Install notes'],
]);

/**
 * @typedef {{description: string, documentation: string, install_notes: string, video_url: string, category_ids: number[], tag_names: string[]}} ListingFields
 */

export class ListingError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'ListingError';
    }
}

/**
 * @returns {ListingFields}
 */
export function emptyListing() {
    return { description: '', documentation: '', install_notes: '', video_url: '', category_ids: [], tag_names: [] };
}

/**
 * @param {string} raw
 * @returns {string}
 */
function parseScalar(raw) {
    const value = raw.trim();

    if (value.startsWith('"')) {
        try {
            return String(JSON.parse(value));
        } catch {
            throw new ListingError(`Could not read the quoted value ${value} in listing.md's frontmatter.`);
        }
    }

    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        return value.slice(1, -1).replaceAll("''", "'");
    }

    return value;
}

/**
 * Split a flow list body on commas outside quotes.
 *
 * @param {string} body
 * @returns {string[]}
 */
function splitFlowList(body) {
    /** @type {string[]} */
    const items = [];
    let current = '';
    /** @type {string|null} */
    let quote = null;

    for (let index = 0; index < body.length; index++) {
        const character = body[index];

        if (quote !== null) {
            current += character;

            if (character === '\\' && quote === '"') {
                current += body[++index] ?? '';
            } else if (character === quote) {
                quote = null;
            }

            continue;
        }

        if (character === '"' || character === "'") {
            quote = character;
            current += character;
            continue;
        }

        if (character === ',') {
            items.push(current);
            current = '';
            continue;
        }

        current += character;
    }

    if (current.trim() !== '' || items.length > 0) {
        items.push(current);
    }

    return items.map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * @param {string} text
 * @returns {{data: Record<string, string|string[]>, body: string}}
 */
function splitFrontmatter(text) {
    const normalised = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const match = normalised.match(/^---\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/);

    if (match === null) {
        return { data: {}, body: normalised };
    }

    /** @type {Record<string, string|string[]>} */
    const data = {};
    /** @type {string|null} */
    let listKey = null;

    for (const line of match[1].split('\n')) {
        if (line.trim() === '' || line.trim().startsWith('#')) {
            continue;
        }

        const item = line.match(/^\s+-\s*(.*)$/) ?? line.match(/^-\s+(.*)$/);

        if (item !== null && listKey !== null) {
            /** @type {string[]} */ (data[listKey]).push(parseScalar(item[1]));
            continue;
        }

        const pair = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);

        if (pair === null) {
            throw new ListingError(`listing.md's frontmatter has a line it cannot read: "${line}".`);
        }

        const [, key, rawValue] = pair;
        const value = rawValue.trim();

        listKey = null;

        if (value === '') {
            data[key] = [];
            listKey = key;
            continue;
        }

        if (value.startsWith('[')) {
            if (!value.endsWith(']')) {
                throw new ListingError(`listing.md's ${key} list is not closed with ].`);
            }

            data[key] = splitFlowList(value.slice(1, -1)).map(parseScalar);
            continue;
        }

        data[key] = parseScalar(value);
    }

    return { data, body: normalised.slice(match[0].length) };
}

/**
 * @param {string} text
 */
function trimBody(text) {
    return text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

/**
 * @param {string|string[]|undefined} value
 * @param {string} key
 * @returns {string[]}
 */
function asList(value, key) {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value)) {
        if (value === '') {
            return [];
        }

        throw new ListingError(`listing.md's ${key} must be a list, like ${key}: [].`);
    }

    return value;
}

/**
 * Read listing.md into the listing fields. Missing fields are empty.
 *
 * @param {string} text
 * @returns {ListingFields}
 */
export function parseListing(text) {
    const { data, body } = splitFrontmatter(text);
    const fields = emptyListing();

    fields.category_ids = asList(data.category_ids, 'category_ids').map((value) => {
        const id = Number(value);

        if (!Number.isInteger(id) || id < 0 || String(value).trim() === '') {
            throw new ListingError(`listing.md's category_ids must be whole numbers; "${value}" is not.`);
        }

        return id;
    });
    fields.tag_names = asList(data.tag_names, 'tag_names').map(String);

    if (Array.isArray(data.video_url)) {
        if (data.video_url.length > 0) {
            throw new ListingError("listing.md's video_url must be a single URL or \"\".");
        }
    } else {
        fields.video_url = data.video_url ?? '';
    }

    const lines = body.split('\n');
    /** @type {{key: string, line: number}[]} */
    const headings = [];
    let from = 0;

    for (const [key, heading] of listingSections) {
        const pattern = new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, 'i');
        const index = lines.findIndex((line, position) => position >= from && pattern.test(line));

        if (index !== -1) {
            headings.push({ key, line: index });
            from = index + 1;
        }
    }

    headings.forEach(({ key, line }, position) => {
        const end = headings[position + 1]?.line ?? lines.length;

        fields[/** @type {'description'|'documentation'|'install_notes'} */ (key)] = trimBody(lines.slice(line + 1, end).join('\n'));
    });

    return fields;
}

/**
 * Write the listing fields as listing.md, in the format parseListing
 * reads back to the same fields.
 *
 * @param {Partial<ListingFields>} [listing]
 * @returns {string}
 */
export function formatListing(listing = {}) {
    const fields = { ...emptyListing(), ...listing };
    const flowList = (/** @type {unknown[]|null|undefined} */ items) => `[${(items ?? []).map((item) => JSON.stringify(item)).join(', ')}]`;
    const frontmatter = [
        '---',
        `category_ids: ${flowList(fields.category_ids)}`,
        `tag_names: ${flowList(fields.tag_names)}`,
        `video_url: ${JSON.stringify(fields.video_url ?? '')}`,
        '---',
    ].join('\n');
    const sections = listingSections.map(([key, heading]) => {
        const body = trimBody(String(fields[/** @type {'description'|'documentation'|'install_notes'} */ (key)] ?? ''));

        return body === '' ? `## ${heading}\n` : `## ${heading}\n\n${body}\n`;
    });

    return `${frontmatter}\n\n${sections.join('\n')}`;
}

/**
 * JSON with object keys sorted at every level, the kit's canonical form
 * for hashing structured values.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sortedJson(value) {
    return JSON.stringify(value, (key, entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return entry;
        }

        return Object.fromEntries(Object.keys(entry).sort().map((name) => [name, entry[name]]));
    });
}

/**
 * The canonical listing used for hashing: sorted key JSON of the six
 * fields, with category ids and tag names sorted, missing values empty,
 * and the three long text fields trimmed. Trimming both sides keeps the
 * hash of a parsed listing.md equal to the hash of the server's fields,
 * whatever blank lines surround a body.
 *
 * @param {Partial<ListingFields>|null|undefined} listing
 * @returns {string}
 */
export function canonicalListing(listing) {
    const fields = { ...emptyListing(), ...(listing ?? {}) };

    return sortedJson({
        category_ids: [...(fields.category_ids ?? [])].map(Number).sort((first, second) => first - second),
        description: String(fields.description ?? '').trim(),
        documentation: String(fields.documentation ?? '').trim(),
        install_notes: String(fields.install_notes ?? '').trim(),
        tag_names: [...(fields.tag_names ?? [])].map(String).sort(),
        video_url: fields.video_url ?? '',
    });
}
