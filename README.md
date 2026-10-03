# @rafflex/dev

```sh
npx @rafflex/dev init && npx @rafflex/dev new game "Spin to Win"
```

Keep every Rafflex marketplace game and block you sell in one workspace on your own machine: preview each with the platform's sample data in every play scenario, use your own art and 3D models, see the platform's rules flagged as you save, and know which version is live, in review, and changed. Push through your connected AI when it is right. Needs Node 20 or newer.

The full reference lives on the marketplace, so it always matches the rules in force:

* [docs/dev-kit.md](https://marketplace.rafflex.io/docs/dev-kit.md): the workspace, every command and its `--json` shape, the sync loop, and the public rule endpoints
* [llms.txt](https://marketplace.rafflex.io/llms.txt): everything an AI assistant needs to build for the marketplace

## Workspace

```
rafflex/
  rafflex.json        {"workspace": 1}
  AGENTS.md           how an AI works here (CLAUDE.md imports it)
  .rafflex/           the rules cache (git ignored)
  games/
    spin-to-win/
      product.json    type, slug, title, version, last known remote state (written by the kit)
      template.twig
      options.json    option overrides
      listing.md      description, documentation, install notes; categories, tags, video in the frontmatter
      CHANGELOG.md    release notes, Unreleased on top
      assets/
  blocks/
    winner-wall/
```

The layout is fixed. `init` creates it (and a git repository with a first commit when git is installed); `new` adds a product folder.

## Commands

Every command takes `--json` and exits 0 on success, 1 when a check finds a blocking problem or a command is refused, and 2 when it cannot run. A `<product>` is its slug, folder name, or path (`games/spin-to-win`), and defaults to the product folder you are in.

| Command | What it does |
| --- | --- |
| `npx @rafflex/dev init` | Creates the workspace in this folder. Refused inside an existing one. |
| `npx @rafflex/dev new <game\|block> "<title>"` | Adds a product folder named after the title, from the type's starter template, at version 1.0.0. |
| `npx @rafflex/dev [--port N] [--no-open]` | Starts one preview server for the whole workspace (port 5173, or the next free one) and opens the product you are in, or the workspace index anywhere else. `npx @rafflex/dev dev <product>` opens a named product. See [Preview](#preview). |
| `npx @rafflex/dev check [<product>...\|--all]` | Renders every scenario headlessly and runs the rules. Outside a product folder it checks every product. `--json` prints one product's result, or `{passed, products: [...]}` for several. |
| `npx @rafflex/dev status [<product>]` | Offline: each product's version, its remote state from the last sync, and what changed locally since. It also refreshes `AGENTS.md` when the file is still the kit's generated copy and the marketplace's guidance changed (`agents_md` in the JSON: `current`, `updated`, `customised`, or `unknown`). |
| `npx @rafflex/dev version <product> <patch\|minor\|major\|x.y.z>` | Sets the version being worked on. Refused while that version is in review. |
| `npx @rafflex/dev import <bundle> [--force]` | Writes a product from an `export_product` bundle (a file, its URL, or `-` for standard input) into `<type folder>/<slug>`, downloading each media file and checking its SHA-256. An existing product folder is replaced only with `--force`; the refusal lists its local changes. |
| `npx @rafflex/dev plan <product>` | The push plan as data: whether the template, options, or listing changed since the last sync, each new or changed asset (path, tag, kind, size, MIME type, SHA-256, and the library name for an approved library, matched by its hash rather than its tag), `removed_assets` for media on the marketplace with no file in `assets/` (the kit never removes media; the AI asks the creator to remove it in the browser), the Unreleased release notes, and `stale_remote` when the last sync is missing or over a day old. Without `--json` it is a numbered list of the marketplace tools to call. |
| `npx @rafflex/dev synced <product>` | Reads a `get_product` result on standard input (the structured content or the whole tool result) and records it in `product.json`. The first sync records the slug and renames the folder to it; the version follows the server's draft. |
| `npx @rafflex/dev release <product>` | After `submit_for_review`: moves the Unreleased notes under `## <version> (submitted <date>)`, starts a fresh Unreleased, commits the product folder, and tags `<slug>@<version>`. A version submitted again after changes were requested adds to its existing section; its tag is left where it is. |

## The sync loop

The kit never signs in. Your AI moves products between the workspace and the marketplace with its marketplace tools, and the kit makes each step mechanical.

1. **Bring a product local.** `export_product` returns a link to a bundle; `npx @rafflex/dev import <link>` writes the product folder.
2. **Before pushing,** read the product with `get_product` and pipe it to `npx @rafflex/dev synced <product>`, so the plan compares with the server's current state.
3. **Push.** `npx @rafflex/dev plan <product>` lists exactly what changed. Call `create_product` (first push only), `update_draft`, `update_product_details`, and `request_media_upload` or `attach_approved_library` for those parts and nothing else.
4. **Record it.** Read the product again and pipe it to `synced`. `plan` now reports nothing to push.
5. **Release.** After `submit_for_review` succeeds, run `npx @rafflex/dev release <product>`.

When the server's draft changed since your last sync (the creator edited it in the studio), export and import it again before pushing; commit first so git keeps your local work.

## Preview

`npx @rafflex/dev` serves the whole workspace from one local server. The index at `/` lists every product with its type, version, remote state from the last sync (live version, in review, changes requested, or not pushed yet), and what changed locally since. Each product's preview lives at `/p/<type folder>/<folder>/` (for example `/p/games/spin-to-win/`) with scenario, play count, and device controls, a problems panel, and live reload. Saving a product's `template.twig`, `options.json`, `product.json`, or anything in its `assets/` reloads only that product's preview; adding or removing a product refreshes the index. A product's frame and files map reach only its own `assets/` folder.

Files in `assets/` are referenced as `{{ files['tag'] }}`, where the tag is the slugified filename stem (`Win Jingle.mp3` becomes `win-jingle`), the same tag the studio gives an upload. An approved library build (for example the three.js bundle) is recognised by its SHA-256 and loads from its shared URL, byte identical to the live site.

Everything the kit reports is guidance. The marketplace's own check is the final verdict.

## Rules, offline use, and privacy

The kit reads the platform's rules, sample contexts, starter templates, and approved libraries from the marketplace's public `/dev-kit/*.json` endpoints, caches them in the workspace's `.rafflex/cache/`, and works offline from that cache. A rule change on the platform reaches your next run without a kit update. Beyond those GET requests the kit only downloads the export bundles and media files you `import`: it has no sign in, holds no secrets, and never uploads anything.

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
