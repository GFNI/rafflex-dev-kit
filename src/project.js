import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const configFilename = 'rafflex.json';
export const templateFilename = 'template.twig';
export const assetsDirectoryName = 'assets';

/**
 * @typedef {{type: 'game'|'block', product: string|null, base_url?: string|null}} ProjectConfig
 * @typedef {{directory: string, config: ProjectConfig, templatePath: string, assetsDirectory: string}} Project
 */

export class ProjectError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'ProjectError';
    }
}

/**
 * The project folder: the nearest directory at or above `start` holding a
 * rafflex.json.
 *
 * @param {string} start
 * @returns {string|null}
 */
export function findProjectDirectory(start) {
    let directory = resolve(start);

    while (true) {
        if (existsSync(join(directory, configFilename))) {
            return directory;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return null;
        }

        directory = parent;
    }
}

/**
 * @param {string} start
 * @returns {Project}
 */
export function loadProject(start) {
    const directory = findProjectDirectory(start);

    if (directory === null) {
        throw new ProjectError(`No ${configFilename} here or in any parent folder. Run "npx @rafflex/dev init" to set up a project.`);
    }

    /** @type {any} */
    let config;

    try {
        config = JSON.parse(readFileSync(join(directory, configFilename), 'utf8'));
    } catch (error) {
        throw new ProjectError(`${configFilename} is not valid JSON: ${/** @type {Error} */ (error).message}`);
    }

    if (config?.type !== 'game' && config?.type !== 'block') {
        throw new ProjectError(`${configFilename} must set "type" to "game" or "block".`);
    }

    return {
        directory,
        config: { type: config.type, product: config.product ?? null, base_url: config.base_url ?? null },
        templatePath: join(directory, templateFilename),
        assetsDirectory: join(directory, assetsDirectoryName),
    };
}

/**
 * @param {Project} project
 */
export function readTemplate(project) {
    try {
        return readFileSync(project.templatePath, 'utf8');
    } catch {
        throw new ProjectError(`${templateFilename} is missing. Run "npx @rafflex/dev init" to restore the starter template.`);
    }
}
