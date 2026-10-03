import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { closeUnreleased, localDate, unreleasedNotes } from '../src/commands/release.js';
import { isolatedGitEnv, runJson } from './helpers/cli.js';
import { temporaryWorkspace } from './helpers/project.js';

const today = localDate();

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } }).trim();
}

/**
 * @param {string} root
 */
function initRepository(root) {
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'Scaffold']);
}

describe('closing the Unreleased section', () => {
    const changelog = '# Changelog\n\n## Unreleased\n\nAdds a blue wheel.\n\nFixes the timer.\n\n## 1.2.0 (2026-09-01)\n\nFaster spins.\n';

    test('moves the notes under the version with the submission date and starts a fresh Unreleased', () => {
        const closed = closeUnreleased(changelog, '1.3.0', '2026-10-02');

        assert.equal(closed.text, '# Changelog\n\n## Unreleased\n\n## 1.3.0 (submitted 2026-10-02)\n\nAdds a blue wheel.\n\nFixes the timer.\n\n## 1.2.0 (2026-09-01)\n\nFaster spins.\n');
        assert.equal(closed.merged, false);
        assert.equal(closed.notes, 'Adds a blue wheel.\n\nFixes the timer.');
        assert.equal(unreleasedNotes(closed.text), null);
    });

    test('adds to the section of a version submitted again instead of a second heading', () => {
        const first = closeUnreleased(changelog, '1.3.0', '2026-10-02').text;
        const second = closeUnreleased(first.replace('## Unreleased\n', '## Unreleased\n\nAnswers the review: labels the button.\n'), '1.3.0', '2026-10-05');

        assert.equal(second.merged, true);
        assert.equal(second.text, '# Changelog\n\n## Unreleased\n\n## 1.3.0 (submitted 2026-10-05)\n\nAdds a blue wheel.\n\nFixes the timer.\n\nAnswers the review: labels the button.\n\n## 1.2.0 (2026-09-01)\n\nFaster spins.\n');
    });

    test('refuses an empty or missing Unreleased section', () => {
        assert.throws(() => closeUnreleased('# Changelog\n\n## Unreleased\n\n## 1.0.0 (2026-06-01)\n\nFirst.\n', '1.1.0', today), /no notes under "## Unreleased"/);
        assert.throws(() => closeUnreleased('# Changelog\n', '1.1.0', today), /no notes/);
    });

    test('reads the Unreleased notes for plan', () => {
        assert.equal(unreleasedNotes(changelog), 'Adds a blue wheel.\n\nFixes the timer.');
        assert.equal(unreleasedNotes('# Changelog\n\n## Unreleased\n\n\n'), null);
    });
});

describe('release', () => {
    test('commits only the product folder and tags slug@version', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win', version: '1.3.0', changelog: '# Changelog\n\n## Unreleased\n\nAdds a blue wheel.\n' }, { title: 'Other' }] });

        initRepository(root);
        writeFileSync(join(root, 'games', 'other', 'template.twig'), '<p>work in progress</p>\n');

        const { code, output } = await runJson(['release', 'spin-to-win'], { cwd: root });

        assert.equal(code, 0, JSON.stringify(output));
        assert.equal(output.heading, `1.3.0 (submitted ${today})`);
        assert.equal(output.merged, false);
        assert.deepEqual({ ...output.git, commit: undefined }, { repository: true, committed: true, commit: undefined, tag: 'spin-to-win@1.3.0', tag_created: true, tag_existed: false, error: null });
        assert.equal(readFileSync(join(root, 'games', 'spin-to-win', 'CHANGELOG.md'), 'utf8'), `# Changelog\n\n## Unreleased\n\n## 1.3.0 (submitted ${today})\n\nAdds a blue wheel.\n`);
        assert.equal(git(root, ['log', '-1', '--format=%s']), 'Release spin-to-win 1.3.0');
        assert.equal(git(root, ['rev-parse', 'spin-to-win@1.3.0']), output.git.commit);
        assert.equal(git(root, ['status', '--porcelain']), 'M games/other/template.twig');
    });

    test('a resubmitted version merges its notes and leaves the existing tag where it is', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win', version: '1.3.0', changelog: '# Changelog\n\n## Unreleased\n\nAdds a blue wheel.\n' }] });
        const changelogPath = join(root, 'games', 'spin-to-win', 'CHANGELOG.md');

        initRepository(root);

        const first = await runJson(['release', 'spin-to-win'], { cwd: root });

        writeFileSync(changelogPath, readFileSync(changelogPath, 'utf8').replace('## Unreleased\n', '## Unreleased\n\nLabels the button.\n'));

        const second = await runJson(['release', 'spin-to-win'], { cwd: root });

        assert.equal(second.code, 0);
        assert.equal(second.output.merged, true);
        assert.equal(second.output.git.committed, true);
        assert.equal(second.output.git.tag_existed, true);
        assert.equal(second.output.git.tag_created, false);
        assert.equal(git(root, ['rev-parse', 'spin-to-win@1.3.0']), first.output.git.commit);
        assert.equal(readFileSync(changelogPath, 'utf8').match(/## 1\.3\.0/g)?.length, 1);
    });

    test('refuses an empty Unreleased section and changes nothing', async () => {
        const changelog = '# Changelog\n\n## Unreleased\n';
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win', changelog }] });
        const { code, output } = await runJson(['release', 'spin-to-win'], { cwd: root });

        assert.equal(code, 1);
        assert.equal(output.error.code, 'no_notes');
        assert.match(output.error.message, /no notes under "## Unreleased"/);
        assert.equal(readFileSync(join(root, 'games', 'spin-to-win', 'CHANGELOG.md'), 'utf8'), changelog);
    });

    test('without git, or without a slug, it closes the section and skips the commit or tag', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Lucky Dip', changelog: '# Changelog\n\n## Unreleased\n\nFirst release.\n' }] });
        const { code, output } = await runJson(['release', 'lucky-dip'], { cwd: root, env: { GIT_CEILING_DIRECTORIES: dirname(root) } });

        assert.equal(code, 0);
        assert.equal(output.git.repository, false);
        assert.equal(output.git.committed, false);
        assert.equal(output.git.tag, null);
        assert.match(readFileSync(join(root, 'games', 'lucky-dip', 'CHANGELOG.md'), 'utf8'), /## 1\.0\.0 \(submitted/);
    });
});
