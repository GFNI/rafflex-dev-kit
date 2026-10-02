// The workspace index: every product with its version, its remote state
// from the last sync, and what changed locally since, each linking to its
// preview. Refreshes over SSE when products or their files change.

const elements = {
    path: document.getElementById('workspace-path'),
    meta: document.getElementById('workspace-meta'),
    warnings: document.getElementById('warnings'),
    empty: document.getElementById('empty'),
    list: document.getElementById('products'),
};

function typeLabel(types, value) {
    return types.find((type) => type.value === value)?.label ?? value;
}

/**
 * The remote side in a few words, most important first.
 */
function remoteParts(product) {
    const { remote } = product;

    if (!remote.pushed) {
        return [{ text: 'Not pushed yet', tone: 'muted' }];
    }

    if (!remote.synced) {
        return [{ text: 'Not synced yet', tone: 'warning' }];
    }

    const parts = [{ text: remote.live_version ? `Live ${remote.live_version}` : 'Not live', tone: remote.live_version ? 'ok' : 'muted' }];

    if (remote.in_review) {
        parts.push({ text: 'In review', tone: 'warning' });
    }

    if (remote.review) {
        const label = remote.review.decision === 'changes_requested' ? 'Changes requested' : remote.review.decision === 'rejected' ? 'Rejected' : remote.review.decision;

        parts.push({ text: `${label}${remote.review.version ? ` on ${remote.review.version}` : ''}`, tone: 'error' });
    }

    return parts;
}

function localText(product) {
    if (product.local === null) {
        return null;
    }

    return product.local.changed.length === 0 ? 'No local changes since the last sync' : `Changed locally: ${product.local.changed.join(', ')}`;
}

function badge({ text, tone }) {
    const element = document.createElement('span');

    element.className = `badge badge-${tone}`;
    element.textContent = text;

    return element;
}

function renderProduct(product, types) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    const meta = document.createElement('span');
    const states = document.createElement('div');

    link.href = product.url;
    link.className = 'product';
    heading.className = 'product-heading';
    title.textContent = product.title;
    meta.className = 'muted';
    meta.textContent = `${typeLabel(types, product.type)} · ${product.version} · ${product.path}`;
    heading.append(title, meta);
    states.className = 'product-states';
    states.append(...remoteParts(product).map(badge));

    const local = localText(product);

    if (local !== null) {
        const changes = document.createElement('span');

        changes.className = 'muted';
        changes.textContent = local;
        states.append(changes);
    }

    link.append(heading, states);

    for (const problem of product.problems) {
        const note = document.createElement('div');

        note.className = 'product-problem';
        note.textContent = problem;
        link.append(note);
    }

    item.append(link);

    return item;
}

async function refresh() {
    let payload;

    try {
        payload = await (await fetch('/__rafflex/products', { cache: 'no-store' })).json();
    } catch (error) {
        elements.warnings.replaceChildren(Object.assign(document.createElement('li'), { textContent: `Could not reach the kit's server (${error.message}). Is it still running?` }));

        return;
    }

    elements.path.textContent = payload.workspace;
    elements.meta.textContent = `Rules ${payload.rules_version ?? 'unversioned'}${payload.offline ? ' · offline' : ''}`;
    elements.warnings.replaceChildren(...payload.warnings.map((warning) => Object.assign(document.createElement('li'), { textContent: warning })));
    elements.empty.hidden = payload.products.length > 0;
    elements.list.replaceChildren(...payload.products.map((product) => renderProduct(product, payload.types)));
}

refresh();

const events = new EventSource('/__rafflex/events');

events.addEventListener('products', refresh);
events.addEventListener('change', refresh);
