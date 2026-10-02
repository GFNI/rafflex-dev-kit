import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compilePatterns, decodeEscapes, matchPatterns } from '../src/banned-patterns.js';
import { isBlocking, referencedFileKeys, runChecks } from '../src/checker.js';
import { gameContext, inferToggleDefaults } from '../src/context.js';
import { moduleSpecifiers, scanScripts, sourceScriptViolations } from '../src/script-rules.js';
import { fixtureDocuments } from './helpers/project.js';

const documents = fixtureDocuments();
const { rules, libraries } = documents;
const messages = rules.script_rules.messages;
const libraryUrl = libraries.libraries[0].url;
const files = { three: libraryUrl, background: '/assets/background.png' };

/**
 * @param {string} template
 * @param {Record<string, string>} [fileMap]
 */
function check(template, fileMap = files) {
    return runChecks({ template, files: fileMap, documents, renderedPlayCounts: 'all' }).issues;
}

/**
 * @param {string} template
 */
function messagesOf(template) {
    return check(template).map((issue) => `${issue.code}: ${issue.message}`);
}

describe('script rules', () => {
    test('allow an approved library through files, as src or module import', () => {
        assert.deepEqual(check(`<script src="{{ files['three'] }}"></script><script type="module">import * as THREE from "{{ files["three"] }}";</script>`), []);
    });

    test('refuse a bare or relative module import', () => {
        assert.deepEqual(messagesOf('<script type="module">import * as THREE from "three";</script>'), [`safety: ${messages.module_import}`]);
        assert.deepEqual(messagesOf('<script type="module">import x from "./x.js";</script>'), [`safety: ${messages.module_import}`]);
    });

    test('refuse an import map', () => {
        assert.deepEqual(messagesOf('<script type="importmap">{"imports": {}}</script>'), [`safety: ${messages.import_map}`]);
    });

    test('refuse dynamic import through the banned pattern list', () => {
        assert.deepEqual(messagesOf('<script type="module">const m = await import("{{ files[\'three\'] }}");</script>'), [`safety: ${messages.dynamic_import}`]);
    });

    test('refuse a script src that is not an approved library', () => {
        assert.deepEqual(messagesOf(`<script src="{{ files['background'] }}"></script>`), [`safety: ${messages.script_source}`]);
        assert.deepEqual(messagesOf('<script src="/game.js"></script>'), [`safety: ${messages.script_source}`]);
    });

    test('refuse a script src assembled with Twig, in the rendered output', () => {
        const issues = check(`{% set tag = 'thr' ~ 'ee' %}<script src="{{ files[tag] }}x"></script>`);

        assert.deepEqual(issues.map((issue) => issue.code), ['safety']);
        assert.equal(issues[0].message, messages.script_source);
    });

    test('a library reference whose tag is not an approved library is refused', () => {
        assert.deepEqual(messagesOf(`<script src="{{ files['three'] }}"></script>`).length, 0);
        assert.deepEqual(
            check(`<script src="{{ files['three'] }}"></script>`, { three: '/assets/three.js' }).map((issue) => issue.message),
            [messages.script_source],
        );
    });

    test('the scanner reads attributes and specifiers like a browser', () => {
        const [element] = scanScripts('<script type=module src=\'a.js\' defer>import "b"; export * from \'c\';</script>');

        assert.deepEqual(element.attributes, [{ name: 'type', value: 'module' }, { name: 'src', value: 'a.js' }, { name: 'defer', value: '' }]);
        assert.deepEqual(moduleSpecifiers(element.content), ['b', 'c']);
    });

    test('source violations point at the template line', () => {
        const [violation] = sourceScriptViolations('{% if x %}\n<p>{{ y }}</p>\n<script src="/a.js"></script>', {}, () => false, rules.script_rules);
        const template = '{% if x %}\n<p>{{ y }}</p>\n<script src="/a.js"></script>';

        assert.equal(template.slice(violation.offset, violation.offset + 7), '<script');
    });
});

