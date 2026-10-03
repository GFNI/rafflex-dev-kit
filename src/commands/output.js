/**
 * Output helpers shared by the commands: every command prints prose by
 * default and one JSON document with --json, and reports failure through
 * its exit code.
 */

/**
 * @param {NodeJS.WritableStream} stream
 * @param {unknown} value
 */
export function writeJson(stream, value) {
    stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Report a command that cannot run or was refused: `{error}` as JSON with
 * --json, the message on stderr otherwise.
 *
 * @param {import('../cli.js').CommandContext} context
 * @param {string} message
 * @param {number} [code]
 * @param {Record<string, unknown>} [extra] Extra JSON fields.
 * @returns {number}
 */
export function fail({ stdout, stderr, options }, message, code = 2, extra = {}) {
    if (options.json) {
        writeJson(stdout, { error: message, ...extra });
    } else {
        stderr.write(`${message}\n`);
    }

    return code;
}

/**
 * Report a refusal the way push, synced, and release do: `{error: {code,
 * message, issues?}}` as JSON with --json, the message (and any issue
 * lines) on stderr otherwise.
 *
 * @param {import('../cli.js').CommandContext} context
 * @param {{code: string, message: string, issues?: any[], retry_after_seconds?: number}} error
 * @param {number} exitCode
 * @param {Record<string, unknown>} [extra] Extra JSON fields beside `error`.
 * @param {string[]} [lines] Lines to print under the message without --json.
 * @returns {number}
 */
export function failWithCode({ stdout, stderr, options }, error, exitCode, extra = {}, lines = []) {
    if (options.json) {
        writeJson(stdout, { ...extra, error });
    } else {
        stderr.write(`${[error.message, ...lines].join('\n')}\n`);
    }

    return exitCode;
}

/**
 * @param {unknown} error
 */
export function messageOf(error) {
    return String(/** @type {Error} */ (error)?.message ?? error);
}
