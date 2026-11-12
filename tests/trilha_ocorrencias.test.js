'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const occurrences = require('../Trilha Caminhos da Baleia Franca/js/trilha-ocorrencias');

const ROOT = path.resolve(__dirname, '..');
const MAP_ROOT = path.join(ROOT, 'Trilha Caminhos da Baleia Franca');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseElements(markup) {
    const voidElements = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr'
    ]);
    const elements = new Map();
    const stack = [];

    Array.from(markup.matchAll(/<\/?[a-z][^>]*>/gi)).forEach(function (match) {
        const token = match[0];
        const tagMatch = /^<\/?([a-z][\w:-]*)/i.exec(token);
        const tagName = tagMatch[1].toLowerCase();
        if (token.startsWith('</')) {
            for (let index = stack.length - 1; index >= 0; index -= 1) {
                if (stack[index].tagName === tagName) {
                    stack.length = index;
                    break;
                }
            }
            return;
        }

        const idMatch = /\bid=["']([^"']+)["']/i.exec(token);
        const classMatch = /\bclass=["']([^"']*)["']/i.exec(token);
        const element = {
            tagName: tagName,
            id: idMatch ? idMatch[1] : '',
            className: classMatch ? classMatch[1] : '',
            parent: stack.length ? stack[stack.length - 1] : null
        };
        if (element.id) {
            elements.set(element.id, element);
        }
        if (!voidElements.has(tagName) && !/\/\s*>$/.test(token)) {
            stack.push(element);
        }
    });

    return elements;
}

function createMockElement(tagName) {
    return {
        tagName: tagName,
        children: [],
        options: [],
        dataset: {},
        style: {
            setProperty: function () {}
        },
        classList: {
            add: function () {}
        },
        addEventListener: function () {},
        appendChild: function (child) {
            this.children.push(child);
            if (this.tagName === 'select') {
                this.options.push(child);
            }
        },
        append: function () {
            this.children.push.apply(this.children, arguments);
        },
        replaceChildren: function () {
            this.children = [];
            this.options = [];
        },
        setAttribute: function () {},
        reset: function () {}
    };
}

test('trail and occurrence tabs are sibling panels and all sidebar tabs remain addressable', function () {
    const html = fs.readFileSync(path.join(MAP_ROOT, 'index.html'), 'utf8');
    const interfaceSource = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilhas-interface.js'), 'utf8');
    const sidebarStart = html.indexOf('<div class="sidebar-content">');
    const sidebarEnd = html.indexOf('</aside>', sidebarStart);
    assert.ok(sidebarStart !== -1 && sidebarEnd > sidebarStart, 'sidebar content markup must be present');
    const panels = parseElements(html.slice(sidebarStart, sidebarEnd));
    const trailPanel = panels.get('tab-trilhas');
    const occurrencePanel = panels.get('tab-ocorrencias');

    assert.ok(trailPanel);
    assert.ok(occurrencePanel);
    assert.equal(trailPanel.parent, occurrencePanel.parent);
    assert.equal(trailPanel.parent.tagName, 'div');
    assert.equal(trailPanel.parent.className, 'sidebar-content');

    ['info', 'ajuda', 'trilhas', 'ocorrencias'].forEach(function (tab) {
        assert.ok(html.includes('data-tab="' + tab + '"'), 'missing sidebar tab button: ' + tab);
        assert.ok(panels.has('tab-' + tab), 'missing sidebar panel: tab-' + tab);
    });
    assert.match(interfaceSource, /content\.id === 'tab-' \+ button\.dataset\.tab/);
});

test('runtime catalog validation accepts all seven categories and five situations', function () {
    const catalog = readJson(path.join(ROOT, 'dados', 'catalogo_ocorrencias.json'));

    assert.doesNotThrow(function () {
        occurrences.validateCatalog(catalog);
    });
    assert.equal(catalog.categorias.length, 7);
    assert.equal(catalog.situacoes.length, 5);
    assert.ok(catalog.categorias.every(function (category) {
        return category.chave && category.nome && category.ativo === true;
    }));
    assert.ok(catalog.situacoes.every(function (situation) {
        return situation.chave && situation.rotulo && situation.ativo === true;
    }));
});

