import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { isBlocking } from '../checker.js';

/**
 * A product's last test result, as the app shows it: read from the
 * product's `.results/` folder (PRD 41), whoever ran the test, the app or
 * the AI from its terminal. `verify --json` output is normalised into one
 * shape so the app does not depend on every field of every command.
 */

/** Test output inside a product folder, ignored by git. */
export const resultsDirectoryName = '.results';

/** Written by the app after a run when the command left no result of its own. */
export const appResultFilename = 'last-run.json';

/** The result files the app reads, newest first by modification time. */
export const resultFilenames = ['verify.json', 'last-run.json', 'results.json'];

export const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];

const devices = ['phone', 'tablet', 'desktop', 'mobile'];
const maxScreenshots = 120;

/**
 * @typedef {{code: string, message: string, fix: string, scenario?: string, line?: number, file?: string, screenshot?: string, blocking: boolean}} ResultIssue
 * @typedef {{path: string, scenario: string|null, device: string|null}} Screenshot
 * @typedef {{number: number, expected: string|null, actual: string|null, passed: boolean}} PlayResult
 * @typedef {{scenario: string, passed: boolean, plays: PlayResult[], message: string|null}} Playthrough
 * @typedef {object} TestResult
 * @property {'passed'|'issues'|'error'} status
 * @property {string|null} at          ISO time of the run.
 * @property {string|null} source      The command that produced it.
 * @property {ResultIssue[]} blocking
 * @property {ResultIssue[]} warnings
 * @property {string[]} notes          Skipped steps and similar.
 * @property {Screenshot[]} screenshots Paths relative to `.results/`.
 * @property {Playthrough[]} playthrough
 * @property {string|null} error
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every object in a result that may carry issues, screenshots, or a
 * playthrough: the result itself, its steps (format, check, test, as an
 * object or a list), and a single product of a multi product result.
 *
 * @param {Record<string, any>} json
 * @returns {Record<string, any>[]}
 */
function partsOf(json) {
    /** @type {Record<string, any>[]} */
    const parts = [json];

    if (Array.isArray(json.products) && isObject(json.products[0])) {
        parts.push(...partsOf(json.products[0]));
    }

    const steps = Array.isArray(json.steps) ? json.steps : isObject(json.steps) ? Object.values(json.steps) : [];

    for (const step of [...steps, json.format, json.check, json.test, json.lint, json.run_through, json.playthrough_result]) {
        if (isObject(step)) {
            parts.push(step);
        }
    }

    return parts;
}

/**
 * @param {Record<string, any>} issue
 * @returns {ResultIssue|null}
 */
function normaliseIssue(issue) {
    if (!isObject(issue) || typeof issue.message !== 'string') {
        return null;
    }

    const code = typeof issue.code === 'string' ? issue.code : 'issue';
    const explicit = typeof issue.blocking === 'boolean'
        ? issue.blocking
        : typeof issue.severity === 'string'
            ? ['error', 'blocking'].includes(issue.severity)
            : typeof issue.level === 'string'
                ? ['error', 'blocking'].includes(issue.level)
                : null;
    /** @type {ResultIssue} */
    const normalised = { code, message: issue.message, fix: typeof issue.fix === 'string' ? issue.fix : '', blocking: explicit ?? isBlocking({ code }) };

    for (const key of /** @type {const} */ (['scenario', 'file', 'screenshot'])) {
        if (typeof issue[key] === 'string') {
            normalised[key] = issue[key];
        }
    }

    if (Number.isInteger(issue.line)) {
        normalised.line = issue.line;
    }

    return normalised;
}

/**
 * A screenshot path relative to the product's `.results/` folder, or null
 * when it points anywhere else.
 *
 * @param {string} productDirectory
 * @param {string} path
 */
function resultsRelative(productDirectory, path) {
    const resultsDirectory = join(productDirectory, resultsDirectoryName);
    const absolute = isAbsolute(path)
        ? path
        : path.split(/[\\/]/)[0] === resultsDirectoryName ? join(productDirectory, path) : join(resultsDirectory, path);
    const inside = relative(resultsDirectory, absolute);

    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        return null;
    }

    return inside.split(sep).join('/');
}

/**
 * Scenario and device from a screenshot's name, such as
 * "screenshots/win-phone.png" or "no_plays/390.png".
 *
 * @param {string} path
 * @returns {{scenario: string|null, device: string|null}}
 */
export function describeScreenshot(path) {
    const segments = path.replace(/\.[a-z]+$/i, '').split('/');
    const name = segments.pop() ?? '';
    const parts = name.split(/[-_@](?=[a-z0-9]+$)/i);
    const last = parts.length > 1 ? parts.pop() ?? '' : '';

    if (devices.includes(last.toLowerCase()) || /^\d+$/.test(last)) {
        return { scenario: parts.join('-') || segments.pop() || null, device: last };
    }

    if (devices.includes(name.toLowerCase()) || /^\d+$/.test(name)) {
        return { scenario: segments.pop() ?? null, device: name };
    }

    return { scenario: name || null, device: null };
}

