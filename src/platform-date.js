/**
 * The platform's `date` filter, as far as a preview needs it: every
 * format character the platform prints, in UTC (the platform renders in
 * UTC, so `e` and `T` print UTC), and the refusal of text it cannot read
 * as a time.
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
 * One format character's value for a date, or undefined for a character
 * that prints itself.
 *
 * @param {string} character
 * @param {Date} date
 * @returns {string|undefined}
 */
function formatCharacter(character, date) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    const hours = date.getUTCHours();
    const milliseconds = date.getUTCMilliseconds();
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
        case 'W': return pad(isoWeek(date).week, 2);
        case 'F': return months[month];
        case 'm': return pad(month + 1, 2);
        case 'M': return months[month].slice(0, 3);
        case 'n': return String(month + 1);
        case 't': return String(new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
        case 'L': return leap ? '1' : '0';
        case 'o': return String(isoWeek(date).year);
        case 'X': return `${year < 0 ? '-' : '+'}${pad(Math.abs(year), 4)}`;
        case 'x': return year >= 10000 ? `+${year}` : pad(year, 4);
        case 'Y': return pad(year, 4);
        case 'y': return pad(Math.abs(year) % 100, 2);
        case 'a': return hours < 12 ? 'am' : 'pm';
        case 'A': return hours < 12 ? 'AM' : 'PM';
        case 'B': return pad(Math.floor(((hours * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds() + 3600) % 86400) / 86.4), 3);
        case 'g': return String(hours % 12 || 12);
        case 'G': return String(hours);
        case 'h': return pad(hours % 12 || 12, 2);
        case 'H': return pad(hours, 2);
        case 'i': return pad(date.getUTCMinutes(), 2);
        case 's': return pad(date.getUTCSeconds(), 2);
        case 'u': return pad(milliseconds * 1000, 6);
        case 'v': return pad(milliseconds, 3);
        case 'e': return 'UTC';
        case 'I': return '0';
        case 'O': return '+0000';
        case 'P': return '+00:00';
        case 'p': return 'Z';
        case 'T': return 'UTC';
        case 'Z': return '0';
        case 'c': return formatPlatformDate('Y-m-d\\TH:i:sP', date);
        case 'r': return formatPlatformDate('D, d M Y H:i:s O', date);
        case 'U': return String(Math.floor(date.getTime() / 1000));
        default: return undefined;
    }
}

/**
 * A date printed with the platform's format characters, in UTC. A backslash prints the
 * next character as it is; a character that is not a format character
 * prints itself.
 *
 * @param {string} format
 * @param {Date} date
 */
export function formatPlatformDate(format, date) {
    let output = '';

    for (let index = 0; index < format.length; index++) {
        const character = format[index];

        if (character === '\\') {
            index++;
            output += format[index] ?? '';
            continue;
        }

        output += formatCharacter(character, date) ?? character;
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
