/**
 * The kit's commands as the platform documents them (the manifest's
 * `commands`, from the marketplace's DevKitCommand enum). The CLI parses
 * and lists exactly these; a parity test compares the names and usage
 * strings with the published manifest.
 *
 * `positionals` is the kit's own arity check and is not published.
 *
 * @typedef {{name: string, usage: string, summary: string, json: true, positionals: {min: number, max: number}}} DevKitCommand
 */

/** @type {DevKitCommand[]} */
export const devKitCommands = [
    {
        name: 'init',
        usage: 'npx @rafflex/dev init',
        summary: 'Create a workspace in this folder (refused inside an existing one).',
        json: true,
        positionals: { min: 0, max: 0 },
    },
    {
        name: 'new',
        usage: 'npx @rafflex/dev new <game|block> "<title>"',
        summary: "Add a product folder from the type's starter template, at version 1.0.0.",
        json: true,
        positionals: { min: 1, max: 2 },
    },
    {
        name: 'import',
        usage: 'npx @rafflex/dev import <bundle>',
        summary: 'Unpack a product export bundle into its type folder, or refresh an existing one.',
        json: true,
        positionals: { min: 1, max: 1 },
    },
    {
        name: 'dev',
        usage: 'npx @rafflex/dev',
        summary: 'Preview the products in this workspace with live reload.',
        json: true,
        positionals: { min: 0, max: 1 },
    },
    {
        name: 'check',
        usage: 'npx @rafflex/dev check [<product>...|--all]',
        summary: "Check products against the platform's rules: the product you are in, the ones named, or all of them.",
        json: true,
        positionals: { min: 0, max: Number.POSITIVE_INFINITY },
    },
    {
        name: 'status',
        usage: 'npx @rafflex/dev status [<product>]',
        summary: 'Show versions, remote state, and what changed locally since the last sync. Works offline.',
        json: true,
        positionals: { min: 0, max: 1 },
    },
    {
        name: 'plan',
        usage: 'npx @rafflex/dev plan <product>',
        summary: 'Print what to push for a product, as data, for your AI to carry out.',
        json: true,
        positionals: { min: 0, max: 1 },
    },
    {
        name: 'synced',
        usage: 'npx @rafflex/dev synced <product>',
        summary: "Record a get_product result read from standard input as the product's remote state.",
        json: true,
        positionals: { min: 0, max: 1 },
    },
    {
        name: 'release',
        usage: 'npx @rafflex/dev release <product>',
        summary: 'After submitting for review: close the Unreleased changelog section and tag the version.',
        json: true,
        positionals: { min: 0, max: 1 },
    },
    {
        name: 'version',
        usage: 'npx @rafflex/dev version <product> <patch|minor|major|x.y.z>',
        summary: 'Set the version being worked on. Refused while it is in review.',
        json: true,
        positionals: { min: 1, max: 2 },
    },
];

/**
 * The command list in the manifest's shape: `{name, usage, summary, json}`.
 *
 * @returns {{name: string, usage: string, summary: string, json: true}[]}
 */
export function publishedCommands() {
    return devKitCommands.map(({ name, usage, summary, json }) => ({ name, usage, summary, json }));
}

/**
 * @param {string} name
 * @returns {DevKitCommand|undefined}
 */
export function commandNamed(name) {
    return devKitCommands.find((command) => command.name === name);
}
