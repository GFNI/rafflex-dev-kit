import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/fixture-server.js';
import { temporaryDirectory, temporaryProject } from './helpers/project.js';

const bin = fileURLToPath(new URL('../bin/rafflex-dev.js', import.meta.url));
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * @param {string[]} args
 * @param {{cwd: string, baseUrl?: string}} options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(args, { cwd, baseUrl }) {
    return new Promise((resolve) => {
        const env = { ...process.env, RAFFLEX_BASE_URL: baseUrl ?? 'http://127.0.0.1:9' };

        execFile(process.execPath, [bin, ...args], { cwd, env }, (error, stdout, stderr) => {
            resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
        });
    });
}

describe('rafflex-dev CLI', () => {
    /** @type {Awaited<ReturnType<typeof startFixtureServer>>} */
    let server;

    before(async () => {
        server = await startFixtureServer();
    });

    after(() => server.close());

    test('--help and --version', async () => {
        const help = await run(['--help'], { cwd: temporaryDirectory() });
        const version = await run(['--version'], { cwd: temporaryDirectory() });

        assert.equal(help.code, 0);
        assert.match(help.stdout, /npx @rafflex\/dev init/);
        assert.equal(version.stdout.trim(), packageVersion);
    });

    test('an unknown option is a usage error', async () => {
        const result = await run(['check', '--nope'], { cwd: temporaryDirectory() });

        assert.equal(result.code, 2);
        assert.match(result.stderr, /Unknown option --nope/);
    });

    test('init scaffolds a project from the marketplace skeleton', async () => {
        const directory = temporaryDirectory();
        const result = await run(['init', '--type', 'block'], { cwd: directory, baseUrl: server.baseUrl });
        const skeletons = JSON.parse(readFileSync(new URL('./fixtures/endpoints/skeletons.json', import.meta.url), 'utf8'));

        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(readFileSync(join(directory, 'rafflex.json'), 'utf8')), { type: 'block', product: null });
        assert.equal(readFileSync(join(directory, 'template.twig'), 'utf8'), skeletons.block);
        assert.equal(readFileSync(join(directory, 'assets', '.gitkeep'), 'utf8'), '');
        assert.match(readFileSync(join(directory, '.gitignore'), 'utf8'), /^\.rafflex\/$/m);
    });

    test('init never overwrites existing files', async () => {
        const directory = temporaryProject({ type: 'game', template: 'MINE' });

        writeFileSync(join(directory, '.gitignore'), 'node_modules/\n');

        const result = await run(['init', '--type', 'block'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(result.code, 0, result.stderr);
        assert.equal(readFileSync(join(directory, 'template.twig'), 'utf8'), 'MINE');
        assert.equal(JSON.parse(readFileSync(join(directory, 'rafflex.json'), 'utf8')).type, 'game');
        assert.equal(readFileSync(join(directory, '.gitignore'), 'utf8'), 'node_modules/\n');
        assert.match(result.stdout, /kept +template\.twig/);
        assert.match(result.stdout, /add "\.rafflex\/" to your \.gitignore/);
        assert.match(result.stderr, /already says this is a game/);
    });

    test('check --json passes a clean template with exit code 0', async () => {
        const directory = temporaryProject({ template: '<p>{{ play_count }} {{ plays|json }}</p>' });
        const result = await run(['check', '--json'], { cwd: directory, baseUrl: server.baseUrl });
        const output = JSON.parse(result.stdout);

        assert.equal(result.code, 0);
        assert.equal(output.passed, true);
        assert.deepEqual(output.issues, []);
        assert.equal(output.note, "The marketplace's own check is the final verdict.");
        assert.equal(output.checked.play_count, 5);
    });

    test('check --json reports issues in the check_template shape and exits 1', async () => {
        const directory = temporaryProject({ template: '<p>\n{{ plays|raw }}</p><script>fetch("/x")</script>', assets: { 'mine.js': 'x' } });
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
        const directory = temporaryProject({ template: `<img src="{{ files['missing'] }}">` });
        const result = await run(['check'], { cwd: directory, baseUrl: server.baseUrl });

        assert.equal(result.code, 0);
        assert.match(result.stdout, /warning \[unknown_file_tag\]/);
        assert.match(result.stdout, /The marketplace's own check is the final verdict\./);
    });

    test('check without a project explains how to start one', async () => {
        const result = await run(['check'], { cwd: temporaryDirectory(), baseUrl: server.baseUrl });

        assert.equal(result.code, 2);
        assert.match(result.stderr, /npx @rafflex\/dev init/);
    });

    test('check with neither network nor cache fails clearly', async () => {
        const result = await run(['check', '--json'], { cwd: temporaryProject(), baseUrl: 'http://127.0.0.1:9' });
        const output = JSON.parse(result.stdout);

        assert.equal(result.code, 2);
        assert.equal(output.passed, false);
        assert.match(output.error, /no cached copy/);
    });

    test('check works offline once the rules are cached', async () => {
        const directory = temporaryProject();
        const offlineServer = await startFixtureServer();

        await run(['check'], { cwd: directory, baseUrl: offlineServer.baseUrl });
        await offlineServer.close();

        const result = await run(['check', '--json'], { cwd: directory, baseUrl: offlineServer.baseUrl });
        const output = JSON.parse(result.stdout);

        assert.equal(result.code, 0);
        assert.equal(output.checked.offline, true);
        assert.match(output.warnings[0], /Working offline/);
    });
});
