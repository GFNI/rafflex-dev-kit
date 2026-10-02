/**
 * The sandbox whitelist as a lint. twig.js has no sandbox, so instead of
 * refusing at render time like PHP Twig's SecurityPolicy, the kit walks the
 * token tree twig.js parses a template into and reports every tag, filter,
 * function, and (when the rules restrict them) test the whitelist does not
 * allow, with the line it appears on.
 *
 * twig.js token shapes walked here:
 * - top level and nested bodies: `{type: 'raw'|'output'|'logic'|'comment'}`
 * - logic tokens: `{type: 'logic', token: {type: 'Twig.logic.type.for', expression, output, position}}`
 * - expression nodes: `{type: 'Twig.expression.type.filter', value: 'upper', params}`,
 *   `{type: 'Twig.expression.type._function', fn: 'dump', params}`,
 *   `{type: 'Twig.expression.type.test', filter: 'defined'}`
 */

/**
 * Logic token types that belong to an allowed parent tag rather than
 * being tags of their own.
 *
 * @type {Record<string, string>}
 */
const tagOfLogicType = {
    if: 'if',
    elseif: 'if',
    else: 'if',
    endif: 'if',
    for: 'for',
    endfor: 'for',
    set: 'set',
    setcapture: 'set',
    endset: 'set',
};

const skippedKeys = new Set(['position', 'match', 'regex', 'next']);

/**
 * @typedef {{kind: 'tag'|'filter'|'function'|'test', name: string, line: number, message: string}} LintViolation
 */

/**
 * The 1 based line of a character offset.
 *
 * @param {string} template
 * @param {number} offset
 */
export function lineAt(template, offset) {
    let line = 1;

    for (let index = 0; index < offset && index < template.length; index++) {
        if (template[index] === '\n') {
            line++;
        }
    }

    return line;
}

/**
 * @param {any} node
 * @returns {number|undefined}
 */
function offsetOf(node) {
    if (typeof node?.position?.start === 'number') {
        return node.position.start;
    }

    if (typeof node?.position?.open?.start === 'number') {
        return node.position.open.start;
    }

    return undefined;
}

/**
 * @param {unknown[]} tokens The `tokens` of a compiled twig.js template.
 * @param {string} template The template source, for line numbers.
 * @param {{tags: string[], filters: string[], functions?: string[], tests?: string[]}} sandbox
 * @returns {LintViolation[]}
 */
export function lintTemplate(tokens, template, sandbox) {
    const allowedTags = new Set(sandbox.tags);
    const allowedFilters = new Set(sandbox.filters);
    const allowedFunctions = new Set(sandbox.functions ?? []);
    // twig.js spells two word tests as one (divisibleby, sameas).
    const normaliseTest = (/** @type {string} */ name) => name.replace(/\s+/g, '').toLowerCase();
    const restrictedTests = Array.isArray(sandbox.tests) && sandbox.tests.length > 0 ? new Set(sandbox.tests.map(normaliseTest)) : null;

    /** @type {LintViolation[]} */
    const violations = [];
    const seen = new Set();

    /**
     * @param {LintViolation['kind']} kind
     * @param {string} name
     * @param {number} offset
     */
    const report = (kind, name, offset) => {
        const line = lineAt(template, offset);
        const key = `${kind}:${name}:${line}`;

        if (seen.has(key)) {
            return;
        }

        seen.add(key);

        const label = kind[0].toUpperCase() + kind.slice(1);

        violations.push({ kind, name, line, message: `${label} "${name}" is not allowed` });
    };

    /**
     * @param {any} node
     * @param {number} inheritedOffset
     */
    const walk = (node, inheritedOffset) => {
        if (Array.isArray(node)) {
            for (const child of node) {
                walk(child, inheritedOffset);
            }

            return;
        }

        if (node === null || typeof node !== 'object') {
            return;
        }

        const offset = offsetOf(node) ?? inheritedOffset;

        if (typeof node.type === 'string') {
            inspect(node, offset);
        }

        for (const [key, value] of Object.entries(node)) {
            if (skippedKeys.has(key)) {
                continue;
            }

            walk(value, offset);
        }
    };

    /**
     * @param {any} node
     * @param {number} offset
     */
    const inspect = (node, offset) => {
        if (node.type.startsWith('Twig.logic.type.')) {
            const logicType = node.type.slice('Twig.logic.type.'.length);
            const tag = tagOfLogicType[logicType] ?? logicType;

            if (!allowedTags.has(tag)) {
                report('tag', tag, offset);
            }

            return;
        }

        if (node.type === 'Twig.expression.type.filter' && typeof node.value === 'string' && !allowedFilters.has(node.value)) {
            report('filter', node.value, offset);

            return;
        }

        if (node.type === 'Twig.expression.type._function' && typeof node.fn === 'string' && !allowedFunctions.has(node.fn)) {
            report('function', node.fn, offset);

            return;
        }

        if (node.type === 'Twig.expression.type.test' && restrictedTests !== null && typeof node.filter === 'string' && !restrictedTests.has(normaliseTest(node.filter))) {
            report('test', node.filter, offset);
        }
    };

    walk(tokens, 0);

    return violations.sort((first, second) => first.line - second.line);
}
