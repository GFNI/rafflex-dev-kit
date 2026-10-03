import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { commitProduct } from '../git.js';
import { payloadMismatch, recordProductState } from '../record-sync.js';
import { productAndLink, SyncLinkError } from '../sync-link.js';
import { changelogFilename, loadWorkspace, selectProduct, writeProductJson } from '../workspace.js';
import { failWithCode, messageOf, writeJson } from './output.js';
import { failWithLinkError, readLinkState } from './synced.js';

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
 * Whether the marketplace has `version` in review (a submitted draft of
 * that version) or already released, as a get_product payload says.
 *
 * @param {Record<string, any>} payload
 * @param {string} version
 * @returns {'in_review'|'released'|null}
 */
export function submittedState(payload, version) {
    if (payload.draft?.submitted === true && payload.draft?.version === version) {
        return 'in_review';
    }

    const released = Array.isArray(payload.versions) ? payload.versions : [];

    return released.some((/** @type {any} */ entry) => entry?.version === version) ? 'released' : null;
}

/**
 * `release <product> ["<sync_url>"]`: run after submit_for_review succeeds.
 * Closes the Unreleased changelog section under the version being worked
 * on, marks the draft as submitted in the recorded remote state (so the
 * app shows In review without another sync), and with git commits the
 * product folder as "Release <slug> <version>" and tags `<slug>@<version>`
 * (an existing tag is reported, never moved). With a sync link it first
 * reads the marketplace: unless that version is in review (or already
 * released) it changes nothing and exits 1 (`not_submitted`), so the AI
 * calls submit_for_review first; otherwise it records the fresh state and
 * feedback instead of marking it. Refused when Unreleased is empty.
 *
 * JSON: `{product, slug, version, heading, merged, notes, in_review, git: {repository, committed, commit, tag, tag_created, tag_existed, error}}`;
 * a refusal is `{error: {code, message}}`.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runReleaseCommand(context) {
    const { cwd, stdout, stderr, options } = context;
    const { name: productName, link } = productAndLink(options.positionals);
    let workspace;
    let product;

    try {
        workspace = loadWorkspace(cwd);
        product = selectProduct(workspace, productName, cwd);
    } catch (error) {
        return failWithCode(context, { code: 'cannot_run', message: messageOf(error) }, 2);
    }

    /** @type {{payload: Record<string, any>, feedback: unknown}|null} */
    let fresh = null;

    if (link !== undefined) {
        try {
            const state = await readLinkState(workspace, link);

            if (state.payload === null) {
                return failWithCode(context, { code: 'not_created', message: `That link is for a product not on the marketplace yet. Push ${product.path} first with npx @rafflex/dev push ${product.path} "<sync_url>" (a link from request_sync with no slug).` }, 1);
            }

            fresh = { payload: state.payload, feedback: state.feedback };
        } catch (error) {
            if (error instanceof SyncLinkError) {
                return failWithLinkError(context, error);
            }

            throw error;
        }

        const mismatch = payloadMismatch(product, fresh.payload, 'That link');

        if (mismatch !== null) {
            return failWithCode(context, { code: mismatch.exitCode === 2 ? 'unexpected_response' : 'wrong_link', message: mismatch.message }, mismatch.exitCode);
        }

        if (submittedState(fresh.payload, product.version) === null) {
            const slug = fresh.payload.slug;
            const draft = fresh.payload.draft;
            const has = draft === null || draft === undefined
                ? 'no draft'
                : (draft.submitted === true ? `${draft.version} in review` : `${draft.version} as a draft not yet submitted`);

            return failWithCode(context, {
                code: 'not_submitted',
                message: `The marketplace has ${has}, so ${product.version} of ${slug} is not in review and nothing changed (no changelog edit, commit, or tag). When the creator says go, call submit_for_review for ${slug}, then run npx @rafflex/dev release ${slug} "<sync_url>" with a new link.`,
            }, 1);
        }
    }

    if (!existsSync(product.changelogPath)) {
        return failWithCode(context, { code: 'no_changelog', message: `${product.path}/${changelogFilename} is missing. Create it with "# Changelog" and a "## Unreleased" section holding the release notes.` }, 1);
    }

    let closed;

    try {
        closed = closeUnreleased(readFileSync(product.changelogPath, 'utf8'), product.version, localDate());
    } catch (error) {
        return failWithCode(context, { code: 'no_notes', message: `${product.path}: ${messageOf(error)}` }, 1);
    }

    const temporary = `${product.changelogPath}.${process.pid}.tmp`;

    writeFileSync(temporary, closed.text);
    renameSync(temporary, product.changelogPath);

    /** @type {string[]} */
    const notes = [];
    const marked = markInReview(workspace, product, fresh, notes);
    const name = marked.slug ?? product.folder;
    const tag = marked.slug === null ? null : `${marked.slug}@${product.version}`;
    const git = commitProduct(workspace.root, marked.directory, `Release ${name} ${product.version}`, tag);

    if (marked.slug === null) {
        notes.push(`No tag: this product has no slug yet. Push it first: call request_sync with no slug, then run npx @rafflex/dev push ${product.path} "<sync_url>".`);
    }

    if (git.tag_existed) {
        notes.push(`The tag ${tag} already exists and was left where it is.`);
    }

    if (git.error !== null) {
        notes.push(git.error);
    }

    if (options.json) {
        writeJson(stdout, { product: marked.path, slug: marked.slug, version: product.version, heading: closed.heading, merged: closed.merged, notes: closed.notes, in_review: marked.in_review, git });

        return 0;
    }

    const lines = [`${marked.path}: ${closed.merged ? 'added the Unreleased notes to' : 'moved the Unreleased notes under'} "## ${closed.heading}" and started a fresh Unreleased section.`];

    if (git.committed) {
        lines.push(`Committed "Release ${name} ${product.version}"${git.tag_created ? ` and tagged ${tag}` : ''}.`);
    } else if (!git.repository) {
        lines.push('Not a git repository, so nothing was committed or tagged.');
    }

    if (marked.in_review) {
        lines.push(`${product.version} shows as in review until the decision.`);
    }

    stdout.write(`${lines.join('\n')}\n`);

    for (const note of notes) {
        stderr.write(`note: ${note}\n`);
    }

    return 0;
}

