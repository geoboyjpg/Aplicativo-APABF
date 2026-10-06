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
    var downloadDialog = document.getElementById('geo-download-dialog');
    var downloadOpenButton = document.getElementById('geo-download-open');
    var downloadCloseButton = document.getElementById('geo-download-close');
    var downloadLayers = document.getElementById('geo-download-layers');
    var downloadEmpty = document.getElementById('geo-download-empty');
    var downloadSelectedButton = document.getElementById('geo-download-selected');
    var downloadStatus = document.getElementById('geo-download-status');
    var selectedDownloads = new Set();
    var downloadFormats = [
        { key: 'geojson', label: 'GeoJSON' },
        { key: 'kml', label: 'KML' },
        { key: 'shapefile', label: 'Shapefile (.zip)' },
        { key: 'geopackage', label: 'GeoPackage (.gpkg)' }
    ];

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
    locateButton.firstElementChild.remove();
    locateButton.setAttribute('aria-label', 'Centralizar');
    locateButton.title = 'Centralizar';
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

    function downloadFile(state, formatKey) {
        var url = state.definition.downloads && state.definition.downloads[formatKey];
        if (!url) {
            return Promise.reject(new Error('O formato selecionado não está disponível para esta camada.'));
        }

        return fetch(url)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('O servidor respondeu com HTTP ' + response.status + '.');
                }
                return response.blob();
            })
            .then(function (file) {
                var filename = decodeURIComponent(new URL(url).pathname.split('/').pop());
                var objectUrl = URL.createObjectURL(file);
                var link = document.createElement('a');
                link.href = objectUrl;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                window.setTimeout(function () {
                    URL.revokeObjectURL(objectUrl);
                }, 1000);
                return filename;
            });
    }

    function downloadJobKey(path, formatKey) {
        return JSON.stringify([path, formatKey]);
    }

    function downloadFilesSequentially(jobs, button, status) {
        if (!jobs.length) {
            status.textContent = 'Selecione pelo menos um formato.';
            return;
        }

        button.disabled = true;
        status.textContent = 'Preparando os downloads selecionados…';
        var failures = 0;
        var queue = Promise.resolve();

        jobs.forEach(function (job, index) {
            queue = queue.then(function () {
                job.status.textContent = 'Preparando download…';
                return downloadFile(job.state, job.formatKey)
                    .then(function (filename) {
                        job.status.textContent = 'Download iniciado: ' + filename;
                    })
                    .catch(function (error) {
                        failures += 1;
                        console.error('Não foi possível baixar os dados da camada ' + job.state.definition.name + ':', error);
                        job.status.textContent = 'Falha no download: ' + error.message;
                    })
                    .then(function () {
                        if (index < jobs.length - 1) {
                            return new Promise(function (resolve) {
                                window.setTimeout(resolve, 500);
                            });
                        }
                    });
            });
        });

        queue.finally(function () {
            button.disabled = false;
            status.textContent = failures
                ? 'Downloads concluídos com ' + failures + (failures === 1 ? ' falha.' : ' falhas.')
                : 'Downloads selecionados iniciados.';
        });
    }

    function renderDownloadLayers() {
        downloadLayers.querySelectorAll('.geo-download-format input:checked').forEach(function (input) {
            selectedDownloads.add(downloadJobKey(input.dataset.layerPath, input.value));
        });
        downloadLayers.replaceChildren();
        var activeStates = Array.from(layerStates.values()).filter(function (state) {
            return state.geoJsonLayer && map.hasLayer(state.geoJsonLayer);
        });
        downloadEmpty.hidden = activeStates.length > 0;
        downloadLayers.hidden = activeStates.length === 0;
        downloadEmpty.textContent = 'Selecione pelo menos uma camada para baixar.';

        activeStates.forEach(function (state) {
            var item = document.createElement('section');
            var title = document.createElement('h3');
            var options = document.createElement('fieldset');
            var legend = document.createElement('legend');
            var status = document.createElement('p');
            var button = document.createElement('button');
            var availableFormats = downloadFormats.filter(function (format) {
                return state.definition.downloads && state.definition.downloads[format.key];
            });

            item.className = 'geo-download-layer';
            item.dataset.layerPath = state.path;
            title.className = 'geo-download-layer-title';
            title.textContent = state.definition.name;
            options.className = 'geo-download-formats';
            legend.textContent = 'Formato';
            options.appendChild(legend);
            status.className = 'geo-download-status';
            status.setAttribute('role', 'status');
            button.className = 'geo-download-button';
            button.type = 'button';
            button.textContent = 'Baixar';
            button.disabled = availableFormats.length === 0;

            availableFormats.forEach(function (format) {
                var label = document.createElement('label');
                var input = document.createElement('input');
                input.type = 'checkbox';
                input.dataset.layerPath = state.path;
                input.value = format.key;
                input.checked = selectedDownloads.has(downloadJobKey(state.path, format.key));
                label.className = 'geo-download-format';
                input.addEventListener('change', function () {
                    var key = downloadJobKey(state.path, format.key);
                    if (input.checked) {
                        selectedDownloads.add(key);
                    } else {
                        selectedDownloads.delete(key);
                    }
                });
                label.appendChild(input);
                label.appendChild(document.createTextNode(format.label));
                options.appendChild(label);
            });

            button.addEventListener('click', function () {
                var jobs = Array.from(options.querySelectorAll('input:checked')).map(function (input) {
                    return {
                        state: state,
                        formatKey: input.value,
                        status: status
                    };
                });
                downloadFilesSequentially(jobs, button, status);
            });

            item.appendChild(title);
            item.appendChild(options);
            item.appendChild(button);
            item.appendChild(status);
            downloadLayers.appendChild(item);
        });
    }

    function downloadSelectedFormats() {
        var jobs = Array.from(downloadLayers.querySelectorAll('.geo-download-format input:checked')).map(function (input) {
            var item = input.closest('.geo-download-layer');
            return {
                state: layerStates.get(input.dataset.layerPath),
                formatKey: input.value,
                status: item.querySelector('.geo-download-status')
            };
        }).filter(function (job) {
            return job.state && job.state.definition.downloads[job.formatKey];
        });

        downloadFilesSequentially(jobs, downloadSelectedButton, downloadStatus);
    }

    function layerStyle(state, isPoint) {
        if (isPoint) {
            return {
                color: '#ffffff',
                fillColor: state.definition.color,
                weight: 1.5,
                opacity: 0.9,
                fillOpacity: 0.9
            };
        }
        return {
            color: state.definition.color,
            fillColor: state.definition.color,
            weight: 2,
            opacity: 0.9,
            fillOpacity: 0.2
        };
    }

    function applyLayerColor(layer, state) {
        if (layer instanceof L.CircleMarker) {
            layer.setStyle(layerStyle(state, true));
        } else if (layer instanceof L.Path) {
            layer.setStyle(layerStyle(state, false));
        } else if (typeof layer.eachLayer === 'function') {
            layer.eachLayer(function (childLayer) {
                applyLayerColor(childLayer, state);
            });
        }
    }

    function updateLayerColor(state, color) {
        state.definition.color = color;
        if (state.geoJsonLayer) {
            state.geoJsonLayer.eachLayer(function (layer) {
                applyLayerColor(layer, state);
            });
        }
        updateLegend();
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
                return layerStyle(state, false);
            },
            pointToLayer: function (feature, latlng) {
                var style = layerStyle(state, true);
                style.radius = 6;
                return L.circleMarker(latlng, style);
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
        state.status.hidden = !isError;
        state.status.setAttribute('aria-live', 'polite');
        state.status.classList.toggle('is-error', Boolean(isError));
    }

    function loadLayer(state) {
        if (state.loadPromise) {
            return state.loadPromise;
        }

        setLayerStatus(state, '', false);
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
                    setLayerStatus(state, '', false);
                    updateLegend();

                    var bounds = state.geoJsonLayer.getBounds();
                    if (state.definition.initiallyVisible && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [22, 22], maxZoom: 12 });
                    }
                } else {
                    setLayerStatus(state, '', false);
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
                setLayerStatus(state, '', false);
                updateLegend();
                return;
            }
            loadLayer(state);
            return;
        }

        if (state.geoJsonLayer && map.hasLayer(state.geoJsonLayer)) {
            map.removeLayer(state.geoJsonLayer);
        }
        setLayerStatus(state, '', false);
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
                initiallyVisible: Boolean(configured.initiallyVisible),
                downloads: configured.downloads || {}
            };
            var item = document.createElement('div');
            var checkbox = document.createElement('input');
            var textWrapper = document.createElement('label');
            var name = document.createElement('span');
            var colorPicker = document.createElement('input');
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
            checkbox.id = 'geo-layer-toggle-' + index;
            checkbox.checked = definition.initiallyVisible;
            checkbox.setAttribute('aria-label', definition.name);
            textWrapper.htmlFor = checkbox.id;
            colorPicker.type = 'color';
            colorPicker.className = 'geo-layer-color';
            colorPicker.value = definition.color;
            colorPicker.setAttribute('aria-label', 'Alterar a cor da camada ' + definition.name);
            name.className = 'geo-layer-label';
            name.textContent = definition.name;
            status.className = 'geo-layer-status';
            textWrapper.appendChild(name);
            textWrapper.appendChild(status);
            item.appendChild(checkbox);
            item.appendChild(textWrapper);
            item.appendChild(colorPicker);
            layerList.appendChild(item);
            layerStates.set(path, state);
            checkbox.addEventListener('change', function () {
                handleLayerChange(state);
            });
            colorPicker.addEventListener('input', function () {
                updateLayerColor(state, colorPicker.value);
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

    map.on('layeradd layerremove', function () {
        updateLegend();
        if (downloadDialog.open) {
            renderDownloadLayers();
        }
    });
    layerSearch.addEventListener('input', filterLayers);
    downloadOpenButton.addEventListener('click', function () {
        renderDownloadLayers();
        downloadDialog.showModal();
    });
    downloadCloseButton.addEventListener('click', function () {
        downloadDialog.close();
        downloadOpenButton.focus();
    });
    downloadSelectedButton.addEventListener('click', downloadSelectedFormats);
    loadCatalog();
}());
