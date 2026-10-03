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
        summary: 'Start the Rafflex app on this workspace (outside one, set one up in a new rafflex folder first).',
        json: true,
        positionals: { min: 0, max: 1 },
    },
    {
        name: 'format',
        usage: 'npx @rafflex/dev format [<product>...|--all]',
        summary: 'Format templates in the house style. Twig is never touched. --check reports without writing.',
        json: true,
        positionals: { min: 0, max: Number.POSITIVE_INFINITY },
    },
    {
        name: 'check',
        usage: 'npx @rafflex/dev check [<product>...|--all]',
        summary: "Check products against the platform's rules, the lint warnings, and the house style: the product you are in, the ones named, or all of them.",
        json: true,
        positionals: { min: 0, max: Number.POSITIVE_INFINITY },
    },
    {
        name: 'test',
        usage: 'npx @rafflex/dev test [<product>...|--all]',
        summary: 'Render every scenario in headless Chromium, play games through, and run the specs in tests/. Needs Playwright: test --install.',
        json: true,
        positionals: { min: 0, max: Number.POSITIVE_INFINITY },
    },
    {
        name: 'capture',
        usage: 'npx @rafflex/dev capture <product>',
        summary: "Write a cover image and screenshots into the product's listing/ folder from the preview when it has none. Never overwrites without --force. Needs Playwright.",
        json: true,
        positionals: { min: 0, max: 1 },
    },
    {
        name: 'verify',
        usage: 'npx @rafflex/dev verify [<product>...|--all]',
        summary: 'format, then check, then test when Playwright is installed. Run it before every push.',
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
        summary: 'Run verify, then print what to push for a product, as data, for your AI to carry out.',
        json: true,
        positionals: { min: 0, max: 1 },
    },
    {
        name: 'push',
        usage: 'npx @rafflex/dev push <product> <sync_url>',
        summary: 'Verify, then push only what changed (and create the product the first time) through a sync link from request_sync, and record the result.',
        json: true,
        positionals: { min: 0, max: 2 },
    },
    {
        name: 'synced',
        usage: 'npx @rafflex/dev synced <product> [<sync_url>]',
        summary: "Record the product's marketplace state and feedback from a sync link, or a get_product result read from standard input.",
        json: true,
        positionals: { min: 0, max: 2 },
    },
    {
        name: 'release',
        usage: 'npx @rafflex/dev release <product> [<sync_url>]',
        summary: 'After submitting for review: close the Unreleased changelog section, tag the version, and mark it in review.',
        json: true,
        positionals: { min: 0, max: 2 },
    },
    {
        name: 'version',
        usage: 'npx @rafflex/dev version <product> <patch|minor|major|x.y.z>',
        summary: 'Set the version being worked on. Refused while it is in review.',
        json: true,
        positionals: { min: 1, max: 2 },
    },
    {
        name: 'restore',
        usage: 'npx @rafflex/dev restore <product> last-push',
        summary: 'Discard unpushed work: return a product folder to its last confirmed push (confirm with --yes).',
        json: true,
        positionals: { min: 2, max: 2 },
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
