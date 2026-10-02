/**
 * The platform's banned pattern list (SubmissionSafetyChecker), served as
 * JavaScript compatible regular expressions in rules.banned_patterns. A
 * pattern marked `js_compatible: false` cannot be expressed in JavaScript
 * and is skipped (the marketplace's own check still applies it). A pattern
 * with `source_only: true` (the escape sequence bans) applies to the
 * template source only: the rendered output legitimately contains escapes from the
 * json filter, so the rendered pass decodes escapes and re-runs the other
 * patterns instead.
 */

/**
 * @typedef {{key: string, pattern: string, flags?: string, message: string, scope?: string, source_only?: boolean, js_compatible?: boolean}} BannedPatternRule
 * @typedef {{key: string, regex: RegExp, message: string, sourceOnly: boolean}} CompiledPattern
 */

/**
 * @param {BannedPatternRule[]} rules
 * @returns {{patterns: CompiledPattern[], skipped: string[]}}
 */
export function compilePatterns(rules) {
    /** @type {CompiledPattern[]} */
    const patterns = [];
    /** @type {string[]} */
    const skipped = [];

    for (const rule of rules ?? []) {
        if (rule.js_compatible === false) {
            skipped.push(rule.key);
            continue;
        }

        const flags = [...new Set((rule.flags ?? '').replace(/[^dgimsuyv]/g, '').replace('g', ''))].join('');

        try {
            patterns.push({
                key: rule.key,
                regex: new RegExp(rule.pattern, flags),
                message: rule.message,
                sourceOnly: rule.scope === 'source' || rule.source_only === true,
            });
        } catch {
            skipped.push(rule.key);
        }
    }

    return { patterns, skipped };
}

/**
 * @typedef {{key: string, message: string, offset: number}} PatternMatch
 */

/**
 * Every pattern that matches, once each, with the offset of its first
 * match.
 *
 * @param {string} subject
 * @param {CompiledPattern[]} patterns
 * @param {{includeSourceOnly: boolean}} options
 * @returns {PatternMatch[]}
 */
export function matchPatterns(subject, patterns, options) {
    /** @type {PatternMatch[]} */
    const matches = [];

    for (const pattern of patterns) {
        if (pattern.sourceOnly && !options.includeSourceOnly) {
            continue;
        }

        const match = pattern.regex.exec(subject);

        if (match !== null) {
            matches.push({ key: pattern.key, message: pattern.message, offset: match.index });
        }
    }

    return matches;
}

/**
 * Decode JavaScript hex and unicode escape sequences so the rendered scan
 * sees the identifier an escaped payload would evaluate to.
 *
 * @param {string} html
 */
export function decodeEscapes(html) {
    return html.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (match, braced, unicode, hex) => {
        const codepoint = Number.parseInt(braced ?? unicode ?? hex, 16);

        return codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : '';
    });
}
