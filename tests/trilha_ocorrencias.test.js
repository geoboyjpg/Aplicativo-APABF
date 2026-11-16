'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const occurrences = require('../Trilha Caminhos da Baleia Franca/js/trilha-ocorrencias');

const ROOT = path.resolve(__dirname, '..');
const MAP_ROOT = path.join(ROOT, 'Trilha Caminhos da Baleia Franca');
const CATALOG_PATH = path.join(ROOT, 'dados', 'catalogo_ocorrencias.json');
const TRAILS_PATH = path.join(ROOT, 'dados', 'trilhas_apabf.geojson');

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
    const listeners = new Map();
    const classes = new Set();
    const element = {
        tagName: tagName,
        children: [],
        options: [],
        dataset: {},
        attributes: {},
        value: '',
        textContent: '',
        hidden: false,
        disabled: false,
        style: {
            setProperty: function () {}
        },
        classList: {
            add: function () {
                Array.from(arguments).forEach(function (name) {
                    classes.add(name);
                });
            },
            toggle: function (name, force) {
                if (force === undefined ? !classes.has(name) : force) {
                    classes.add(name);
                    return true;
                }
                classes.delete(name);
                return false;
            },
            contains: function (name) {
                return classes.has(name);
            }
        },
        addEventListener: function (type, handler) {
            const handlers = listeners.get(type) || [];
            handlers.push(handler);
            listeners.set(type, handlers);
        },
        appendChild: function (child) {
            this.children.push(child);
            if (this.tagName === 'select') {
                this.options.push(child);
            }
            return child;
        },
        append: function () {
            this.children.push.apply(this.children, arguments);
        },
        replaceChildren: function () {
            this.children = [];
            this.options = [];
        },
        setAttribute: function (name, value) {
            this.attributes[name] = String(value);
            if (name === 'src') {
                this.src = String(value);
            }
        },
        removeAttribute: function (name) {
            delete this.attributes[name];
            if (name === 'src') {
                this.src = '';
            }
        },
        click: function () {},
        reset: function () {
            this.children.forEach(function (child) {
                if ('value' in child) {
                    child.value = '';
                }
            });
        },
        focus: function () {},
        dispatch: function (type, event) {
            (listeners.get(type) || []).forEach(function (handler) {
                handler(Object.assign({
                    target: element,
                    preventDefault: function () {},
                    stopPropagation: function () {}
                }, event || {}));
            });
        },
        getAttribute: function (name) {
            if (name === 'src' && this.src) {
                return this.src;
            }
            return this.attributes[name] || null;
        },
        querySelectorAll: function (selector) {
            const matches = [];
            function visit(node) {
                if (!node.children) {
                    return;
                }
                node.children.forEach(function (child) {
                    if (selector === 'img[data-photo-url]' && child.tagName === 'img'
                        && child.dataset.photoUrl) {
                        matches.push(child);
                    }
                    visit(child);
                });
            }
            visit(this);
            return matches;
        },
        cloneNode: function (deep) {
            const clone = createMockElement(this.tagName);
            clone.className = this.className;
            clone.dataset = Object.assign({}, this.dataset);
            clone.attributes = Object.assign({}, this.attributes);
            clone.textContent = this.textContent;
            if (deep) {
                this.children.forEach(function (child) {
                    clone.appendChild(child.cloneNode(true));
                });
            }
            return clone;
        },
        listenerCount: function (type) {
            return (listeners.get(type) || []).length;
        }
    };
    Object.defineProperty(element, 'innerHTML', {
        get: function () {
            return this._innerHTML || '';
        },
        set: function (value) {
            this._innerHTML = value;
            this.textContent = String(value).replace(/<[^>]*>/g, '').trim();
        }
    });
    return element;
}

function createResponse(body, status) {
    return {
        ok: status >= 200 && status < 300,
        status: status,
        json: function () {
            return Promise.resolve(body);
        }
    };
}

function makeOccurrenceFeature(id, trailId, coordinates, options) {
    const settings = options || {};
    return {
        type: 'Feature',
        properties: {
            ocorrencia_id: String(id),
            trilha_fid: trailId,
            categoria: settings.category || 'erosao_solo',
            descricao: settings.description === undefined ? 'Ocorrência de teste.' : settings.description,
            data_identificacao: settings.date || '2026-04-10',
            situacao: settings.situation || 'pendente_avaliacao',
            fotografias: []
        },
        geometry: {
            type: 'Point',
            coordinates: coordinates
        }
    };
}

