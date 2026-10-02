import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseArguments, UsageError } from '../src/cli.js';
import { devKitCommands, publishedCommands } from '../src/command-list.js';
import { legacyLayoutMessage } from '../src/workspace.js';
import { run, runJson } from './helpers/cli.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { addProduct, temporaryDirectory, temporaryProduct, temporaryWorkspace } from './helpers/project.js';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const fixtureManifest = JSON.parse(readFileSync(new URL('./fixtures/endpoints/manifest.json', import.meta.url), 'utf8'));

describe('argument parsing', () => {
    test('no command is the preview', () => {
        assert.equal(parseArguments([]).command, 'dev');
        assert.equal(parseArguments(['--port', '6000']).port, 6000);
    });

    test('takes several positionals, --all, and --json on any command', () => {
        assert.deepEqual(parseArguments(['check', 'spin-to-win', 'winner-wall']).positionals, ['spin-to-win', 'winner-wall']);
        assert.equal(parseArguments(['check', '--all']).all, true);

        for (const { name } of devKitCommands) {
            const argv = { new: ['new', 'game', 'Title'], import: ['import', 'bundle.json'], version: ['version', 'patch'] }[name] ?? [name];

            assert.equal(parseArguments([...argv, '--json']).json, true, name);
        }
    });

    test('checks each command takes the right number of arguments', () => {
        assert.throws(() => parseArguments(['init', 'extra']), /Too many arguments for init/);
        assert.throws(() => parseArguments(['version']), /Missing arguments for version/);
        assert.throws(() => parseArguments(['status', 'a', 'b']), /Too many arguments for status/);
        assert.throws(() => parseArguments(['launch']), UsageError);
        assert.throws(() => parseArguments(['status', '--all']), /--all only applies to check/);
        assert.throws(() => parseArguments(['check', '--type', 'game']), /--type only applies to new/);
        assert.deepEqual(parseArguments(['new', '--', 'game', '--odd title']).positionals, ['game', '--odd title']);
    });

    test('the command list is the one the manifest publishes', () => {
        assert.deepEqual(publishedCommands().map(({ name, usage }) => ({ name, usage })), fixtureManifest.commands.map(({ name, usage }) => ({ name, usage })));
    });
});