/**
 * Mark the version in review in the recorded remote state: the fresh
 * state from a sync link when given, otherwise the recorded draft marked
 * as submitted. Returns the product folder (unchanged unless a first
 * sync renamed it) and whether the version now shows as in review.
 *
 * @param {import('../workspace.js').Workspace} workspace
 * @param {import('../workspace.js').Product} product
 * @param {{payload: Record<string, any>, feedback: unknown}|null} fresh
 * @param {string[]} notes
 * @returns {{directory: string|string[], path: string, slug: string|null, in_review: boolean}}
 */
function markInReview(workspace, product, fresh, notes) {
    if (fresh !== null) {
        const recorded = recordProductState({ workspace, product, payload: fresh.payload, feedback: fresh.feedback, kind: 'none' });
        const inReview = recorded.remote.draft?.submitted === true;

        notes.push(...recorded.notes);

        if (!inReview) {
            notes.push(`${product.version} is already released on the marketplace.`);
        }

        return { directory: recorded.renamed ? [product.directory, recorded.directory] : recorded.directory, path: recorded.path, slug: recorded.slug, in_review: inReview };
    }

    const remote = product.manifest.remote;

    if (remote === null || remote.draft === null || remote.draft === undefined) {
        notes.push(`No draft is recorded for ${product.path}, so it is not marked in review. Record it with npx @rafflex/dev synced ${product.slug ?? product.path} "<sync_url>".`);

        return { directory: product.directory, path: product.path, slug: product.slug, in_review: false };
    }

    writeProductJson(product.directory, { ...product.manifest, remote: { ...remote, draft: { ...remote.draft, submitted: true } } });

    return { directory: product.directory, path: product.path, slug: product.slug, in_review: true };
}
