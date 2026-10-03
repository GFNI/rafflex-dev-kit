/**
 * The platform's `date` filter, as far as a preview needs it: every
 * format character the platform prints, in UTC (the platform renders in
 * UTC, so `e` and `T` print UTC) or in the time zone the filter is given,
 * and the refusal of text it cannot read as a time.
 */

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * @param {number} value
 * @param {number} length
 */
function pad(value, length) {
    const text = String(Math.abs(value)).padStart(length, '0');

    return value < 0 ? `-${text}` : text;
}

/**
 * The ISO 8601 week and its year for a date.
 *
 * @param {Date} date
 * @returns {{week: number, year: number}}
 */
function isoWeek(date) {
    const day = date.getUTCDay() || 7;
    const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day));
    const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);

    return { week: Math.ceil(((thursday.getTime() - yearStart) / 864e5 + 1) / 7), year: thursday.getUTCFullYear() };
}

/**
 * A time zone as the platform prints it: `e` prints its name, `T` its
 * abbreviation, and `p` prints Z at a zero offset only for UTC and a
 * plain offset.
 *
 * @typedef {object} PlatformZone
 * @property {string} name
 * @property {(date: Date) => number} offset Seconds east of UTC at that moment.
 * @property {(date: Date, offset: number) => string} abbreviation
 * @property {(date: Date) => boolean} dst
 * @property {boolean} zulu
 */

/** @type {PlatformZone} */
export const utcZone = Object.freeze({ name: 'UTC', offset: () => 0, abbreviation: () => 'UTC', dst: () => false, zulu: true });

/**
 * An offset as the platform prints it, +01:00 (or +0100 without the colon).
 *
 * @param {number} seconds
 * @param {string} [separator]
 */
function offsetText(seconds, separator = ':') {
    const minutes = Math.round(Math.abs(seconds) / 60);

    return `${seconds < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60), 2)}${separator}${pad(minutes % 60, 2)}`;
}

/**
 * A fixed offset zone, as a timestamp (+00:00) or "+02:00" gives one.
 *
 * @param {number} seconds
 * @returns {PlatformZone}
 */
export function fixedZone(seconds) {
    return { name: offsetText(seconds), offset: () => seconds, abbreviation: () => `GMT${offsetText(seconds, '')}`, dst: () => false, zulu: true };
}

/**
 * The time zone abbreviations the platform takes as a zone of their own:
 * a fixed offset in hours, and whether it is a summer time.
 *
 * @type {Record<string, [number, boolean]>}
 */
const zoneAbbreviations = {
    utc: [0, false], z: [0, false], gmt: [0, false], wet: [0, false], west: [1, true], bst: [1, true], ist: [2, false],
    cet: [1, false], cest: [2, true], eet: [2, false], eest: [3, true], msk: [3, false],
    est: [-5, false], edt: [-4, true], cst: [-6, false], cdt: [-5, true], mst: [-7, false], mdt: [-6, true],
    pst: [-8, false], pdt: [-7, true], akst: [-9, false], akdt: [-8, true], hst: [-10, false],
    jst: [9, false], awst: [8, false], acst: [9.5, false], acdt: [10.5, true], aest: [10, false], aedt: [11, true],
    nzst: [12, false], nzdt: [13, true],
};

/** @type {Map<string, Intl.DateTimeFormat>} */
const zoneFormatters = new Map();

/**
 * @param {string} zone
 */
function zoneFormatter(zone) {
    let formatter = zoneFormatters.get(zone);

    if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short' });
        zoneFormatters.set(zone, formatter);
    }

    return formatter;
}

/**
 * Seconds east of UTC in a named zone at a moment.
 *
 * @param {string} zone
 * @param {Date} date
 */
function namedZoneOffset(zone, date) {
    const whole = new Date(Math.floor(date.getTime() / 1000) * 1000);
    /** @type {Record<string, string>} */
    const parts = {};

    for (const part of zoneFormatter(zone).formatToParts(whole)) {
        parts[part.type] = part.value;
    }

    const year = parts.era === 'BC' || parts.era === 'B' ? 1 - Number(parts.year) : Number(parts.year);
    const local = new Date(0);

    local.setUTCFullYear(year, Number(parts.month) - 1, Number(parts.day));
    local.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);

    return Math.round((local.getTime() - whole.getTime()) / 1000);
}

/** The abbreviations a British English runtime gives European zones, as the platform prints them. */
const europeanAbbreviations = new Set(['GMT', 'BST', 'IST', 'WET', 'WEST', 'CET', 'CEST', 'EET', 'EEST']);

/**
 * @param {string} locale
 * @param {string} zone
 * @param {Date} date
 */
function shortZoneName(locale, zone, date) {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? '';
}

/**
 * The abbreviation a named zone goes by at a moment, as far as the
 * runtime knows it (BST, CEST, EDT), else the offset (+04, +0530), as
 * the platform prints a zone without one.
 *
 * @param {string} zone
 * @param {Date} date
 * @param {number} offset
 */