function createInterfaceHarness(settings) {
    const options = settings || {};
    const ids = [
        ['occurrence-status', 'p'],
        ['occurrence-action-status', 'p'],
        ['occurrence-cleanup-retry', 'button'],
        ['occurrence-form-status', 'p'],
        ['occurrence-location-status', 'p'],
        ['occurrence-filters', 'form'],
        ['occurrence-registration-form', 'form'],
        ['occurrence-query-view', 'div'],
        ['occurrence-registration-view', 'section'],
        ['occurrence-filter-trail', 'select'],
        ['occurrence-filter-category', 'select'],
        ['occurrence-filter-situation', 'select'],
        ['occurrence-filter-date-from', 'input'],
        ['occurrence-filter-date-to', 'input'],
        ['occurrence-filter-reset', 'button'],
        ['occurrence-status-legend', 'ul'],
        ['occurrence-open-form', 'button'],
        ['occurrence-registration-trail', 'select'],
        ['occurrence-registration-category', 'select'],
        ['occurrence-registration-situation', 'select'],
        ['occurrence-situation-field', 'div'],
        ['occurrence-form-title', 'h5'],
        ['occurrence-registration-description', 'textarea'],
        ['occurrence-registration-date', 'input'],
        ['occurrence-existing-photos', 'div'],
        ['occurrence-existing-photo-list', 'ul'],
        ['occurrence-existing-photo-status', 'p'],
        ['occurrence-photo-camera', 'button'],
        ['occurrence-photo-gallery', 'button'],
        ['occurrence-photo-camera-input', 'input'],
        ['occurrence-photo-gallery-input', 'input'],
        ['occurrence-photo-previews', 'ul'],
        ['occurrence-photo-status', 'p'],
        ['occurrence-pick-location', 'button'],
        ['occurrence-get-location', 'button'],
        ['occurrence-submit', 'button'],
        ['occurrence-cancel-form', 'button']
    ];
    const elements = new Map(ids.map(function (entry) {
        return [entry[0], createMockElement(entry[1])];
    }));
    const previousDocument = global.document;
    global.document = {
        getElementById: function (id) {
            return elements.get(id);
        },
        querySelector: function () {
            return null;
        },
        createElement: createMockElement,
        createTextNode: function (text) {
            return { textContent: text };
        }
    };

    const layers = new Set();
    const markers = [];
    const mapHandlers = new Map();
    const mapContainer = createMockElement('div');
    const map = {
        panes: new Map(),
        zoom: 12,
        createPane: function (name) {
            this.panes.set(name, { style: {} });
        },
        getPane: function (name) {
            return this.panes.get(name);
        },
        addLayer: function (layer) {
            layers.add(layer);
        },
        removeLayer: function (layer) {
            layers.delete(layer);
        },
        hasLayer: function (layer) {
            return layers.has(layer);
        },
        getContainer: function () {
            return mapContainer;
        },
        getZoom: function () {
            return this.zoom;
        },
        setView: function (latlng, zoom) {
            this.view = { latlng: latlng, zoom: zoom };
        },
        on: function (type, handler) {
            const handlers = mapHandlers.get(type) || [];
            handlers.push(handler);
            mapHandlers.set(type, handlers);
        },
        fire: function (type, event) {
            (mapHandlers.get(type) || []).forEach(function (handler) {
                handler(event);
            });
        }
    };

    function createMarker() {
        const markerHandlers = new Map();
        const marker = {
            handlers: markerHandlers,
            popupContent: null,
            popupOpen: false,
            bindPopup: function (content) {
                this.popupContent = content;
                return this;
            },
            on: function (type, handler) {
                const handlers = markerHandlers.get(type) || [];
                handlers.push(handler);
                markerHandlers.set(type, handlers);
                return this;
            },
            setPopupContent: function (content) {
                this.popupContent = content;
                return this;
            },
            openPopup: function () {
                this.popupOpen = true;
                (markerHandlers.get('popupopen') || []).forEach(function (handler) {
                    handler();
                });
                return this;
            },
            closePopup: function () {
                this.popupOpen = false;
                return this;
            },
            unbindPopup: function () {
                this.popupContent = null;
                return this;
            },
            isPopupOpen: function () {
                return this.popupOpen;
            },
            click: function () {
                this.openPopup();
                (markerHandlers.get('click') || []).forEach(function (handler) {
                    handler();
                });
            }
        };
        markers.push(marker);
        return marker;
    }

    const leaflet = {
        featureGroup: function () {
            return {
                layers: [],
                clearLayers: function () {
                    this.layers = [];
                },
                addLayer: function (layer) {
                    if (!this.layers.includes(layer)) {
                        this.layers.push(layer);
                    }
                }
            };
        },
        marker: createMarker,
        circleMarker: createMarker,
        divIcon: function (icon) {
            return { options: icon };
        }
    };
    const trails = readJson(path.join(ROOT, 'dados', 'trilhas_apabf.geojson'));
    const catalog = readJson(CATALOG_PATH);
    const requests = [];
    elements.get('occurrence-registration-view').hidden = true;
    const apiUrl = 'https://apabf-trilhas-api.gerhard-henrique23.workers.dev/api/ocorrencias';
    const defaultPostFeature = makeOccurrenceFeature('101', trails.features[0].properties.fid, [-49.2, -28.8]);
    const app = {
        map: map,
        L: leaflet,
        fetch: function (url, requestOptions) {
            requests.push({ url: url, options: requestOptions || {} });
            if (url === '../dados/catalogo_ocorrencias.json') {
                return Promise.resolve(createResponse(catalog, 200));
            }
            if (url === apiUrl) {
                if (requestOptions && requestOptions.method === 'POST') {
                    const body = requestOptions.body
                        ? JSON.parse(typeof requestOptions.body === 'string'
                            ? requestOptions.body
                            : requestOptions.body.get('occurrence'))
                        : null;
                    const result = typeof options.postResponse === 'function'
                        ? options.postResponse(body)
                        : options.postResponse || defaultPostFeature;
                    return Promise.resolve(createResponse(result, options.postStatus || 201));
                }
                return Promise.resolve(createResponse(
                    options.occurrences || { type: 'FeatureCollection', features: [] },
                    options.getStatus || 200
                ));
            }
            if (url.startsWith(apiUrl + '/')) {
                const result = typeof options.adminResponse === 'function'
                    ? options.adminResponse(url, requestOptions || {})
                    : options.adminResponse || {};
                const status = typeof options.adminStatus === 'function'
                    ? options.adminStatus(url, requestOptions || {})
                    : options.adminStatus || 200;
                return Promise.resolve(createResponse(result, status));
            }
            return Promise.resolve(createResponse({ error: 'Not found' }, 404));
        },
        prompt: function () {
            return options.adminToken === null ? null : options.adminToken || 'test-admin-token-for-ui-tests';
        },
        confirm: function () {
            return options.confirmDelete !== false;
        },
        FormData: global.FormData,
        trailDataReady: Promise.resolve(trails),
        json_TrilhaCaminhosdaBaleiaFranca_2: trails,
        TrilhasInterface: {
            closeSidebar: function () {
                app.sidebarOpen = false;
            },
            openOccurrences: function () {
                app.sidebarOpen = true;
                app.occurrenceTabOpen = true;
            }
        },
        navigator: options.navigator
    };
    occurrences.initialize(app);

    return {
        app: app,
        elements: elements,
        map: map,
        mapContainer: mapContainer,
        mapHandlers: mapHandlers,
        markers: markers,
        layers: layers,
        requests: requests,
        apiUrl: apiUrl,
        flush: async function () {
            await new Promise(function (resolve) {
                setImmediate(resolve);
            });
            await new Promise(function (resolve) {
                setImmediate(resolve);
            });
        },
        restoreDocument: function () {
            if (previousDocument === undefined) {
                delete global.document;
            } else {
                global.document = previousDocument;
            }
        }
    };
}

