(function () {
    'use strict';

    var config = window.CAMADAS_GEOGRAFICAS;
    var catalogUrl = 'https://api.github.com/repos/' + config.repository + '/git/trees/' + config.branch + '?recursive=1';
    var rawBaseUrl = 'https://raw.githubusercontent.com/' + config.repository + '/' + config.branch + '/';
    var palette = ['#12647a', '#2e8b57', '#e28b32', '#2589b5', '#9b5b3c', '#7857a5'];
    var layerStates = new Map();
    var map = L.map('geo-map', { zoomControl: false, minZoom: 5, maxZoom: 19 }).setView([-28.2, -48.8], 8);
    var legendList = document.getElementById('geo-legend-list');
    var legendEmpty = document.getElementById('geo-legend-empty');
    var layerList = document.getElementById('geo-layer-list');
    var catalogStatus = document.getElementById('geo-catalog-status');
    var retryButton = document.getElementById('geo-retry');
    var basemapStatus = document.getElementById('geo-basemap-status');
    var dataAttribution = document.getElementById('geo-data-attribution');
    var catalogGeneration = 0;
    var attributionRequest = 0;
    var attributionTimer;

    function setBasemapStatus(message, isError) {
        basemapStatus.textContent = message;
        if (isError) {
            basemapStatus.setAttribute('role', 'alert');
        } else {
            basemapStatus.setAttribute('role', 'status');
        }
    }

    function loadSatelliteBasemap() {
        var apiKey = config.googleMapsApiKey.trim();
        if (!apiKey) {
            setBasemapStatus('Para exibir o Google Satellite, configure sua chave Google Maps Platform em camadas-geograficas.js. Restrinja a chave ao domínio publicado e à Map Tiles API. Para testar localmente, abra o projeto por um servidor HTTP; o GitHub Pages atende esse requisito.', true);
            return Promise.resolve();
        }

        setBasemapStatus('Conectando ao Google Satellite…', false);
        return fetch('https://tile.googleapis.com/v1/createSession?key=' + encodeURIComponent(apiKey), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mapType: 'satellite',
                language: 'pt-BR',
                region: 'BR'
            })
        })
            .then(function (response) {
                if (!response.ok) {
                    return response.json().catch(function () {
                        throw new Error('O Google Maps respondeu com HTTP ' + response.status + '.');
                    }).then(function (errorBody) {
                        var message = errorBody.error && errorBody.error.message;
                        throw new Error(message || 'O Google Maps respondeu com HTTP ' + response.status + '.');
                    });
                }
                return response.json();
            })
            .then(function (sessionData) {
                if (!sessionData.session) {
                    throw new Error('O Google Maps não retornou um token de sessão.');
                }

                var tileUrl = 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=' +
                    encodeURIComponent(sessionData.session) + '&key=' + encodeURIComponent(apiKey);
                L.tileLayer(tileUrl, {
                    maxZoom: 19,
                    maxNativeZoom: 19,
                    attribution: '&copy; <a href="https://maps.google.com/" target="_blank" rel="noopener noreferrer">Google Maps</a>'
                }).addTo(map);
                setBasemapStatus('', false);
                updateDataAttribution(apiKey, sessionData.session);
                map.on('moveend zoomend', function () {
                    window.clearTimeout(attributionTimer);
                    attributionTimer = window.setTimeout(function () {
                        updateDataAttribution(apiKey, sessionData.session);
                    }, 350);
                });
            })
            .catch(function (error) {
                console.error('Não foi possível carregar o mapa-base Google Satellite:', error);
                setBasemapStatus('Não foi possível carregar o Google Satellite: ' + error.message + ' Verifique a chave, a ativação da Map Tiles API, o faturamento e as restrições de domínio.', true);
            });
    }

    function updateDataAttribution(apiKey, sessionToken) {
        var requestId = ++attributionRequest;
        var bounds = map.getBounds();
        var query = new URLSearchParams({
            session: sessionToken,
            key: apiKey,
            zoom: String(Math.floor(map.getZoom())),
            north: String(bounds.getNorth()),
            south: String(bounds.getSouth()),
            east: String(bounds.getEast()),
            west: String(bounds.getWest())
        });

        fetch('https://tile.googleapis.com/v1/mapTypes/satellite/viewport?' + query.toString())
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('O Google Maps respondeu com HTTP ' + response.status + '.');
                }
                return response.json();
            })
            .then(function (viewport) {
                if (requestId !== attributionRequest) {
                    return;
                }
                dataAttribution.textContent = viewport.copyright || '';
            })
            .catch(function (error) {
                console.error('Não foi possível consultar os créditos do mapa-base:', error);
            });
    }

    L.control.zoom({ position: 'topright' }).addTo(map);
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
        var table = document.createElement('table');
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

        container.appendChild(table);
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
                layer.bindPopup(createPopup(feature.properties));
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
        state.loadPromise = fetch(rawBaseUrl + encodedPath)
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
                setLayerStatus(state, 'Falha ao carregar. Marque novamente para tentar.', true);
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

    function loadCatalog() {
        var generation = ++catalogGeneration;
        catalogStatus.removeAttribute('role');
        catalogStatus.textContent = 'Buscando camadas publicadas no GitHub…';
        retryButton.hidden = true;

        fetch(catalogUrl, { headers: { Accept: 'application/vnd.github+json' } })
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('O GitHub respondeu com HTTP ' + response.status + '.');
                }
                return response.json();
            })
            .then(function (catalog) {
                if (generation !== catalogGeneration) {
                    return;
                }
                if (!catalog || !Array.isArray(catalog.tree)) {
                    throw new Error('A resposta do GitHub não contém a lista de arquivos esperada.');
                }
                var files = catalog.tree
                    .filter(function (entry) {
                        return entry.type === 'blob' && /\.geojson$/i.test(entry.path);
                    })
                    .map(function (entry) {
                        return entry.path;
                    });
                renderLayers(files);
                catalogStatus.textContent = files.length
                    ? files.length + (files.length === 1 ? ' camada encontrada no repositório.' : ' camadas encontradas no repositório.')
                    : 'Nenhum arquivo GeoJSON foi encontrado no repositório.';
            })
            .catch(function (error) {
                if (generation !== catalogGeneration) {
                    return;
                }
                console.error('Não foi possível consultar as camadas do repositório:', error);
                catalogStatus.textContent = 'Não foi possível consultar o repositório de dados. Verifique sua conexão e tente novamente.';
                catalogStatus.setAttribute('role', 'alert');
                retryButton.hidden = false;
            });
    }

    retryButton.addEventListener('click', loadCatalog);
    map.on('layeradd layerremove', updateLegend);
    loadSatelliteBasemap();
    loadCatalog();
}());
