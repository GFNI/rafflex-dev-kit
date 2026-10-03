# @rafflex/dev

```sh
npx @rafflex/dev@latest
```

* It sets up a workspace in a new `rafflex` folder (or opens the one you are in) and opens the Rafflex app in your browser. It asks nothing.
* The app shows every game and block you are building, previews each one in every play scenario, and tests it with one click.
* It hands every next step to your AI as a ready made prompt, so you never need a terminal again. Needs Node 20 or newer.

The full reference lives on the marketplace, so it always matches the rules in force:

* [docs/dev-kit.md](https://marketplace.rafflex.io/docs/dev-kit.md): the workspace, every command and its `--json` shape, the sync loop, and the public rule endpoints
* [llms.txt](https://marketplace.rafflex.io/llms.txt): everything an AI assistant needs to build for the marketplace

## Workspace

```
rafflex/
  rafflex.json        {"workspace": 1}
  AGENTS.md           how an AI works here (CLAUDE.md imports it)
  .rafflex/           the rules and Playwright cache (git ignored)
  games/
    spin-to-win/
      product.json    type, slug, title, version, last known remote state (written by the kit)
      template.twig
      options.json    option overrides
      listing.md      description, documentation, install notes; categories, tags, video in the frontmatter
      CHANGELOG.md    release notes, Unreleased on top
      assets/
      tests/          your own browser specs (optional, committed, never pushed)
      .results/       screenshots, the last test run, and verify.json (git ignored, never pushed)
  blocks/
    winner-wall/
```

The layout is fixed. `npx @rafflex/dev` outside a workspace (or `init` in an empty folder) creates it, with a git repository and a first commit when git is installed; `new` adds a product folder.

## Commands

Every command takes `--json` and exits 0 on success, 1 when a check finds a blocking problem or a command is refused, and 2 when it cannot run. A `<product>` is its slug, folder name, or path (`games/spin-to-win`), and defaults to the product folder you are in.

| Command | What it does |
| --- | --- |
| `npx @rafflex/dev init` | Creates the workspace in this folder. Refused inside an existing one. |
| `npx @rafflex/dev new <game\|block> "<title>"` | Adds a product folder named after the title, from the type's starter template, at version 1.0.0. |
| `npx @rafflex/dev [--port N] [--no-open]` | Starts the Rafflex app for the whole workspace (port 5173, or the next free one) and opens the product you are in, or Home anywhere else. Outside a workspace it first sets one up in a new `rafflex` folder here, asking nothing. `npx @rafflex/dev dev <product>` opens a named product. See [The app](#the-app). |
| `npx @rafflex/dev format [<product>...\|--all] [--check]` | Formats templates in the house style (below). `--check` reports without writing. JSON: `{product, formatted, changed, written, error}`, or `{passed, products: [...]}` for several. |
| `npx @rafflex/dev check [<product>...\|--all]` | Renders every scenario headlessly and runs the rules, then the lint warnings and a format check. Outside a product folder it checks every product. `--json` prints one product's result, or `{passed, products: [...]}` for several. |
| `npx @rafflex/dev test [<product>...\|--all] [--install]` | The browser tests (below). Without Playwright it prints the install command and skips. `--install` installs Playwright and Chromium into `.rafflex/playwright` (about 100 MB; the AI asks first). JSON: `{product, passed, skipped, reason, install, issues, runs, playthrough, creator_tests, results}`. |
| `npx @rafflex/dev verify [<product>...\|--all]` | `format`, then `check`, then `test` when Playwright is installed: the one command to run before every push. JSON: `{product, ready, browser_tests, format, check, test, issues, blocking, warnings, note}`, or `{ready, products: [...]}`. Exits 1 when not ready. |
| `npx @rafflex/dev status [<product>]` | Offline: each product's version, its remote state from the last sync, and what changed locally since. It also refreshes `AGENTS.md` when the file is still the kit's generated copy and the marketplace's guidance changed (`agents_md` in the JSON: `current`, `updated`, `customised`, or `unknown`). |
| `npx @rafflex/dev version <product> <patch\|minor\|major\|x.y.z>` | Sets the version being worked on. Refused while that version is in review. |
| `npx @rafflex/dev import <bundle> [--force]` | Writes a product from an `export_product` bundle (a file, its URL, or `-` for standard input) into `<type folder>/<slug>`, downloading each media file and checking its SHA-256. An existing product folder is replaced only with `--force`; the refusal lists its local changes. |
| `npx @rafflex/dev plan <product>` | Runs `verify` first; while anything blocks, it says "not ready to push", lists the blocking issues, and exits 1 (`ready` and `verify: {ready, browser_tests, blocking_issues, warning_count}` in the JSON). Then the push plan as data: whether the template, options, or listing changed since the last sync, each new or changed asset (path, tag, kind, size, MIME type, SHA-256, and the library name for an approved library, matched by its hash rather than its tag), `removed_assets` for media on the marketplace with no file in `assets/` (the kit never removes media; the AI asks the creator to remove it in the browser), the Unreleased release notes, and `stale_remote` when the last sync is missing or over a day old. Without `--json` it is a numbered list of the marketplace tools to call. |
| `npx @rafflex/dev synced <product>` | Reads a `get_product` result on standard input (the structured content or the whole tool result) and records it in `product.json`. The first sync records the slug and renames the folder to it; the version follows the server's draft. After a push (a new draft revision) it commits the product folder as "Push spin-to-win 1.3.0 (draft revision 7)". |
| `npx @rafflex/dev release <product>` | After `submit_for_review`: moves the Unreleased notes under `## <version> (submitted <date>)`, starts a fresh Unreleased, commits the product folder, and tags `<slug>@<version>`. A version submitted again after changes were requested adds to its existing section; its tag is left where it is. |
| `npx @rafflex/dev restore <product> last-push [--yes]` | Discards unpushed work: lists what would be lost, and with `--yes` returns the product folder to its last confirmed push (the kit's newest Push, Release, Import, or Revert commit), leaving `tests/` alone. Without git it explains the `export_product` and `import --force` route. Going back to an earlier shipped version is `revert_to_version` on the marketplace. |

## The sync loop

The kit never signs in. Your AI moves products between the workspace and the marketplace with its marketplace tools, and the kit makes each step mechanical.

1. **Bring a product local.** `export_product` returns a link to a bundle; `npx @rafflex/dev import <link>` writes the product folder.
2. **Before pushing,** read the product with `get_product` and pipe it to `npx @rafflex/dev synced <product>`, so the plan compares with the server's current state.
3. **Push.** `npx @rafflex/dev plan <product>` lists exactly what changed. Call `create_product` (first push only), `update_draft`, `update_product_details`, and `request_media_upload` or `attach_approved_library` for those parts and nothing else.
4. **Record it.** Read the product again and pipe it to `synced`. `plan` now reports nothing to push.
5. **Release.** After `submit_for_review` succeeds, run `npx @rafflex/dev release <product>`.

`import` commits the product as "Import spin-to-win from the marketplace" (or "Revert spin-to-win to 2.0.0 as 3.0.1" after `revert_to_version`). The kit only ever commits the product concerned; the AI commits its own verified changes in between.

When the server's draft changed since your last sync (the creator edited it in the studio), export and import it again before pushing; commit first so git keeps your local work.

## The quality loop

`npx @rafflex/dev verify <product>` before every push. The preview runs `check` on every save, and `plan` runs `verify` first, so the loop also runs when nobody asks.

* **Format.** One house style: Prettier over the HTML, inline CSS, and inline JavaScript with a fixed configuration pinned with the kit. Every Twig region is masked before formatting and restored byte for byte, and the formatted template must render the same page as the original in every scenario, or it is left untouched. `check` warns `unformatted`.
* **Lint (warnings, never blocking).** ESLint on every inline script (undefined and unused variables, unreachable code, `==`), Alpine attributes that read state no `x-data` declares (`alpine_state`), and an HTML validator (`markup`: unclosed or misnested elements, duplicate ids, images without `alt`). The platform's own game warnings come from its rules: `game_twig_logic` (a game uses only `{{ value|json }}`, `{{ files['tag'] }}`, `{{ settings.* }}`, and a simple `{% if %}`) and `playthrough_hooks_missing`.
* **Test (Playwright, optional).** Every scenario at phone, tablet, and desktop widths in headless Chromium under the preview CSP, recording console errors, uncaught exceptions, failed requests, and CSP violations, with a screenshot of each in `.results/screenshots/`. For a game with the hooks, a playthrough clicks `data-rafflex-play` once per entry in `plays` and checks each `data-rafflex-result="win|lose"` revealed matches the predetermined result, in order, and that no plays shows an empty state. A mismatch is the blocking `playthrough_mismatch`. Uncaught exceptions and CSP violations block too; console errors and failed requests are warnings.
* **Your own specs.** `tests/*.spec.mjs` export a test function, or an object of named ones, as the default export. Each receives the kit's helpers: `open(scenario, {width, playCount})`, `playNext()` (returns `win` or `lose`), `result()`, `results()`, `expected(scenario)`, `screenshot(name)`, `page` (Playwright), and `assert` (`node:assert/strict`). A failure is the blocking `creator_test_failed`.

## The app

`npx @rafflex/dev` serves the Rafflex app for the whole workspace on `127.0.0.1`, and prints three lines: the workspace, the app's address, and "Leave this running. Close it with Ctrl+C."

* **Home:** the Get started prompt for your AI, the AI apps found on this computer with their connect commands, New game and New block, and a health strip (rules, kit version, git).
* **Products:** every product with its version, state (Not pushed yet, Changes not pushed, In review, Changes requested, Live 1.2.0), and last test result (Passed, Issues, Not tested).
* **Product** at `/p/<type folder>/<folder>/` (for example `/p/games/spin-to-win/`): the preview with scenario, play count, and device controls; Test, which runs `verify` with live progress and shows blocking issues with fix prompts, screenshots, and the playthrough from the product's `.results/`; Get it live, the next step with its prompt (disabled while tests have blocking issues); prompts for changing, fixing, the next version, and reverting; and the Unreleased notes.
* **New product:** a name and a type, which runs `new`, then the prompt to hand to your AI.

Everything updates by itself: saving a product's `template.twig`, `options.json`, `product.json`, or anything in its `assets/` reloads only that product's preview, and products your AI adds, tests, or pushes appear and change on their own. Every prompt comes from the marketplace's `/dev-kit/prompts.json`, filled in locally, so the wording improves without a kit release.

The app answers only requests addressed to its own address (no DNS rebinding), every action (new product, test, open folder) needs a random token generated at start and embedded in the page, and every path is checked to resolve inside the workspace. A product's frame and files map reach only its own `assets/` folder. The app holds no account access: publishing stays with your AI.

Files in `assets/` are referenced as `{{ files['tag'] }}`, where the tag is the slugified filename stem (`Win Jingle.mp3` becomes `win-jingle`), the same tag the studio gives an upload. An approved library build (for example the three.js bundle) is recognised by its SHA-256 and loads from its shared URL, byte identical to the live site.

Everything the kit reports is guidance. The marketplace's own check is the final verdict.

## Rules, offline use, and privacy

The kit reads the platform's rules, sample contexts, starter templates, and approved libraries from the marketplace's public `/dev-kit/*.json` endpoints, caches them in the workspace's `.rafflex/cache/`, and works offline from that cache. A rule change on the platform reaches your next run without a kit update. Beyond those GET requests the kit only downloads the export bundles and media files you `import` (and Playwright with Chromium when you run `test --install`): it has no sign in, holds no secrets, and never uploads anything.

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
npm test                 # unit, CLI, server, browser (when Chromium is available), and recorded parity tests
RAFFLEX_BASE_URL=https://marketplace.rafflex.io npm run test:parity
```

`scripts/generate-test-fixtures.php` regenerates `test/fixtures` from a marketplace checkout.

MIT licensed.
