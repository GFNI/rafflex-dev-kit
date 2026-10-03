import { twigRegionPattern } from './format.js';

/**
 * A port of the platform's game warnings (GameTemplateRules, PRD 41), with
 * the messages and hook names from rules.game_rules, so the kit and the
 * marketplace report `game_twig_logic` and `playthrough_hooks_missing`
 * identically. Both are warnings, and only games get them.
 *
 * - thin Twig: {{ value|json }}, {{ files['tag'] }}, {{ settings.* }}, and
 *   a simple {% if %} (no filters); any other region is game logic that
 *   belongs in Alpine. Comments are fine.
 * - playthrough hooks: data-rafflex-play and data-rafflex-result.
 */

const pathPattern = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*(?:'[^']*'|"[^"]*"|\d+)\s*\])*`;
const keyPattern = String.raw`(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*(?:'[^']*'|"[^"]*")\s*\])`;
const jsonOutput = new RegExp(String.raw`^${pathPattern}\s*\|\s*json$`);
const filesOutput = new RegExp(String.raw`^files${keyPattern}$`);
const settingsOutput = new RegExp(String.raw`^settings${keyPattern}+$`);

/**
 * @param {string} inner
 * @param {string[]} allowedTags
 */
function isSimpleIf(inner, allowedTags) {
    const tag = inner.replace(/\s[\s\S]*$/, '');

    if (!allowedTags.includes(tag)) {
        return false;
    }

    if (tag === 'else' || tag === 'endif') {
        return inner === tag;
    }

    return !inner.includes('|');
}

/**
 * @param {string} region
 * @param {string[]} allowedTags
 */
export function isAllowedGameRegion(region, allowedTags) {
    if (region.startsWith('{#')) {
        return true;
    }

    const inner = region.slice(2, -2).replace(/^[-~]|[-~]$/g, '').trim();

    if (region.startsWith('{%')) {
        return isSimpleIf(inner, allowedTags);
    }

    return jsonOutput.test(inner) || filesOutput.test(inner) || settingsOutput.test(inner);
}

/**
 * @param {string} region
 * @param {number} length
 */
function excerpt(region, length) {
    const collapsed = Array.from(region.replace(/\s+/g, ' '));

    return collapsed.length <= length ? collapsed.join('') : `${collapsed.slice(0, length - 3).join('')}...`;
}

/**
 * @typedef {{code: string, message: string, line?: number}} GameIssue
 */

/**
 * @param {string} template
 * @param {any} gameRules rules.game_rules
 * @returns {GameIssue[]}
 */
export function gameTwigLogicIssues(template, gameRules) {
    const twig = gameRules?.twig;

    if (twig === undefined) {
        return [];
    }

    /** @type {GameIssue[]} */
    const issues = [];
    const seen = new Set();

    for (const match of template.matchAll(twigRegionPattern)) {
        if (isAllowedGameRegion(match[0], twig.tags ?? [])) {
            continue;
        }

        const text = excerpt(match[0], twig.excerpt_length ?? 60);

        if (seen.has(text)) {
            continue;
        }

        seen.add(text);
        issues.push({ code: 'game_twig_logic', message: String(twig.message).replace(':region', text), line: template.slice(0, match.index).split('\n').length });
    }

    return issues;
}

/**
 * @param {string} template
 * @param {any} gameRules rules.game_rules
 * @returns {GameIssue[]}
 */
export function playthroughHookIssues(template, gameRules) {
    const hooks = gameRules?.hooks;

    if (hooks === undefined) {
        return [];
    }

    const missing = [];

    if (!/data-rafflex-play(?![\w-])|dataset\.rafflexPlay\b/.test(template)) {
        missing.push(hooks.play);
    }

    if (!/data-rafflex-result(?![\w-])|dataset\.rafflexResult\b/.test(template)) {
        missing.push(hooks.result);
    }

    return missing.length === 0 ? [] : [{ code: 'playthrough_hooks_missing', message: String(hooks.message).replace(':missing', missing.join(' or ')) }];
}

/**
 * Whether a template has both playthrough hooks.
 *
 * @param {string} template
 */
export function hasPlaythroughHooks(template) {
    return /data-rafflex-play(?![\w-])|dataset\.rafflexPlay\b/.test(template) && /data-rafflex-result(?![\w-])|dataset\.rafflexResult\b/.test(template);
}
