// The preview page: scenario, play count, and device controls around the
// sandboxed frame, a problems panel fed by the kit's checks and by the
// frame's CSP and script error reports, and live reload over SSE.

const elements = {
    type: document.getElementById('project-type'),
    scenario: document.getElementById('scenario'),
    scenarioControl: document.getElementById('scenario-control'),
    playCount: document.getElementById('play-count'),
    playCountControl: document.getElementById('play-count-control'),
    deviceButtons: [...document.querySelectorAll('[data-device]')],
    frameWrapper: document.getElementById('frame-wrapper'),
    frame: document.getElementById('preview'),
    problems: document.getElementById('problems'),
    toggle: document.getElementById('problems-toggle'),
    summary: document.getElementById('problems-summary'),
    body: document.getElementById('problems-body'),
    warnings: document.getElementById('warnings'),
    list: document.getElementById('problem-list'),
    note: document.getElementById('verdict-note'),
};

const nonBlockingCodes = ['option_warning', 'unknown_file_tag'];
const params = new URLSearchParams(location.search);
const state = {
    config: null,
    scenario: params.get('scenario'),
    playCount: Number.parseInt(params.get('play_count') ?? '', 10),
    device: params.get('device') ?? 'desktop',
    revision: 0,
    checkIssues: [],
    frameIssues: [],
    warnings: [],
    note: '',
    error: null,
};

function remember() {
    const query = new URLSearchParams({ scenario: state.scenario, play_count: String(state.playCount), device: state.device });

    history.replaceState(null, '', `?${query}`);
}

function selectionQuery() {
    return new URLSearchParams({ scenario: state.scenario, play_count: String(state.playCount) }).toString();
}

function reloadFrame() {
    state.frameIssues = [];
    state.revision++;
    elements.frame.src = `/frame?${selectionQuery()}&v=${state.revision}`;
}

async function refreshProblems() {
    try {
        const response = await fetch(`/__rafflex/problems?${selectionQuery()}`, { cache: 'no-store' });
        const payload = await response.json();

        state.checkIssues = payload.issues ?? [];
        state.warnings = payload.warnings ?? [];
        state.note = payload.note ?? '';
        state.error = payload.error ?? null;
    } catch (error) {
        state.error = `Could not reach the kit's server (${error.message}). Is it still running?`;
    }

    renderProblems();
}

function refresh() {
    remember();
    reloadFrame();
    refreshProblems();
}

/**
 * Identical messages from several scenarios collapse into one entry that
 * names every scenario.
 */
function groupedIssues() {
    const groups = new Map();

    for (const issue of [...state.checkIssues, ...state.frameIssues]) {
        const key = `${issue.code}|${issue.message}|${issue.file ?? ''}`;
        const group = groups.get(key) ?? { ...issue, scenarios: [] };

        if (issue.scenario && !group.scenarios.includes(issue.scenario)) {
            group.scenarios.push(issue.scenario);
        }

        groups.set(key, group);
    }

    return [...groups.values()];
}

function scenarioLabel(value) {
    return state.config?.scenarios.find((scenario) => scenario.value === value)?.label ?? value;
}

function renderProblems() {
    const issues = groupedIssues();
    const blocking = issues.filter((issue) => !nonBlockingCodes.includes(issue.code));
    const reportOnly = issues.length - blocking.length;

    elements.warnings.replaceChildren(...[...state.warnings, ...(state.error ? [state.error] : [])].map((warning) => {
        const item = document.createElement('li');

        item.textContent = warning;

        return item;
    }));

    elements.list.replaceChildren(...issues.map((issue) => {
        const item = document.createElement('li');
        const meta = document.createElement('div');
        const message = document.createElement('div');
        const fix = document.createElement('div');
        const where = [
            issue.file ?? 'template.twig',
            issue.line ? `line ${issue.line}` : null,
            issue.scenarios.length > 0 ? issue.scenarios.map(scenarioLabel).join(', ') : null,
        ].filter(Boolean).join(' · ');

        item.className = nonBlockingCodes.includes(issue.code) ? 'report-only' : 'blocking';
        meta.className = 'problem-meta';
        meta.textContent = `${issue.code} · ${where}`;
        message.textContent = issue.message;
        fix.className = 'problem-fix';
        fix.textContent = issue.fix ?? '';
        item.append(meta, message);

        if (issue.fix) {
            item.append(fix);
        }

        return item;
    }));

    elements.note.textContent = state.note;

    if (blocking.length > 0) {
        elements.problems.dataset.state = 'error';
        elements.summary.textContent = `${blocking.length} ${blocking.length === 1 ? 'problem' : 'problems'}${reportOnly > 0 ? `, ${reportOnly} to review` : ''}`;
    } else if (reportOnly > 0 || state.warnings.length > 0 || state.error) {
        elements.problems.dataset.state = 'warning';
        elements.summary.textContent = reportOnly > 0 ? `${reportOnly} to review` : 'No problems found (see notes)';
    } else {
        elements.problems.dataset.state = 'ok';
        elements.summary.textContent = 'No problems found locally';
    }

    if (blocking.length > 0 && elements.body.hidden && !state.userCollapsed) {
        setExpanded(true);
    }
}

