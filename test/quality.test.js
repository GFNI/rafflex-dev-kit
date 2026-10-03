import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { isBlocking, runChecks } from '../src/checker.js';
import { alpineIssues, lineMapper, markupIssues, qualityIssues, scriptIssues } from '../src/quality.js';
import { fixtureDocuments } from './helpers/project.js';

const documents = fixtureDocuments();
const platformLint = JSON.parse(readFileSync(new URL('./fixtures/endpoints/platform-lint.json', import.meta.url), 'utf8')).fixtures;
const gameCodes = ['game_twig_logic', 'playthrough_hooks_missing'];

describe('game warnings match the platform', () => {
    for (const fixture of platformLint) {
        test(`${fixture.name} reports exactly what the marketplace's check reports`, () => {
            const { issues } = runChecks({ template: fixture.template, files: {}, documents, type: fixture.type });

            assert.deepEqual(issues.filter((issue) => gameCodes.includes(issue.code)), fixture.issues);
        });
    }

    test('the shared fixtures cover both warnings and a clean game', () => {
        const codes = platformLint.flatMap((/** @type {any} */ fixture) => fixture.issues.map((/** @type {any} */ issue) => issue.code));

        assert.ok(codes.includes('game_twig_logic'));
        assert.ok(codes.includes('playthrough_hooks_missing'));
        assert.ok(platformLint.some((/** @type {any} */ fixture) => fixture.type === 'game' && fixture.issues.length === 0));
    });

    test('the game warnings never block', () => {
        const { issues } = runChecks({ template: '<p>{{ play_count }}</p>', files: {}, documents, type: 'game' });

        assert.deepEqual(issues.map((issue) => issue.code), ['game_twig_logic', 'playthrough_hooks_missing']);
        assert.equal(issues.some(isBlocking), false);
        assert.equal(issues[0].fix, documents.rules.issue_codes.game_twig_logic);
    });
});

describe('script lint', () => {
    test('reports undefined and unused variables, unreachable code, and == at the template line', () => {
        const template = `<div>
    <script>
        function go(answer) {
            const unused = 1;
            if (answer == 1) {
                return missing;
                console.log('never');
            }
        }
        go({{ play_count|json }});
    </script>
</div>`;
        const html = template.replace('{{ play_count|json }}', '5');

        assert.deepEqual(scriptIssues(html, template, 'mixed').map((issue) => [issue.code, issue.message, issue.line]), [
            ['script_lint', "'unused' is assigned a value but never used. (no-unused-vars)", 4],
            ['script_lint', "Expected '===' and instead saw '=='. (eqeqeq)", 5],
            ['script_lint', "'missing' is not defined. (no-undef)", 6],
            ['script_lint', 'Unreachable code. (no-unreachable)', 7],
        ]);
    });

    test('names declared by another classic script, browser globals, and Alpine are defined', () => {
        const html = '<script>function shared() { return window.innerWidth; }</script><script>shared(); Alpine.start(); document.title = "x";</script>';

        assert.deepEqual(scriptIssues(html, html, undefined), []);
    });

    test('reports a syntax error and skips data scripts', () => {
        const html = '<script type="application/json">{"a": </script><script>const = 1;</script>';

        assert.deepEqual(scriptIssues(html, html, undefined).map((issue) => issue.message), ["Parsing error: Unexpected token = (syntax error)"]);
    });
});

describe('Alpine state', () => {
    test('reports attributes that read state no enclosing x-data declares', () => {
        const html = `<div x-data="{ open: false, items: [], toggle() { this.open = !this.open } }">
    <button @click="toggle(); count++">Toggle</button>
    <p x-show="open" x-text="title"></p>
    <template x-for="(item, index) in items"><span x-text="item.name + index"></span></template>
    <span :class="{ active: open }" x-text="$refs.box ? 'a' : 'b'"></span>
</div>`;

        assert.deepEqual(alpineIssues(html, html, undefined).map((issue) => [issue.message, issue.line]), [
            ['@click="toggle(); count++" reads count, which no enclosing x-data declares.', 2],
            ['x-text="title" reads title, which no enclosing x-data declares.', 3],
        ]);
    });

    test('skips component functions and markup outside any component', () => {
        const html = '<div x-data="game()"><p x-text="anything"></p></div><p x-text="outside"></p>';

        assert.deepEqual(alpineIssues(html, html, undefined), []);
    });
});

describe('markup', () => {
    test('reports unclosed and misnested elements, duplicate ids, and images without alt', async () => {
        const html = '<div id="a"><p>Hi<span>x</div>\n<img src="a.png"><b id="a"></b>';
        const messages = (await markupIssues(html, html, undefined)).map((issue) => issue.message);

        assert.ok(messages.includes("Unclosed element '<p>'"));
        assert.ok(messages.includes('<img> is missing required "alt" attribute'));
        assert.ok(messages.includes('Duplicate ID "a"'));
    });
});

describe('quality warnings', () => {
    test('map rendered lines back to the template only when one line matches', () => {
        const map = lineMapper('<div>\n    <p>{{ title }}</p>\n    <p>Fixed</p>\n</div>\n<div>\n</div>');

        assert.equal(map('    <p>Spin to Win</p>'), 2);
        assert.equal(map('<p>Fixed</p>'), 3);
        assert.equal(map('</div>'), undefined);
    });

    test('a clean, formatted game has none, and every one is a warning', async () => {
        const clean = `<div x-data='{ plays: {{ plays|json }}, revealed: [] }'>
    <button type="button" data-rafflex-play @click="revealed.push(plays[revealed.length])">Play</button>
    <template x-for="play in revealed">
        <p :data-rafflex-result="play.won ? 'win' : 'lose'"></p>
    </template>
</div>
`;
        const dirty = '<div x-data="{}"><p x-text="nope">\n<script>if (a == 1) {}</script>';

        assert.deepEqual(await qualityIssues({ type: 'game', template: clean, files: {}, documents }), []);

        const issues = await qualityIssues({ type: 'game', template: dirty, files: {}, documents });

        assert.deepEqual([...new Set(issues.map((issue) => issue.code))].sort(), ['alpine_state', 'markup', 'script_lint', 'unformatted']);
        assert.equal(issues.some(isBlocking), false);
        assert.ok(issues.every((issue) => issue.fix !== '' && (issue.code === 'unformatted' || issue.scenario === 'mixed')));
    });
});
