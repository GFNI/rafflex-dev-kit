import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from '../assets.js';
import { formatListing } from '../listing.js';
import { loadDocuments, RulesUnavailableError } from '../remote.js';
import {
    assetsDirectoryName,
    assetTypeNamed,
    changelogFilename,
    listingFilename,
    loadWorkspace,
    optionsFilename,
    productFilename,
    templateFilename,
    withManifest,
    writeProductJson,
} from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

/** The platform's starting version for a new product. */
export const initialVersion = '1.0.0';

export const initialChangelog = '# Changelog\n\n## Unreleased\n';

/**
 * `new <type> "<title>"`: add a product folder named after the slugified
 * title under the type's folder, from the type's starter template, at
 * version 1.0.0 and not yet on the marketplace (`slug: null`). Refuses a
 * folder that already exists.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runNewCommand(context) {
    const { cwd, stdout, stderr, options } = context;
    const [first, second] = options.positionals;
    const [typeName, title] = options.type !== undefined ? [options.type, first.trim()] : [first, (second ?? '').trim()];

    if (title === '' || (options.type !== undefined && second !== undefined)) {
        return fail(context, 'Usage: npx @rafflex/dev new <game|block> "<title>"', 2);
    }

    let workspace;
    let loaded;

    try {
        workspace = loadWorkspace(cwd);
        loaded = await loadDocuments({ workspaceDirectory: workspace.root, baseUrl: workspace.baseUrl, names: ['skeletons'] });
        workspace = withManifest(workspace, loaded.manifest);
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    const assetType = assetTypeNamed(workspace, typeName);

    if (assetType === undefined) {
        return fail(context, `Unknown product type "${typeName}". Use ${workspace.assetTypes.map((type) => type.value).join(' or ')}.`, 2);
    }

    const folder = slugify(title);

    if (folder === '') {
        return fail(context, `"${title}" has no letters or numbers to name a folder after. Choose another title.`, 2);
    }

    const directory = join(workspace.root, assetType.folder, folder);
    const path = `${assetType.folder}/${folder}`;

    if (existsSync(directory)) {
        return fail(context, `${path} already exists. Choose another title, or work on that product.`, 1);
    }

    const skeleton = loaded.documents.skeletons?.[assetType.value];

    if (typeof skeleton !== 'string') {
        return fail(context, new RulesUnavailableError(`The marketplace's skeletons.json has no ${assetType.value} starter template.`).message, 2);
    }

    mkdirSync(join(directory, assetsDirectoryName), { recursive: true });
    writeProductJson(directory, { type: assetType.value, slug: null, title, version: initialVersion, remote: null });
    writeFileSync(join(directory, templateFilename), skeleton);
    writeFileSync(join(directory, optionsFilename), '{}\n');
    writeFileSync(join(directory, listingFilename), formatListing());
    writeFileSync(join(directory, changelogFilename), initialChangelog);
    writeFileSync(join(directory, assetsDirectoryName, '.gitkeep'), '');

    const files = [productFilename, templateFilename, optionsFilename, listingFilename, changelogFilename, `${assetsDirectoryName}/`];

    if (options.json) {
        writeJson(stdout, { product: path, type: assetType.value, title, slug: null, version: initialVersion, directory, files, warnings: loaded.warnings });

        return 0;
    }

    for (const warning of loaded.warnings) {
        stderr.write(`note: ${warning}\n`);
    }

    stdout.write(`Created ${path} (${assetType.label.toLowerCase()} "${title}", version ${initialVersion})\n${files.map((file) => `  ${path}/${file}`).join('\n')}\n\nNext: cd ${path} && npx @rafflex/dev to preview it.\n`);

    return 0;
}
