// The Rafflex app: Home, Products, Product, and New product, served by the
// kit on 127.0.0.1. It shows what is happening and hands everything else to
// the creator's AI as ready made prompts. Live: the server's event stream
// refreshes products and previews as the AI works. Actions carry the start
// token embedded in this page.

const token = document.querySelector('meta[name="rafflex-token"]')?.getAttribute('content') ?? '';
const placeholders = ['title', 'path', 'slug', 'type', 'version', 'live_version', 'issues', 'issue'];

function fillPrompt(text, values) {
    return String(text ?? '').replace(/\{([a-z_]+)\}/g, (match, name) => (placeholders.includes(name) && values[name] ? values[name] : match));
}

function slugify(title) {
    return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function productBase(path) {
    return `/p/${path.split('/').map(encodeURIComponent).join('/')}/`;
}

function parseRoute(location) {
    const path = location.pathname;

    if (path.startsWith('/p/')) {
        const [type, folder] = path.slice(3).split('/').map(decodeURIComponent);

        return { name: 'product', path: `${type}/${folder}` };
    }

    if (path === '/products') {
        return { name: 'products' };
    }

    if (path === '/new') {
        return { name: 'new' };
    }

    return { name: 'home' };
}

document.addEventListener('alpine:init', () => {
    window.Alpine.data('rafflexApp', () => ({
        route: parseRoute(location),
        home: null,
        products: null,
        product: null,
        productError: null,
        actionError: null,
        offline: false,
        copied: null,
        created: false,
        tab: 'preview',
        tabs: [
            { key: 'preview', label: 'Preview' },
            { key: 'test', label: 'Test' },
            { key: 'live', label: 'Get it live' },
            { key: 'prompts', label: 'Prompts' },
            { key: 'changelog', label: 'Changelog' },
        ],
        devices: [
            { key: 'phone', label: 'Phone' },
            { key: 'tablet', label: 'Tablet' },
            { key: 'desktop', label: 'Desktop' },
        ],
        preview: { scenario: null, playCount: null, device: 'desktop', revision: 0, buyerImages: false },
        previewProblems: [],
        optionsForm: null,
        optionValues: {},
        optionsOpen: false,
        frameIssues: [],
        testLines: [],
        newProduct: { title: '', type: 'game', creating: false, error: null },

        init() {
            document.addEventListener('click', (event) => {
                const link = event.target.closest('a[data-link]');

                if (link === null || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                    return;
                }

                event.preventDefault();
                this.go(link.getAttribute('href'));
            });
            window.addEventListener('popstate', () => this.enter());
            window.addEventListener('message', (event) => this.frameMessage(event));
            this.loadHome();
            this.listen();
            this.enter();
        },

        get detectedClients() {
            return (this.home?.clients ?? []).filter((client) => client.detected);
        },

        get otherClients() {
            return (this.home?.clients ?? []).filter((client) => !client.detected);
        },

        get frameUrl() {
            if (this.product === null || this.preview.scenario === null) {
                return 'about:blank';
            }

            const extra = new URLSearchParams();

            if (this.setOptionCount() > 0) {
                extra.set('options', JSON.stringify(this.optionValues));
            }

            if (this.preview.buyerImages) {
                extra.set('buyer_images', '1');
            }

            return `${productBase(this.product.path)}frame?${this.selectionQuery()}${extra.size > 0 ? `&${extra}` : ''}&v=${this.preview.revision}`;
        },

        get newProductValues() {
            const type = this.home?.types.find((entry) => entry.value === this.newProduct.type);
            const slug = slugify(this.newProduct.title);

            return { title: this.newProduct.title.trim(), type: this.newProduct.type, slug, path: type && slug ? `${type.folder}/${slug}` : '' };
        },

        get aiStartPrompt() {
            const template = this.home?.new_product?.ai_start;

            return template ? fillPrompt(template, this.newProductValues) : '';
        },

        get newProductPrompt() {
            const template = this.home?.new_product?.build;

            if (!template || this.product === null) {
                return '';
            }

            return fillPrompt(template, { title: this.product.title, path: this.product.path, slug: this.product.slug ?? this.product.path.split('/').pop(), type: this.product.type, version: this.product.version });
        },

        get screenshotGroups() {
            const groups = new Map();

            for (const shot of this.product?.result?.screenshots ?? []) {
                const key = shot.scenario ?? 'Screenshots';

                groups.set(key, [...(groups.get(key) ?? []), shot]);
            }

            const order = (shot) => {
                const index = ['phone', 'mobile', 'tablet', 'desktop'].indexOf(String(shot.device).toLowerCase());

                return index === -1 ? Number.parseInt(shot.device, 10) || 99 : index - 10;
            };

            return [...groups.entries()].map(([scenario, shots]) => ({ scenario, shots: [...shots].sort((first, second) => order(first) - order(second)) }));
        },

        go(href) {
            history.pushState(null, '', href);
            this.enter();
            window.scrollTo(0, 0);
        },

        enter() {
            this.route = parseRoute(location);
            this.actionError = null;

            const query = new URLSearchParams(location.search);

            if (this.route.name === 'products') {
                this.loadProducts();
            }

            if (this.route.name === 'new') {
                this.newProduct = { title: '', type: query.get('type') ?? this.newProduct.type, creating: false, error: null };
            }

            if (this.route.name === 'product') {
                this.created = query.has('created');
                this.tab = this.tabs.some((item) => item.key === query.get('tab')) ? query.get('tab') : 'preview';
                this.preview = { scenario: query.get('scenario'), playCount: Number.parseInt(query.get('play_count') ?? '', 10) || null, device: query.get('device') ?? 'desktop', revision: 0, buyerImages: false };

                if (this.product?.path !== this.route.path) {
                    this.product = null;
                    this.testLines = [];
                    this.optionsForm = null;
                    this.optionValues = this.rememberedOptions(this.route.path);
                }

                this.loadOptions();

                this.loadProduct();
            }
        },

        async getJson(url) {
            const response = await fetch(url, { cache: 'no-store' });

            if (!response.ok) {
                throw new Error(await response.text());
            }

            this.offline = false;

            return response.json();
        },

        async action(url, body = {}) {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rafflex-Token': token }, body: JSON.stringify(body) });
            const payload = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(payload.error ?? 'That did not work. Try again.');
            }

            return payload;
        },

        async loadHome() {
            try {
                this.home = await this.getJson('/__rafflex/home');

                if (!this.home.types.some((type) => type.value === this.newProduct.type)) {
                    this.newProduct.type = this.home.types[0]?.value ?? 'game';
                }
            } catch {
                this.offline = true;
            }
        },

        async loadProducts() {
            try {
                this.products = (await this.getJson('/__rafflex/products')).products;
            } catch {
                this.offline = true;
            }
        },

        async loadProduct() {
            const path = this.route.path;

            try {
                const product = await this.getJson(`${productBase(path)}__rafflex/product`);

                if (this.route.name !== 'product' || this.route.path !== path) {
                    return;
                }

                const firstLoad = this.product === null;

                this.product = product;
                this.productError = null;

                if (product.test.running && this.testLines.length === 0) {
                    this.testLines = product.test.lines;
                }

                if (firstLoad) {
                    const scenarios = product.scenarios.map((scenario) => scenario.value);
                    const { min, max } = product.play_count;

                    this.preview.scenario = scenarios.includes(this.preview.scenario) ? this.preview.scenario : scenarios[0] ?? null;
                    this.preview.playCount = this.preview.playCount === null ? product.play_count.default : Math.min(max, Math.max(min, this.preview.playCount));
                    this.loadPreviewProblems();
                }
            } catch (error) {
                this.product = null;
                this.productError = String(error.message || 'This product could not be found.');
            }
        },

        selectionQuery() {
            return new URLSearchParams({ scenario: this.preview.scenario ?? '', play_count: String(this.preview.playCount ?? '') }).toString();
        },

        rememberQuery() {
            const query = new URLSearchParams({ tab: this.tab, scenario: this.preview.scenario ?? '', play_count: String(this.preview.playCount ?? ''), device: this.preview.device });

            history.replaceState(null, '', `?${query}`);
        },

        setTab(key) {
            this.tab = key;
            this.rememberQuery();
        },

        previewChanged() {
            const { min, max, default: fallback } = this.product.play_count;
            const count = Number.parseInt(this.preview.playCount, 10);

            this.preview.playCount = Number.isFinite(count) ? Math.min(max, Math.max(min, count)) : fallback;
            this.rememberQuery();
            this.reloadFrame();
        },

        reloadFrame() {
            this.frameIssues = [];
            this.preview.revision++;
            this.loadPreviewProblems();
        },

        async loadPreviewProblems() {
            if (this.product === null) {
                return;
            }

            try {
                const payload = await this.getJson(`${productBase(this.product.path)}__rafflex/problems?${this.selectionQuery()}`);

                const warningCodes = payload.warning_codes ?? ['option_warning', 'unknown_file_tag'];

                this.previewProblems = [...(payload.issues ?? []).filter((issue) => !warningCodes.includes(issue.code)), ...this.frameIssues];
            } catch {
                this.previewProblems = [...this.frameIssues];
            }
        },

        frameMessage(event) {
            const frame = document.querySelector('.frame iframe');

            if (frame === null || event.source !== frame.contentWindow || typeof event.data !== 'object' || event.data === null) {
                return;
            }

            if (event.data.type === 'rafflex-dev-violation') {
                this.frameIssues.push({ code: 'safety', message: `The preview blocked a request (${event.data.directive}).`, fix: 'Use media only through the files map and keep code inline.' });
            } else if (event.data.type === 'rafflex-dev-script-error') {
                this.frameIssues.push({ code: 'script_error', message: `A script failed: ${event.data.message}`, fix: 'Ask your AI to fix it so it works in every scenario.' });
            } else {
                return;
            }

            this.previewProblems = [...this.previewProblems, this.frameIssues[this.frameIssues.length - 1]];
        },

        listen() {
            const events = new EventSource('/__rafflex/events');

            events.addEventListener('open', () => {
                if (this.offline) {
                    this.offline = false;
                    this.loadHome();
                    this.enter();
                }
            });
            events.addEventListener('error', () => {
                this.offline = events.readyState !== EventSource.OPEN;
            });
            events.addEventListener('products', () => this.refreshVisible(null));
            events.addEventListener('change', (event) => this.refreshVisible(JSON.parse(event.data)));
            events.addEventListener('test', (event) => this.testEvent(JSON.parse(event.data)));
        },

        refreshVisible(change) {
            if (this.route.name === 'products') {
                this.loadProducts();
            }

            if (this.route.name === 'product' && (change === null || change.path === this.route.path || change.type === 'all')) {
                this.loadProduct();

                if (change !== null && change.preview) {
                    this.loadOptions();
                    this.reloadFrame();
                }
            }
        },

        testEvent(event) {
            if (this.route.name === 'products') {
                this.loadProducts();
            }

            if (this.route.name !== 'product' || event.product !== this.route.path) {
                return;
            }

            if (event.status === 'running') {
                this.testLines = [...this.testLines, event.line];

                if (this.product !== null) {
                    this.product.test.running = true;
                }

                return;
            }

            this.loadProduct();
        },

        async startTest(product) {
            this.actionError = null;

            if (this.route.name === 'product') {
                this.testLines = [];
                this.rememberQuery();
            }

            try {
                await this.action(`${productBase(product.path)}__rafflex/actions/test`);
                product.test.running = true;
            } catch (error) {
                this.actionError = error.message;
            }
        },

        async openFolder(product) {
            this.actionError = null;

            try {
                const { opened } = await this.action(`${productBase(product.path)}__rafflex/actions/open-folder`);

                if (!opened) {
                    this.actionError = `Could not open the folder. It is at ${product.directory}`;
                }
            } catch (error) {
                this.actionError = error.message;
            }
        },

        async createProduct() {
            this.newProduct.creating = true;
            this.newProduct.error = null;

            try {
                const { url } = await this.action('/__rafflex/actions/new', { type: this.newProduct.type, title: this.newProduct.title });

                this.go(`${url}?created=1`);
            } catch (error) {
                this.newProduct.error = error.message;
            } finally {
                this.newProduct.creating = false;
            }
        },

        // Every way to hand a prompt to the creator's AI (openers.js): the
        // first ready app as a link, the rest in the menu beside Copy.
        promptActions(text) {
            const build = window.rafflexOpeners?.promptActions;

            if (typeof build !== 'function' || !text) {
                return { open: null, menu: [] };
            }

            return build(this.home?.openers ?? [], text, { path: this.home?.workspace ?? null, platform: this.home?.platform ?? 'darwin' });
        },

        async copy(text, key) {
            try {
                await navigator.clipboard.writeText(text);
            } catch {
                const area = document.createElement('textarea');

                area.value = text;
                document.body.append(area);
                area.select();
                document.execCommand('copy');
                area.remove();
            }

            this.copied = key;
            setTimeout(() => {
                if (this.copied === key) {
                    this.copied = null;
                }
            }, 2000);
        },

        typeLabel(value) {
            return this.home?.types.find((type) => type.value === value)?.label ?? value;
        },

        scenarioLabel(value) {
            if (value === 'buyer_images') {
                return 'Buyer images';
            }

            return this.product?.scenarios.find((scenario) => scenario.value === value)?.label ?? value;
        },

        // The Options panel: the form a buyer sees (the inferred options with
        // options.json applied), its values kept in the page and remembered
        // per product in this browser.
        async loadOptions() {
            const path = this.route.path;

            try {
                const form = await this.getJson(`${productBase(path)}__rafflex/options`);

                if (this.route.name === 'product' && this.route.path === path) {
                    this.optionsForm = form;
                }
            } catch {
                this.optionsForm = null;
            }
        },

        optionsKey(path) {
            return `rafflex-options:${path}`;
        },

        rememberedOptions(path) {
            try {
                const saved = JSON.parse(localStorage.getItem(this.optionsKey(path)) ?? '{}');

                return saved !== null && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
            } catch {
                return {};
            }
        },

        optionsChanged() {
            try {
                localStorage.setItem(this.optionsKey(this.route.path), JSON.stringify(this.optionValues));
            } catch {
                // Not remembered in this browser.
            }

            this.reloadFrame();
        },

        setOptionCount() {
            return Object.keys(this.optionValues).length;
        },

        setOption(key, value) {
            const values = { ...this.optionValues };

            if (value === '' || value === null || value === undefined) {
                delete values[key];
            } else {
                values[key] = value;
            }

            this.optionValues = values;
            this.optionsChanged();
        },

        resetOptions() {
            this.optionValues = {};
            this.optionsChanged();
        },

        optionChecked(field, values) {
            return typeof values[field.key] === 'boolean' ? values[field.key] : field.starts === true;
        },

        optionPlaceholder(field) {
            if (field.default !== null && typeof field.default !== 'object') {
                return String(field.default);
            }

            return field.default_expression ? `Default: ${field.default_expression}` : '';
        },

        colourValue(field, value) {
            const candidate = value ?? field.default;

            return typeof candidate === 'string' && /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : '#000000';
        },

        toggleCategory(slug, ticked) {
            const current = (this.optionValues.categories ?? []).filter((entry) => entry !== slug);

            this.setOption('categories', ticked ? [...current, slug] : (current.length > 0 ? current : null));
        },

        addItem(field) {
            const items = [...(this.optionValues[field.key] ?? [])];

            if (items.length < (this.optionsForm?.max_repeater_items ?? 20)) {
                items.push({});
                this.setOption(field.key, items);
            }
        },

        removeItem(key, index) {
            const items = (this.optionValues[key] ?? []).filter((item, position) => position !== index);

            this.setOption(key, items.length > 0 ? items : null);
        },

        setItemValue(key, index, childKey, value) {
            const items = (this.optionValues[key] ?? []).map((item, position) => {
                if (position !== index) {
                    return item;
                }

                const next = { ...item };

                if (value === '' || value === null) {
                    delete next[childKey];
                } else {
                    next[childKey] = value;
                }

                return next;
            });

            this.setOption(key, items);
        },

        issueWhere(issue) {
            return [issue.file, issue.line ? `line ${issue.line}` : null, issue.scenario ? this.scenarioLabel(issue.scenario) : null].filter(Boolean).join(' · ');
        },

        resultUrl(path) {
            return `${productBase(this.product.path)}results/${path.split('/').map(encodeURIComponent).join('/')}`;
        },

        timeAgo(at) {
            const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));

            if (seconds < 60) {
                return 'just now';
            }

            if (seconds < 3600) {
                return `${Math.round(seconds / 60)} min ago`;
            }

            if (seconds < 86400) {
                return `${Math.round(seconds / 3600)} h ago`;
            }

            return new Date(at).toLocaleDateString();
        },
    }));
});