function getOccurrenceLayer(harness) {
    return Array.from(harness.layers).find(function (layer) {
        return Array.isArray(layer.layers);
    });
}

function confirmLatestLocation(harness) {
    const marker = harness.markers[harness.markers.length - 1];
    marker.popupContent.children[0].dispatch('click');
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

test('accepts nullable descriptions and JSON photo metadata from the API', function () {
    const catalog = readJson(CATALOG_PATH);
    const feature = makeOccurrenceFeature('72', 1, [-49.2, -28.8], { description: null });
    feature.properties.situacao = null;
    feature.properties.fotografias = [{ url: 'https://storage.example/photo.jpg' }];

    assert.doesNotThrow(function () {
        occurrences.validateOccurrenceCollection({
            type: 'FeatureCollection',
            features: [feature]
        }, catalog);
    });
    assert.equal(
        occurrences.getMarkerVisuals(catalog, 'erosao_solo', null).situationLabel,
        'Situação não informada'
    );
});

test('initialization fills category, situation and trail selects from the loaded files', async function () {
    const catalog = readJson(path.join(ROOT, 'dados', 'catalogo_ocorrencias.json'));
    const trails = readJson(path.join(ROOT, 'dados', 'trilhas_apabf.geojson'));
    const harness = createInterfaceHarness();
    try {
        await harness.flush();

        assert.deepEqual(harness.requests.map(function (request) {
            return request.url;
        }), [
            '../dados/catalogo_ocorrencias.json',
            harness.apiUrl
        ]);
        assert.equal(harness.elements.get('occurrence-filter-trail').options.length, trails.features.length + 1);
        assert.equal(harness.elements.get('occurrence-registration-trail').options.length, trails.features.length + 1);
        assert.equal(harness.elements.get('occurrence-filter-category').options.length, catalog.categorias.length + 1);
        assert.equal(harness.elements.get('occurrence-filter-situation').options.length, catalog.situacoes.length + 1);
        assert.equal(harness.elements.get('occurrence-registration-category').options.length, catalog.categorias.length + 1);
        assert.equal(harness.elements.get('occurrence-filter-category').options[0].textContent, 'Todas as categorias');
        assert.equal(harness.elements.get('occurrence-filter-situation').options[0].textContent, 'Todas as situações');
        assert.equal(harness.elements.get('occurrence-status').textContent, 'Nenhuma ocorrência cadastrada.');
        assert.equal(
            harness.elements.get('occurrence-status-legend').children.length,
            catalog.categorias.length + catalog.situacoes.length
        );
        assert.match(harness.elements.get('occurrence-registration-date').value, /^\d{4}-\d{2}-\d{2}$/);
    } finally {
        harness.restoreDocument();
    }
});

test('opens the registration form, pre-fills the date, and blocks incomplete submissions', async function () {
    const harness = createInterfaceHarness();
    try {
        await harness.flush();
        const queryView = harness.elements.get('occurrence-query-view');
        const registrationView = harness.elements.get('occurrence-registration-view');
        const registrationForm = harness.elements.get('occurrence-registration-form');
        const html = fs.readFileSync(path.join(MAP_ROOT, 'index.html'), 'utf8');

        assert.equal(queryView.hidden, false);
        assert.equal(registrationView.hidden, true);
        harness.elements.get('occurrence-open-form').dispatch('click');
        assert.equal(queryView.hidden, true);
        assert.equal(registrationView.hidden, false);
        assert.match(harness.elements.get('occurrence-registration-date').value, /^\d{4}-\d{2}-\d{2}$/);

        registrationForm.dispatch('submit');
        await harness.flush();
        assert.match(harness.elements.get('occurrence-form-status').textContent, /Informe a trilha/);
        assert.equal(harness.requests.filter(function (request) {
            return request.options.method === 'POST';
        }).length, 0);

        harness.elements.get('occurrence-registration-trail').value =
            String(readJson(TRAILS_PATH).features[0].properties.fid);
        harness.elements.get('occurrence-registration-category').value = 'erosao_solo';
        harness.elements.get('occurrence-registration-form').dispatch('submit');
        assert.match(harness.elements.get('occurrence-form-status').textContent, /Marque a localização/);
        assert.equal(harness.requests.filter(function (request) {
            return request.options.method === 'POST';
        }).length, 0);

        assert.match(html, /id="occurrence-registration-trail" required/);
        assert.match(html, /id="occurrence-registration-category" required/);
        assert.match(html, /id="occurrence-registration-date" type="date" required/);
        assert.match(html, /id="occurrence-photo-camera-input"[^>]*capture="environment"/);
        assert.match(html, /id="occurrence-photo-gallery-input"[^>]*multiple/);
        assert.match(html, /id="occurrence-photo-previews"/);
    } finally {
        harness.restoreDocument();
    }
});

test('confirms, replaces and cancels temporary map locations without losing the form', async function () {
    const harness = createInterfaceHarness();
    try {
        await harness.flush();
        harness.elements.get('occurrence-open-form').dispatch('click');
        harness.elements.get('occurrence-registration-description').value = 'Campo preservado';
        const pickButton = harness.elements.get('occurrence-pick-location');

        pickButton.dispatch('click');
        assert.equal(occurrences.isPickingLocation(), true);
        assert.equal(harness.mapContainer.classList.contains('occurrence-location-picking'), true);
        assert.match(harness.elements.get('occurrence-location-status').textContent, /Aguardando clique/);
        assert.equal(harness.app.sidebarOpen, false);
        const markerCount = harness.markers.length;
        harness.map.fire('click', {
            latlng: { lat: -28.9, lng: -49.3 },
            originalEvent: { target: { closest: function () { return true; } } }
        });
        assert.equal(harness.markers.length, markerCount);
        harness.map.fire('click', { latlng: { lat: -28.8, lng: -49.2 } });
        assert.equal(occurrences.isPickingLocation(), true);
        assert.match(harness.elements.get('occurrence-location-status').textContent, /Ponto provisório/);
        assert.equal(harness.layers.size, 2);
        let candidate = harness.markers[harness.markers.length - 1];
        assert.equal(candidate.popupOpen, true);
        assert.equal(candidate.popupContent.children[0].textContent, 'Selecionar localização');

        harness.map.fire('click', { latlng: { lat: -28.7, lng: -49.1 } });
        assert.equal(harness.layers.size, 2);
        candidate = harness.markers[harness.markers.length - 1];
        candidate.popupContent.children[0].dispatch('click');
        assert.equal(occurrences.isPickingLocation(), false);
        assert.equal(harness.mapContainer.classList.contains('occurrence-location-picking'), false);
        assert.match(harness.elements.get('occurrence-location-status').textContent, /-28\.70000, -49\.10000/);
        assert.equal(harness.app.sidebarOpen, true);
        assert.equal(harness.app.occurrenceTabOpen, true);
        assert.equal(harness.elements.get('occurrence-registration-description').value, 'Campo preservado');

        pickButton.dispatch('click');
        assert.equal(harness.app.sidebarOpen, false);
        harness.map.fire('click', { latlng: { lat: -28.7, lng: -49.1 } });
        candidate = harness.markers[harness.markers.length - 1];
        candidate.popupContent.children[1].dispatch('click');
        assert.equal(occurrences.isPickingLocation(), false);
        assert.equal(harness.layers.size, 2);
        assert.match(harness.elements.get('occurrence-location-status').textContent, /-28\.70000, -49\.10000/);
        assert.equal(harness.mapHandlers.get('click').length, 1);
        assert.equal(harness.elements.get('occurrence-pick-location').attributes['aria-pressed'], 'false');

        harness.elements.get('occurrence-cancel-form').dispatch('click');
        assert.equal(harness.layers.size, 1);
        assert.equal(harness.elements.get('occurrence-query-view').hidden, false);
    } finally {
        harness.restoreDocument();
    }
});

test('GPS collection is explicit, fills coordinates, reports precision and maps geolocation errors', async function () {
    const calls = [];
    const harness = createInterfaceHarness({
        navigator: {
            geolocation: {
                getCurrentPosition: function (success, error, options) {
                    calls.push({ success: success, error: error, options: options });
                }
            }
        }
    });
    try {
        await harness.flush();
        assert.equal(calls.length, 0);
        harness.elements.get('occurrence-open-form').dispatch('click');
        harness.elements.get('occurrence-get-location').dispatch('click');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.enableHighAccuracy, true);
        calls[0].success({ coords: { latitude: -28.8, longitude: -49.2, accuracy: 18 } });
        assert.match(harness.elements.get('occurrence-location-status').textContent, /Precisão aproximada: 18 m/);
        assert.deepEqual(harness.map.view, { latlng: [-28.8, -49.2], zoom: 15 });

        harness.elements.get('occurrence-get-location').dispatch('click');
        calls[1].error({ code: 1 });
        assert.match(harness.elements.get('occurrence-location-status').textContent, /Permissão de localização negada/);
        harness.elements.get('occurrence-get-location').dispatch('click');
        calls[2].error({ code: 2 });
        assert.match(harness.elements.get('occurrence-location-status').textContent, /GPS indisponível/);
        harness.elements.get('occurrence-get-location').dispatch('click');
        calls[3].error({ code: 3 });
        assert.match(harness.elements.get('occurrence-location-status').textContent, /Tempo excedido/);
        harness.elements.get('occurrence-get-location').dispatch('click');
        calls[4].success({ coords: { latitude: -28.8, longitude: -49.2, accuracy: 150 } });
        assert.equal(harness.elements.get('occurrence-location-status').dataset.state, 'warning');
        assert.match(harness.elements.get('occurrence-location-status').textContent, /Baixa precisão/);
        harness.elements.get('occurrence-get-location').dispatch('click');
        calls[5].success({ coords: { latitude: -28.8, longitude: -49.2, accuracy: 18 } });
        harness.elements.get('occurrence-registration-trail').value =
            String(readJson(TRAILS_PATH).features[0].properties.fid);
        harness.elements.get('occurrence-registration-category').value = 'erosao_solo';
        harness.elements.get('occurrence-registration-date').value = '2026-04-10';
        harness.elements.get('occurrence-registration-form').dispatch('submit');
        await harness.flush();
        const request = harness.requests.find(function (entry) {
            return entry.options.method === 'POST';
        });
        assert.deepEqual(JSON.parse(request.options.body).coordinates, [-49.2, -28.8]);
    } finally {
        harness.restoreDocument();
    }
});

