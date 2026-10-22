'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'dados', 'noticias-publicacoes.json');
const PAGE_PATH = path.join(ROOT, 'noticias-publicacoes.html');
const SCRIPT_PATH = path.join(ROOT, 'noticias-publicacoes.js');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.listeners = {};
        this.hidden = false;
        this.value = '';
        this.attributes = {};
        this._text = '';
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        this.children = children;
        this._text = '';
    }

    addEventListener(type, listener) {
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type].push(listener);
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    get lastChild() {
        return this.children[this.children.length - 1];
    }

    get textContent() {
        return this._text + this.children.map(child => child.textContent || '').join('');
    }

    set textContent(value) {
        this._text = String(value);
        this.children = [];
    }

    dispatch(type) {
        (this.listeners[type] || []).forEach(listener => listener({ target: this }));
    }
}

async function loadPage(fetchImpl) {
    const elements = new Map();
    const defaults = {
        'category-filter': 'todos',
        'sort-order': 'relevance'
    };
    const document = {
        getElementById(id) {
            if (!elements.has(id)) {
                const element = new Element('div');
                element.value = defaults[id] || '';
                elements.set(id, element);
            }
            return elements.get(id);
        },
        createElement(tagName) {
            return new Element(tagName);
        },
        createTextNode(text) {
            const element = new Element('#text');
            element.textContent = text;
            return element;
        }
    };
    const errors = [];
    const context = {
        document,
        fetch: fetchImpl,
        console: { error: (...args) => errors.push(args) }
    };

    vm.runInNewContext(fs.readFileSync(SCRIPT_PATH, 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    return { elements, errors };
}

function itemCount(items) {
    return items.filter(item => item.relevance
        && ['alta', 'media', 'complementar'].includes(item.relevance.level)).length;
}

test('the page loads the valid dataset and renders searchable, filterable links', async function () {
    const page = fs.readFileSync(PAGE_PATH, 'utf8');
    const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(homepage, /href="noticias-publicacoes\.html"/);
    assert.match(page, /href="nav\.css"/);
    assert.doesNotMatch(page, /class="nav-bar"/);
    assert.match(fs.readFileSync(SCRIPT_PATH, 'utf8'), /fetch\('dados\/noticias-publicacoes\.json'/);
    assert.equal(data.schema_version, 1);

    let requestedPath;
    const { elements } = await loadPage(async (url, options) => {
        requestedPath = url;
        assert.equal(options.cache, 'no-cache');
        return { ok: true, json: async () => data };
    });
    const results = elements.get('news-results');
    const visibleItems = data.items.filter(item => item.relevance
        && ['alta', 'media', 'complementar'].includes(item.relevance.level));

    assert.equal(requestedPath, 'dados/noticias-publicacoes.json');
    assert.equal(results.children.length, itemCount(data.items));
    assert.equal(elements.get('results-count').textContent, itemCount(data.items) + ' resultados');

    const firstItem = visibleItems.find(item => item.title);
    const search = elements.get('news-search');
    search.value = firstItem.title;
    search.dispatch('input');
    assert.equal(results.children.length, 1);
    assert.equal(results.children[0].children[1].textContent, firstItem.title);
    assert.equal(results.children[0].lastChild.href, firstItem.url);
    assert.equal(results.children[0].lastChild.target, '_blank');

    search.value = '';
    search.dispatch('input');
    const categoryFilter = elements.get('category-filter');
    categoryFilter.value = 'noticia';
    categoryFilter.dispatch('change');
    const newsItems = visibleItems.filter(item => item.category === 'noticia');
    assert.equal(results.children.length, newsItems.length);

    const selectedDate = newsItems[0].published_at.slice(0, 10);
    elements.get('date-from').value = selectedDate;
    elements.get('date-to').value = selectedDate;
    elements.get('date-from').dispatch('change');
    const sameDayNews = newsItems.filter(item => item.published_at.slice(0, 10) === selectedDate);
    assert.equal(results.children.length, sameDayNews.length);

    elements.get('date-from').value = '';
    elements.get('date-to').value = '';
    elements.get('date-from').dispatch('change');
    elements.get('sort-order').value = 'recent';
    elements.get('sort-order').dispatch('change');
    const displayedTitles = results.children.map(card => card.children[1].textContent);
    const recentTitles = newsItems
        .slice()
        .sort((left, right) => right.published_at.localeCompare(left.published_at)
            || right.relevance.score - left.relevance.score)
        .map(item => item.title);
    assert.deepEqual(displayedTitles, recentTitles);

    search.value = 'termo sem correspondência';
    search.dispatch('input');
    assert.equal(results.children.length, 0);
    assert.match(elements.get('news-status').textContent, /Nenhum conteúdo corresponde/);
});

test('institutional category from the dataset is displayed and filterable', async function () {
    const institutionalItem = {
        ...data.items.find(item => item.relevance
            && ['alta', 'media', 'complementar'].includes(item.relevance.level)),
        category: 'institucional'
    };
    const fixture = { ...data, items: [institutionalItem] };
    const { elements } = await loadPage(async () => ({
        ok: true,
        json: async () => fixture
    }));

    const categoryFilter = elements.get('category-filter');
    categoryFilter.value = 'institucional';
    categoryFilter.dispatch('change');
    const results = elements.get('news-results');
    assert.equal(results.children.length, 1);
    assert.match(results.children[0].children[0].children[0].textContent, /Institucional/);
});

test('publisher attribution from targeted news feeds is displayed and searchable', async function () {
    const article = {
        ...data.items.find(item => item.relevance
            && ['alta', 'media', 'complementar'].includes(item.relevance.level)),
        publisher: 'Portal Regional',
        source: { name: 'Google News - baleia-franca e APABF', type: 'noticia' },
        category: 'noticia'
    };
    const fixture = { ...data, items: [article] };
    const { elements } = await loadPage(async () => ({
        ok: true,
        json: async () => fixture
    }));

    const results = elements.get('news-results');
    assert.equal(results.children.length, 1);
    assert.match(results.children[0].textContent, /Portal Regional \(via Google News\)/);
    assert.equal(results.children[0].lastChild.textContent, 'Abrir notícia no Google News');
    const search = elements.get('news-search');
    search.value = 'Portal Regional';
    search.dispatch('input');
    assert.equal(results.children.length, 1);
});

test('complementary publications, authors, journals, and partial collection status are visible', async function () {
    const publication = {
        title: 'Southern right whale ecology in Brazil',
        summary: '',
        url: 'https://doi.org/10.1234/example',
        source: { name: 'Crossref', type: 'academica' },
        published_at: '2025-01-01T00:00:00+00:00',
        category: 'academico',
        keywords: ['Eubalaena australis'],
        authors: ['Ana Silva', 'João Costa'],
        journal: 'Marine Ecology',
        locations: [],
        relevance: { level: 'complementar', score: 3, reason: ['contexto científico complementar'] }
    };
    const responseData = {
        schema_version: 1,
        generated_at: '2025-01-01T00:00:00+00:00',
        last_checked_at: '2025-01-02T00:00:00+00:00',
        collection_status: 'partial',
        collection_scope: 'news',
        items: [publication]
    };
    const { elements } = await loadPage(async () => ({
        ok: true,
        json: async () => responseData
    }));

    const results = elements.get('news-results');
    assert.equal(results.children.length, 1);
    assert.match(results.children[0].textContent, /Relevância complementar/);
    assert.match(results.children[0].textContent, /Ana Silva; João Costa/);
    assert.match(results.children[0].textContent, /Marine Ecology/);
    assert.match(elements.get('last-updated').textContent, /Coleta parcial/);
    assert.match(elements.get('news-status').textContent, /registros acadêmicos e de pesquisa foram preservados/);
});

test('a failed collection state is not displayed as a successful empty search', async function () {
    const responseData = {
        schema_version: 1,
        generated_at: '',
        last_checked_at: '2025-01-02T00:00:00+00:00',
        collection_status: 'failed',
        items: []
    };
    const { elements } = await loadPage(async () => ({
        ok: true,
        json: async () => responseData
    }));

    assert.match(elements.get('last-updated').textContent, /Última coleta falhou/);
    assert.match(elements.get('news-status').textContent, /última coleta falhou/);
    assert.equal(elements.get('results-count').textContent, '0 resultados');
});

test('a stale snapshot is labeled instead of appearing as a fresh collection', async function () {
    const responseData = {
        schema_version: 1,
        generated_at: '2020-01-01T00:00:00+00:00',
        items: [{
            title: 'Publicação anterior',
            summary: '',
            url: 'https://example.org/old',
            source: { name: 'Arquivo', type: 'academica' },
            published_at: '2020-01-01T00:00:00+00:00',
            category: 'academico',
            relevance: { level: 'media', score: 5, reason: [] }
        }]
    };
    const { elements } = await loadPage(async () => ({
        ok: true,
        json: async () => responseData
    }));

    assert.match(elements.get('last-updated').textContent, /Checagem desatualizada/);
    assert.match(elements.get('news-status').textContent, /data da última checagem está desatualizada/);
});

test('a failed request offers retry and recovers after data becomes available', async function () {
    let attempts = 0;
    const recoveredData = {
        ...data,
        collection_status: 'complete',
        collection_scope: 'all'
    };
    const { elements, errors } = await loadPage(async () => {
        attempts += 1;
        if (attempts === 1) {
            return { ok: false, status: 503 };
        }
        return { ok: true, json: async () => recoveredData };
    });

    const status = elements.get('news-status');
    assert.equal(attempts, 1);
    assert.equal(errors.length, 1);
    assert.match(status.textContent, /Verifique sua conexão/);
    assert.equal(status.lastChild.textContent, 'Tentar novamente');

    status.lastChild.dispatch('click');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(attempts, 2);
    assert.equal(elements.get('news-results').children.length, itemCount(data.items));
    assert.equal(status.hidden, true);
});

test('an empty dataset displays an explicit no-content state', async function () {
    const { elements } = await loadPage(async () => ({
        ok: true,
        json: async () => ({ schema_version: 1, items: [] })
    }));

    assert.equal(elements.get('news-results').children.length, 0);
    assert.match(elements.get('news-status').textContent, /Ainda não há resultados publicados/);
});
