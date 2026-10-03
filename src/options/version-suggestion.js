import { bumpVersion, compareVersions, isVersion } from '../semver.js';
import { comparableKeys } from './check.js';
import { flattenedKeys, inferOptions } from './infer.js';

/**
 * The version the platform would suggest for the version in progress,
 * measured against the live version's options: major when an option the
 * live version reads is gone (sites may have set it), minor when options
 * are added, patch otherwise. Null when nothing is live, its version is
 * not major.minor.patch, or the marketplace did not send the live
 * version's option keys (`versions[].option_keys` in get_product).
 */

/**
 * @typedef {{version: string, bump: 'major'|'minor'|'patch', reason: string}} VersionSuggestion
 */

/**
 * @param {string[]} names
 */
function joined(names) {
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * @param {object} input
 * @param {unknown} input.liveVersion
 * @param {unknown} input.liveOptionKeys
 * @param {import('./infer.js').InferredField[]} input.fields The options the local template reads.
 * @returns {VersionSuggestion|null}
 */
export function suggestVersion({ liveVersion, liveOptionKeys, fields }) {
    if (typeof liveVersion !== 'string' || !isVersion(liveVersion) || !Array.isArray(liveOptionKeys)) {
        return null;
    }

    const liveKeys = liveOptionKeys.filter((key) => typeof key === 'string');
    const localKeys = comparableKeys(fields, liveKeys);
    const labels = flattenedKeys(fields);
    const removed = liveKeys.filter((key) => !localKeys.includes(key));
    const added = localKeys.filter((key) => !liveKeys.includes(key));

    if (removed.length > 0) {
        return {
            version: bumpVersion(liveVersion, 'major'),
            bump: 'major',
            reason: `Sites on ${liveVersion} may have set ${joined(removed.map((key) => `options.${key}`))}, which this version no longer reads, so it is a major release.`,
        };
    }

    if (added.length > 0) {
        return {
            version: bumpVersion(liveVersion, 'minor'),
            bump: 'minor',
            reason: `This version adds ${joined(added.map((key) => `${labels.get(key) ?? key} (options.${key})`))}, so it is a minor release.`,
        };
    }

    return {
        version: bumpVersion(liveVersion, 'patch'),
        bump: 'patch',
        reason: `This version reads the same options as ${liveVersion}, so it is a patch release.`,
    };
}

/**
 * The suggestion for a product's local template against its last synced
 * remote state.
 *
 * @param {{manifest: {remote: any}}} product
 * @param {string} template
 * @param {any} [contexts]
 * @returns {VersionSuggestion|null}
 */
export function suggestedVersionFor(product, template, contexts) {
    const remote = product.manifest.remote;

    return suggestVersion({ liveVersion: remote?.live_version, liveOptionKeys: remote?.live_option_keys, fields: inferOptions(template, contexts).fields });
}

/**
 * The plan's warning when the version in progress is lower than the
 * suggestion.
 *
 * @param {{version: string, suggested_version: VersionSuggestion|null, product: string}} plan
 * @returns {string[]}
 */
export function versionSuggestionLines(plan) {
    const suggestion = plan.suggested_version;

    if (suggestion === null || !isVersion(plan.version) || compareVersions(plan.version, suggestion.version) >= 0) {
        return [];
    }

    return [`  Version ${plan.version} is lower than the ${suggestion.bump} release the marketplace expects (${suggestion.version}). ${suggestion.reason} Set it with npx @rafflex/dev version ${plan.product} ${suggestion.version}.`];
}
