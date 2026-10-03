# Changelog

## 0.4.0

The kit closes the loop: a product goes from an empty folder to in review without meeting a rule the workspace could not know, pushes in one command, and brings the reviewer's answer back.

### Push in one command

* `push <product> "<sync_url>"` pushes through the short lived link the creator's AI asks for with `request_sync`. It reads the product's state from the link, refuses when the draft changed on the marketplace and the folder differs from it, runs `verify` (reusing a fresh `.results/verify.json`), sends only what changed, creates the product the first time (renaming its folder to the slug), uploads each file (cover, screenshots, and media, in batches), attaches approved libraries, removes screenshots no longer in `listing/screenshots/`, and records the result. The template never passes through the AI.
* A refused push says what to do next: the marketplace's issues printed like `check`, a conflict with the export and import route, an expired link, a rate limit with the wait, a push body over the marketplace's limit (`too_large`, with how to push less at once), and a link whose AI app the creator disconnected (reconnect it, then ask for a new link). A file that did not upload is named by its path in the folder, and a second push sends only what is still missing.
* The cover and screenshots upload under names of their own (`cover.png`, and `screenshot-01.png` onwards by their place in `listing/screenshots/`), so a screenshot keeps the name the computer gave it. The listing shows the screenshots in the folder's filename order: one the marketplace shows out of order is uploaded again in its place.
* `synced <product> ["<sync_url>"]` and `release <product> ["<sync_url>"]` take a sync link. Standard input still takes a `get_product` result, for a shell that cannot reach the marketplace. `release <product> "<sync_url>"` changes nothing unless the marketplace has the version in review (`not_submitted`, exit 1).
* `release` marks the version in review in the recorded state, so the app shows In review without another sync. `release --json` adds `in_review`.
* A sync that records a draft changed elsewhere is committed as "Sync <slug> (draft revision N)", so `restore last-push` only returns to real pushes and imports. A sync that changed only other state (in review, a review decision) commits `product.json` alone, and one that changed nothing writes nothing: the time of the last sync is kept outside git in `.rafflex/sync-times.json`.
* `plan` tells an AI with a shell to call `request_sync` and run `push`, and keeps the tool by tool route for a shell that cannot reach the marketplace.
* A push compares the draft's version and revision, so a new draft started in the studio is a conflict even at the same revision number. A never pushed folder refuses a link for an existing product (`wrong_link`). Tags compare by the marketplace's slug, so `WHEEL` and `wheel` are one tag and a second push has nothing to send. A push that changed nothing on the marketplace makes no commit, and one where files did not upload says so in its commit ("2 files not uploaded") and keeps them as changes.
* A saved verify is reused only when no file in the folder changed and the platform's rules are the ones it was made with.
* `push`, `synced`, and `release` report a refusal as `{error: {code, message}}`; `rate_limited`, `forbidden`, and `too_large` exit 1. A folder renamed on its first push is still found by its old path.
* The usage lines quote the links: `import "<bundle>"`, `push <product> "<sync_url>"`, `synced <product> ["<sync_url>"]`, `release <product> ["<sync_url>"]`. `import "<bundle_url>"` downloads the bundle itself.
* Names from outside (an export bundle, a sync link's answer) never become paths outside the workspace: an unsafe slug, type, tag, or file name is refused, and `import` downloads give up after a timeout.
* The kit holds no secret and never signs in. It sends files only to the sync link's own marketplace and the upload links it answers with, never follows a redirect, prints the link with its signature left out, and never writes it to disk or git.

### Feedback in the workspace

* The sync link's feedback is recorded in `product.json`: the latest review with its notes and the submission checks still failing, the open bug report and unanswered question counts, and installs, sales, and rating. `status --json` carries it as `feedback`, and `status` prints the decision, the notes, and the counts.
* The app shows the reviewer's decision and notes (as plain text) above the product's tabs, with a prompt to fix them; badges for open bug reports and unanswered questions with prompts that have the AI read them through the marketplace's tools (what buyers write never reaches the workspace); one line of numbers for a live product; and Removed for a product the marketplace's staff took down.

### Ready for review, locally

* A product folder holds its cover and screenshots in `listing/`, committed and pushed. `capture <product> [--force]` writes them from the browser run, and never replaces the creator's own without `--force`. `import` downloads them and checks their hashes.
* `verify`, `plan`, and `status` report `submission: {ready, missing}`: what review still needs (a description, a category, a cover image, a screenshot, release notes once a version is live, and the listing limits), with the marketplace's own messages. The app's Get it live step lists it.
* `listing.md` accepts category names as well as ids, resolved through the marketplace's `categories.json`.
* New blocking checks before a push: `listing_invalid`, `asset_filename` (a name in `assets/` the upload refuses, with the name to use), `asset_duplicate` (only files that upload under the same name, or two approved libraries that would take one tag; files that share a stem take `win`, `win-2`), `asset_capacity` (counting files still on the marketplace), `asset_content_mismatch` (only content the marketplace refuses: a JPEG named `.png` is fine, AAC named `.mp3` is not), and `asset_locked` (a changed file a submitted or published version uses, which `plan` also lists under `refusals` with the name to use). A cover or screenshot may have any file name. Audio named as an image, or the reverse, is the warning `asset_content_warning`.
* A product last synced by kit 0.3.0 has no record of its listing images: the checklist says to refresh its state with `synced` first, `capture` adds nothing without `--force`, and `plan` plans no listing images until the state is known.
* `plan --json` adds `listing_images` (the cover and the screenshots to upload, compared by SHA-256, each with its `upload_filename`, and the screenshots to remove) and `refusals`.

### Options, as a buyer sees them

* The kit infers the options a template reads exactly as the platform does (field types, labels, defaults, choices, repeaters, the Categories filter), held to a fixture suite recorded from the platform.
* The app has an Options panel: the form a buyer sees, with the labels, help, and choices from `options.json`. Changing a value renders the preview with it. A Buyer images toggle swaps each image a buyer may replace for a placeholder of another shape.
* `check` reports the platform's `option_warning`s, blocks on an `options.json` the marketplace would refuse (`option_override_invalid`, with the joined choices limit read from the rules when they publish it), and renders every scenario once more with every option set as a buyer may set it (`option_render_error`, only for a failure the marketplace has too; any other is a warning).
* Creator specs pass options with `open(scenario, {options})`, and the browser run adds a buyer images pass with screenshots.
* `plan --json` adds `suggested_version`: the bump the platform would suggest against the live version's options, before the push.
* Option overrides are compared after the same tidy up the marketplace applies, entries the template does not read dropped (the draft's against the draft's own template), so `plan` no longer reports options as changed after every push and `push` sees no conflict where there is none.
* The preview renders closer to the platform: every `date` format character (`e` prints UTC), a render error for text the platform cannot read as a time, `number_format` with any number of decimals, arithmetic with null and booleans, division and modulo by zero failing, and `length` and `join` on numbers and text. Buyer image placeholders keep their shape inside a `<style>`.

The command not found message now says to run the command with `npx @rafflex/dev@latest`.