describe('banned patterns', () => {
    test('apply to the source with the line of the match', () => {
        const issues = check('<p>ok</p>\n<script>\nconst f = fetch;\n</script>');

        assert.deepEqual(issues.map((issue) => [issue.code, issue.message, issue.line]), [['safety', 'External network calls are not allowed (fetch).', 3]]);
    });

    test('apply to the rendered output of every scenario and play count', () => {
        const issues = check(`{% if play_count == 25 %}<p>{{ 'navi' ~ 'gator' }}</p>{% endif %}`);

        assert.deepEqual(issues.map((issue) => [issue.code, issue.message]), [['rendered_output', 'The navigator object is not allowed.']]);
    });

    test('catch an escaped identifier assembled in the output', () => {
        const issues = check(`<script>const a = "{{ '\\\\u' ~ '0066etch' }}";</script>`);

        assert.ok(issues.some((issue) => issue.code === 'rendered_output' && issue.message.includes('fetch')), JSON.stringify(issues));
    });

    test('source only patterns do not flag the json filter output', () => {
        assert.deepEqual(check('<script>const s = {{ settings|json }}; const p = {{ plays|json }};</script>'), []);
        assert.deepEqual(messagesOf('<script>const a = "\\u0041";</script>'), ['safety: Unicode escape sequences are not allowed (\\u....).']);
    });

    test('patterns marked js_compatible false are skipped and reported', () => {
        const { patterns, skipped } = compilePatterns([{ key: 'pcre_only', pattern: '(?<=x)', flags: '', js_compatible: false, message: 'x' }, { key: 'fetch', pattern: '\\bfetch\\b', flags: 'i', js_compatible: true, message: 'm', source_only: false }]);

        assert.deepEqual(skipped, ['pcre_only']);
        assert.deepEqual(matchPatterns('FETCH', patterns, { includeSourceOnly: false }).map((match) => match.key), ['fetch']);
    });

    test('decodeEscapes decodes hex and unicode escapes', () => {
        assert.equal(decodeEscapes('\\x66\\u0065\\u{74}'), 'fet');
    });
});

describe('render failures and other issues', () => {
    test('a render error names every scenario and the line', () => {
        const issues = check('<p>\n{{ plays|raw }}</p>');

        assert.deepEqual(issues.map((issue) => issue.scenario), ['mixed', 'all_win', 'all_lose', 'big_win', 'no_plays']);
        assert.ok(issues.every((issue) => issue.code === 'sandbox' && issue.line === 2));
    });

    test('a syntax error is a render error', () => {
        const [issue] = check('{% if %}');

        assert.equal(issue.code, 'render_error');
        assert.equal(isBlocking(issue), true);
    });

    test('unknown file tags are reported but do not block', () => {
        const issues = check(`<img src="{{ files['nope'] }}">{{ files.other }}`);

        assert.deepEqual(issues.map((issue) => [issue.code, issue.message]), [
            ['unknown_file_tag', "The template references files['nope'], but no uploaded file has that tag."],
            ['unknown_file_tag', "The template references files['other'], but no uploaded file has that tag."],
        ]);
        assert.equal(issues.some(isBlocking), false);
    });

    test('a template over the size limit is too large', () => {
        const [issue] = check(`<p>${'x'.repeat(rules.template_max_bytes)}</p>`);

        assert.deepEqual([issue.code, issue.message], ['too_large', rules.messages.too_large]);
    });

    test('every issue carries the fix from the rules', () => {
        const [issue] = check('<form></form>');

        assert.equal(issue.fix, rules.issue_codes.safety);
    });

    test('asset refusals are blocking safety issues naming the file', () => {
        const { issues } = runChecks({ template: '<p></p>', files: {}, documents, assetRefusals: [{ file: 'assets/x.js', message: 'nope' }] });

        assert.deepEqual(issues, [{ code: 'safety', message: 'nope', fix: rules.issue_codes.safety, file: 'assets/x.js' }]);
    });

    test('the starter skeletons pass', () => {
        assert.deepEqual(check(documents.skeletons.game, {}), []);
        assert.deepEqual(check(documents.skeletons.block, {}), []);
    });

    test('referencedFileKeys reads bracket and dot access in order', () => {
        assert.deepEqual(referencedFileKeys("{{ files.logo }} <img src=\"{{ files['bg'] }}\"> <script>files.notTwig</script> {{ files[\"bg\"] }}"), ['logo', 'bg']);
    });
});

describe('contexts', () => {
    test('a game context has the catalogue, the files map, and [] when there are no files', () => {
        const withFiles = gameContext(documents.contexts, { scenario: 'mixed', playCount: 5, files, template: '' });
        const without = gameContext(documents.contexts, { scenario: 'no_plays', playCount: 5, files: {}, template: '' });

        assert.deepEqual(withFiles.files, files);
        assert.equal(withFiles.play_count, 5);
        assert.ok(Array.isArray(withFiles.competitions.all));
        assert.deepEqual(without.files, []);
        assert.equal(without.play_count, 0);
    });

    test('toggles resolve to their literal default or the published unset value', () => {
        assert.deepEqual(inferToggleDefaults('{{ options.show_title|default(true) }}{% if options.hide_price %}{% endif %}{{ options.heading|default("x") }}', false), { show_title: true, hide_price: false });
    });
});
