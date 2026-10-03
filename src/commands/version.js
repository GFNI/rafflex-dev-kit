import { bumpVersion, compareVersions, isVersion } from '../semver.js';
import { loadWorkspace, selectProduct, writeProductJson } from '../workspace.js';
import { fail, messageOf, writeJson } from './output.js';

const bumps = ['patch', 'minor', 'major'];

/**
 * `version [<product>] <patch|minor|major|x.y.z>`: set the version being
 * worked on, bumping from product.json's version or to an explicit one.
 * Refused while the product's draft is in review (the last synced draft
 * was submitted) and below or at the live version.
 *
 * JSON: `{product, previous_version, version}`.
 *
 * @param {import('../cli.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function runVersionCommand(context) {
    const { cwd, stdout, options } = context;
    const [name, target] = options.positionals.length === 2 ? options.positionals : [undefined, options.positionals[0]];

    if (!bumps.includes(target) && !isVersion(target)) {
        return fail(context, `"${target}" is not patch, minor, major, or a major.minor.patch version such as 1.4.0.`, 2);
    }

    let product;

    try {
        product = selectProduct(loadWorkspace(cwd), name, cwd);
    } catch (error) {
        return fail(context, messageOf(error), 2);
    }

    const remote = product.manifest.remote;

    if (remote?.draft?.submitted === true) {
        return fail(context, `${product.title} ${remote.draft.version ?? product.version} is in review. Wait for the decision: changes requested or rejected keeps the version, and a new version starts after it is published.`, 1);
    }

    if (!isVersion(product.version) && bumps.includes(target)) {
        return fail(context, `${product.path}/product.json has version "${product.version}", which cannot be bumped. Set one explicitly, such as 1.0.0.`, 1);
    }

    const next = bumps.includes(target) ? bumpVersion(product.version, /** @type {'major'|'minor'|'patch'} */ (target)) : target;
    const live = remote?.live_version ?? null;

    if (typeof live === 'string' && isVersion(live) && compareVersions(next, live) <= 0) {
        return fail(context, `${next} is not higher than the live version ${live}. Choose a higher version.`, 1);
    }

    writeProductJson(product.directory, { ...product.manifest, version: next });

    if (options.json) {
        writeJson(stdout, { product: product.path, previous_version: product.version, version: next });
    } else {
        stdout.write(`${product.path}: version ${product.version} -> ${next}\n`);
    }

    return 0;
}
