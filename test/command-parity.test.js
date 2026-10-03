import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { devKitCommands, publishedCommands } from '../src/command-list.js';
import { runJson } from './helpers/cli.js';
import { temporaryWorkspace } from './helpers/project.js';

// The kit's command list against the marketplace's DevKitCommand enum, as
// recorded in the contract fixture and, when RAFFLEX_PARITY_BASE_URL is
// set, as the live marketplace publishes it in /dev-kit/manifest.json.
const fixtureManifest = JSON.parse(readFileSync(new URL('./fixtures/endpoints/manifest.json', import.meta.url), 'utf8'));
const liveBaseUrl = process.env.RAFFLEX_PARITY_BASE_URL?.replace(/\/+$/, '');

/**
 * @param {{name: string, usage: string}[]} commands
 */
const namesAndUsage = (commands) => commands.map(({ name, usage }) => ({ name, usage }));

describe('command list parity', () => {
    test('the CLI lists exactly the commands the marketplace documents', () => {
        assert.deepEqual(namesAndUsage(publishedCommands()), namesAndUsage(fixtureManifest.commands));
    });

    test('every listed command is dispatched by the CLI', () => {
        const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');

        for (const { name } of devKitCommands) {
            assert.ok(cli.includes(`case '${name}':`), `src/cli.js does not run ${name}`);
        }
    });

    test('no command answers "not implemented"', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win' }] });

        for (const args of [['import', 'missing.json'], ['plan', 'spin-to-win'], ['synced', 'spin-to-win'], ['release', 'spin-to-win'], ['status'], ['version', 'spin-to-win', 'patch']]) {
            const { output } = await runJson(args, { cwd: root });

            assert.doesNotMatch(JSON.stringify(output), /not implemented/, args.join(' '));
        }
    });

    test('matches the live marketplace', { skip: liveBaseUrl ? false : 'RAFFLEX_PARITY_BASE_URL is not set' }, async () => {
        const response = await fetch(`${liveBaseUrl}/dev-kit/manifest.json`, { headers: { Accept: 'application/json' } });

        assert.equal(response.status, 200, `manifest.json answered ${response.status}`);

        const manifest = await response.json();

        assert.deepEqual(namesAndUsage(publishedCommands()), namesAndUsage(manifest.commands ?? []));
    });
});