/**
 * @param {string} productDirectory
 * @param {unknown} entry
 * @returns {Screenshot|null}
 */
function normaliseScreenshot(productDirectory, entry) {
    const path = typeof entry === 'string' ? entry : isObject(entry) ? entry.path ?? entry.file ?? entry.screenshot : null;

    if (typeof path !== 'string' || !imageExtensions.includes(extname(path).toLowerCase())) {
        return null;
    }

    const relativePath = resultsRelative(productDirectory, path);

    if (relativePath === null) {
        return null;
    }

    const described = describeScreenshot(relativePath);
    const device = isObject(entry) ? entry.device ?? entry.width ?? entry.viewport ?? null : null;

    return {
        path: relativePath,
        scenario: isObject(entry) && typeof entry.scenario === 'string' ? entry.scenario : described.scenario,
        device: device === null ? described.device : String(device),
    };
}

/**
 * Every image in the product's `.results/` folder, for results that do
 * not list their screenshots.
 *
 * @param {string} productDirectory
 * @returns {string[]}
 */
function imagesIn(productDirectory) {
    const root = join(productDirectory, resultsDirectoryName);
    /** @type {string[]} */
    const found = [];
    const walk = (/** @type {string} */ directory) => {
        let entries = [];

        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
            if (found.length >= maxScreenshots || entry.name.startsWith('.')) {
                continue;
            }

            const full = join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && imageExtensions.includes(extname(entry.name).toLowerCase())) {
                found.push(full);
            }
        }
    };

    walk(root);

    return found;
}

/**
 * @param {unknown} value
 */
function resultText(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'boolean') {
        return value ? 'win' : 'lose';
    }

    return null;
}

/**
 * @param {string} scenario
 * @param {unknown} entry
 * @returns {Playthrough|null}
 */
function normalisePlaythrough(scenario, entry) {
    if (!isObject(entry)) {
        return null;
    }

    const rawPlays = Array.isArray(entry.plays) ? entry.plays : Array.isArray(entry.results) ? entry.results : [];
    const plays = rawPlays.filter(isObject).map((play, index) => {
        const expected = resultText(play.expected);
        const actual = resultText(play.actual ?? play.revealed ?? play.result);

        return {
            number: Number.isInteger(play.number) ? play.number : Number.isInteger(play.index) ? play.index + 1 : Number.isInteger(play.play) ? play.play : index + 1,
            expected,
            actual,
            passed: typeof play.passed === 'boolean' ? play.passed : expected === actual,
        };
    });

    return {
        scenario: typeof entry.scenario === 'string' ? entry.scenario : scenario,
        passed: typeof entry.passed === 'boolean' ? entry.passed : plays.every((play) => play.passed),
        plays,
        message: typeof entry.message === 'string' ? entry.message : null,
    };
}

/**
 * @param {unknown} value
 * @returns {Playthrough[]}
 */
function playthroughsFrom(value) {
    if (Array.isArray(value)) {
        return value.map((entry, index) => normalisePlaythrough(String(index), entry)).filter((entry) => entry !== null);
    }

    if (isObject(value)) {
        if (Array.isArray(value.scenarios)) {
            return playthroughsFrom(value.scenarios);
        }

        return Object.entries(value)
            .filter(([, entry]) => isObject(entry))
            .map(([scenario, entry]) => normalisePlaythrough(scenario, entry))
            .filter((entry) => entry !== null);
    }

    return [];
}

/**
 * @param {Record<string, any>} part
 * @returns {string[]}
 */
function notesOf(part) {
    /** @type {string[]} */
    const notes = [];

    for (const key of ['skipped', 'skipped_reason', 'note', 'notes']) {
        const value = part[key];

        if (typeof value === 'string' && value !== '') {
            notes.push(value);
        } else if (Array.isArray(value)) {
            notes.push(...value.filter((note) => typeof note === 'string'));
        } else if (value === true && key === 'skipped') {
            notes.push('Browser tests skipped.');
        }
    }

    return notes;
}

/**
 * Normalise a check, test, or verify result (their `--json` output) into
 * the app's shape.
 *
 * @param {unknown} json
 * @param {{productDirectory: string, at?: string|null, source?: string|null}} context
 * @returns {TestResult}
 */