test('initialization fills category, situation and trail selects from the loaded files', async function () {
    const collection = readJson(path.join(ROOT, 'dados', 'ocorrencias_trilhas.geojson'));
    const catalog = readJson(path.join(ROOT, 'dados', 'catalogo_ocorrencias.json'));
    const trails = readJson(path.join(ROOT, 'dados', 'trilhas_apabf.geojson'));
    const elements = new Map();
    [
        ['occurrence-status', 'p'],
        ['occurrence-filters', 'form'],
        ['occurrence-filter-trail', 'select'],
        ['occurrence-filter-category', 'select'],
        ['occurrence-filter-situation', 'select'],
        ['occurrence-filter-date-from', 'input'],
        ['occurrence-filter-date-to', 'input'],
        ['occurrence-filter-reset', 'button'],
        ['occurrence-status-legend', 'ul']
    ].forEach(function (entry) {
        elements.set(entry[0], createMockElement(entry[1]));
    });
    const previousDocument = global.document;
    global.document = {
        getElementById: function (id) {
            return elements.get(id);
        },
        createElement: createMockElement,
        createTextNode: function (text) {
            return { textContent: text };
        }
    };
    const requestedPaths = [];

    try {
        occurrences.initialize({
            map: {
                createPane: function () {},
                getPane: function () {
                    return { style: {} };
                },
                addLayer: function () {}
            },
            L: {
                featureGroup: function () {
                    return {
                        clearLayers: function () {},
                        addLayer: function () {}
                    };
                }
            },
            fetch: function (url) {
                requestedPaths.push(url);
                const data = url.endsWith('ocorrencias_trilhas.geojson')
                    ? collection
                    : url.endsWith('catalogo_ocorrencias.json')
                        ? catalog
                        : null;
                return Promise.resolve({
                    ok: data !== null,
                    status: data === null ? 404 : 200,
                    json: function () {
                        return Promise.resolve(data);
                    }
                });
            },
            trailDataReady: Promise.resolve(trails)
        });
        await new Promise(function (resolve) {
            setImmediate(resolve);
        });

        assert.deepEqual(requestedPaths, [
            '../dados/ocorrencias_trilhas.geojson',
            '../dados/catalogo_ocorrencias.json'
        ]);
        assert.equal(elements.get('occurrence-filter-trail').options.length, trails.features.length + 1);
        assert.equal(elements.get('occurrence-filter-category').options.length, catalog.categorias.length + 1);
        assert.equal(elements.get('occurrence-filter-situation').options.length, catalog.situacoes.length + 1);
        assert.equal(elements.get('occurrence-filter-category').options[0].textContent, 'Todas as categorias');
        assert.equal(elements.get('occurrence-filter-situation').options[0].textContent, 'Todas as situações');
        assert.equal(elements.get('occurrence-status').textContent, 'Nenhuma ocorrência cadastrada.');
        assert.equal(elements.get('occurrence-status-legend').children.length, catalog.situacoes.length);
    } finally {
        if (previousDocument === undefined) {
            delete global.document;
        } else {
            global.document = previousDocument;
        }
    }
});

test('trail filter options use the loaded trail fid and name and retain a fallback', function () {
    const trails = readJson(path.join(ROOT, 'dados', 'trilhas_apabf.geojson'));
    const options = occurrences.buildTrailOptions(trails, []);
    const fallback = occurrences.buildTrailOptions(null, [
        { properties: { trilha_fid: '8' } },
        { properties: { trilha_fid: '8' } }
    ]);

    assert.equal(options.length, trails.features.length);
    assert.equal(new Set(options.map(function (option) {
        return option.chave;
    })).size, options.length);
    assert.deepEqual(options[0], {
        chave: String(trails.features[0].properties.fid),
        nome: trails.features[0].properties.Nome + ' (' + trails.features[0].properties.fid + ')'
    });
    assert.deepEqual(fallback, [{ chave: '8', nome: 'Trilha 8' }]);
});

test('occurrence layer and catalog load independently from the existing trail interface', function () {
    const html = fs.readFileSync(path.join(MAP_ROOT, 'index.html'), 'utf8');
    const moduleSource = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilha-ocorrencias.js'), 'utf8');
    const interfaceSource = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilhas-interface.js'), 'utf8');

    assert.match(html, /<script src="js\/trilha-ocorrencias\.js"><\/script>/);
    assert.match(moduleSource, /fetchJson\('\.\.\/dados\/ocorrencias_trilhas\.geojson'\)/);
    assert.match(moduleSource, /fetchJson\('\.\.\/dados\/catalogo_ocorrencias\.json'\)/);
    assert.match(moduleSource, /leaflet\.featureGroup\(\)/);
    assert.match(moduleSource, /map\.addLayer\(occurrenceLayer\)/);
    assert.match(moduleSource, /Não foi possível carregar as ocorrências\. As trilhas continuam disponíveis\./);
    assert.match(moduleSource, /Falha ao carregar os dados das ocorrências/);
    assert.match(interfaceSource, /trailDataReady\.then\(initializeWithTrailData\)/);
    assert.match(html, /trailDataReady\.catch/);
});

