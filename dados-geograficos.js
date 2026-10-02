(function () {
    'use strict';

    var config = window.CAMADAS_GEOGRAFICAS;
    var palette = ['#12647a', '#2e8b57', '#e28b32', '#2589b5', '#9b5b3c', '#7857a5'];
    var layerStates = new Map();
    var map = L.map('geo-map', { zoomControl: false, minZoom: 5, maxZoom: 19 }).setView([-28.2, -48.8], 8);
    var legendList = document.getElementById('geo-legend-list');
    var legendEmpty = document.getElementById('geo-legend-empty');
    var layerList = document.getElementById('geo-layer-list');
    var catalogStatus = document.getElementById('geo-catalog-status');
    var layerSearch = document.getElementById('geo-layer-search');
    var layerNoResults = document.getElementById('geo-layer-no-results');

    map.createPane('pane_GoogleSatellite');
    map.getPane('pane_GoogleSatellite').style.zIndex = 200;
    L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
        pane: 'pane_GoogleSatellite',
        opacity: 1,
        attribution: '<a href="https://www.google.at/permissions/geoguidelines/attr-guide.html" target="_blank" rel="noopener noreferrer">Map data &copy; Google</a>',
        minZoom: 1,
        maxZoom: 18,
        minNativeZoom: 0,
        maxNativeZoom: 20
    }).addTo(map);

    L.control.zoom({ position: 'topright' }).addTo(map);
    var locateControl = L.control.locate({ position: 'bottomleft', locateOptions: { maxZoom: 19 } }).addTo(map);
    var locateButton = locateControl.getContainer().querySelector('a');
    var locateLabel = document.createElement('span');
    locateLabel.className = 'leaflet-control-locate-label';
    locateLabel.textContent = 'Centralizar';
    locateButton.setAttribute('aria-label', 'Centralizar');
    locateButton.title = 'Centralizar';
    locateButton.firstElementChild.setAttribute('aria-hidden', 'true');
    locateButton.appendChild(locateLabel);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    function displayName(path) {
        var basename = path.split('/').pop().replace(/\.geojson$/i, '');
        return basename.replace(/[_-]+/g, ' ').replace(/\b\w/g, function (letter) {
            return letter.toLocaleUpperCase('pt-BR');
        });
    }

    function describeValue(value) {
        if (value === null || value === undefined || value === '') {
            return '';
        }
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return String(value);
    }

    function createPopup(properties) {
        var container = document.createElement('div');
        var scrollArea = document.createElement('div');
        var table = document.createElement('table');
        scrollArea.className = 'geo-popup-scroll';
        table.className = 'geo-popup-table';
        var entries = properties && typeof properties === 'object' ? Object.entries(properties) : [];
        var availableEntries = entries.filter(function (entry) {
            return describeValue(entry[1]) !== '';
        });

        if (!availableEntries.length) {
            container.textContent = 'Esta feição não possui atributos disponíveis.';
            return container;
        }

        availableEntries.forEach(function (entry) {
            var row = document.createElement('tr');
            var key = document.createElement('th');
            var value = document.createElement('td');
            key.scope = 'row';
            key.textContent = entry[0];
            value.textContent = describeValue(entry[1]);
            row.appendChild(key);
            row.appendChild(value);
            table.appendChild(row);
        });

        scrollArea.appendChild(table);
        container.appendChild(scrollArea);
        return container;
    }

    function updateLegend() {
        legendList.replaceChildren();
        var activeStates = Array.from(layerStates.values()).filter(function (state) {
            return state.geoJsonLayer && map.hasLayer(state.geoJsonLayer);
        });
        legendEmpty.hidden = activeStates.length > 0;

        activeStates.forEach(function (state) {
            var item = document.createElement('li');
            var symbol = document.createElement('span');
            var label = document.createElement('span');
            symbol.className = 'geo-legend-symbol';
            symbol.style.setProperty('--legend-color', state.definition.color);
            symbol.setAttribute('aria-hidden', 'true');

            if (state.geometryType === 'line') {
                symbol.classList.add('is-line');
            } else if (state.geometryType === 'point') {
                symbol.classList.add('is-point');
            }

            label.textContent = state.definition.name;
            item.className = 'geo-legend-item';
            item.appendChild(symbol);
            item.appendChild(label);
            legendList.appendChild(item);
        });
    }

    function geometryKind(geojson) {
        var features = geojson.type === 'FeatureCollection'
            ? geojson.features
            : [geojson.type === 'Feature' ? geojson : { geometry: geojson }];
        var types = features.map(function (feature) {
            return feature && feature.geometry ? feature.geometry.type : '';
        });

        if (types.some(function (type) { return /Point/.test(type); })) {
            return 'point';
        }
        if (types.some(function (type) { return /LineString/.test(type); })) {
            return 'line';
        }
        return 'polygon';
    }

    function createLayer(state, geojson) {
        if (!geojson || ['FeatureCollection', 'Feature', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].indexOf(geojson.type) === -1) {
            throw new Error('O arquivo não contém um GeoJSON válido.');
        }

        state.geometryType = geometryKind(geojson);
        return L.geoJSON(geojson, {
            style: function () {
                return {
                    color: state.definition.color,
                    fillColor: state.definition.color,
                    weight: 2,
                    opacity: 0.9,
                    fillOpacity: 0.2
                };
            },
            pointToLayer: function (feature, latlng) {
                return L.circleMarker(latlng, {
                    radius: 6,
                    color: '#ffffff',
                    weight: 1.5,
                    fillColor: state.definition.color,
                    fillOpacity: 0.9
                });
            },
            onEachFeature: function (feature, layer) {
                var maxWidth = Math.max(180, Math.min(window.innerWidth - 40, map.getSize().x - 56, 520));
                layer.bindPopup(createPopup(feature.properties), {
                    minWidth: Math.min(180, maxWidth),
                    maxWidth: maxWidth,
                    maxHeight: Math.max(180, Math.min(window.innerHeight - 120, map.getSize().y - 32, 420)),
                    autoPanPadding: [16, 16],
                    keepInView: true
                });
            }
        });
    }

    function setLayerStatus(state, message, isError) {
        state.status.textContent = message;
        state.status.setAttribute('aria-live', 'polite');
        state.status.classList.toggle('is-error', Boolean(isError));
    }

    function loadLayer(state) {
        if (state.loadPromise) {
            return state.loadPromise;
        }

        setLayerStatus(state, 'Carregando dados do GitHub…', false);
        var encodedPath = state.path.split('/').map(encodeURIComponent).join('/');
        state.loadPromise = fetch(encodedPath)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('O GitHub respondeu com HTTP ' + response.status + '.');
                }
                return response.json();
            })
            .then(function (geojson) {
                state.geoJsonLayer = createLayer(state, geojson);
                if (state.checkbox.checked) {
                    state.geoJsonLayer.addTo(map);
                    setLayerStatus(state, 'Camada exibida no mapa.', false);
                    updateLegend();

                    var bounds = state.geoJsonLayer.getBounds();
                    if (state.definition.initiallyVisible && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [22, 22], maxZoom: 12 });
                    }
                } else {
                    setLayerStatus(state, 'Carregada; desativada no mapa.', false);
                }
            })
            .catch(function (error) {
                console.error('Não foi possível carregar a camada ' + state.path + ':', error);
                state.checkbox.checked = false;
                var retryMessage = window.location.protocol === 'file:'
                    ? 'A leitura de GeoJSON requer um servidor HTTP local; abra o projeto por HTTP e tente novamente.'
                    : 'Falha ao carregar. Verifique o arquivo no repositório e marque novamente para tentar.';
                setLayerStatus(state, retryMessage, true);
                updateLegend();
            })
            .finally(function () {
                state.loadPromise = null;
            });

        return state.loadPromise;
    }

    function handleLayerChange(state) {
        if (state.checkbox.checked) {
            if (state.geoJsonLayer) {
                state.geoJsonLayer.addTo(map);
                setLayerStatus(state, 'Camada exibida no mapa.', false);
                updateLegend();
                return;
            }
            loadLayer(state);
            return;
        }

        if (state.geoJsonLayer && map.hasLayer(state.geoJsonLayer)) {
            map.removeLayer(state.geoJsonLayer);
        }
        setLayerStatus(state, state.loadPromise ? 'Carregamento em andamento…' : '', false);
        updateLegend();
    }

    function renderLayers(files) {
        layerList.replaceChildren();
        layerStates.clear();
        var orderedFiles = files.sort(function (first, second) {
            var firstConfigured = Object.prototype.hasOwnProperty.call(config.definitions, first);
            var secondConfigured = Object.prototype.hasOwnProperty.call(config.definitions, second);
            if (firstConfigured !== secondConfigured) {
                return firstConfigured ? -1 : 1;
            }
            return first.localeCompare(second, 'pt-BR');
        });

        orderedFiles.forEach(function (path, index) {
            var configured = config.definitions[path] || {};
            var definition = {
                name: configured.name || displayName(path),
                color: configured.color || palette[index % palette.length],
                initiallyVisible: Boolean(configured.initiallyVisible)
            };
            var item = document.createElement('label');
            var checkbox = document.createElement('input');
            var textWrapper = document.createElement('span');
            var name = document.createElement('span');
            var status = document.createElement('span');
            var state = {
                path: path,
                definition: definition,
                checkbox: checkbox,
                status: status,
                geometryType: '',
                geoJsonLayer: null,
                loadPromise: null
            };

            item.className = 'geo-layer-option';
            checkbox.type = 'checkbox';
            checkbox.checked = definition.initiallyVisible;
            checkbox.setAttribute('aria-label', definition.name);
            name.className = 'geo-layer-label';
            name.textContent = definition.name;
            status.className = 'geo-layer-status';
            textWrapper.appendChild(name);
            textWrapper.appendChild(status);
            item.appendChild(checkbox);
            item.appendChild(textWrapper);
            layerList.appendChild(item);
            layerStates.set(path, state);
            checkbox.addEventListener('change', function () {
                handleLayerChange(state);
            });

            if (checkbox.checked) {
                loadLayer(state);
            }
        });

        if (!orderedFiles.length) {
            var empty = document.createElement('p');
            empty.className = 'geo-catalog-status';
            empty.textContent = 'Nenhum arquivo GeoJSON foi encontrado no repositório.';
            layerList.appendChild(empty);
        }
        updateLegend();
    }

    function filterLayers() {
        var query = layerSearch.value.trim().toLocaleLowerCase('pt-BR');
        var visibleCount = 0;

        Array.from(layerList.querySelectorAll('.geo-layer-option')).forEach(function (item) {
            var name = item.querySelector('.geo-layer-label').textContent.toLocaleLowerCase('pt-BR');
            var matches = name.indexOf(query) !== -1;
            item.hidden = !matches;
            if (matches) {
                visibleCount += 1;
            }
        });

        layerNoResults.hidden = visibleCount > 0 || !query;
    }

    function loadCatalog() {
        var files = Object.keys(config.definitions || {});
        renderLayers(files);
        catalogStatus.textContent = files.length
            ? files.length + (files.length === 1 ? ' camada configurada.' : ' camadas configuradas.')
            : 'Nenhuma camada está configurada.';
    }

    map.on('layeradd layerremove', updateLegend);
    layerSearch.addEventListener('input', filterLayers);
    loadCatalog();
}());
