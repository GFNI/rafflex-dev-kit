import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { icons, packageFolders } from '../scripts/copy-icons.js';
import { inlineIcons } from '../src/dev-server.js';

const clientDirectory = new URL('../src/client/', import.meta.url);
const html = readFileSync(new URL('app.html', clientDirectory), 'utf8');
const css = readFileSync(new URL('app.css', clientDirectory), 'utf8');
const script = readFileSync(new URL('app.js', clientDirectory), 'utf8');

/** @returns {string[]} */
function markersIn(source) {
    return [...source.matchAll(/<!-- icon:([a-z]+\/[a-z0-9-]+) -->/g)].map((match) => match[1]);
}

/** @returns {Record<string, string>} */
function views() {
    const names = ['Home', 'Products', 'Product', 'New product'];

    return Object.fromEntries(names.map((name, index) => {
        const start = html.indexOf(`<!-- ${name} -->`);
        const end = index + 1 < names.length ? html.indexOf(`<!-- ${names[index + 1]} -->`) : html.length;

        return [name, html.slice(start, end)];
    }));
}

describe('app icons', () => {
    test('bundles exactly the Heroicons the page uses, with their licence', () => {
        const bundled = Object.entries(icons).flatMap(([variant, names]) => names.map((name) => `${variant}/${name}`)).sort();

        assert.deepEqual([...new Set(markersIn(html))].sort(), bundled);
        assert.deepEqual(readdirSync(new URL('icons/', clientDirectory)).sort(), ['LICENSE', ...Object.keys(icons)].sort());
        assert.match(readFileSync(new URL('icons/LICENSE', clientDirectory), 'utf8'), /Tailwind Labs/);
    });

    test('bundled icons are the heroicons package files, unchanged', () => {
        for (const [variant, names] of Object.entries(icons)) {
            for (const name of names) {
                const bundled = readFileSync(new URL(`icons/${variant}/${name}.svg`, clientDirectory), 'utf8');
                const original = readFileSync(new URL(`../node_modules/heroicons/${packageFolders[variant]}/${name}.svg`, import.meta.url), 'utf8');

                assert.equal(bundled, original, `${variant}/${name}`);
            }
        }
    });

    test('the served page inlines every icon, so nothing loads from elsewhere', () => {
        const served = inlineIcons(html);

        assert.deepEqual(markersIn(served), []);
        assert.equal((served.match(/<svg class="icon icon-(outline|micro)"/g) ?? []).length, markersIn(html).length);
        assert.ok(served.includes('aria-hidden="true"'));
        assert.doesNotMatch(served, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    });
});

describe('app design rules', () => {
    test('each view has at most one dark primary button', () => {
        for (const [name, markup] of Object.entries(views())) {
            assert.ok((markup.match(/class="button primary/g) ?? []).length <= 1, name);
        }
    });

    test('uses the marketplace tokens: Inter, the neutral scale, and the near black accent', () => {
        assert.match(css, /font-family: "Inter", ui-sans-serif, system-ui, sans-serif;/);
        assert.match(css, /--accent: #262626;/);
        assert.match(css, /--border: #e5e5e5;/);
        assert.match(css, /--background: #ffffff;/);
    });

    test('has none of the banned AI smells', () => {
        assert.doesNotMatch(css, /gradient|blur\(|backdrop-filter|text-shadow|filter:/);
        assert.doesNotMatch(css, /#(?:7c3aed|8b5cf6|a855f7|6366f1|3b82f6|2563eb)/i, 'no purple or blue palette');

        for (const shadow of css.matchAll(/box-shadow: ([^;]+);/g)) {
            assert.match(shadow[1], /^0 1px 2px rgb\(0 0 0 \/ 0\.0[0-5]\)$/, 'only the faintest popover shadow');
        }

        const copy = `${html}\n${script}`;

        assert.doesNotMatch(copy, /supercharge|unleash|seamless|effortless|magic|sparkle/i);
        assert.doesNotMatch(copy, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');
        assert.doesNotMatch(html.replace(/<!DOCTYPE[^>]*>|<!--[^]*?-->|="[^"]*"/g, ''), /!/, 'no exclamation marks in page text');
    });
});