function namedZoneAbbreviation(zone, date, offset) {
    const american = shortZoneName('en-US', zone, date);

    if (/^[A-Z]{2,5}$/.test(american) && american !== 'UTC') {
        return american;
    }

    const british = shortZoneName('en-GB', zone, date);

    if (europeanAbbreviations.has(british)) {
        return british;
    }

    const text = offsetText(offset, '');

    return text.endsWith('00') ? text.slice(0, 3) : text;
}

/**
 * The zone the date filter's time zone argument names, as the platform
 * reads it: a zone identifier (Europe/London, in any case), an offset
 * (+02:00, +2, GMT+1), or an abbreviation (BST, EST). Anything else is a
 * render error, as it is there.
 *
 * @param {unknown} argument
 * @returns {PlatformZone}
 */
export function platformZone(argument) {
    const text = argument === true ? '1' : String(argument);
    const offset = text.match(/^(?:GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i);

    if (offset !== null) {
        return fixedZone((offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 3600 + Number(offset[3] ?? 0) * 60));
    }

    const abbreviation = zoneAbbreviations[text.toLowerCase()];

    if (abbreviation !== undefined) {
        const [hours, summer] = abbreviation;
        const name = text.toUpperCase();

        return { name, offset: () => hours * 3600, abbreviation: () => name, dst: () => summer, zulu: name === 'UTC' || name === 'Z' };
    }

    try {
        zoneFormatter(text);
    } catch {
        throw new Error(`Unknown or bad timezone (${text})`);
    }

    return {
        name: text,
        offset: (date) => namedZoneOffset(text, date),
        abbreviation: (date, seconds) => namedZoneAbbreviation(text, date, seconds),
        dst: (date) => {
            const year = date.getUTCFullYear();
            const standard = Math.min(namedZoneOffset(text, new Date(Date.UTC(year, 0, 1))), namedZoneOffset(text, new Date(Date.UTC(year, 6, 1))));

            return namedZoneOffset(text, date) > standard;
        },
        zulu: false,
    };
}

/**
 * One format character's value for a date, or undefined for a character
 * that prints itself.
 *
 * @param {string} character
 * @param {Date} date
 * @param {PlatformZone} zone
 * @returns {string|undefined}
 */
function formatCharacter(character, date, zone) {
    const offset = zone.offset(date);
    const wall = new Date(date.getTime() + offset * 1000);
    const year = wall.getUTCFullYear();
    const month = wall.getUTCMonth();
    const day = wall.getUTCDate();
    const weekday = wall.getUTCDay();
    const hours = wall.getUTCHours();
    const milliseconds = wall.getUTCMilliseconds();
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

    switch (character) {
        case 'd': return pad(day, 2);
        case 'D': return weekdays[weekday].slice(0, 3);
        case 'j': return String(day);
        case 'l': return weekdays[weekday];
        case 'N': return String(weekday || 7);
        case 'S': return day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
        case 'w': return String(weekday);
        case 'z': return String(Math.round((Date.UTC(year, month, day) - Date.UTC(year, 0, 1)) / 864e5));
        case 'W': return pad(isoWeek(wall).week, 2);
        case 'F': return months[month];
        case 'm': return pad(month + 1, 2);
        case 'M': return months[month].slice(0, 3);
        case 'n': return String(month + 1);
        case 't': return String(new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
        case 'L': return leap ? '1' : '0';
        case 'o': return String(isoWeek(wall).year);
        case 'X': return `${year < 0 ? '-' : '+'}${pad(Math.abs(year), 4)}`;
        case 'x': return year >= 10000 ? `+${year}` : pad(year, 4);
        case 'Y': return pad(year, 4);
        case 'y': return pad(Math.abs(year) % 100, 2);
        case 'a': return hours < 12 ? 'am' : 'pm';
        case 'A': return hours < 12 ? 'AM' : 'PM';
        case 'B': return pad(Math.floor(((date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds() + 3600) % 86400) / 86.4), 3);
        case 'g': return String(hours % 12 || 12);
        case 'G': return String(hours);
        case 'h': return pad(hours % 12 || 12, 2);
        case 'H': return pad(hours, 2);
        case 'i': return pad(wall.getUTCMinutes(), 2);
        case 's': return pad(wall.getUTCSeconds(), 2);
        case 'u': return pad(milliseconds * 1000, 6);
        case 'v': return pad(milliseconds, 3);
        case 'e': return zone.name;
        case 'I': return zone.dst(date) ? '1' : '0';
        case 'O': return offsetText(offset, '');
        case 'P': return offsetText(offset);
        case 'p': return offset === 0 && zone.zulu ? 'Z' : offsetText(offset);
        case 'T': return zone.abbreviation(date, offset);
        case 'Z': return String(offset);
        case 'c': return formatPlatformDate('Y-m-d\\TH:i:sP', date, zone);
        case 'r': return formatPlatformDate('D, d M Y H:i:s O', date, zone);
        case 'U': return String(Math.floor(date.getTime() / 1000));
        default: return undefined;
    }
}

/**
 * A date printed with the platform's format characters, in UTC or the
 * given zone. A backslash prints the next character as it is; a character
 * that is not a format character prints itself.
 *
 * @param {string} format
 * @param {Date} date
 * @param {PlatformZone} [zone]
 */
export function formatPlatformDate(format, date, zone = utcZone) {
    let output = '';

    for (let index = 0; index < format.length; index++) {
        const character = format[index];

        if (character === '\\') {
            index++;
            output += format[index] ?? '';
            continue;
        }

        output += formatCharacter(character, date, zone) ?? character;
    }

    return output;
}

/**
 * The time zone abbreviations the platform's time parser knows. Any
 * single letter is a military time zone too. The parser takes the word
 * after a time zone with it ("PST foo" reads as PST).
 */
const timeZoneWords = new Set([
    'acdt', 'acst', 'addt', 'adt', 'aedt', 'aest', 'ahdt', 'ahst', 'akdt', 'akst', 'amt', 'apt', 'ast', 'awdt', 'awst', 'awt',
    'bdst', 'bdt', 'bmt', 'bst', 'cast', 'cat', 'cddt', 'cdt', 'cemt', 'cest', 'cet', 'cmt', 'cpt', 'cst', 'cwt', 'chst',
    'dmt', 'eat', 'eddt', 'edt', 'eest', 'eet', 'emt', 'ept', 'est', 'ewt', 'ffmt', 'fmt', 'gdt', 'gmt', 'gst',
    'hdt', 'hkst', 'hkt', 'hmt', 'hpt', 'hst', 'hwt', 'iddt', 'idt', 'imt', 'ist', 'jdt', 'jmt', 'jst', 'kdt', 'kmt', 'kst',
    'lst', 'mddt', 'mdst', 'mdt', 'mest', 'met', 'mmt', 'mpt', 'msd', 'msk', 'mst', 'mwt', 'nddt', 'ndt', 'npt', 'nst', 'nwt',
    'nzdt', 'nzmt', 'nzst', 'pddt', 'pdt', 'pkst', 'pkt', 'plmt', 'pmt', 'ppmt', 'ppt', 'pst', 'pwt', 'qmt', 'rmt',
    'sast', 'sdmt', 'sjmt', 'smt', 'sst', 'tbmt', 'tmt', 'uct', 'utc', 'wast', 'wat', 'wemt', 'west', 'wet', 'wib', 'wita',
    'wit', 'wmt', 'yddt', 'ydt', 'ypt', 'yst', 'ywt',
]);

/**
 * Words the platform's time parser reads besides time zones: relative
 * words, units, day and month names, and ordinal suffixes.
 */
const timeWords = new Set([
    'now', 'today', 'midnight', 'noon', 'tomorrow', 'yesterday', 'ago', 'next', 'last', 'previous', 'this', 'of', 'back', 'front',
    'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
    'sec', 'secs', 'seconds', 'min', 'mins', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week', 'weeks', 'weekday', 'weekdays',
    'fortnight', 'fortnights', 'forthnight', 'forthnights', 'month', 'months', 'year', 'years',
    'ms', 'msec', 'msecs', 'millisecond', 'milliseconds', 'usec', 'usecs', 'microsecond', 'microseconds',
    'am', 'pm', 'st', 'nd', 'rd', 'th',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'mon', 'tue', 'tues', 'wed', 'wednes', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'xi', 'xii',
]);

/**
 * The platform's refusal for text it cannot read as a time, or null when
 * the platform may read it. Only called once the kit's own parser has
 * failed, and conservative: the text is refused only when it holds a
 * word the platform's parser never reads ("23 hours from now", "Ends
 * soon", "TBC"), since the platform takes it as an unknown time zone.
 * The word after a time zone is never the one refused, since the parser
 * takes it with the zone, and text with a time zone identifier
 * (Europe/London) is never refused.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function unparseableDateMessage(text) {
    if (/[A-Za-z]\/[A-Za-z]/.test(text)) {
        return null;
    }

    let afterTimeZone = false;
    let previousEnd = -1;

    for (const match of text.matchAll(/[A-Za-z]+/g)) {
        const word = match[0].toLowerCase();
        const follows = afterTimeZone && /^\s+$/.test(text.slice(previousEnd, match.index));

        afterTimeZone = word.length === 1 || timeZoneWords.has(word);
        previousEnd = match.index + match[0].length;

        if (afterTimeZone || timeWords.has(word)) {
            continue;
        }

        if (follows) {
            continue;
        }

        return `Failed to parse time string (${text}) at position ${match.index} (${match[0][0]}): The timezone could not be found in the database`;
    }

    return null;
}