test('GPS button reports when geolocation is unsupported', async function () {
    const harness = createInterfaceHarness();
    try {
        await harness.flush();
        harness.elements.get('occurrence-get-location').dispatch('click');
        assert.match(harness.elements.get('occurrence-location-status').textContent, /não oferece suporte/i);
    } finally {
        harness.restoreDocument();
    }
});

test('occurrence marker opens its popup and lazily activates private photo thumbnails', async function () {
    const feature = makeOccurrenceFeature('42', 1, [-49.2, -28.8]);
    feature.properties.fotografias = [{
        foto_id: '12345678-1234-1234-1234-123456789abc',
        url: '/api/ocorrencias/42/fotografias/12345678-1234-1234-1234-123456789abc',
        miniatura_url: '/api/ocorrencias/42/fotografias/12345678-1234-1234-1234-123456789abc/miniatura'
    }];
    const harness = createInterfaceHarness({
        occurrences: { type: 'FeatureCollection', features: [feature] }
    });
    try {
        await harness.flush();
        const marker = getOccurrenceLayer(harness).layers[0];
        assert.equal(marker.popupContent.tagName, 'div');
        assert.equal(typeof marker.popupContent.querySelectorAll, 'function');
        marker.click();
        const thumbnails = marker.popupContent.querySelectorAll('img[data-photo-url]');
        assert.equal(thumbnails.length, 1);
        assert.match(thumbnails[0].src, /\/api\/ocorrencias\/42\/fotografias\/.*\/miniatura$/);
        assert.equal(marker.popupOpen, true);
        thumbnails[0].onerror();
        assert.match(thumbnails[0].src, /\/api\/ocorrencias\/42\/fotografias\/.*$/);
        assert.doesNotMatch(thumbnails[0].src, /\/miniatura$/);
        const styles = fs.readFileSync(path.join(MAP_ROOT, 'css', 'trilhas-interface.css'), 'utf8');
        assert.match(styles, /object-fit:\s*contain/);
        assert.match(styles, /height:\s*94dvh/);
    } finally {
        harness.restoreDocument();
    }
});

