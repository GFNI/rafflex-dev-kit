// Opening a prompt in the creator's AI app. The marketplace lists the apps
// that take a prompt from a link (prompts.json `openers`); the kit marks
// which are ready on this computer. Every app fills its prompt box and
// waits for the creator to press Enter, so a link never runs anything on
// its own. Copy and the terminal commands are the fallbacks for an app the
// kit cannot open, a prompt too long for a link, or a link that does nothing.

/**
 * @typedef {{key: string, label: string, url: string, prompt_param: string, path_param?: string|null, max_prompt?: number|null, command?: string|null, link_ready?: boolean, command_ready?: boolean}} Opener
 * @typedef {{key: string, kind: 'link', label: string, href: string}} LinkAction
 * @typedef {{key: string, kind: 'copy', label: string, text: string}} CopyAction
 */

/**
 * A link that opens `prompt` in the app, in the workspace folder when the
 * app takes one, or null when the prompt is too long for the app's links.
 *
 * @param {Opener} opener
 * @param {string} prompt
 * @param {string|null} [path]
 * @returns {string|null}
 */
export function promptLink(opener, prompt, path = null) {
    if (typeof opener.url !== 'string' || typeof opener.prompt_param !== 'string' || prompt === '') {
        return null;
    }

    if (typeof opener.max_prompt === 'number' && prompt.length > opener.max_prompt) {
        return null;
    }

    const parameters = [];

    if (opener.path_param && path) {
        parameters.push(`${opener.path_param}=${encodeURIComponent(path)}`);
    }

    parameters.push(`${opener.prompt_param}=${encodeURIComponent(prompt)}`);

    return `${opener.url}?${parameters.join('&')}`;
}

/**
 * A value quoted for the creator's shell: PowerShell on Windows, a POSIX
 * shell everywhere else. Single quotes keep every character literal.
 *
 * @param {string} value
 * @param {string} platform
 */
export function shellQuote(value, platform) {
    if (platform === 'win32') {
        return `'${value.replace(/'/g, "''")}'`;
    }

    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The terminal command that starts the app's CLI in the workspace with the
 * prompt, or null when the app has no CLI.
 *
 * @param {Opener} opener
 * @param {string} prompt
 * @param {string|null} path
 * @param {string} platform
 * @returns {string|null}
 */
export function terminalCommand(opener, prompt, path, platform) {
    if (typeof opener.command !== 'string' || opener.command === '' || prompt === '') {
        return null;
    }

    const start = `${opener.command} ${shellQuote(prompt, platform)}`;

    if (!path) {
        return start;
    }

    return platform === 'win32'
        ? `Set-Location -LiteralPath ${shellQuote(path, platform)}; ${start}`
        : `cd ${shellQuote(path, platform)} && ${start}`;
}

/**
 * Every way to hand a prompt to the creator's AI: the first ready app as
 * the one click link, then the other ready apps, the terminal commands,
 * and the link itself to paste into a browser. Copying the prompt is
 * always offered by the page beside these.
 *
 * @param {Opener[]} openers
 * @param {string} prompt
 * @param {{path?: string|null, platform?: string}} [where]
 * @returns {{open: LinkAction|null, menu: (LinkAction|CopyAction)[]}}
 */
export function promptActions(openers, prompt, { path = null, platform = 'darwin' } = {}) {
    const text = String(prompt ?? '');
    /** @type {LinkAction[]} */
    const links = [];

    for (const opener of openers ?? []) {
        const href = opener.link_ready ? promptLink(opener, text, path) : null;

        if (href !== null) {
            links.push({ key: `open-${opener.key}`, kind: 'link', label: `Open in ${opener.label}`, href });
        }
    }

    /** @type {CopyAction[]} */
    const commands = [];

    for (const opener of openers ?? []) {
        const command = opener.command_ready ? terminalCommand(opener, text, path, platform) : null;

        if (command !== null) {
            commands.push({ key: `command-${opener.key}`, kind: 'copy', label: `Copy ${opener.label} terminal command`, text: command });
        }
    }

    const [open = null, ...otherLinks] = links;

    return {
        open,
        menu: [
            ...otherLinks,
            ...commands,
            ...(open === null ? [] : [{ key: 'copy-link', kind: /** @type {const} */ ('copy'), label: 'Copy link', text: open.href }]),
        ],
    };
}

if (typeof window !== 'undefined') {
    /** @type {any} */ (window).rafflexOpeners = { promptActions, promptLink, terminalCommand };
}
