import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectOpeners } from '../src/app/clients.js';
import { promptActions, promptLink, shellQuote, terminalCommand } from '../src/client/openers.js';
import { fixturePrompts } from './helpers/project.js';

const openers = fixturePrompts().openers;
const claudeCode = openers.find((/** @type {any} */ opener) => opener.key === 'claude-code');
const cursor = openers.find((/** @type {any} */ opener) => opener.key === 'cursor');

/**
 * @param {Record<string, boolean>} ready
 */
function readyOpeners(ready) {
    return openers.map((/** @type {any} */ opener) => ({ ...opener, link_ready: ready[opener.key] ?? false, command_ready: ready[`${opener.key}-command`] ?? false }));
}

describe('opening a prompt in an AI app', () => {
    test('builds the app\'s link with the encoded prompt and the workspace folder', () => {
        assert.equal(
            promptLink(claudeCode, 'Fix "Spin & Win"\nnow', '/Users/me/rafflex'),
            'claude-cli://open?cwd=%2FUsers%2Fme%2Frafflex&q=Fix%20%22Spin%20%26%20Win%22%0Anow',
        );
        assert.equal(promptLink(cursor, 'Hello', '/Users/me/rafflex'), 'cursor://anysphere.cursor-deeplink/prompt?text=Hello');
    });

    test('gives no link for a prompt longer than the app\'s links carry, or an empty one', () => {
        assert.equal(promptLink(claudeCode, 'a'.repeat(claudeCode.max_prompt + 1), null), null);
        assert.equal(promptLink(claudeCode, '', null), null);
    });

    test('quotes the prompt and folder for the creator\'s shell', () => {
        assert.equal(shellQuote(`it's`, 'darwin'), `'it'\\''s'`);
        assert.equal(shellQuote(`it's`, 'win32'), `'it''s'`);
        assert.equal(terminalCommand(claudeCode, `Fix it's bug`, '/Users/me/my rafflex', 'linux'), `cd '/Users/me/my rafflex' && claude 'Fix it'\\''s bug'`);
        assert.equal(terminalCommand(claudeCode, 'Fix it', 'C:\\Users\\me\\rafflex', 'win32'), `Set-Location -LiteralPath 'C:\\Users\\me\\rafflex'; claude 'Fix it'`);
        assert.equal(terminalCommand(cursor, 'Fix it', null, 'darwin'), null);
    });

    test('offers the first ready app as the link, then the other apps, the terminal commands, and the link to copy', () => {
        const actions = promptActions(readyOpeners({ 'claude-code': true, cursor: true, 'claude-code-command': true, 'codex-command': true }), 'Fix it', { path: '/w', platform: 'darwin' });

        assert.equal(actions.open?.label, 'Open in Claude Code');
        assert.equal(actions.open?.href, 'claude-cli://open?cwd=%2Fw&q=Fix%20it');
        assert.deepEqual(actions.menu.map((item) => [item.kind, item.label]), [
            ['link', 'Open in Cursor'],
            ['copy', 'Copy Claude Code terminal command'],
            ['copy', 'Copy Codex terminal command'],
            ['copy', 'Copy link'],
        ]);
        assert.equal(/** @type {any} */ (actions.menu.find((item) => item.key === 'command-codex'))?.text, `cd '/w' && codex 'Fix it'`);
    });

    test('falls back to copy alone when no app is ready', () => {
        assert.deepEqual(promptActions(readyOpeners({}), 'Fix it', { path: '/w' }), { open: null, menu: [] });
        assert.deepEqual(promptActions([], '', {}), { open: null, menu: [] });
    });

    test('skips an app whose link cannot carry the prompt, so the next one leads', () => {
        const actions = promptActions(readyOpeners({ 'claude-code': true, cursor: true }), 'a'.repeat(4000), { path: '/w' });

        assert.equal(actions.open?.label, 'Open in Claude Code');
        assert.deepEqual(actions.menu.map((item) => item.label), ['Copy link']);

        const cursorOnly = promptActions(readyOpeners({ cursor: true }), 'a'.repeat(4000), { path: '/w' });

        assert.deepEqual(cursorOnly, { open: null, menu: [] });
    });
});

describe('which openers are ready on this computer', () => {
    /**
     * @param {string[]} paths
     */
    const existing = (paths) => (/** @type {string} */ path) => paths.includes(path);

    test('Claude Code\'s link is ready once its handler is registered, on macOS and Linux', () => {
        const mac = detectOpeners(openers, { env: { PATH: '/usr/local/bin' }, platform: 'darwin', home: '/Users/me', exists: existing(['/Users/me/Applications/Claude Code URL Handler.app', '/usr/local/bin/claude']), readdir: () => [] });
        const linux = detectOpeners(openers, { env: { PATH: '/usr/bin', XDG_DATA_HOME: '/home/me/.data' }, platform: 'linux', home: '/home/me', exists: existing(['/home/me/.data/applications/claude-code-url-handler.desktop']), readdir: () => [] });
        const unregistered = detectOpeners(openers, { env: { PATH: '/usr/local/bin' }, platform: 'darwin', home: '/Users/me', exists: existing(['/usr/local/bin/claude']), readdir: () => [] });

        assert.deepEqual(mac.find((opener) => opener.key === 'claude-code'), { ...claudeCode, link_ready: true, command_ready: true });
        assert.equal(linux.find((opener) => opener.key === 'claude-code')?.link_ready, true);
        assert.equal(unregistered.find((opener) => opener.key === 'claude-code')?.link_ready, false);
        assert.equal(unregistered.find((opener) => opener.key === 'claude-code')?.command_ready, true);
    });

    test('finds the VS Code extension, the ChatGPT or Codex app, and Cursor', () => {
        const ready = detectOpeners(openers, {
            env: { PATH: '' },
            platform: 'darwin',
            home: '/Users/me',
            exists: existing(['/Applications/ChatGPT.app', '/Applications/Cursor.app']),
            readdir: (path) => (path === '/Users/me/.vscode/extensions' ? ['anthropic.claude-code-2.1.300-darwin-arm64'] : []),
        });

        assert.deepEqual(Object.fromEntries(ready.map((opener) => [opener.key, opener.link_ready])), { 'claude-code': false, 'claude-code-vscode': true, codex: true, cursor: true });
    });

    test('never offers an app the kit does not know', () => {
        const [unknown] = detectOpeners([{ key: 'new-app', label: 'New app', url: 'new-app://open', prompt_param: 'q' }], { env: { PATH: '' }, platform: 'darwin', home: '/Users/me', exists: () => true, readdir: () => [] });

        assert.equal(unknown.link_ready, false);
        assert.equal(unknown.command_ready, false);
    });
});
