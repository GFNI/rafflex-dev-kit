/**
 * The platform's template tokenizer, ported for the options inferrer: the
 * same token stream (types, values, and the same refusals) the platform
 * reads a template's options from. The preview's renderer has its own
 * tokenizer, but its tokens differ in places that change what an option
 * read looks like (operators, word operators, inline comments,
 * interpolated strings), so the inferrer reads this stream instead.
 *
 * Only what the inferrer reads is kept: each token's type and value, and
 * for a number whether the platform holds it as a float. A template the
 * platform cannot tokenize throws a TemplateTokenError, and the inferrer
 * then reports no options, as the platform does.
 */

export class TemplateTokenError extends Error {}

/**
 * @typedef {'text'|'block_start'|'var_start'|'block_end'|'var_end'|'name'|'number'|'string'|'operator'|'punctuation'|'interpolation_start'|'interpolation_end'} TokenType
 * @typedef {{type: TokenType, value: any, float?: boolean}} TemplateToken
 */

const whitespace = '[ \\t\\n\\v\\f\\r]';
const lineWhitespace = '[ \\t\\0\\v]';
const anyButNewline = '[^\\n]';

/**
 * The expression operators, longest first, each with the platform's
 * guards: a word operator must be followed by whitespace, a parenthesis,
 * or an opening bracket, and must not follow a dot or a pipe.
 */
const operators = [
    'starts with', 'ends with', 'has every', 'has some', 'matches', 'not in', 'is not', 'b-xor', 'b-and', 'b-or', 'not', '...', '? :', 'xor', 'and',
    '<=>', '===', '!==', '?:', '??', 'or', '==', '!=', '>=', '<=', 'in', '..', '//', '**', 'is', '?.', '=>', '-', '+', '(', '<', '>', '~', '*', '/', '%', '?', '=', '|', '.', '[',
];

/**
 * @param {string} text
 */
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

const operatorPattern = new RegExp(operators.map((operator) => {
    let pattern = escapeRegex(operator).replace(/ +/g, `${whitespace}+`);

    if (/[a-zA-Z]$/.test(operator)) {
        pattern += '(?=[\\t\\n\\v\\f\\r ()\\[{])';
    }

    if (/^[a-zA-Z]/.test(operator)) {
        pattern = `(?<![.|]${whitespace}|${anyButNewline}[.|])${pattern}`;
    }

    return pattern;
}).join('|'), 'y');

