/**
 * A port of the platform's script rules (SubmissionSafetyChecker and
 * ScriptElementScanner, PRD 35): a script src, or a static import in a
 * module script, may load only an approved library through its files
 * reference. Any other src, a bare or relative specifier, or an import map
 * is refused. Dynamic import() is a banned pattern, so it is reported by
 * the pattern list, with the message the rules publish for it.
 *
 * The creator facing messages come from rules.script_rules.messages; the
 * kit holds none of its own.
 */

const whitespace = ' \t\n\r\f';

/**
 * Stands in for a Twig print tag while the source's HTML is read, so
 * quotes inside {{ files["three"] }} cannot end an attribute value.
 */
const twigExpressionMarker = '\x1F';

const defaultSourceAttributes = ['src', 'href', 'xlink:href'];

/**
 * @param {string} subject
 * @param {string} characters
 * @param {number} start
 */
function spanOf(subject, characters, start) {
    let index = start;

    while (index < subject.length && characters.includes(subject[index])) {
        index++;
    }

    return index - start;
}

/**
 * @param {string} subject
 * @param {string} characters
 * @param {number} start
 */
function spanUntil(subject, characters, start) {
    let index = start;

    while (index < subject.length && !characters.includes(subject[index])) {
        index++;
    }

    return index - start;
}

/**
 * @typedef {{name: string, value: string}} ScriptAttribute
 * @typedef {{attributes: ScriptAttribute[], content: string, offset: number}} ScriptElement
 */

/**
 * Every script start tag in a document with its attributes and content,
 * read the way a browser's tokenizer reads them.
 *
 * @param {string} html
 * @returns {ScriptElement[]}
 */
export function scanScripts(html) {
    /** @type {ScriptElement[]} */
    const elements = [];
    const openings = /<script(?=[\s/>])/gi;
    let match;

    while ((match = openings.exec(html)) !== null) {
        const [attributes, contentStart] = attributesFrom(html, match.index + match[0].length);

        elements.push({ attributes, content: contentFrom(html, contentStart), offset: match.index });
    }

    return elements;
}

/**
 * @param {string} html
 * @param {number} start
 * @returns {[ScriptAttribute[], number]}
 */
function attributesFrom(html, start) {
    /** @type {ScriptAttribute[]} */
    const attributes = [];
    let position = start;
    const length = html.length;

    while (position < length) {
        position += spanOf(html, `${whitespace}/`, position);

        if (position >= length) {
            break;
        }

        if (html[position] === '>') {
            return [attributes, position + 1];
        }

        const nameLength = Math.max(1, spanUntil(html, `${whitespace}/>=`, position + 1) + 1);
        const name = html.slice(position, position + nameLength).toLowerCase();

        position += nameLength;
        position += spanOf(html, whitespace, position);

        if (position >= length || html[position] !== '=') {
            attributes.push({ name, value: '' });
            continue;
        }

        position++;
        position += spanOf(html, whitespace, position);

        const [value, next] = valueFrom(html, position);

        attributes.push({ name, value });
        position = next;
    }

    return [attributes, length];
}

/**
 * @param {string} html
 * @param {number} position
 * @returns {[string, number]}
 */
function valueFrom(html, position) {
    const quote = html[position] ?? '';

    if (quote === '"' || quote === "'") {
        let end = html.indexOf(quote, position + 1);

        end = end === -1 ? html.length : end;

        return [html.slice(position + 1, end), end + 1];
    }

    const valueLength = spanUntil(html, `${whitespace}>`, position);

    return [html.slice(position, position + valueLength), position + valueLength];
}

/**
 * @param {string} html
 * @param {number} position
 */
function contentFrom(html, position) {
    const closing = /<\/script[\s/>]/gi;

    closing.lastIndex = position;

    const match = closing.exec(html);

    return match === null ? html.slice(position) : html.slice(position, match.index);
}

/**
 * The module specifiers a script's text imports from: every string literal
 * that follows `import` or `from` with only whitespace or comments
 * between. Non ASCII characters count as whitespace so a no-break space
 * cannot hide a specifier.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function moduleSpecifiers(content) {
    const pattern = /\b(?:import|from)(?:[\s\u0080-￿]|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*)*(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;

    return [...content.matchAll(pattern)].map((match) => match[2]);
}

/**
 * @param {ScriptAttribute[]} attributes
 */
function scriptType(attributes) {
    const type = attributes.find((attribute) => attribute.name === 'type');

    return type === undefined ? '' : type.value.trim().toLowerCase();
}

/**
 * @param {string} type
 */
function isModuleType(type) {
    return type.includes('module') || type.includes(twigExpressionMarker);
}

/**
 * @typedef {{script_source: string, module_import: string, import_map: string, dynamic_import?: string}} ScriptMessages
 * @typedef {{messages: ScriptMessages, source_attributes?: string[]}} ScriptRules
 * @typedef {{message: string, offset: number}} ScriptViolation
 */

