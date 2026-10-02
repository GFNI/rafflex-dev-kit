import { runCheckCommand } from './commands/check.js';
import { runDevCommand } from './commands/dev.js';
import { runInitCommand } from './commands/init.js';
import { kitVersion } from './version.js';

export const usage = `rafflex-dev ${kitVersion}: build and check Rafflex games and blocks locally.

Usage
  npx @rafflex/dev init [--type game|block]   Set up a project in this folder
  npx @rafflex/dev [--port N] [--no-open]     Preview the template with live reload
  npx @rafflex/dev check [--json] [--play-count N] [--verbose]
                                              Check every scenario against the platform's rules

Options
  --type game|block   Project type for init (default game)
  --json              Print the check result as JSON: {passed, issues, warnings, note}
  --play-count N      Plays per scenario when rendering (default from the rules)
  --port N            Preferred preview port (default 5173, the next free one if taken)
  --no-open           Do not open the browser
  --verbose           Also list rules the kit cannot apply locally
  -h, --help          Show this help
  -v, --version       Show the version

Environment
  RAFFLEX_BASE_URL     Marketplace to read rules from (default https://marketplace.rafflex.io)
  NODE_EXTRA_CA_CERTS  Extra certificate authorities, for a local marketplace or a proxy

The kit only downloads the marketplace's public rules. It never signs in or uploads.
Docs: https://marketplace.rafflex.io/docs/dev-kit.md`;

/**
 * @typedef {{command: string, type?: string, json: boolean, playCount?: number, port?: number, open: boolean, verbose: boolean, help: boolean, version: boolean}} CliOptions
 */

export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseArguments(argv) {
    /** @type {CliOptions} */
    const options = { command: 'dev', json: false, open: true, verbose: false, help: false, version: false };
    const positional = [];

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const [flag, inlineValue] = argument.startsWith('--') ? argument.split(/=(.*)/s, 2) : [argument, undefined];
        const value = () => {
            const next = inlineValue ?? argv[++index];

            if (next === undefined) {
                throw new UsageError(`${flag} needs a value.`);
            }

            return next;
        };
        const integer = () => {
            const parsed = Number(value());

            if (!Number.isInteger(parsed) || parsed < 0) {
                throw new UsageError(`${flag} needs a whole number.`);
            }

            return parsed;
        };

        switch (flag) {
            case '-h':
            case '--help':
                options.help = true;
                break;
            case '-v':
            case '--version':
                options.version = true;
                break;
            case '--json':
                options.json = true;
                break;
            case '--no-open':
                options.open = false;
                break;
            case '--verbose':
                options.verbose = true;
                break;
            case '--type':
                options.type = value();
                break;
            case '--play-count':
                options.playCount = integer();
                break;
            case '--port':
                options.port = integer();
                break;
            default:
                if (argument.startsWith('-')) {
                    throw new UsageError(`Unknown option ${argument}.`);
                }

                positional.push(argument);
        }
    }

    if (positional.length > 1) {
        throw new UsageError(`Expected one command, got ${positional.join(' ')}.`);
    }

    if (positional.length === 1) {
        if (!['init', 'check', 'dev'].includes(positional[0])) {
            throw new UsageError(`Unknown command ${positional[0]}.`);
        }

        options.command = positional[0];
    }

    if (options.type !== undefined && options.type !== 'game' && options.type !== 'block') {
        throw new UsageError('--type must be game or block.');
    }

    return options;
}

/**
 * Run the CLI and return the exit code: 0 on success, 1 when check finds a
 * blocking issue (or a command fails), 2 for usage errors.
 *
 * @param {string[]} argv
 * @param {{cwd?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
    const cwd = io.cwd ?? process.cwd();
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;

    /** @type {CliOptions} */
    let options;

    try {
        options = parseArguments(argv);
    } catch (error) {
        stderr.write(`${/** @type {Error} */ (error).message}\n\n${usage}\n`);

        return 2;
    }

    if (options.help) {
        stdout.write(`${usage}\n`);

        return 0;
    }

    if (options.version) {
        stdout.write(`${kitVersion}\n`);

        return 0;
    }

    const context = { cwd, stdout, stderr, options };

    switch (options.command) {
        case 'init':
            return runInitCommand(context);
        case 'check':
            return runCheckCommand(context);
        default:
            return runDevCommand(context);
    }
}