const namePattern = /[a-zA-Z_\u007f-\uffff][a-zA-Z0-9_\u007f-\uffff]*/y;
const numberPattern = /[0-9]+(?:_[0-9]+)*(?:\.[0-9]+(?:_[0-9]+)*)?(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?/y;
const stringPattern = /"([^#"\\]*(?:\\[\s\S][^#"\\]*)*)"|'([^'\\]*(?:\\[\s\S][^'\\]*)*)'/y;
const doubleQuotePattern = /"/y;
const doubleQuotedPartPattern = /[^#"\\]*(?:(?:\\[\s\S]|#(?!\{))[^#"\\]*)*/y;
const inlineCommentPattern = /#[^\r\n]*/y;
const whitespacePattern = new RegExp(`${whitespace}+`, 'y');
const punctuation = '()[]{}?:.,|';

const tokenStartPattern = /(\{\{|\{%|\{##(?!\})|\{#)(-|~)?/g;
const varEndPattern = new RegExp(`${whitespace}*(?:-\\}\\}${whitespace}*|~\\}\\}${lineWhitespace}*|\\}\\})`, 'y');
const blockEndPattern = new RegExp(`${whitespace}*(?:-%\\}${whitespace}*\\n?|~%\\}${lineWhitespace}*|%\\}(?:\\r\\n?|\\n)?)`, 'y');
const rawDataPattern = new RegExp(`\\{%(-|~)?${whitespace}*endverbatim${whitespace}*(?:-%\\}${whitespace}*|~%\\}${lineWhitespace}*|%\\})`, 'g');
const commentEndPattern = new RegExp(`(?:-#\\}${whitespace}*\\n?|~#\\}${lineWhitespace}*|#\\}(?:\\r\\n?|\\n)?)`, 'g');
const documentationEndPattern = new RegExp(`(?:-##\\}${whitespace}*\\n?|~##\\}${lineWhitespace}*|-#\\}${whitespace}*\\n?|~#\\}${lineWhitespace}*|#\\}(?:\\r\\n?|\\n)?)`, 'g');
const blockRawPattern = new RegExp(`${whitespace}*verbatim${whitespace}*(?:-%\\}${whitespace}*|~%\\}${lineWhitespace}*|%\\})`, 'y');
const blockLinePattern = new RegExp(`${whitespace}*line${whitespace}+(\\d+)${whitespace}*%\\}`, 'y');
const interpolationStartPattern = new RegExp(`#\\{${whitespace}*`, 'y');
const interpolationEndPattern = new RegExp(`${whitespace}*\\}`, 'y');

const openingBrackets = ['{', '(', '['];
const closingBrackets = ['}', ')', ']'];

/** @type {Record<string, string>} */
const specialCharacters = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

const stateData = 0;
const stateBlock = 1;
const stateVar = 2;
const stateString = 3;
const stateInterpolation = 4;

/**
 * @param {RegExp} pattern a sticky pattern
 * @param {string} code
 * @param {number} cursor
 * @returns {RegExpExecArray|null}
 */
function matchAt(pattern, code, cursor) {
    pattern.lastIndex = cursor;

    return pattern.exec(code);
}

/**
 * @param {RegExp} pattern a global pattern
 * @param {string} code
 * @param {number} cursor
 * @returns {RegExpExecArray|null}
 */
function searchFrom(pattern, code, cursor) {
    pattern.lastIndex = cursor;

    return pattern.exec(code);
}

/**
 * @param {string} text
 */
function normaliseNewlines(text) {
    return text.replace(/\r\n|\r/g, '\n');
}

/**
 * PHP's rtrim with its default characters, or the given ones.
 *
 * @param {string} text
 * @param {string} [characters]
 */
function rtrim(text, characters = ' \t\n\r\0\v') {
    let end = text.length;

    while (end > 0 && characters.includes(text[end - 1])) {
        end--;
    }

    return text.slice(0, end);
}

/**
 * The platform's string literal unescaping.
 *
 * @param {string} text
 */
function unescapeString(text) {
    let result = '';
    let index = 0;

    while (index < text.length) {
        const position = text.indexOf('\\', index);

        if (position === -1) {
            result += text.slice(index);
            break;
        }

        result += text.slice(index, position);
        index = position + 1;

        if (index >= text.length) {
            result += '\\';
            break;
        }

        const next = text[index];

        if (specialCharacters[next] !== undefined) {
            result += specialCharacters[next];
        } else if (next === '\\' || next === "'" || next === '"') {
            result += next;
        } else if (next === '#' && text[index + 1] === '{') {
            result += '#{';
            index++;
        } else if (next === 'x' && /^[0-9a-fA-F]$/.test(text[index + 1] ?? '')) {
            let hex = text[++index];

            if (/^[0-9a-fA-F]$/.test(text[index + 1] ?? '')) {
                hex += text[++index];
            }

            result += String.fromCharCode(Number.parseInt(hex, 16));
        } else if (/^[0-7]$/.test(next)) {
            let octal = next;

            while (/^[0-7]$/.test(text[index + 1] ?? '') && octal.length < 3) {
                octal += text[++index];
            }

            result += String.fromCharCode(Number.parseInt(octal, 8) % 256);
        } else {
            result += next;
        }

        index++;
    }

    return result;
}

/**
 * A number literal as the platform holds it: an integer, or a float when
 * it has a fraction or exponent or does not fit a 64 bit integer.
 *
 * @param {string} text
 * @returns {{value: number, float: boolean}}
 */
function numberValue(text) {
    const digits = text.replace(/_/g, '');
    const value = Number(digits);

    if (/[.eE]/.test(digits)) {
        return { value, float: true };
    }

    return { value, float: BigInt(digits) > 9223372036854775807n };
}

/**
 * Tokenize a template exactly as the platform does, without the end of
 * file token.
 *
 * @param {string} code
 * @returns {TemplateToken[]}
 */
export function tokenizeTemplate(code) {
    /** @type {TemplateToken[]} */
    const tokens = [];
    let cursor = 0;
    let state = stateData;
    /** @type {number[]} */
    const states = [];
    /** @type {string[]} */
    const brackets = [];
    const positions = [...code.matchAll(tokenStartPattern)].map((match) => ({ index: match.index, whole: match[0], tag: match[1], trim: match[2] }));
    let position = -1;
    const end = code.length;

    const push = (/** @type {TokenType} */ type, /** @type {any} */ value = '', /** @type {boolean} */ float = false) => {
        if (type === 'text' && value === '') {
            return;
        }

        tokens.push(type === 'number' ? { type, value, float } : { type, value });
    };
    const pushState = (/** @type {number} */ next) => {
        states.push(state);
        state = next;
    };
    const popState = () => {
        if (states.length === 0) {
            throw new TemplateTokenError('Cannot pop state without a previous state.');
        }

        state = /** @type {number} */ (states.pop());
    };
    const checkBrackets = (/** @type {string} */ character) => {
        if (openingBrackets.includes(character)) {
            brackets.push(character);

            return;
        }

        if (!closingBrackets.includes(character)) {
            return;
        }

        if (brackets.length === 0) {
            throw new TemplateTokenError(`Unexpected "${character}".`);
        }

        const expect = /** @type {string} */ (brackets.pop());

        if (character !== closingBrackets[openingBrackets.indexOf(expect)]) {
            throw new TemplateTokenError(`Unclosed "${expect}".`);
        }
    };
    const pushClosing = (/** @type {TokenType} */ type, /** @type {string} */ match) => {
        push(type);
        cursor += match.length;
    };

    const lexData = () => {
        if (position === positions.length - 1) {
            push('text', normaliseNewlines(code.slice(cursor)));
            cursor = end;

            return;
        }

        let found = positions[++position];

        while (found.index < cursor) {
            if (position === positions.length - 1) {
                return;
            }

            found = positions[++position];
        }

        let text = code.slice(cursor, found.index);
        const textLength = text.length;

        if (found.trim === '-') {
            text = rtrim(text);
        } else if (found.trim === '~') {
            text = rtrim(text, ' \t\0\v');
        }

        push('text', normaliseNewlines(text));
        cursor += textLength;

        switch (found.tag) {
            case '{##':
                cursor += found.whole.length;
                lexComment(true);
                break;
            case '{#':
                cursor += found.whole.length;
                lexComment(false);
                break;
            case '{%': {
                cursor += found.whole.length;

                const raw = matchAt(blockRawPattern, code, cursor);

                if (raw !== null) {
                    cursor += raw[0].length;
                    lexRawData();
                    break;
                }

                const line = matchAt(blockLinePattern, code, cursor);

                if (line !== null) {
                    cursor += line[0].length;
                    break;
                }

                push('block_start');
                pushState(stateBlock);
                break;
            }
            case '{{':
                cursor += found.whole.length;
                push('var_start');
                pushState(stateVar);
                break;
            default:
                break;
        }
    };

    const lexComment = (/** @type {boolean} */ documentation) => {
        const match = searchFrom(documentation ? documentationEndPattern : commentEndPattern, code, cursor);

        if (match === null) {
            throw new TemplateTokenError('Unclosed comment.');
        }

        cursor = match.index + match[0].length;
    };

    const lexRawData = () => {
        const match = searchFrom(rawDataPattern, code, cursor);

        if (match === null) {
            throw new TemplateTokenError('Unexpected end of file: Unclosed "verbatim" block.');
        }

        let text = code.slice(cursor, match.index);

        cursor = match.index + match[0].length;

        if (match[1] === '-') {
            text = rtrim(text);
        } else if (match[1] === '~') {
            text = rtrim(text, ' \t\0\v');
        }

        push('text', normaliseNewlines(text));
    };

    const lexExpression = () => {
        const space = matchAt(whitespacePattern, code, cursor);

        if (space !== null) {
            cursor += space[0].length;

            if (cursor >= end) {
                throw new TemplateTokenError(`Unclosed "${state === stateBlock ? 'block' : 'variable'}".`);
            }
        }

        const operator = matchAt(operatorPattern, code, cursor);

        if (operator !== null) {
            const value = operator[0].replace(/[ \t\n\v\f\r]+/g, ' ');

            if (openingBrackets.includes(value)) {
                checkBrackets(value);
            }

            push('operator', value);
            cursor += operator[0].length;

            return;
        }

        const name = matchAt(namePattern, code, cursor);

        if (name !== null) {
            push('name', name[0]);
            cursor += name[0].length;

            return;
        }

        const number = matchAt(numberPattern, code, cursor);

        if (number !== null) {
            const { value, float } = numberValue(number[0]);

            push('number', value, float);
            cursor += number[0].length;

            return;
        }

        const character = code[cursor];

        if (character !== undefined && punctuation.includes(character)) {
            checkBrackets(character);
            push('punctuation', character);
            cursor += 1;

            return;
        }

        const string = matchAt(stringPattern, code, cursor);

        if (string !== null) {
            push('string', unescapeString(normaliseNewlines(string[0].slice(1, -1))));
            cursor += string[0].length;

            return;
        }

        if (matchAt(doubleQuotePattern, code, cursor) !== null) {
            brackets.push('"');
            pushState(stateString);
            cursor += 1;

            return;
        }

        const comment = matchAt(inlineCommentPattern, code, cursor);

        if (comment !== null) {
            cursor += comment[0].length;

            return;
        }

        throw new TemplateTokenError(`Unexpected character "${character}".`);
    };

    const lexString = () => {
        const interpolation = matchAt(interpolationStartPattern, code, cursor);

        if (interpolation !== null) {
            brackets.push('#{');
            push('interpolation_start');
            cursor += interpolation[0].length;
            pushState(stateInterpolation);

            return;
        }

        const part = matchAt(doubleQuotedPartPattern, code, cursor);

        if (part !== null && part[0] !== '') {
            push('string', unescapeString(normaliseNewlines(part[0])));
            cursor += part[0].length;

            return;
        }

        if (matchAt(doubleQuotePattern, code, cursor) !== null) {
            brackets.pop();
            popState();
            cursor += 1;

            return;
        }

        throw new TemplateTokenError(`Unexpected character "${code[cursor]}".`);
    };

    const lexInterpolation = () => {
        const end = brackets.at(-1) === '#{' ? matchAt(interpolationEndPattern, code, cursor) : null;

        if (end !== null) {
            brackets.pop();
            pushClosing('interpolation_end', end[0]);
            popState();

            return;
        }

        lexExpression();
    };

    while (cursor < end) {
        switch (state) {
            case stateData:
                lexData();
                break;
            case stateBlock: {
                const match = brackets.length === 0 ? matchAt(blockEndPattern, code, cursor) : null;

                if (match !== null) {
                    pushClosing('block_end', match[0]);
                    popState();
                } else {
                    lexExpression();
                }

                break;
            }
            case stateVar: {
                const match = brackets.length === 0 ? matchAt(varEndPattern, code, cursor) : null;

                if (match !== null) {
                    pushClosing('var_end', match[0]);
                    popState();
                } else {
                    lexExpression();
                }

                break;
            }
            case stateString:
                lexString();
                break;
            default:
                lexInterpolation();
                break;
        }
    }

    if (brackets.length > 0) {
        throw new TemplateTokenError(`Unclosed "${brackets.at(-1)}".`);
    }

    return tokens;
}
