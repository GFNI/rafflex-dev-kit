import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gitState, runGit } from '../git.js';
import { changelogFilename, loadWorkspace, selectProduct } from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

/**
 * CHANGELOG.md holds the release notes, newest first, under `## <heading>`
 * sections with `## Unreleased` on top for the version in progress.
 *
 * @typedef {{heading: string, start: number, end: number, body: string}} ChangelogSection
 *   `start` is the heading's line, `end` the line after the section.
 */

/**
 * @param {string} text
 * @returns {{lines: string[], sections: ChangelogSection[]}}
 */
export function parseChangelog(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    /** @type {number[]} */
    const headingLines = [];

    lines.forEach((line, index) => {
        if (/^##[ \t]+\S/.test(line)) {
            headingLines.push(index);
        }
    });

    const sections = headingLines.map((start, position) => {
        const end = headingLines[position + 1] ?? lines.length;

        return {
            heading: lines[start].replace(/^##[ \t]+/, '').trim(),
            start,
            end,
            body: lines.slice(start + 1, end).join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd(),
        };
    });

    return { lines, sections };
}

/**
 * @param {ChangelogSection[]} sections
 */
function unreleasedSection(sections) {
    return sections.find((section) => /^unreleased$/i.test(section.heading)) ?? null;
}

/**
 * The notes under `## Unreleased`, or null when the section is missing or
 * empty.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function unreleasedNotes(text) {
    const body = unreleasedSection(parseChangelog(text).sections)?.body ?? '';

    return body.trim() === '' ? null : body;
}

/**
 * The section for `version`: a heading that is the version alone or the
 * version followed by a space (`1.3.0 (submitted 2026-10-02)`).
 *
 * @param {ChangelogSection[]} sections
 * @param {string} version
 */
function versionSection(sections, version) {
    return sections.find((section) => section.heading === version || section.heading.startsWith(`${version} `)) ?? null;
}

/**
 * Close the Unreleased section for `version`: its notes move under
 * `## <version> (submitted <date>)` and a fresh empty Unreleased takes its
 * place. When the version already has a section (changes were requested
 * and it was submitted again) the notes are added to that section, which
 * takes the new submission date, instead of a second heading.
 *
 * @param {string} text
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @returns {{text: string, notes: string, heading: string, merged: boolean}}
 */
export function closeUnreleased(text, version, date) {
    const { lines, sections } = parseChangelog(text);
    const unreleased = unreleasedSection(sections);

    if (unreleased === null || unreleased.body.trim() === '') {
        throw new Error(`${changelogFilename} has no notes under "## Unreleased". Write the release notes for site owners there first.`);
    }

    const heading = `${version} (submitted ${date})`;
    const existing = versionSection(sections, version);
    const before = lines.slice(0, unreleased.start).join('\n').trimEnd();
    /** @type {string[]} */
    const parts = [];

    if (before !== '') {
        parts.push(before);
    }

    parts.push('## Unreleased');

    const body = (/** @type {string} */ value) => (value === '' ? [] : [value]);

    if (existing === null) {
        parts.push(`## ${heading}`, unreleased.body);
    }

    for (const section of sections) {
        if (section === unreleased) {
            continue;
        }

        if (section === existing) {
            parts.push(`## ${heading}`, ...body(section.body), unreleased.body);
            continue;
        }

        parts.push(lines[section.start], ...body(section.body));
    }

    return { text: `${parts.join('\n\n')}\n`, notes: unreleased.body, heading, merged: existing !== null };
}

/**
 * Today's date in the creator's time zone, YYYY-MM-DD.
 *
 * @param {Date} [now]
 */
export function localDate(now = new Date()) {
    const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');

    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Commit the product folder and tag the release. Only the product's own
 * files are committed, so unrelated work elsewhere in the workspace stays
 * out of the release commit. An existing tag is never moved.
 *
 * @param {string} root
 * @param {string} directory
 * @param {string} message
 * @param {string|null} tag
 * @returns {{repository: boolean, committed: boolean, commit: string|null, tag: string|null, tag_created: boolean, tag_existed: boolean, error: string|null}}
 */
function commitAndTag(root, directory, message, tag) {
    const result = { repository: false, committed: false, commit: /** @type {string|null} */ (null), tag, tag_created: false, tag_existed: false, error: /** @type {string|null} */ (null) };

    if (!gitState(root).repository) {
        return result;
    }

    result.repository = true;

    const added = runGit(root, ['add', '-A', '--', directory]);
    const committed = added.ok ? runGit(root, ['commit', '-q', '-m', message, '--', directory]) : added;

    if (!committed.ok) {
        result.error = `git commit failed: ${committed.stderr}`;

        return result;
    }

    result.committed = true;
    result.commit = runGit(root, ['rev-parse', 'HEAD']).stdout.trim() || null;

    if (tag === null) {
        return result;
    }

    if (runGit(root, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok) {
        result.tag_existed = true;

        return result;
    }

    const tagged = runGit(root, ['tag', tag]);

    if (!tagged.ok) {
        result.error = `git tag failed: ${tagged.stderr}`;

        return result;
    }

    result.tag_created = true;

    return result;
}

/**
 * `release <product>`: run after submit_for_review succeeds. Closes the
 * Unreleased changelog section under the version being worked on, and
 * with git commits the product folder as "Release <slug> <version>" and
 * tags `<slug>@<version>` (an existing tag is reported, never moved).
 * Refused when Unreleased is empty.
 *
 * JSON: `{product, slug, version, heading, merged, notes, git: {repository, committed, commit, tag, tag_created, tag_existed, error}}`.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runReleaseCommand(context) {
    const { cwd, stdout, stderr, options } = context;
    let workspace;
    let product;

    try {
        workspace = loadWorkspace(cwd);
        product = selectProduct(workspace, options.positionals[0], cwd);
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    if (!existsSync(product.changelogPath)) {
        return fail(context, `${product.path}/${changelogFilename} is missing. Create it with "# Changelog" and a "## Unreleased" section holding the release notes.`, 1);
    }

    let closed;

    try {
        closed = closeUnreleased(readFileSync(product.changelogPath, 'utf8'), product.version, localDate());
    } catch (error) {
        return fail(context, `${product.path}: ${messageOf(error)}`, 1);
    }

    const temporary = `${product.changelogPath}.${process.pid}.tmp`;

    writeFileSync(temporary, closed.text);
    renameSync(temporary, product.changelogPath);

    const name = product.slug ?? product.folder;
    const tag = product.slug === null ? null : `${product.slug}@${product.version}`;
    const git = commitAndTag(workspace.root, product.directory, `Release ${name} ${product.version}`, tag);
    /** @type {string[]} */
    const notes = [];

    if (product.slug === null) {
        notes.push('No tag: this product has no slug yet. Read it with get_product and run synced first.');
    }

    if (git.tag_existed) {
        notes.push(`The tag ${tag} already exists and was left where it is.`);
    }

    if (git.error !== null) {
        notes.push(git.error);
    }

    if (options.json) {
        writeJson(stdout, { product: product.path, slug: product.slug, version: product.version, heading: closed.heading, merged: closed.merged, notes: closed.notes, git });

        return 0;
    }

    const lines = [`${product.path}: ${closed.merged ? 'added the Unreleased notes to' : 'moved the Unreleased notes under'} "## ${closed.heading}" and started a fresh Unreleased section.`];

    if (git.committed) {
        lines.push(`Committed "Release ${name} ${product.version}"${git.tag_created ? ` and tagged ${tag}` : ''}.`);
    } else if (!git.repository) {
        lines.push('Not a git repository, so nothing was committed or tagged.');
    }

    stdout.write(`${lines.join('\n')}\n`);

    for (const note of notes) {
        stderr.write(`note: ${note}\n`);
    }

    return 0;
}
