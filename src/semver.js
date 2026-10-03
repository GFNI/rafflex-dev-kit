/**
 * The platform's versions: plain major.minor.patch, no prerelease or
 * build parts, no leading zeros.
 */

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * @param {string} version
 * @returns {[number, number, number]|null}
 */
export function parseVersion(version) {
    const match = versionPattern.exec(version);

    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {string} version
 */
export function isVersion(version) {
    return parseVersion(version) !== null;
}

/**
 * Negative when `first` is lower, positive when higher, 0 when equal.
 *
 * @param {string} first
 * @param {string} second
 */
export function compareVersions(first, second) {
    const left = parseVersion(first);
    const right = parseVersion(second);

    if (left === null || right === null) {
        throw new Error(`Cannot compare ${first} with ${second}: versions are major.minor.patch.`);
    }

    for (let index = 0; index < 3; index++) {
        if (left[index] !== right[index]) {
            return left[index] - right[index];
        }
    }

    return 0;
}

/**
 * @param {string} version
 * @param {'major'|'minor'|'patch'} bump
 */
export function bumpVersion(version, bump) {
    const parts = parseVersion(version);

    if (parts === null) {
        throw new Error(`${version} is not a major.minor.patch version.`);
    }

    const [major, minor, patch] = parts;

    switch (bump) {
        case 'major':
            return `${major + 1}.0.0`;
        case 'minor':
            return `${major}.${minor + 1}.0`;
        default:
            return `${major}.${minor}.${patch + 1}`;
    }
}