describe('rafflex-dev CLI', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    test('--help lists every command and --version prints the version', async () => {
        const help = await run(['--help'], { cwd: temporaryDirectory() });
        const version = await run(['--version'], { cwd: temporaryDirectory() });

        assert.equal(help.code, 0);

        for (const command of devKitCommands) {
            assert.ok(help.stdout.includes(`  ${command.usage}\n`), command.usage);
        }

        assert.equal(version.stdout.trim(), packageVersion);
    });

    test('an unknown option is a usage error', async () => {
        const result = await run(['check', '--nope'], { cwd: temporaryDirectory() });

        assert.equal(result.code, 2);
        assert.match(result.stderr, /Unknown option --nope/);
    });

    test('a product command with no product to work on exits 2', async () => {
        const { code, output } = await runJson(['plan', 'spin-to-win'], { cwd: temporaryWorkspace() });

        assert.equal(code, 2);
        assert.match(output.error, /No product "spin-to-win"/);
    });

    test('every command refuses the old single project layout', async () => {
        const directory = temporaryDirectory();

        writeFileSync(join(directory, 'rafflex.json'), JSON.stringify({ type: 'game', product: null }));

        for (const args of [['check'], ['status'], ['new', 'game', 'X'], ['version', 'patch'], ['init'], ['dev']]) {
            const result = await run(args, { cwd: directory, baseUrl: server.baseUrl });

            assert.notEqual(result.code, 0, args.join(' '));
            assert.equal(result.stderr.trim(), legacyLayoutMessage, args.join(' '));
        }
    });

    test('the preview refuses a product the workspace does not have', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win' }, { type: 'block', title: 'Winner Wall' }] });
        const { code, output } = await runJson(['dev', 'nope', '--no-open'], { cwd: root, baseUrl: server.baseUrl });

        assert.equal(code, 2);
        assert.match(output.error, /No product "nope" in this workspace/);
    });

    test('check --json passes a clean template with exit code 0', async () => {
        const directory = temporaryProduct({ template: '<p>{{ play_count }} {{ plays|json }}</p>' });
        const result = await run(['check', '--json'], { cwd: directory, baseUrl: server.baseUrl });
        const output = JSON.parse(result.stdout);

        assert.equal(result.code, 0);
        assert.equal(output.product, 'games/spin-to-win');
        assert.equal(output.passed, true);
        assert.deepEqual(output.issues, []);
        assert.equal(output.note, "The marketplace's own check is the final verdict.");
        assert.equal(output.checked.play_count, 5);
        assert.equal(output.checked.type, 'game');
    });

    test('check --json reports issues in the check_template shape and exits 1', async () => {
        const directory = temporaryProduct({ template: '<p>\n{{ plays|raw }}</p><script>fetch("/x")</script>', assets: { 'mine.js': 'x' } });
        const result = await run(['check', '--json', '--play-count', '3'], { cwd: directory, baseUrl: server.baseUrl });
        const output = JSON.parse(result.stdout);

        assert.equal(result.code, 1);
        assert.equal(output.passed, false);
        assert.equal(output.checked.play_count, 3);

        for (const issue of output.issues) {
            assert.deepEqual(Object.keys(issue).filter((key) => !['code', 'message', 'fix', 'scenario', 'line', 'file'].includes(key)), []);
            assert.equal(typeof issue.code, 'string');
            assert.equal(typeof issue.message, 'string');
            assert.equal(typeof issue.fix, 'string');
        }

        assert.deepEqual([...new Set(output.issues.map((issue) => issue.code))], ['safety', 'sandbox']);
        assert.ok(output.issues.some((issue) => issue.code === 'sandbox' && issue.scenario === 'no_plays' && issue.line === 2));
        assert.ok(output.issues.some((issue) => issue.file === 'assets/mine.js'));
    });

    test('check exits 0 when only report only issues remain', async () => {
        const directory = temporaryProduct({ template: `<img src="{{ files['missing'] }}">` });
        const result = await run(['check'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(result.code, 0);
        assert.match(result.stdout, /warning \[unknown_file_tag\]/);
        assert.match(result.stdout, /The marketplace's own check is the final verdict\./);
    });

    test('check --all checks every product and fails when any does', async () => {
        const root = temporaryWorkspace({
            products: [
                { title: 'Spin to Win', template: '<p>{{ play_count }}</p>' },
                { title: 'Scratch Card', template: '{{ plays|raw }}' },
                { type: 'block', title: 'Winner Wall', template: '<p>{{ settings.primary_color }}</p>' },
            ],
        });
        const { code, output } = await runJson(['check', '--all'], { cwd: join(root, 'games', 'spin-to-win', 'assets'), baseUrl: server.baseUrl });

        assert.equal(code, 1);
        assert.equal(output.passed, false);
        assert.deepEqual(output.products.map((product) => [product.product, product.passed]), [
            ['games/scratch-card', false],
            ['games/spin-to-win', true],
            ['blocks/winner-wall', true],
        ]);
        assert.equal(output.products[2].checked.type, 'block');
    });

    test('check with no product outside a product folder checks them all; named products check just those', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win', slug: 'spin-to-win-2' }, { type: 'block', title: 'Winner Wall' }] });
        const everything = await runJson(['check'], { cwd: root, baseUrl: server.baseUrl });
        const named = await runJson(['check', 'spin-to-win-2'], { cwd: root, baseUrl: server.baseUrl });
        const both = await runJson(['check', 'blocks/winner-wall', 'spin-to-win'], { cwd: root, baseUrl: server.baseUrl });

        assert.equal(everything.code, 0);
        assert.equal(everything.output.products.length, 2);
        assert.equal(named.output.product, 'games/spin-to-win');
        assert.deepEqual(both.output.products.map((product) => product.product), ['blocks/winner-wall', 'games/spin-to-win']);
    });

    test('check names an unknown product and lists the known ones', async () => {
        const root = temporaryWorkspace({ products: [{ title: 'Spin to Win' }] });
        const result = await run(['check', 'nope'], { cwd: root, baseUrl: server.baseUrl });

        assert.equal(result.code, 2);
        assert.match(result.stderr, /No product "nope" in this workspace\. Products: games\/spin-to-win\./);
    });

    test('check outside a workspace explains how to start one', async () => {
        const result = await run(['check'], { cwd: temporaryDirectory(), baseUrl: server.baseUrl });

        assert.equal(result.code, 2);
        assert.match(result.stderr, /npx @rafflex\/dev init/);
    });

    test('check with neither network nor cache fails clearly', async () => {
        const result = await run(['check', '--json'], { cwd: temporaryProduct(), baseUrl: 'http://127.0.0.1:9' });
        const output = JSON.parse(result.stdout);

        assert.equal(result.code, 2);
        assert.equal(output.passed, false);
        assert.match(output.error, /no cached copy/);
    });

    test('check works offline once the rules are cached in the workspace root', async () => {
        const root = temporaryWorkspace();
        const directory = addProduct(root, { title: 'Spin to Win' });
        const offlineServer = await startFixtureServer();

        await run(['check'], { cwd: directory, baseUrl: offlineServer.baseUrl });
        await offlineServer.close();

        const { code, output } = await runJson(['check'], { cwd: directory, baseUrl: offlineServer.baseUrl });

        assert.equal(code, 0);
        assert.equal(output.checked.offline, true);
        assert.match(output.warnings[0], /Working offline/);
        assert.ok(readFileSync(join(root, '.rafflex', 'cache', new URL(offlineServer.baseUrl).host.replace(/[^a-z0-9.-]/gi, '_'), 'rules.json'), 'utf8').length > 0);
    });
});