export function normaliseResult(json, { productDirectory, at = null, source = null }) {
    if (!isObject(json)) {
        return { status: 'error', at, source, blocking: [], warnings: [], notes: [], screenshots: [], playthrough: [], error: 'The test printed no result.' };
    }

    const parts = partsOf(json);
    /** @type {Map<string, ResultIssue>} */
    const issues = new Map();
    /** @type {Map<string, Screenshot>} */
    const screenshots = new Map();
    /** @type {Map<string, Playthrough>} */
    const playthroughs = new Map();
    /** @type {string[]} */
    const notes = [];

    for (const part of parts) {
        for (const raw of Array.isArray(part.issues) ? part.issues : []) {
            const issue = normaliseIssue(raw);

            if (issue !== null) {
                issues.set([issue.code, issue.message, issue.scenario, issue.line, issue.file].join('|'), issue);

                if (issue.screenshot !== undefined) {
                    const screenshot = normaliseScreenshot(productDirectory, { path: issue.screenshot, scenario: issue.scenario });

                    if (screenshot !== null) {
                        screenshots.set(screenshot.path, screenshot);
                    }
                }
            }
        }

        for (const raw of Array.isArray(part.screenshots) ? part.screenshots : []) {
            const screenshot = normaliseScreenshot(productDirectory, raw);

            if (screenshot !== null) {
                screenshots.set(screenshot.path, screenshot);
            }
        }

        for (const playthrough of playthroughsFrom(part.playthrough ?? part.playthroughs)) {
            playthroughs.set(playthrough.scenario, playthrough);
        }

        for (const note of notesOf(part)) {
            if (!notes.includes(note)) {
                notes.push(note);
            }
        }
    }

    if (screenshots.size === 0) {
        for (const image of imagesIn(productDirectory)) {
            const screenshot = normaliseScreenshot(productDirectory, image);

            if (screenshot !== null) {
                screenshots.set(screenshot.path, screenshot);
            }
        }
    }

    const all = [...issues.values()];
    const blocking = all.filter((issue) => issue.blocking);
    const error = typeof json.error === 'string' ? json.error : null;
    const failedPlaythrough = [...playthroughs.values()].some((playthrough) => !playthrough.passed);
    const passed = error === null && blocking.length === 0 && !failedPlaythrough && json.passed !== false;

    return {
        status: error !== null && all.length === 0 ? 'error' : passed ? 'passed' : 'issues',
        at,
        source: typeof json.command === 'string' ? json.command : source,
        blocking,
        warnings: all.filter((issue) => !issue.blocking),
        notes,
        screenshots: [...screenshots.values()],
        playthrough: [...playthroughs.values()],
        error,
    };
}

/**
 * The product's last test result, or null when it was never tested.
 *
 * @param {string} productDirectory
 * @returns {TestResult|null}
 */
export function readLastResult(productDirectory) {
    const resultsDirectory = join(productDirectory, resultsDirectoryName);
    const candidates = resultFilenames
        .map((name) => ({ path: join(resultsDirectory, name), stats: statSync(join(resultsDirectory, name), { throwIfNoEntry: false }) }))
        .filter((candidate) => candidate.stats?.isFile())
        .sort((first, second) => Number(second.stats?.mtimeMs) - Number(first.stats?.mtimeMs));

    for (const candidate of candidates) {
        let json;

        try {
            json = JSON.parse(readFileSync(candidate.path, 'utf8'));
        } catch {
            continue;
        }

        const wrapped = isObject(json) && json.kit_app === true;
        const at = wrapped && typeof json.at === 'string' ? json.at : new Date(Number(candidate.stats?.mtimeMs)).toISOString();

        return normaliseResult(wrapped ? json.output : json, { productDirectory, at, source: wrapped ? json.source : null });
    }

    return null;
}

/**
 * The newest modification time of the product's result files, or 0.
 *
 * @param {string} productDirectory
 */
export function lastResultTime(productDirectory) {
    return Math.max(0, ...resultFilenames.map((name) => statSync(join(productDirectory, resultsDirectoryName, name), { throwIfNoEntry: false })?.mtimeMs ?? 0));
}

/**
 * Record a run's output when the command did not leave a result of its own
 * (the check fallback, or a run that failed before writing). The folder
 * ignores itself, so test output is never committed.
 *
 * @param {string} productDirectory
 * @param {{source: string, at: string, output: unknown, exitCode: number|null}} run
 */
export function writeAppResult(productDirectory, { source, at, output, exitCode }) {
    const resultsDirectory = join(productDirectory, resultsDirectoryName);

    mkdirSync(resultsDirectory, { recursive: true });

    if (!existsSync(join(resultsDirectory, '.gitignore'))) {
        writeFileSync(join(resultsDirectory, '.gitignore'), '*\n');
    }

    writeFileSync(join(resultsDirectory, appResultFilename), `${JSON.stringify({ kit_app: true, source, at, exit_code: exitCode, output }, null, 2)}\n`);
}
