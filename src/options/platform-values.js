/**
 * The platform holds option values with its own scalar rules: one array
 * type for lists and maps, integers apart from floats, and its own
 * string, number, and boolean conversions. These helpers reproduce the
 * conversions the options inferrer and the value coercion rely on, so the
 * kit reaches the same values from the same input.
 *
 * A literal map from a template is held as a Map (insertion order, like
 * the platform's arrays); a float literal as a PlatformFloat until it leaves
 * the inferrer, so its string form in a default expression and its JSON
 * (`-0.0`) follow the platform's.
 */

export class PlatformFloat {
    /**
     * @param {number} value
     */
    constructor(value) {
        this.value = value;
    }
}

const integerKey = /^(?:0|-?[1-9][0-9]*)$/;

/**
 * The key a map literal's key becomes on the platform: a decimal integer
 * string becomes an integer key.
 *
 * @param {string} key
 * @returns {string|number}
 */
export function platformArrayKey(key) {
    if (integerKey.test(key)) {
        const number = Number(key);

        if (Number.isSafeInteger(number)) {
            return number;
        }
    }

    return key;
}

/**
 * Whether a Map literal is a list on the platform: its keys are 0, 1, 2
 * in order once integer strings become integers.
 *
 * @param {Map<string, unknown>} map
 */
function isListMap(map) {
    let expected = 0;

    for (const key of map.keys()) {
        if (platformArrayKey(key) !== expected) {
            return false;
        }

        expected++;
    }

    return true;
}

/**
 * The platform's JSON encoding of a literal, as a signature: two literals
 * are the same default exactly when their signatures match.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function literalSignature(value) {
    if (value instanceof PlatformFloat) {
        return Object.is(value.value, -0) ? '-0.0' : JSON.stringify(value.value);
    }

    if (value instanceof Map) {
        if (isListMap(value)) {
            return `[${[...value.values()].map(literalSignature).join(',')}]`;
        }

        const entries = new Map();

        for (const [key, entry] of value) {
            entries.set(String(platformArrayKey(key)), entry);
        }

        return `{${[...entries].map(([key, entry]) => `${JSON.stringify(key)}:${literalSignature(entry)}`).join(',')}}`;
    }

    if (Array.isArray(value)) {
        return `[${value.map(literalSignature).join(',')}]`;
    }

    return JSON.stringify(value) ?? 'null';
}

/**
 * A literal in the shape the platform publishes it (its JSON): floats as
 * numbers, maps as objects, and a map whose keys run 0, 1, 2 as a list.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function plainLiteral(value) {
    if (value instanceof PlatformFloat) {
        return value.value;
    }

    if (value instanceof Map) {
        if (isListMap(value)) {
            return [...value.values()].map(plainLiteral);
        }

        /** @type {Record<string, unknown>} */
        const object = {};

        for (const [key, entry] of value) {
            object[String(platformArrayKey(key))] = plainLiteral(entry);
        }

        return object;
    }

    if (Array.isArray(value)) {
        return value.map(plainLiteral);
    }

    return value;
}

/**
 * The platform's string form of a float: 14 significant digits, with an
 * exponent from 1.0E+14 up and below 0.0001.
 *
 * @param {number} value
 */
export function platformFloatString(value) {
    if (Number.isNaN(value)) {
        return 'NAN';
    }

    if (!Number.isFinite(value)) {
        return value > 0 ? 'INF' : '-INF';
    }

    if (value === 0) {
        return Object.is(value, -0) ? '-0' : '0';
    }

    const [mantissa, exponentText] = value.toExponential(13).split('e');
    const exponent = Number(exponentText);
    const digits = mantissa.replace(/\.?0+$/, '');

    if (exponent < -4 || exponent >= 14) {
        return `${digits.includes('.') ? digits : `${digits}.0`}E${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
    }

    return String(Number(`${digits}e${exponent}`));
}

/**
 * Whether a JavaScript number from decoded JSON is an integer on the
 * platform. JSON decoding cannot tell `1.0` from `1`, and both print the
 * same, so only an integral value too large for a 64 bit integer counts
 * as a float.
 *
 * @param {number} value
 */
function isPlatformInteger(value) {
    return Number.isInteger(value) && Math.abs(value) < 9223372036854775808;
}

/**
 * The platform's string form of a scalar.
 *
 * @param {string|number|boolean} value
 */
export function platformString(value) {
    if (typeof value === 'boolean') {
        return value ? '1' : '';
    }

    if (typeof value === 'number') {
        return isPlatformInteger(value) ? String(value) : platformFloatString(value);
    }

    return value;
}

/**
 * @param {unknown} value
 * @returns {value is string|number|boolean}
 */
export function isScalar(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

const platformTrimCharacters = ' \t\n\r\0\v';

/**
 * The platform's trim with its default characters.
 *
 * @param {string} text
 */
export function platformTrim(text) {
    let start = 0;
    let end = text.length;

    while (start < end && platformTrimCharacters.includes(text[start])) {
        start++;
    }

    while (end > start && platformTrimCharacters.includes(text[end - 1])) {
        end--;
    }

    return text.slice(start, end);
}

/**
 * The platform's boolean reading of a value, or null when it is not one:
 * true for 1, true, on, yes; false for 0, false, off, no, and empty.
 *
 * @param {unknown} value
 * @returns {boolean|null}
 */
export function platformBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (value === null || value === undefined) {
        return false;
    }

    if (!isScalar(value)) {
        return null;
    }

    const text = platformString(value).replace(/^[ \t\n\r\v]+|[ \t\n\r\v]+$/g, '').toLowerCase();

    if (['1', 'true', 'on', 'yes'].includes(text)) {
        return true;
    }

    if (['0', 'false', 'off', 'no', ''].includes(text)) {
        return false;
    }

    return null;
}

const numericString = /^[ \t\n\r\v\f]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\n\r\v\f]*$/;

/**
 * The platform's number reading of a value (`value + 0` when it is
 * numeric), or null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function platformNumber(value) {
    if (typeof value === 'number') {
        return value;
    }

    if (typeof value !== 'string' || !numericString.test(value)) {
        return null;
    }

    return Number(value.trim());
}

/**
 * Whether a decoded JSON value is a list on the platform.
 *
 * @param {unknown} value
 */
export function isPlatformList(value) {
    if (Array.isArray(value)) {
        return true;
    }

    if (value === null || typeof value !== 'object') {
        return false;
    }

    return Object.keys(value).every((key, index) => key === String(index));
}

/**
 * Whether a decoded JSON value is an array (list or map) on the platform.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>|unknown[]}
 */
export function isPlatformArray(value) {
    return value !== null && typeof value === 'object';
}
