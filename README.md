# @rafflex/dev

```sh
npx @rafflex/dev init && npx @rafflex/dev
```

Build a Rafflex marketplace game or block on your own machine: preview it with the platform's sample data in every play scenario, use your own art and 3D models, and see the platform's rules flagged as you save. Push through your connected AI when it is right. Needs Node 20 or newer.

The full reference lives on the marketplace, so it always matches the rules in force:

* [docs/dev-kit.md](https://marketplace.rafflex.io/docs/dev-kit.md): commands, project layout, tags, `check --json`, and the public rule endpoints
* [llms.txt](https://marketplace.rafflex.io/llms.txt): everything an AI assistant needs to build for the marketplace

## Usage

| Command | What it does |
| --- | --- |
| `npx @rafflex/dev init [--type game\|block]` | Creates `rafflex.json`, the starter `template.twig`, `assets/`, and a `.gitignore` for the rules cache. Existing files are never overwritten. |
| `npx @rafflex/dev [--port N] [--no-open]` | Starts the preview (port 5173, or the next free one) with scenario, play count, and device controls, a problems panel, and live reload when `template.twig` or anything in `assets/` changes. |
| `npx @rafflex/dev check [--json] [--play-count N]` | Renders every scenario headlessly and runs the rules. Exit code 1 when anything would block submission, 0 otherwise, 2 when the check cannot run. |

Files in `assets/` are referenced as `{{ files['tag'] }}`, where the tag is the slugified filename stem (`Win Jingle.mp3` becomes `win-jingle`), the same tag the studio gives an upload. An approved library build (for example the three.js bundle) is recognised by its SHA-256 and loads from its shared URL, byte identical to the live site.

Everything the kit reports is guidance. The marketplace's own check is the final verdict.

## Rules, offline use, and privacy

The kit reads the platform's rules, sample contexts, starter templates, and approved libraries from the marketplace's public `/dev-kit/*.json` endpoints, caches them in `.rafflex/cache/`, and works offline from that cache. A rule change on the platform reaches your next run without a kit update. Those GET requests are the only network traffic: the kit has no sign in, holds no secrets, and never uploads anything.

| Variable | Use |
| --- | --- |
| `RAFFLEX_BASE_URL` | Read rules from another marketplace (also `base_url` in `rafflex.json`). |
| `NODE_EXTRA_CA_CERTS` | Trust an extra certificate authority, for a proxy or a local marketplace such as `https://marketplace.rafflex.io.test` under Laravel Herd. |

## Known differences from the platform renderer

The preview renders with [twig.js](https://github.com/twigjs/twig.js), adjusted to match the platform's PHP Twig for the sandboxed subset (string literal escapes, `default` keeping `false`, PHP style number printing and `json` encoding, `trim` sides, missing keys being undefined, the newline after a comment). A shared fixture suite proves the two agree. What remains:

* The sandbox whitelist is a lint over the parsed template rather than a runtime sandbox, and twig.js reports some syntax errors with different wording or no line.
* twig.js cannot parse a string literal that ends in an escaped backslash (`'\\'`).
* Joining a boolean with `~` gives `true` or `false` where PHP gives `1` or nothing, and mapping keys that look like integers come first.
* Upload checks for images and audio look at the extension only; the platform also inspects the content.
* Option warnings from the platform's options inferrer are not reproduced; only toggle defaults are resolved.

## Development

```sh
npm test                 # unit, CLI, server, and recorded parity tests
RAFFLEX_BASE_URL=https://marketplace.rafflex.io npm run test:parity
```

`scripts/generate-test-fixtures.php` regenerates `test/fixtures` from a marketplace checkout.

MIT licensed.
