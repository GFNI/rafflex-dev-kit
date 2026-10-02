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
 * @param {unknown} error
 */
export function messageOf(error) {
    return String(/** @type {Error} */ (error)?.message ?? error);
}