function setExpanded(expanded) {
    elements.body.hidden = !expanded;
    elements.toggle.setAttribute('aria-expanded', String(expanded));
}

function applyDevice() {
    elements.frameWrapper.dataset.device = state.device;

    for (const button of elements.deviceButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.device === state.device));
    }
}

window.addEventListener('message', (event) => {
    if (event.source !== elements.frame.contentWindow || typeof event.data !== 'object' || event.data === null) {
        return;
    }

    if (event.data.type === 'rafflex-dev-violation') {
        let origin = event.data.blockedUri;

        try {
            origin = new URL(event.data.blockedUri).origin;
        } catch {
            // inline, eval, and data: reports carry no URL
        }

        state.frameIssues.push({
            code: 'safety',
            message: `The preview blocked a request to ${origin || 'an inline resource'} (${event.data.directive}).`,
            fix: 'Reference media only through the files map and keep code inline. Every external domain is blocked on the platform too.',
            scenario: state.config?.type === 'game' ? state.scenario : undefined,
        });
        renderProblems();

        return;
    }

    if (event.data.type === 'rafflex-dev-script-error') {
        state.frameIssues.push({
            code: 'script_error',
            message: `A script in the preview failed: ${event.data.message}${event.data.line ? ` (line ${event.data.line} of the rendered page)` : ''}.`,
            fix: 'The platform does not check runtime errors; fix it so the game works in every scenario.',
            scenario: state.config?.type === 'game' ? state.scenario : undefined,
        });
        renderProblems();
    }
});

elements.toggle.addEventListener('click', () => {
    const expanded = elements.body.hidden;

    state.userCollapsed = !expanded;
    setExpanded(expanded);
});

elements.scenario.addEventListener('change', () => {
    state.scenario = elements.scenario.value;
    refresh();
});

elements.playCount.addEventListener('change', () => {
    const { min, max } = state.config.play_count;
    const value = Number.parseInt(elements.playCount.value, 10);

    state.playCount = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : state.config.play_count.default;
    elements.playCount.value = String(state.playCount);
    refresh();
});

for (const button of elements.deviceButtons) {
    button.addEventListener('click', () => {
        state.device = button.dataset.device;
        applyDevice();
        remember();
    });
}

async function start() {
    state.config = await (await fetch('/__rafflex/config')).json();

    const { scenarios, play_count: playCount, type } = state.config;

    elements.type.textContent = `${type}${state.config.offline ? ' · offline' : ''}`;
    elements.scenario.replaceChildren(...scenarios.map((scenario) => new Option(scenario.label, scenario.value)));
    state.scenario = scenarios.some((scenario) => scenario.value === state.scenario) ? state.scenario : scenarios[0]?.value;
    elements.scenario.value = state.scenario;
    state.playCount = Number.isFinite(state.playCount) ? Math.min(playCount.max, Math.max(playCount.min, state.playCount)) : playCount.default;
    elements.playCount.min = String(playCount.min);
    elements.playCount.max = String(playCount.max);
    elements.playCount.value = String(state.playCount);

    // A block renders the one block data contract; scenarios and play
    // counts only change a game's data.
    elements.scenarioControl.hidden = type !== 'game';
    elements.playCountControl.hidden = type !== 'game';

    applyDevice();
    refresh();

    const events = new EventSource('/__rafflex/events');

    events.addEventListener('reload', () => {
        reloadFrame();
        refreshProblems();
    });
}

start();
