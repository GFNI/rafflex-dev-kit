/**
 * Sample contexts from contexts.json, with the project's own `files` map
 * injected and the template's toggles resolved into `options`, as the
 * platform builds a preview or check context.
 *
 * contexts.json keeps game contexts small: each carries only the game
 * variables (user, settings, plays, play_count, win_count). The platform's
 * check renders a game with the whole data contract, so for checks and the
 * preview the kit adds the catalogue variables from the block context,
 * which do not vary by scenario. The fixture parity suite uses the
 * published contexts exactly as they are (see rawFixtureContext).
 */

const toggleNamePattern = /^(?:show_|hide_|enable_|is_|has_)|_enabled$/;

/**
 * The toggles a template reads and the value each starts with when a site
 * owner has typed nothing: its literal `|default(true)` or
 * `|default(false)`, otherwise the published `toggle_unset` value for an
 * option whose name follows the toggle convention (show_, hide_, enable_,
 * is_, has_, or ending _enabled). Other options stay unset so the
 * template's own default applies.
 *
 * @param {string} template
 * @param {unknown} [toggleUnset]
 * @returns {Record<string, boolean>}
 */
export function inferToggleDefaults(template, toggleUnset = false) {
    /** @type {Record<string, boolean>} */
    const toggles = {};
    /** @type {Set<string>} */
    const conventionalNames = new Set();

    for (const tag of template.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g)) {
        for (const match of tag[0].matchAll(/\boptions\.([A-Za-z_][A-Za-z0-9_]*)(\s*\|\s*default\(\s*(true|false)\s*\))?/g)) {
            if (match[3] !== undefined) {
                toggles[match[1]] ??= match[3] === 'true';
                continue;
            }

            if (toggleNamePattern.test(match[1])) {
                conventionalNames.add(match[1]);
            }
        }
    }

    for (const name of conventionalNames) {
        toggles[name] ??= Boolean(toggleUnset);
    }

    return toggles;
}

/**
 * The play counts contexts.json carries for a scenario, ascending.
 *
 * @param {any} contexts
 * @param {string} scenario
 * @returns {number[]}
 */
export function availablePlayCounts(contexts, scenario) {
    return Object.keys(contexts.game?.[scenario] ?? {}).map(Number).filter(Number.isFinite).sort((first, second) => first - second);
}

/**
 * The available play count closest to the one asked for.
 *
 * @param {any} contexts
 * @param {string} scenario
 * @param {number} playCount
 * @returns {number|null}
 */
export function nearestPlayCount(contexts, scenario, playCount) {
    const counts = availablePlayCounts(contexts, scenario);

    if (counts.length === 0) {
        return null;
    }

    return counts.reduce((best, count) => (Math.abs(count - playCount) < Math.abs(best - playCount) ? count : best), counts[0]);
}

/**
 * PHP has one array type, so an empty map is `[]`. Keeping it an empty
 * array keeps `{{ files|json }}` identical to the platform's output.
 *
 * @param {Record<string, string>|unknown[]} files
 */
function filesValue(files) {
    return Array.isArray(files) || Object.keys(files).length === 0 ? [] : files;
}

/**
 * @param {Record<string, boolean>} toggles
 */
function optionsValue(toggles) {
    return Object.keys(toggles).length === 0 ? [] : toggles;
}

/**
 * A game scenario's context at a play count (the nearest available one
 * when contexts.json does not carry that count), with the catalogue
 * variables, files, and options.
 *
 * @param {any} contexts
 * @param {{scenario: string, playCount: number, files: Record<string, string>, template: string}} selection
 */
export function gameContext(contexts, { scenario, playCount, files, template }) {
    const count = nearestPlayCount(contexts, scenario, playCount);

    if (count === null) {
        throw new Error(`contexts.json has no sample data for the ${scenario} scenario.`);
    }

    return {
        ...(contexts.block?.context ?? {}),
        ...contexts.game[scenario][String(count)],
        files: filesValue(files),
        options: optionsValue(inferToggleDefaults(template, contexts.block?.options_defaults?.toggle_unset)),
    };
}

/**
 * The block data contract's context (PRD 28), with files and options.
 *
 * @param {any} contexts
 * @param {{files: Record<string, string>, template: string}} selection
 */
export function blockContext(contexts, { files, template }) {
    return {
        ...(contexts.block?.context ?? {}),
        files: filesValue(files),
        options: optionsValue(inferToggleDefaults(template, contexts.block?.options_defaults?.toggle_unset)),
    };
}

/**
 * A fixture's context exactly as the platform rendered it: the published
 * context for its type, scenario, and play count, plus its files map.
 *
 * @param {any} contexts
 * @param {{type: string, scenario: string|null, play_count: number|null, files: Record<string, string>|unknown[]}} fixture
 */
export function rawFixtureContext(contexts, fixture) {
    const base = fixture.type === 'block'
        ? contexts.block.context
        : contexts.game[String(fixture.scenario)][String(fixture.play_count)];

    return { ...base, files: filesValue(fixture.files) };
}