/**
 * The script rules over one document: no import maps, every script source
 * attribute an allowed source, and in module scripts every static import
 * an allowed source. A script whose type or attribute name Twig builds is
 * treated as the most dangerous reading.
 *
 * @param {string} html
 * @param {(source: string) => boolean} isAllowedSource
 * @param {ScriptRules} scriptRules rules.script_rules
 * @returns {ScriptViolation[]}
 */
export function scriptViolations(html, isAllowedSource, scriptRules) {
    const { messages } = scriptRules;
    const scriptSourceAttributes = scriptRules.source_attributes ?? defaultSourceAttributes;
    /** @type {ScriptViolation[]} */
    const violations = [];

    for (const element of scanScripts(html)) {
        const type = scriptType(element.attributes);

        if (type.includes('importmap')) {
            violations.push({ message: messages.import_map, offset: element.offset });
        }

        for (const attribute of element.attributes) {
            if (attribute.name.includes(twigExpressionMarker)) {
                violations.push({ message: messages.script_source, offset: element.offset });
                continue;
            }

            if (!scriptSourceAttributes.includes(attribute.name)) {
                continue;
            }

            if (!isAllowedSource(attribute.value.trim())) {
                violations.push({ message: messages.script_source, offset: element.offset });
            }
        }

        if (!isModuleType(type)) {
            continue;
        }

        for (const specifier of moduleSpecifiers(element.content)) {
            if (!isAllowedSource(specifier.trim())) {
                violations.push({ message: messages.module_import, offset: element.offset });
            }
        }
    }

    return uniqueByMessage(violations);
}

/**
 * @param {ScriptViolation[]} violations
 */
function uniqueByMessage(violations) {
    const seen = new Set();

    return violations.filter((violation) => {
        if (seen.has(violation.message)) {
            return false;
        }

        seen.add(violation.message);

        return true;
    });
}

/**
 * Whether a source value is exactly one Twig files reference,
 * {{ files['tag'] }} or {{ files["tag"] }}, whose tag resolves to an
 * approved library URL.
 *
 * @param {string} source
 * @param {Record<string, string>} files Tag to URL.
 * @param {(url: string) => boolean} isApprovedUrl
 */
export function isApprovedFilesReference(source, files, isApprovedUrl) {
    const match = source.match(/^\{\{[-~]?\s*files\s*\[\s*(['"])([^'"]+)\1\s*\]\s*[-~]?\}\}$/);

    if (match === null) {
        return false;
    }

    const url = files[match[2]];

    return url !== undefined && isApprovedUrl(url);
}

/**
 * The script rules over a template's source. Twig print tags are swapped
 * for markers while the HTML is read, then restored, so a script src or
 * import passes only when it is exactly a files reference whose tag
 * resolves to an approved library. Twig logic tags and comments become
 * whitespace, so a src wrapped in a condition is still seen. Offsets in
 * the result point into the original template.
 *
 * @param {string} template
 * @param {Record<string, string>} files Tag to URL.
 * @param {(url: string) => boolean} isApprovedUrl
 * @param {ScriptRules} scriptRules rules.script_rules
 * @returns {ScriptViolation[]}
 */
export function sourceScriptViolations(template, files, isApprovedUrl, scriptRules) {
    /** @type {Map<string, string>} */
    const twigExpressions = new Map();
    /** @type {{markedOffset: number, originalOffset: number}[]} */
    const offsetMap = [];
    let marked = '';
    let cursor = 0;

    for (const match of template.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g)) {
        marked += template.slice(cursor, match.index);
        offsetMap.push({ markedOffset: marked.length, originalOffset: match.index });

        if (match[0].startsWith('{{')) {
            const marker = `${twigExpressionMarker}${twigExpressions.size}${twigExpressionMarker}`;

            twigExpressions.set(marker, match[0]);
            marked += marker;
        } else {
            marked += ' ';
        }

        cursor = match.index + match[0].length;
        offsetMap.push({ markedOffset: marked.length, originalOffset: cursor });
    }

    marked += template.slice(cursor);

    const restore = (/** @type {string} */ value) => value.replace(new RegExp(`${twigExpressionMarker}\\d+${twigExpressionMarker}`, 'g'), (marker) => twigExpressions.get(marker) ?? marker);

    const toOriginalOffset = (/** @type {number} */ offset) => {
        let shift = 0;

        for (const entry of offsetMap) {
            if (entry.markedOffset > offset) {
                break;
            }

            shift = entry.originalOffset - entry.markedOffset;
        }

        return offset + shift;
    };

    return scriptViolations(marked, (source) => isApprovedFilesReference(restore(source), files, isApprovedUrl), scriptRules)
        .map((violation) => ({ ...violation, offset: toOriginalOffset(violation.offset) }));
}
