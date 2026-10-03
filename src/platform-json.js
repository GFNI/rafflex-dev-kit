/**
 * JSON encoding as the platform's `json` filter does it: `/` becomes
 * `\/`, every non ASCII character becomes a lowercase `\uXXXX` escape (astral
 * characters as a surrogate pair), and `< > & ' "` become the uppercase
 * `< > & ' "` escapes.
 *
 * The platform has one array type: an empty array or one keyed 0..n-1
 * encodes as a JSON list, anything else as an object. JavaScript objects
 * with those shapes are encoded the same way so `{{ files|json }}` with
 * no files reads `[]` exactly as it does on the platform.
 */

const hexTagEscapes = {
    '<': '\\u003C',
    '>': '\\u003E',
    '&': '\\u0026',
    "'": '\\u0027',
    '"': '\\u0022',
};

const shortEscapes = {
    '\\': '\\\\',
    '/': '\\/',
    '\b': '\\b',
    '\f': '\\f',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
};

/**
 * @param {string} value
 * @returns {string}
 */
export function encodeString(value) {
    let encoded = '"';

    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        const code = value.charCodeAt(index);

        if (hexTagEscapes[character] !== undefined) {
            encoded += hexTagEscapes[character];
            continue;
        }

        if (shortEscapes[character] !== undefined) {
            encoded += shortEscapes[character];
            continue;
        }

        if (code < 0x20 || code > 0x7e && code !== 0x7f) {
            encoded += `\\u${code.toString(16).padStart(4, '0')}`;
            continue;
        }

        encoded += character;
    }

    return `${encoded}"`;
}

/**
 * A number as the platform's JSON encoding writes it: the shortest round trip form, with a `.0` mantissa in exponent form.
 *
 * @param {number} value
 * @returns {string|false}
 */
export function encodeNumber(value) {
    if (!Number.isFinite(value)) {
        return false;
    }

    const text = String(value);

    if (!text.includes('e')) {
        return text;
    }

    const [mantissa, exponent] = text.split('e');

    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${exponent}`;
}

/**
 * @param {object} value
 * @returns {boolean}
 */
function isPhpList(value) {
    if (Array.isArray(value)) {
        return true;
    }

    const keys = Array.isArray(value._keys) ? value._keys : Object.keys(value);

    return keys.every((key, index) => key === String(index));
}

/**
 * Encode a value as the platform would, or false where the platform fails
 * (non finite numbers), which Twig then prints as an empty string.
 *
 * @param {unknown} value
 * @returns {string|false}
 */
export function platformJsonEncode(value) {
    if (value === undefined || value === null) {
        return 'null';
    }

    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }

    if (typeof value === 'number') {
        return encodeNumber(value);
    }

    if (typeof value === 'string' || value instanceof String) {
        return encodeString(String(value));
    }

    if (value instanceof Date) {
        return encodeString(value.toISOString());
    }

    if (typeof value === 'object') {
        // twig.js hash literals record their written key order in _keys.
        const keys = Array.isArray(value._keys) ? value._keys : Object.keys(value).filter((key) => key !== '_keys');
        const parts = [];

        if (isPhpList(value)) {
            for (const key of keys) {
                const encoded = platformJsonEncode(value[key]);

                if (encoded === false) {
                    return false;
                }

                parts.push(encoded);
            }

            return `[${parts.join(',')}]`;
        }

        for (const key of keys) {
            const encoded = platformJsonEncode(value[key]);

            if (encoded === false) {
                return false;
            }

            parts.push(`${encodeString(key)}:${encoded}`);
        }

        return `{${parts.join(',')}}`;
    }

    return 'null';
}
