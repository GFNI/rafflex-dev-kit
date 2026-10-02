import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsDirectoryName, configFilename, templateFilename } from '../project.js';
import { loadDocuments, resolveBaseUrl, RulesUnavailableError } from '../remote.js';

const gitignoreContents = `# Cached marketplace rules (rafflex-dev)
.rafflex/
`;

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
 * `init`: scaffold rafflex.json, the starter template for the type (from
 * the marketplace's skeletons), assets/, and a .gitignore for the cache.
 * Existing files are never overwritten.
 *
 * @param {{cwd: string, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream, options: import('../cli.js').CliOptions}} context
 * @returns {Promise<number>}
 */
export async function runInitCommand({ cwd, stdout, stderr, options }) {
    const configPath = join(cwd, configFilename);
    /** @type {any} */
    let existingConfig = null;

    if (existsSync(configPath)) {
        try {
            existingConfig = JSON.parse(readFileSync(configPath, 'utf8'));
        } catch {
            stderr.write(`${configFilename} exists but is not valid JSON; fix or remove it, then run init again.\n`);

            return 1;
        }
    }

    const type = existingConfig?.type ?? options.type ?? 'game';

    if (existingConfig !== null && options.type !== undefined && options.type !== existingConfig.type) {
        stderr.write(`${configFilename} already says this is a ${existingConfig.type}; keeping it. Edit ${configFilename} to change the type.\n`);
    }

    const lines = [];
    const record = (/** @type {boolean} */ written, /** @type {string} */ name) => {
        lines.push(`${written ? 'created' : 'kept   '} ${name}`);
    };

    record(writeIfMissing(configPath, `${JSON.stringify({ type, product: null }, null, 2)}\n`), configFilename);

    let failed = false;
    const templatePath = join(cwd, templateFilename);

    if (existsSync(templatePath)) {
        record(false, templateFilename);
    } else {
        try {
            const loaded = await loadDocuments({ projectDirectory: cwd, baseUrl: resolveBaseUrl(existingConfig), names: ['skeletons'] });
            const skeleton = loaded.documents.skeletons?.[type];

            for (const warning of loaded.warnings) {
                stderr.write(`${warning}\n`);
            }

            if (typeof skeleton !== 'string') {
                throw new RulesUnavailableError(`The marketplace's skeletons.json has no ${type} starter template.`);
            }

            record(writeIfMissing(templatePath, skeleton), templateFilename);
        } catch (error) {
            failed = true;
            stderr.write(`Could not create ${templateFilename}: ${/** @type {Error} */ (error).message}\n`);
        }
    }

    const assetsDirectory = join(cwd, assetsDirectoryName);
    const assetsExisted = existsSync(assetsDirectory);

    mkdirSync(assetsDirectory, { recursive: true });

    if (!assetsExisted) {
        writeIfMissing(join(assetsDirectory, '.gitkeep'), '');
    }

    record(!assetsExisted, `${assetsDirectoryName}/`);

    const gitignorePath = join(cwd, '.gitignore');
    const gitignoreWritten = writeIfMissing(gitignorePath, gitignoreContents);

    record(gitignoreWritten, '.gitignore');

    if (!gitignoreWritten && !readFileSync(gitignorePath, 'utf8').split(/\r?\n/).some((line) => /^\/?\.rafflex\/?$/.test(line.trim()))) {
        lines.push('note: add ".rafflex/" to your .gitignore (the kit\'s rules cache)');
    }

    stdout.write(`Rafflex ${type} project in ${cwd}\n${lines.map((line) => `  ${line}`).join('\n')}\n`);

    if (failed) {
        return 1;
    }

    stdout.write('\nNext: run "npx @rafflex/dev" to preview, and "npx @rafflex/dev check" before pushing.\n');

    return 0;
}