test('occurrence filters match trail, category, situation, and inclusive identification dates only', function () {
    const records = [
        { properties: {
            trilha_fid: '1',
            categoria: 'erosao_solo',
            situacao: 'pendente_avaliacao',
            data_identificacao: '2026-04-10'
        } },
        { properties: {
            trilha_fid: '2',
            categoria: 'problemas_acesso',
            situacao: 'resolvida',
            data_identificacao: '2026-04-20'
        } },
        { properties: {
            trilha_fid: '1',
            categoria: 'erosao_solo',
            situacao: 'em_atendimento',
            data_identificacao: '2026-05-01'
        } }
    ];

    assert.deepEqual(occurrences.filterOccurrences(records, {
        trailId: '1',
        category: 'erosao_solo',
        situation: 'em_atendimento',
        dateFrom: '2026-05-01',
        dateTo: '2026-05-01'
    }), [records[2]]);
    assert.deepEqual(occurrences.filterOccurrences(records, {
        dateFrom: '2026-04-10',
        dateTo: '2026-04-20'
    }), [records[0], records[1]]);
    assert.deepEqual(occurrences.filterOccurrences(records, { trailId: '99' }), []);
});

test('trail association resolves by fid and popup includes the associated trail name when available', function () {
    const trails = {
        features: [
            { properties: { fid: '1', Nome: 'Praia do Rincão' } },
            { properties: { fid: '2', Nome: 'Praia da Esplanada' } }
        ]
    };
    const moduleSource = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilha-ocorrencias.js'), 'utf8');

    assert.equal(occurrences.resolveTrailName(trails, 2), 'Praia da Esplanada');
    assert.equal(occurrences.resolveTrailName(trails, 'unknown'), null);
    assert.match(moduleSource, /resolveTrailName\(trailCollection, trailId\)/);
    assert.match(moduleSource, /\['Categoria', visuals\.categoryName\]/);
    assert.match(moduleSource, /\['Descrição', properties\.descricao\]/);
    assert.match(moduleSource, /\['Data de identificação', properties\.data_identificacao\]/);
    assert.match(moduleSource, /\['Situação', visuals\.situationLabel\]/);
    assert.match(moduleSource, /\['Trilha relacionada'/);
});

test('marker symbols and colors come from the catalog and distinguish all situations accessibly', function () {
    const catalog = readJson(path.join(ROOT, 'dados', 'catalogo_ocorrencias.json'));
    const categories = catalog.categorias.map(function (category) {
        return category.identificacao_visual.icone;
    });
    const statusIcons = catalog.situacoes.map(function (situation) {
        return situation.identificacao_visual.icone;
    });
    const statusColors = catalog.situacoes.map(function (situation) {
        return situation.identificacao_visual.cor;
    });
    const moduleSource = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilha-ocorrencias.js'), 'utf8');
    const styles = fs.readFileSync(path.join(MAP_ROOT, 'css', 'trilhas-interface.css'), 'utf8');

    assert.equal(new Set(categories).size, catalog.categorias.length);
    assert.equal(new Set(statusIcons).size, 5);
    assert.equal(new Set(statusColors).size, 5);
    catalog.situacoes.forEach(function (situation) {
        const visuals = occurrences.getMarkerVisuals(
            catalog,
            catalog.categorias[0].chave,
            situation.chave
        );
        assert.equal(visuals.situationIcon, situation.identificacao_visual.icone);
        assert.equal(visuals.situationColor, situation.identificacao_visual.cor);
    });
    assert.match(moduleSource, /categorySymbol\.classList\.add\('fas', visuals\.categoryIcon\)/);
    assert.match(moduleSource, /situationSymbol\.classList\.add\('fas', visuals\.situationIcon\)/);
    assert.match(moduleSource, /title: label/);
    assert.match(moduleSource, /alt: label/);
    assert.match(styles, /occurrence-marker__category/);
    assert.match(styles, /occurrence-marker__situation/);
    assert.match(styles, /occurrence-status-legend/);
});

test('empty occurrence collection reports no records and catalog drives all filter labels', function () {
    const collection = readJson(path.join(ROOT, 'dados', 'ocorrencias_trilhas.geojson'));
    const catalog = readJson(path.join(ROOT, 'dados', 'catalogo_ocorrencias.json'));
    const html = fs.readFileSync(path.join(MAP_ROOT, 'index.html'), 'utf8');
    const moduleSource = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilha-ocorrencias.js'), 'utf8');

    assert.deepEqual(collection.features, []);
    assert.match(html, /id="occurrence-filter-trail"/);
    assert.match(html, /id="occurrence-filter-category"/);
    assert.match(html, /id="occurrence-filter-situation"/);
    assert.match(html, /type="date"/);
    assert.match(moduleSource, /Nenhuma ocorrência cadastrada\./);
    catalog.categorias.forEach(function (category) {
        assert.ok(category.nome);
    });
});
