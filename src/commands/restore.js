import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { changesSince, fileAt, gitState, lastPushCommit, recordVerbs, restoreProductFolder } from '../git.js';
import { loadWorkspace, productFilename, selectProduct, writeProductJson } from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

export const restoreTargets = ['last-push'];

/**
 * `restore <product> last-push [--yes]`: undo unpushed work by returning
 * the creator's files (template, options, listing, changelog, assets,
 * listing images) to the last confirmed push, the kit's newest Push,
 * Release, Import, or Revert commit for it. tests/ and .results/ are left
 * alone. Without --yes it only lists what would be discarded (exit 1).
 * Without git, or with no such commit, it says how to restore through
 * export_product and import instead.
 *
 * product.json is never rolled back: it records the marketplace's state,
 * which a later Sync may have moved on (a version now in review). Only
 * its version goes back, and only when it was changed locally since the
 * last recorded state (an unpushed `version` bump).
 *
 * Going back to an earlier shipped version is revert_to_version on the
 * marketplace, never this command.
 *
 * JSON: `{product, target, restored, commit, subject, discarded, version, needs_confirmation, export_fallback}`,
 * `version` being `{from, to}` when the version goes back, else null.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runRestoreCommand(context) {
    const { cwd, stdout, options } = context;
    const [name, target] = options.positionals;
    let workspace;
    let product;

    if (!restoreTargets.includes(target)) {
        return fail(context, `Restore to last-push: npx @rafflex/dev restore ${name} last-push. To go back to an earlier shipped version, use revert_to_version on the marketplace.`, 2);
    }

    try {
        workspace = loadWorkspace(cwd);
        product = selectProduct(workspace, name, cwd);
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    const label = product.slug ?? product.folder;
    const exportFallback = `Read the product with export_product, then run npx @rafflex/dev import "<bundle_url>" --force to replace ${product.path} with the marketplace's copy.`;
    const pushed = gitState(workspace.root).repository ? lastPushCommit(workspace.root, product.directory, label) : null;

    if (pushed === null) {
        const reason = gitState(workspace.root).repository ? `No confirmed push of ${label} is in the git history.` : 'This workspace has no git history.';

        if (options.json) {
            writeJson(stdout, { product: product.path, target, restored: false, commit: null, subject: null, discarded: [], needs_confirmation: false, export_fallback: exportFallback, error: reason });
        } else {
            stdout.write(`${reason} ${exportFallback}\n`);
        }

        return 1;
    }

    const discarded = changesSince(workspace.root, product.directory, pushed.commit, [productFilename]);
    const version = versionToRestore(workspace.root, product.directory, label, pushed.commit);
    const versionLine = version === null ? [] : [`  version ${version.from} (back to ${version.to})`];

    if (discarded.length === 0 && version === null) {
        if (options.json) {
            writeJson(stdout, { product: product.path, target, restored: false, commit: pushed.commit, subject: pushed.subject, discarded, version, needs_confirmation: false, export_fallback: null });
        } else {
            stdout.write(`${product.path} already matches its last push ("${pushed.subject}"). Nothing to restore.\n`);
        }

        return 0;
    }

    if (!options.yes) {
        if (options.json) {
            writeJson(stdout, { product: product.path, target, restored: false, commit: pushed.commit, subject: pushed.subject, discarded, version, needs_confirmation: true, export_fallback: null });
        } else {
            stdout.write(`This discards the unpushed changes to ${product.path} since "${pushed.subject}":\n${[...discarded.map((line) => `  ${line}`), ...versionLine].join('\n')}\nConfirm with the creator, then run: npx @rafflex/dev restore ${label} last-push --yes\n`);
        }

        return 1;
    }

    const restored = restoreProductFolder(workspace.root, product.directory, pushed.commit, [productFilename]);

    if (!restored.ok) {
        return fail(context, `${restored.error}`, 2);
    }

    if (version !== null) {
        const manifest = JSON.parse(readFileSync(join(product.directory, productFilename), 'utf8'));

        writeProductJson(product.directory, { ...manifest, version: version.to });
    }

    if (options.json) {
        writeJson(stdout, { product: product.path, target, restored: true, commit: pushed.commit, subject: pushed.subject, discarded, version, needs_confirmation: false, export_fallback: null });
    } else {
        stdout.write(`Restored ${product.path} to "${pushed.subject}", discarding:\n${[...discarded.map((line) => `  ${line}`), ...versionLine].join('\n')}\n`);
    }

    return 0;
}

/**
 * The version to go back to: product.json's version as the newest kit
 * commit recording the marketplace's state left it (a Sync included),
 * when the folder's version differs from it now. Null when they agree or
 * either cannot be read, so product.json is then left exactly as it is.
 *
 * @param {string} root
 * @param {string} directory
 * @param {string} label
 * @param {string} fallbackCommit The last push, when no newer record exists.
 * @returns {{from: string, to: string}|null}
 */
function versionToRestore(root, directory, label, fallbackCommit) {
    const recorded = lastPushCommit(root, directory, label, recordVerbs)?.commit ?? fallbackCommit;
    const file = join(relative(root, directory), productFilename);

    try {
        const then = JSON.parse(fileAt(root, recorded, file) ?? 'null')?.version;
        const now = JSON.parse(readFileSync(join(directory, productFilename), 'utf8'))?.version;

        return typeof then === 'string' && typeof now === 'string' && then !== now ? { from: now, to: then } : null;
    } catch {
        return null;
    }
}
