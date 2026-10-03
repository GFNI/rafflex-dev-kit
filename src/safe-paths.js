import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * Names that come from outside the workspace (an export bundle, a sync
 * link's answer, a get_product result) and become folder or file names.
 * Anything that reaches the disk is checked here first, because a bundle
 * or an answer can come from any URL or file, and a name such as
 * `../../outside` would otherwise write or move files out of the
 * workspace.
 */

/** A product slug and a media tag: lower case words joined by single hyphens. */
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a value is a slug the kit may use as a folder name.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSlug(value) {
    return typeof value === 'string' && slugPattern.test(value);
}

/**
 * Whether a file name from outside is one plain name: no folder parts,
 * no NUL, not `.` or `..`.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isPlainFilename(value) {
    return typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
}

/**
 * Whether `path` resolves inside `base` (not `base` itself), without
 * following links.
 *
 * @param {string} base
 * @param {string} path
 */
export function resolvesInside(base, path) {
    const inside = relative(resolve(base), resolve(path));

    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * The real path of the deepest existing folder at or above `path`.
 *
 * @param {string} path
 */
function realExisting(path) {
    let current = resolve(path);

    for (;;) {
        try {
            return realpathSync(current);
        } catch {
            const parent = dirname(current);

            if (parent === current) {
                return current;
            }

            current = parent;
        }
    }
}

/**
 * The absolute path for writing `path` when it stays inside `base`, also
 * after following any link in the folders above it; otherwise an error
 * naming the path. Every write of a name from outside goes through this.
 *
 * @param {string} base
 * @param {string} path An absolute path, or one relative to `base`.
 * @returns {string}
 */
export function confinedWritePath(base, path) {
    const target = resolve(base, path);

    if (!resolvesInside(base, target)) {
        throw new Error(`Refused to write ${path}: it is outside ${base}.`);
    }

    const realBase = realExisting(base);
    const realParent = realExisting(dirname(target));

    if (realParent !== realBase && !resolvesInside(realBase, realParent)) {
        throw new Error(`Refused to write ${path}: a folder above it points outside ${base}.`);
    }

    return target;
}