test('edits an occurrence with authorization, removes photos individually and preserves map-selected coordinates', async function () {
    const firstPhotoId = '12345678-1234-4234-8234-123456789abc';
    const secondPhotoId = '22345678-1234-4234-8234-123456789abc';
    const existing = makeOccurrenceFeature('42', 1, [-49.2, -28.8], {
        description: 'Descrição original.',
        category: 'erosao_solo'
    });
    existing.properties.situacao = 'pendente_avaliacao';
    existing.properties.fotografias = [
        {
            foto_id: firstPhotoId,
            gerenciada: true,
            url: '/api/ocorrencias/42/fotografias/' + firstPhotoId,
            miniatura_url: '/api/ocorrencias/42/fotografias/' + firstPhotoId + '/miniatura'
        },
        {
            foto_id: secondPhotoId,
            gerenciada: true,
            url: '/api/ocorrencias/42/fotografias/' + secondPhotoId,
            miniatura_url: '/api/ocorrencias/42/fotografias/' + secondPhotoId + '/miniatura'
        }
    ];
    const updated = makeOccurrenceFeature('42', 1, [-49.1, -28.7], {
        description: 'Descrição editada.',
        category: 'problemas_acesso',
        situation: 'em_atendimento'
    });
    updated.properties.fotografias = [existing.properties.fotografias[1]];
    const harness = createInterfaceHarness({
        occurrences: { type: 'FeatureCollection', features: [existing] },
        adminResponse: function () {
            return updated;
        }
    });
    try {
        const source = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilha-ocorrencias.js'), 'utf8');
        assert.match(source, /global\.prompt\(/);
        assert.doesNotMatch(source, /localStorage/);
        await harness.flush();
        const marker = getOccurrenceLayer(harness).layers[0];
        marker.click();
        const actions = marker.popupContent.children[marker.popupContent.children.length - 1];
        actions.children[0].dispatch('click');

        assert.equal(harness.elements.get('occurrence-registration-view').hidden, false);
        assert.equal(harness.elements.get('occurrence-form-title').textContent, 'Editar ocorrência');
        assert.equal(harness.elements.get('occurrence-registration-description').value, 'Descrição original.');
        assert.equal(harness.elements.get('occurrence-registration-situation').value, 'pendente_avaliacao');
        assert.equal(harness.elements.get('occurrence-existing-photo-list').children.length, 2);

        harness.elements.get('occurrence-existing-photo-list').children[0].children[2].dispatch('click');
        harness.elements.get('occurrence-pick-location').dispatch('click');
        harness.map.fire('click', { latlng: { lat: -28.7, lng: -49.1 } });
        confirmLatestLocation(harness);
        assert.equal(harness.elements.get('occurrence-registration-description').value, 'Descrição original.');

        harness.elements.get('occurrence-registration-form').dispatch('submit');
        await harness.flush();
        const patch = harness.requests.find(function (request) {
            return request.options.method === 'PATCH';
        });
        const payload = JSON.parse(patch.options.body.get('occurrence'));
        assert.equal(patch.url, harness.apiUrl + '/42');
        assert.equal(patch.options.headers.Authorization, 'Bearer test-admin-token-for-ui-tests');
        assert.deepEqual(payload.coordinates, [-49.1, -28.7]);
        assert.deepEqual(payload.keep_photo_ids, [secondPhotoId]);
        assert.deepEqual(payload.keep_legacy_photo_indexes, []);
        assert.match(harness.elements.get('occurrence-action-status').textContent, /atualizada com sucesso/i);
        assert.equal(harness.elements.get('occurrence-registration-view').hidden, true);
    } finally {
        harness.restoreDocument();
    }
});

test('deletes through the protected API and offers a retry when R2 cleanup is pending', async function () {
    const existing = makeOccurrenceFeature('42', 1, [-49.2, -28.8]);
    const harness = createInterfaceHarness({
        occurrences: { type: 'FeatureCollection', features: [existing] },
        adminResponse: function (url, requestOptions) {
            return requestOptions.method === 'DELETE'
                ? { deleted: true, arquivos_pendentes: 1 }
                : { limpeza: 'concluida', arquivos_pendentes: 0 };
        },
        adminStatus: function (url, requestOptions) {
            return requestOptions.method === 'DELETE' ? 202 : 200;
        }
    });
    try {
        await harness.flush();
        const marker = getOccurrenceLayer(harness).layers[0];
        marker.click();
        const actions = marker.popupContent.children[marker.popupContent.children.length - 1];
        actions.children[1].dispatch('click');
        await harness.flush();

        const deletion = harness.requests.find(function (request) {
            return request.options.method === 'DELETE';
        });
        assert.equal(deletion.url, harness.apiUrl + '/42');
        assert.equal(deletion.options.headers.Authorization, 'Bearer test-admin-token-for-ui-tests');
        assert.match(harness.elements.get('occurrence-action-status').textContent, /aguardam limpeza no R2/i);
        assert.equal(harness.elements.get('occurrence-cleanup-retry').hidden, false);
        assert.equal(getOccurrenceLayer(harness).layers.length, 0);

        harness.elements.get('occurrence-cleanup-retry').dispatch('click');
        await harness.flush();
        const retry = harness.requests.find(function (request) {
            return request.options.method === 'POST';
        });
        assert.equal(retry.url, harness.apiUrl + '/42/limpeza');
        assert.equal(retry.options.headers.Authorization, 'Bearer test-admin-token-for-ui-tests');
        assert.match(harness.elements.get('occurrence-action-status').textContent, /limpeza .*concluída/i);
        assert.equal(harness.elements.get('occurrence-cleanup-retry').hidden, true);
    } finally {
        harness.restoreDocument();
    }
});

test('sends the API payload in longitude-latitude order and adds the confirmed marker', async function () {
    const harness = createInterfaceHarness();
    try {
        await harness.flush();
        const trailId = String(readJson(TRAILS_PATH).features[0].properties.fid);
        harness.elements.get('occurrence-open-form').dispatch('click');
        harness.elements.get('occurrence-registration-trail').value = trailId;
        harness.elements.get('occurrence-registration-category').value = 'erosao_solo';
        harness.elements.get('occurrence-registration-description').value = 'Raiz exposta no caminho.';
        harness.elements.get('occurrence-registration-date').value = '2026-04-10';
        harness.elements.get('occurrence-pick-location').dispatch('click');
        harness.map.fire('click', { latlng: { lat: -28.8, lng: -49.2 } });
        confirmLatestLocation(harness);
        harness.elements.get('occurrence-registration-form').dispatch('submit');
        await harness.flush();

        const postRequest = harness.requests.find(function (request) {
            return request.options.method === 'POST';
        });
        assert.ok(postRequest);
        assert.equal(postRequest.url, harness.apiUrl);
        assert.deepEqual(JSON.parse(postRequest.options.body), {
            trilha_fid: trailId,
            categoria: 'erosao_solo',
            descricao: 'Raiz exposta no caminho.',
            data_identificacao: '2026-04-10',
            coordinates: [-49.2, -28.8]
        });
        assert.equal(Object.hasOwn(JSON.parse(postRequest.options.body), 'situacao'), false);
        assert.equal(Object.hasOwn(JSON.parse(postRequest.options.body), 'fotografias'), false);
        assert.match(harness.elements.get('occurrence-action-status').textContent, /cadastrada com sucesso/i);
        assert.equal(harness.elements.get('occurrence-registration-view').hidden, true);
        assert.equal(getOccurrenceLayer(harness).layers.length, 1);
    } finally {
        harness.restoreDocument();
    }
});

test('updates a repeated occurrence ID instead of duplicating its marker', async function () {
    const existing = makeOccurrenceFeature('42', 1, [-49.2, -28.8]);
    const updated = makeOccurrenceFeature('42', 1, [-49.1, -28.7]);
    const harness = createInterfaceHarness({
        occurrences: { type: 'FeatureCollection', features: [existing] },
        postResponse: updated
    });
    try {
        await harness.flush();
        harness.elements.get('occurrence-open-form').dispatch('click');
        harness.elements.get('occurrence-registration-trail').value = '1';
        harness.elements.get('occurrence-registration-category').value = 'erosao_solo';
        harness.elements.get('occurrence-registration-date').value = '2026-04-10';
        harness.elements.get('occurrence-pick-location').dispatch('click');
        harness.map.fire('click', { latlng: { lat: -28.7, lng: -49.1 } });
        confirmLatestLocation(harness);
        harness.elements.get('occurrence-registration-form').dispatch('submit');
        await harness.flush();

        assert.equal(getOccurrenceLayer(harness).layers.length, 1);
        assert.equal(Array.from(harness.layers).filter(function (layer) {
            return Array.isArray(layer.layers);
        }).length, 1);
    } finally {
        harness.restoreDocument();
    }
});

test('preserves active filters while updating the occurrence layer after a submission', async function () {
    const trails = readJson(TRAILS_PATH).features;
    const firstId = String(trails[0].properties.fid);
    const secondId = String(trails[1].properties.fid);
    const initial = makeOccurrenceFeature('42', secondId, [-49.2, -28.8], {
        category: 'problemas_acesso'
    });
    const added = makeOccurrenceFeature('43', firstId, [-49.1, -28.7]);
    const harness = createInterfaceHarness({
        occurrences: { type: 'FeatureCollection', features: [initial] },
        postResponse: added
    });
    try {
        await harness.flush();
        const trailFilter = harness.elements.get('occurrence-filter-trail');
        trailFilter.value = secondId;
        trailFilter.dispatch('change');
        assert.equal(getOccurrenceLayer(harness).layers.length, 1);

        harness.elements.get('occurrence-open-form').dispatch('click');
        harness.elements.get('occurrence-registration-trail').value = firstId;
        harness.elements.get('occurrence-registration-category').value = 'erosao_solo';
        harness.elements.get('occurrence-registration-date').value = '2026-04-10';
        harness.elements.get('occurrence-pick-location').dispatch('click');
        harness.map.fire('click', { latlng: { lat: -28.7, lng: -49.1 } });
        confirmLatestLocation(harness);
        harness.elements.get('occurrence-registration-form').dispatch('submit');
        await harness.flush();

        assert.equal(trailFilter.value, secondId);
        assert.equal(getOccurrenceLayer(harness).layers.length, 1);
        assert.match(harness.elements.get('occurrence-action-status').textContent, /cadastrada com sucesso/i);
    } finally {
        harness.restoreDocument();
    }
});

test('handles unavailable API responses without treating local GeoJSON as confirmed records', async function () {
    const harness = createInterfaceHarness({ getStatus: 404 });
    try {
        await harness.flush();

        assert.match(harness.elements.get('occurrence-status').textContent, /ainda não está disponível na API/i);
        assert.equal(harness.elements.get('occurrence-filter-category').options.length, 8);
        assert.equal(getOccurrenceLayer(harness).layers.length, 0);
        assert.equal(harness.requests.some(function (request) {
            return request.url.endsWith('ocorrencias_trilhas.geojson');
        }), false);
    } finally {
        harness.restoreDocument();
    }
});

test('presents POST HTTP errors without reporting success or leaving the form', async function () {
    const harness = createInterfaceHarness({
        postStatus: 429,
        postResponse: { error: 'Limite de envios atingido.' }
    });
    try {
        await harness.flush();
        harness.elements.get('occurrence-open-form').dispatch('click');
        harness.elements.get('occurrence-registration-trail').value = '1';
        harness.elements.get('occurrence-registration-category').value = 'erosao_solo';
        harness.elements.get('occurrence-registration-date').value = '2026-04-10';
        harness.elements.get('occurrence-pick-location').dispatch('click');
        harness.map.fire('click', { latlng: { lat: -28.8, lng: -49.2 } });
        confirmLatestLocation(harness);
        harness.elements.get('occurrence-registration-form').dispatch('submit');
        await harness.flush();

        assert.match(harness.elements.get('occurrence-form-status').textContent, /Muitos envios/i);
        assert.equal(harness.elements.get('occurrence-registration-view').hidden, false);
        assert.equal(harness.elements.get('occurrence-action-status').textContent, '');
    } finally {
        harness.restoreDocument();
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

test('occurrences load from the API without local-data fallback and preserve trail integration', function () {
    const html = fs.readFileSync(path.join(MAP_ROOT, 'index.html'), 'utf8');
    const moduleSource = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilha-ocorrencias.js'), 'utf8');
    const interfaceSource = fs.readFileSync(path.join(MAP_ROOT, 'js', 'trilhas-interface.js'), 'utf8');

    assert.match(html, /<script src="js\/trilha-ocorrencias\.js"><\/script>/);
    assert.match(moduleSource, /fetchJson\('\.\.\/dados\/catalogo_ocorrencias\.json'\)/);
    assert.match(moduleSource, /API_BASE_URL \+ '\/api\/ocorrencias'/);
    assert.match(moduleSource, /new global\.FormData\(\)/);
    const multipartSubmission = moduleSource.match(
        /if \(selectedPhotos\.length \|\| isEditing\) \{([\s\S]*?)\} else \{/
    )[1];
    assert.match(multipartSubmission, /requestOptions\.body = formData/);
    assert.doesNotMatch(multipartSubmission, /Content-Type/);
    assert.doesNotMatch(moduleSource, /fetchJson\('\.\.\/dados\/ocorrencias_trilhas\.geojson'\)/);
    assert.match(moduleSource, /leaflet\.featureGroup\(\)/);
    assert.match(moduleSource, /map\.addLayer\(occurrenceLayer\)/);
    assert.match(moduleSource, /Não foi possível carregar as ocorrências da API/);
    assert.match(interfaceSource, /trailDataReady\.then\(initializeWithTrailData\)/);
    assert.match(interfaceSource, /occurrenceModule\.isPickingLocation\(\)/);
    assert.match(interfaceSource, /setHighlight\(trail\);/);
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
    assert.match(moduleSource, /\['Descrição', properties\.descricao \|\| 'Sem descrição informada\.'\]/);
    assert.match(moduleSource, /\['Data de identificação', properties\.data_identificacao\]/);
    assert.match(moduleSource, /\['Situação', visuals\.situationLabel\]/);
    assert.match(moduleSource, /\['Trilha relacionada'/);
});

test('marker symbols and colors come from the catalog and the legend covers categories and situations', function () {
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
    assert.match(moduleSource, /catalog\.categorias\.forEach/);
    assert.match(moduleSource, /catalog\.situacoes\.forEach/);
    assert.doesNotMatch(moduleSource, /marker\.bindTooltip/);
    assert.doesNotMatch(moduleSource, /title: label/);
    assert.match(styles, /occurrence-marker__category/);
    assert.match(styles, /occurrence-marker__situation/);
    assert.match(styles, /occurrence-status-legend/);
});

test('institutional trails landing page presents both initiatives and a centered responsive map link', function () {
    const html = fs.readFileSync(path.join(ROOT, 'trilhas.html'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'institutional-pages.css'), 'utf8');

    assert.match(html, /Caminhos da Baleia Franca/);
    assert.match(html, /Rede Brasileira de Trilhas de Longo Curso/);
    assert.match(html, /https:\/\/redetrilhas\.org\.br\/w3\//);
    assert.match(html, /Acessar o mapa de trilhas/);
    assert.match(styles, /justify-content:\s*center/);
    assert.match(styles, /trails-overview-grid/);
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
