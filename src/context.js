import { inferOptions } from './options/infer.js';
import { renderOptions } from './options/render-options.js';
import { resolveOptions, valueLimits } from './options/values.js';

/**
 * Sample contexts from contexts.json, with the project's own `files` map
 * injected and the template's options resolved (see options/), as the
 * platform builds a preview or check context.
 *
 * contexts.json publishes the catalogue both types render with (the
 * platform's preview and check give a game the whole data contract) once
 * under `shared`; each game context carries only what its scenario and play
 * count change (plays, play_count, win_count) and the block context only
 * the block's own variables. A context is `shared` merged with the game or
 * block context, then files and options. Rules cached before `shared` was
 * published carry the catalogue in the block context instead, so that
 * stands in for it.
 */

/**
 * The toggles a template reads and the value each starts with when a site
 * owner has typed nothing, from the platform's options inferrer (see
 * options/infer.js): a literal default, otherwise the published
 * `toggle_unset`. Other options stay unset so the template's own default
 * applies.
 *
 * @param {string} template
 * @param {unknown} [toggleUnset]
 * @returns {Record<string, boolean>}
 */
export function inferToggleDefaults(template, toggleUnset = false) {
    const fields = inferOptions(template).fields.filter((field) => field.type === 'toggle');
    const limits = { ...valueLimits(), toggle_unset: Boolean(toggleUnset) };

    return /** @type {Record<string, boolean>} */ (resolveOptions(fields, {}, null, limits));
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
 * The platform has one array type, so an empty map is `[]`. Keeping it an empty
 * array keeps `{{ files|json }}` identical to the platform's output.
 *
 * @param {Record<string, string>|unknown[]} files
 */
function filesValue(files) {
    return Array.isArray(files) || Object.keys(files).length === 0 ? [] : files;
}

/**
 * @param {Record<string, unknown>} options
 */
function optionsValue(options) {
    return Object.keys(options).length === 0 ? [] : options;
}

/**
 * The catalogue variables both types render with.
 *
 * @param {any} contexts
 * @returns {Record<string, unknown>}
 */
function sharedContext(contexts) {
    return contexts.shared ?? contexts.block?.context ?? {};
}

/**
 * @typedef {object} OptionSelection
 * @property {Record<string, unknown>} [options] Option values set (the app's options form or a spec), coerced as the platform coerces a site owner's.
 * @property {unknown} [overrides] options.json, whose choices narrow what a text option accepts.
 */

/**
 * A game scenario's context at a play count (the nearest available one
 * when contexts.json does not carry that count), with the catalogue
 * variables (narrowed by a ticked Categories filter), files, and the
 * resolved options.
 *
 * @param {any} contexts
 * @param {{scenario: string, playCount: number, files: Record<string, string>, template: string} & OptionSelection} selection
 */
export function gameContext(contexts, { scenario, playCount, files, template, options = {}, overrides = null }) {
    const count = nearestPlayCount(contexts, scenario, playCount);

    if (count === null) {
        throw new Error(`contexts.json has no sample data for the ${scenario} scenario.`);
    }

    const resolved = renderOptions({ contexts, template, files, shared: sharedContext(contexts), values: options, overrides });

    return {
        ...resolved.shared,
        ...contexts.game[scenario][String(count)],
        files: filesValue(files),
        options: optionsValue(resolved.options),
    };
}

/**
 * The block data contract's context (PRD 28), with files and the resolved
 * options.
 *
 * @param {any} contexts
 * @param {{files: Record<string, string>, template: string} & OptionSelection} selection
 */
export function blockContext(contexts, { files, template, options = {}, overrides = null }) {
    const resolved = renderOptions({ contexts, template, files, shared: contexts.shared ?? {}, values: options, overrides });

    return {
        ...resolved.shared,
        ...(contexts.block?.context ?? {}),
        files: filesValue(files),
        options: optionsValue(resolved.options),
    };
}

/**
 * A fixture's context exactly as the platform rendered it: the shared
 * catalogue merged with the published context for its type, scenario, and
 * play count, plus its files map.
 *
 * @param {any} contexts
 * @param {{type: string, scenario: string|null, play_count: number|null, files: Record<string, string>|unknown[]}} fixture
 */
export function rawFixtureContext(contexts, fixture) {
    const base = fixture.type === 'block'
        ? contexts.block.context
        : contexts.game[String(fixture.scenario)][String(fixture.play_count)];

    return { ...(contexts.shared ?? {}), ...base, files: filesValue(fixture.files) };
}
