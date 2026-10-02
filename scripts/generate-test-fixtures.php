<?php

/**
 * Maintainer tool: regenerates test/fixtures/endpoints from a local
 * marketplace checkout through its DevKitContract, so the kit's tests run
 * against the documents the endpoints serve, with HTML rendered by the
 * platform's own TwigRenderer. The library list is a test stand in (a
 * fake build in test/fixtures/lib), since the registry lives in a database.
 *
 * Usage: php scripts/generate-test-fixtures.php /path/to/marketplace.rafflex.io
 *
 * It only reads from the marketplace application (no database writes, no
 * files written there). The live endpoints remain the source of truth; this
 * exists so the kit's offline tests and parity suite have realistic data.
 */

use App\Services\DevKitContract;
use Illuminate\Contracts\Console\Kernel;

$marketplace = $argv[1] ?? null;

if ($marketplace === null || ! is_file("{$marketplace}/artisan")) {
    fwrite(STDERR, "Pass the path to a marketplace.rafflex.io checkout.\n");
    exit(1);
}

require "{$marketplace}/vendor/autoload.php";
$app = require "{$marketplace}/bootstrap/app.php";
$app->make(Kernel::class)->bootstrap();

$kitRoot = dirname(__DIR__);
$out = "{$kitRoot}/test/fixtures/endpoints";
@mkdir($out, 0777, true);

// Documents built in memory only: the array cache store keeps this from
// touching the marketplace's cache or database.
config(['cache.default' => 'array']);

$contract = app(DevKitContract::class);

$libraryPath = "{$kitRoot}/test/fixtures/lib/fake-three.module.js";
$libraryContent = [
    'libraries' => [[
        'name' => 'three.js',
        'version' => '0.0.0-test',
        'url' => 'https://static.rafflex.io/marketplace/libraries/three/0.0.0-test/three.module.min.js',
        'sha256' => hash_file('sha256', $libraryPath),
        'licence' => 'MIT',
        'contents' => 'Test stand in for the three.js bundle',
        'default_tag' => 'three',
    ]],
];

$documents = [
    'rules' => $contract->rules(),
    'contexts' => $contract->contexts(),
    'skeletons' => $contract->skeletons(),
    'libraries' => ['version' => substr(hash('sha256', json_encode($libraryContent, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)), 0, 12), ...$libraryContent],
    'fixtures' => $contract->fixtures(),
];

$endpoints = [];
$versions = [];

foreach ($documents as $name => $document) {
    $flags = in_array($name, ['contexts', 'fixtures'], true)
        ? JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        : JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
    file_put_contents("{$out}/{$name}.json", json_encode($document, $flags)."\n");
    $endpoints[$name] = "__BASE_URL__/dev-kit/{$name}.json";
    $versions[$name] = $document['version'];
}

$published = $contract->manifest();
$manifest = [
    'contract' => $published['contract'],
    'version' => substr(hash('sha256', json_encode($versions)), 0, 12),
    'generated_at' => now()->toIso8601String(),
    'endpoints' => $endpoints,
    'versions' => $versions,
];

// The workspace additions (PRD 38): asset types and the command list,
// copied as the marketplace publishes them.
foreach (['asset_types', 'commands'] as $key) {
    if (array_key_exists($key, $published)) {
        $manifest[$key] = $published[$key];
    }
}

file_put_contents("{$out}/manifest.json", json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)."\n");

// The kit's own extra parity cases (test/fixtures/parity), rendered by the
// platform's TwigRenderer with the contract's contexts, covering engine
// differences the marketplace's suite does not exercise.
$files = [
    'background' => 'https://static.rafflex.io/marketplace/products/1/background.png',
    'win-jingle' => 'https://static.rafflex.io/marketplace/products/1/win-jingle.mp3',
    'logo' => 'https://static.rafflex.io/marketplace/products/1/logo.webp',
    'three' => $libraryContent['libraries'][0]['url'],
];
$kitCases = [
    ['json-filter', 'game', 'mixed', 5, $files],
    ['json-filter', 'game', 'no_plays', 1, []],
    ['default-false', 'block', null, null, []],
    ['filters', 'game', 'mixed', 5, []],
    ['filters', 'game', 'big_win', 25, []],
    ['filters', 'game', 'all_lose', 1, []],
    ['scalars', 'game', 'all_win', 5, []],
    ['scalars', 'game', 'no_plays', 1, []],
    ['whitespace', 'game', 'mixed', 5, []],
    ['whitespace', 'game', 'no_plays', 1, []],
    ['block-competitions', 'block', null, null, $files],
    ['files-map', 'game', 'mixed', 5, $files],
];
$renderer = app(App\Services\TwigRenderer::class);
$kitFixtures = [];

foreach ($kitCases as [$name, $type, $scenario, $playCount, $caseFiles]) {
    $input = ['name' => $name, 'type' => $type, 'scenario' => $scenario, 'play_count' => $playCount, 'files' => $caseFiles];
    $template = file_get_contents("{$kitRoot}/test/fixtures/parity/{$name}.twig");
    $kitFixtures[] = [
        'name' => $type === 'block' ? $name : "{$name} ({$scenario}, {$playCount})",
        'type' => $type,
        'scenario' => $scenario,
        'play_count' => $playCount,
        'template' => $template,
        'files' => $caseFiles,
        'expected_html' => $renderer->render($template, $contract->fixtureContext($input)),
    ];
}

file_put_contents("{$kitRoot}/test/fixtures/kit-fixtures.json", json_encode(['fixtures' => $kitFixtures], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n");

echo 'Wrote '.(count($documents) + 1).' documents and '.count($documents['fixtures']['fixtures'])." fixtures to {$out}\n";
