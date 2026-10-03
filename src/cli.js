import { commandNamed, devKitCommands } from './command-list.js';
import { runCaptureCommand } from './commands/capture.js';
import { runCheckCommand } from './commands/check.js';
import { runDevCommand } from './commands/dev.js';
import { runFormatCommand } from './commands/format.js';
import { runInitCommand } from './commands/init.js';
import { runImportCommand } from './commands/import.js';
import { runNewCommand } from './commands/new.js';
import { fail } from './commands/output.js';
import { runPlanCommand } from './commands/plan.js';
import { runReleaseCommand } from './commands/release.js';
import { runRestoreCommand } from './commands/restore.js';
import { runStatusCommand } from './commands/status.js';
import { runSyncedCommand } from './commands/synced.js';
import { runTestCommand } from './commands/test.js';
import { runVerifyCommand } from './commands/verify.js';
import { runVersionCommand } from './commands/version.js';
import { kitVersion } from './version.js';

/**
 * @param {import('./command-list.js').DevKitCommand} command
 */
function usageLine(command) {
    return `  ${command.usage}\n      ${command.summary}`;
}

export const usage = `rafflex-dev ${kitVersion}: build, check, and track your Rafflex games and blocks in one workspace.

Usage
${devKitCommands.map(usageLine).join('\n')}

A <product> is its slug, its folder name, or its path (games/spin-to-win). Inside a
product folder it defaults to that product.

Options
  --json              Print the result as JSON (every command)
  --all               format, check, test, verify: every product in the workspace
  --check             format: report templates to format without writing
  --install           test: install Playwright and Chromium into .rafflex/ (large, ask first)
  --yes               restore: confirm discarding the unpushed changes
  --play-count N      check: plays per scenario when rendering (default from the rules)
  --verbose           check: also list rules the kit cannot apply locally
  --type game|block   new: the product type, instead of the first argument
  --force             import: replace an existing product folder; capture: replace the listing images
  --port N            Preferred app port (default 5173, the next free one if taken)
  --no-open           Do not open the browser
  -h, --help          Show this help
  -v, --version       Show the kit's version

Exit codes: 0 success, 1 a check found blocking problems or a command was refused, 2 usage
errors or a command that cannot run.

Environment
  NODE_EXTRA_CA_CERTS  The certificate authority of a corporate proxy that inspects HTTPS

The kit only downloads the marketplace's public rules and the bundles you import. It never signs in or uploads.
Docs: https://marketplace.rafflex.io/docs/dev-kit.md`;

/**
 * @typedef {object} CliOptions
 * @property {string} command          One of the names in command-list.js; "dev" when none is given.
 * @property {string[]} positionals    Arguments after the command.
 * @property {boolean} all
 * @property {boolean} json
 * @property {string} [type]
 * @property {number} [playCount]
 * @property {number} [port]
 * @property {boolean} open
 * @property {boolean} verbose
 * @property {boolean} force
 * @property {boolean} check
 * @property {boolean} install
 * @property {boolean} yes
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * @typedef {object} CommandContext
 * @property {string} cwd
 * @property {NodeJS.WritableStream} stdout
 * @property {NodeJS.WritableStream} stderr
 * @property {NodeJS.ReadableStream} stdin   For commands that read a payload (synced).
 * @property {CliOptions} options
 */

export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseArguments(argv) {
    /** @type {CliOptions} */
    const options = { command: 'dev', positionals: [], all: false, json: false, open: true, verbose: false, force: false, check: false, install: false, yes: false, help: false, version: false };
    /** @type {string[]} */
    const positional = [];
    let onlyPositionals = false;

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];

        if (onlyPositionals) {
            positional.push(argument);
            continue;
        }

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
            case '--':
                onlyPositionals = true;
                break;
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
            case '--all':
                options.all = true;
                break;
            case '--no-open':
                options.open = false;
                break;
            case '--verbose':
                options.verbose = true;
                break;
            case '--force':
                options.force = true;
                break;
            case '--check':
                options.check = true;
                break;
            case '--install':
                options.install = true;
                break;
            case '--yes':
                options.yes = true;
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
                if (argument.startsWith('-') && argument !== '-') {
                    throw new UsageError(`Unknown option ${argument}.`);
                }

                positional.push(argument);
        }
    }

    if (positional.length > 0) {
        const command = commandNamed(positional[0]);

        if (command === undefined) {
            throw new UsageError(`Unknown command ${positional[0]}.`);
        }

        options.command = command.name;
        options.positionals = positional.slice(1);
    }

    const { positionals: { min, max }, usage: usageText } = /** @type {import('./command-list.js').DevKitCommand} */ (commandNamed(options.command));

    if (!options.help && !options.version) {
        if (options.positionals.length > max) {
            throw new UsageError(`Too many arguments for ${options.command}: ${options.positionals.join(' ')}. Usage: ${usageText}`);
        }

        if (options.positionals.length < min) {
            throw new UsageError(`Missing arguments for ${options.command}. Usage: ${usageText}`);
        }

        if (options.all && !['format', 'check', 'test', 'verify'].includes(options.command)) {
            throw new UsageError('--all only applies to format, check, test, and verify.');
        }

        if (options.check && options.command !== 'format') {
            throw new UsageError('--check only applies to format.');
        }

        if (options.install && options.command !== 'test') {
            throw new UsageError('--install only applies to test.');
        }

        if (options.yes && options.command !== 'restore') {
            throw new UsageError('--yes only applies to restore.');
        }

        if (options.force && !['import', 'capture'].includes(options.command)) {
            throw new UsageError('--force only applies to import and capture.');
        }

        if (options.type !== undefined && options.command !== 'new') {
            throw new UsageError('--type only applies to new.');
        }
    }

    return options;
}

/**
 * Read a readable stream to the end as UTF-8, for commands that take a
 * payload on standard input (synced reads a get_product result).
 *
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export async function readAll(stream) {
    let text = '';

    stream.setEncoding?.('utf8');

    for await (const chunk of stream) {
        text += chunk;
    }

    return text;
}

/**
 * Run the CLI and return the exit code: 0 on success, 1 when check finds a
 * blocking issue or a command is refused, 2 for usage errors and commands
 * that cannot run. Returns null when a long running command (the preview)
 * keeps the process alive.
 *
 * @param {string[]} argv
 * @param {{cwd?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, stdin?: NodeJS.ReadableStream}} [io]
 * @returns {Promise<number|null>}
 */
export async function main(argv, io = {}) {
    const cwd = io.cwd ?? process.cwd();
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    const stdin = io.stdin ?? process.stdin;

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

    /** @type {CommandContext} */
    const context = { cwd, stdout, stderr, stdin, options };

    switch (options.command) {
        case 'init':
            return runInitCommand(context);
        case 'new':
            return runNewCommand(context);
        case 'format':
            return runFormatCommand(context);
        case 'check':
            return runCheckCommand(context);
        case 'test':
            return runTestCommand(context);
        case 'capture':
            return runCaptureCommand(context);
        case 'verify':
            return runVerifyCommand(context);
        case 'restore':
            return runRestoreCommand(context);
        case 'status':
            return runStatusCommand(context);
        case 'version':
            return runVersionCommand(context);
        case 'dev':
            return runDevCommand(context);
        case 'import':
            return runImportCommand(context);
        case 'plan':
            return runPlanCommand(context);
        case 'synced':
            return runSyncedCommand(context);
        case 'release':
            return runReleaseCommand(context);
        default:
            return fail(context, `Unknown command ${options.command}.`, 2);
    }
}
