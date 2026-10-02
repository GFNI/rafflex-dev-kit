import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsFilename, agentsHash } from '../agents-md.js';
import { commitAll, isGitInstalled, isInsideRepository, runGit } from '../git.js';
import { loadDocuments, resolveBaseUrl } from '../remote.js';
import { assetTypesFrom, findWorkspaceRoot, WorkspaceFormat, workspaceFilename } from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

export const initialCommitMessage = 'Set up Rafflex workspace';

const gitignoreContents = `# The Rafflex dev kit's rules cache
.rafflex/
`;

/** Used only when the marketplace's skeletons predate the workspace guidance. */
export const fallbackAgentsMarkdown = `# Rafflex workspace

This folder is a Rafflex marketplace workspace: every game and block the creator sells, one folder per product under games/ and blocks/.

Run \`npx @rafflex/dev status\` first, then follow the workspace guide at https://marketplace.rafflex.io/llms.txt and https://marketplace.rafflex.io/docs/dev-kit.md.
`;

export const fallbackClaudeMarkdown = '@AGENTS.md\n';

/**
 * Write a file only when it does not exist yet.
 *
 * @param {string} path
 * @param {string} contents
 * @returns {boolean} Whether it was written.
 */
function writeIfMissing(path, contents) {
    if (existsSync(path)) {
        return false;
    }

    writeFileSync(path, contents, { flag: 'wx' });

    return true;
}

/**
 * Initialise git and commit the scaffold when git is installed and the
 * folder is not already in a repository. A commit that git refuses (no
 * identity configured, a signing failure) leaves the files uncommitted.
 *
 * @param {string} directory
 * @returns {{installed: boolean, initialised: boolean, committed: boolean, note: string|null}}
 */
function setUpGit(directory) {
    if (!isGitInstalled(directory)) {
        return { installed: false, initialised: false, committed: false, note: 'git is not installed, so the workspace has no history. Install git to keep history and roll back.' };
    }

    if (isInsideRepository(directory)) {
        return { installed: true, initialised: false, committed: false, note: 'This folder is already inside a git repository; nothing was committed.' };
    }

    const initialised = runGit(directory, ['init', '-q']);

    if (!initialised.ok) {
        return { installed: true, initialised: false, committed: false, note: `git init failed: ${initialised.stderr}` };
    }

    const commit = commitAll(directory, initialCommitMessage);

    if (!commit.ok) {
        return { installed: true, initialised: true, committed: false, note: `git could not commit the scaffold, so it is left uncommitted: ${commit.error}` };
    }

    return { installed: true, initialised: true, committed: true, note: null };
}

/**
 * `init`: create a workspace in the current folder: rafflex.json, the
 * generated AGENTS.md and CLAUDE.md, a .gitignore for the cache, and an
 * empty folder per asset type; then git init and commit when git is
 * installed. Refused inside an existing workspace (or the retired single
 * project layout). Existing files are never overwritten.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runInitCommand(context) {
    const { cwd, stdout, options } = context;

    try {
        const existing = findWorkspaceRoot(cwd);

        if (existing !== null) {
            return fail(context, `${existing} is already a Rafflex workspace. Run init in a new folder outside it.`, 1);
        }
    } catch (error) {
        return fail(context, messageOf(error), 1);
    }

    /** @type {string[]} */
    const warnings = [];
    /** @type {string[]} */
    const created = [];
    /** @type {string[]} */
    const kept = [];
    const record = (/** @type {boolean} */ written, /** @type {string} */ name) => {
        (written ? created : kept).push(name);
    };

    /** @type {import('../remote.js').LoadedDocuments|null} */
    let loaded = null;

    try {
        loaded = await loadDocuments({ workspaceDirectory: cwd, baseUrl: resolveBaseUrl(null), names: ['skeletons'] });
        warnings.push(...loaded.warnings);
    } catch (error) {
        warnings.push(`Could not read the marketplace's workspace guidance: ${messageOf(error)}`);
    }

    const guidance = loaded?.documents.skeletons?.workspace;
    const agentsMarkdown = typeof guidance?.agents_md === 'string' ? guidance.agents_md : null;
    const claudeMarkdown = typeof guidance?.claude_md === 'string' ? guidance.claude_md : fallbackClaudeMarkdown;
    const agentsContents = agentsMarkdown ?? fallbackAgentsMarkdown;
    // The hash lets status refresh AGENTS.md later, only while it is still the kit's copy.
    const agentsWritten = !existsSync(join(cwd, agentsFilename));
    const workspaceConfig = agentsWritten ? { workspace: WorkspaceFormat, agents_md_sha256: agentsHash(agentsContents) } : { workspace: WorkspaceFormat };

    if (agentsMarkdown === null && loaded !== null) {
        warnings.push('The marketplace did not send the workspace guidance, so AGENTS.md is a short stand in pointing at llms.txt.');
    }

    record(writeIfMissing(join(cwd, workspaceFilename), `${JSON.stringify(workspaceConfig, null, 2)}\n`), workspaceFilename);
    record(writeIfMissing(join(cwd, agentsFilename), agentsContents), agentsFilename);
    record(writeIfMissing(join(cwd, 'CLAUDE.md'), claudeMarkdown), 'CLAUDE.md');

    const gitignorePath = join(cwd, '.gitignore');

    if (writeIfMissing(gitignorePath, gitignoreContents)) {
        record(true, '.gitignore');
    } else if (!readFileSync(gitignorePath, 'utf8').split(/\r?\n/).some((line) => /^\/?\.rafflex\/?$/.test(line.trim()))) {
        const current = readFileSync(gitignorePath, 'utf8');

        writeFileSync(gitignorePath, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${gitignoreContents}`);
        created.push('.gitignore (added .rafflex/)');
    } else {
        record(false, '.gitignore');
    }

    for (const assetType of assetTypesFrom(loaded?.manifest)) {
        const directory = join(cwd, assetType.folder);
        const existed = existsSync(directory);

        mkdirSync(directory, { recursive: true });

        if (!existed) {
            writeIfMissing(join(directory, '.gitkeep'), '');
        }

        record(!existed, `${assetType.folder}/`);
    }

    const git = setUpGit(cwd);

    if (options.json) {
        writeJson(stdout, { workspace: cwd, created, kept, warnings, git });

        return 0;
    }

    const lines = [
        `Rafflex workspace in ${cwd}`,
        ...created.map((name) => `  created ${name}`),
        ...kept.map((name) => `  kept    ${name}`),
        ...warnings.map((warning) => `note: ${warning}`),
    ];

    if (git.committed) {
        lines.push(`git: initialised and committed "${initialCommitMessage}".`);
    } else if (git.note !== null) {
        lines.push(`git: ${git.note}`);
    }

    lines.push('', 'Next: npx @rafflex/dev new game "<title>" to start a product, then npx @rafflex/dev status.');
    stdout.write(`${lines.join('\n')}\n`);

    return 0;
}
