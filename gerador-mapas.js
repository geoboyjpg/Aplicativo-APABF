(function () {
    'use strict';

    var catalog = window.CATALOGO_GERADOR_MAPAS || [];
    var states = [];
    var map;
    var overviewMap;
    var overviewBoundary;
    var overviewBoundaryCasing;
    var overviewBaseLayer;
    var overviewBounds;
    var extentRectangle;
    var baseLayer;
    var toastTimer;
    var boundaryState;

    var elements = {
        layerList: document.getElementById('layer-list'),
        catalogStatus: document.getElementById('catalog-status'),
        importStatus: document.getElementById('import-status'),
        fileImport: document.getElementById('file-import'),
        basemap: document.getElementById('basemap'),
        title: document.getElementById('map-title'),
        author: document.getElementById('author'),
        sources: document.getElementById('sources'),
        date: document.getElementById('map-date'),
        orientation: document.getElementById('orientation'),
        format: document.getElementById('export-format'),
        exportButton: document.getElementById('export-map'),
        preview: document.getElementById('print-preview'),
        previewTitle: document.getElementById('preview-title'),
        previewSources: document.getElementById('preview-sources'),
        previewAuthor: document.getElementById('preview-author'),
        previewDate: document.getElementById('preview-date'),
        legend: document.getElementById('legend-list'),
        mapStatus: document.getElementById('map-status'),
        coordinates: document.getElementById('map-coordinates'),
        scale: document.getElementById('preview-scale'),
        toast: document.getElementById('export-status')
    };

    function todayISO() {
        var now = new Date();
        var offset = now.getTimezoneOffset() * 60000;
        return new Date(now.getTime() - offset).toISOString().slice(0, 10);
    }

    function showToast(message, isError) {
        elements.toast.textContent = message;
        elements.toast.classList.toggle('is-error', Boolean(isError));
        elements.toast.classList.add('is-visible');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            elements.toast.classList.remove('is-visible');
        }, 6000);
    }

    function formatDate(value) {
        if (!value) {
            return '';
        }
        var parts = value.split('-');
        return parts.length === 3 ? parts[2] + '/' + parts[1] + '/' + parts[0] : value;
    }

    function getGeometryBounds(data) {
        var bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };

        function visit(value) {
            if (!Array.isArray(value)) {
                return;
            }
            if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
                bounds.west = Math.min(bounds.west, value[0]);
                bounds.east = Math.max(bounds.east, value[0]);
                bounds.south = Math.min(bounds.south, value[1]);
                bounds.north = Math.max(bounds.north, value[1]);
                return;
            }
            value.forEach(visit);
        }

        (data.features || []).forEach(function (feature) {
            if (feature.geometry) {
                visit(feature.geometry.coordinates);
            }
        });
        return Number.isFinite(bounds.west) ? bounds : null;
    }

    function getOverviewBounds(bounds) {
        var longitudePadding = (bounds.east - bounds.west) * 0.08;
        var latitudePadding = (bounds.north - bounds.south) * 0.16;
        return {
            west: bounds.west - longitudePadding,
            south: bounds.south - latitudePadding,
            east: bounds.east + longitudePadding,
            north: bounds.north + latitudePadding
        };
    }

    function loadScriptData(definition) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = definition.url;
            script.async = true;
            script.onload = function () {
                var data = window[definition.globalName];
                if (!data || data.type !== 'FeatureCollection') {
                    reject(new Error('O arquivo foi carregado, mas não contém uma camada GeoJSON reconhecida.'));
                    return;
                }
                resolve(data);
            };
            script.onerror = function () {
                reject(new Error('Não foi possível carregar o arquivo de dados local.'));
            };
            document.head.appendChild(script);
        });
    }

    function loadDefinition(definition) {
        var request = definition.format === 'script'
            ? loadScriptData(definition)
            : fetch(definition.url).then(function (response) {
                if (!response.ok) {
                    throw new Error('Servidor respondeu com HTTP ' + response.status + '.');
                }
                return response.json();
            });

        return request.then(function (data) {
            if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length) {
                throw new Error('O arquivo não contém feições geográficas.');
            }
            var state = {
                id: definition.id,
                definition: definition,
                data: data,
                label: definition.name,
                color: definition.color,
                opacity: definition.opacity,
                visible: Boolean(definition.visible),
                layer: null,
                bounds: getGeometryBounds(data),
                error: ''
            };
            if (!state.bounds) {
                throw new Error('Não foram encontradas coordenadas geográficas válidas.');
            }
            if (definition.legendField) {
                initializeZoneStyles(state);
            }
            return state;
        });
    }

    function paletteColor(state, feature, index) {
        var field = state.definition.legendField;
        if (!field) {
            return state.color;
        }
        var value = feature.properties && feature.properties[field];
        var values = [];
        state.data.features.forEach(function (item) {
            var category = item.properties && item.properties[field];
            if (category !== undefined && category !== null && category !== '' && values.indexOf(String(category)) === -1) {
                values.push(String(category));
            }
        });
        var categoryIndex = values.indexOf(String(value));
        var palette = state.definition.palette || [];
        return palette[categoryIndex >= 0 ? categoryIndex % palette.length : index % palette.length] || state.color;
    }

    function getZoneStyle(state, feature) {
        if (!state.zoneStyles || !feature || !feature.properties) {
            return null;
        }
        var zoneName = feature.properties[state.definition.legendField];
        return state.zoneStyles.find(function (zone) { return zone.name === zoneName; }) || null;
    }

    function initializeZoneStyles(state) {
        state.zoneStyles = [];
        state.data.features.forEach(function (feature, index) {
            var zoneName = feature.properties && feature.properties[state.definition.legendField];
            if (typeof zoneName !== 'string' || !zoneName.trim() ||
                state.zoneStyles.some(function (zone) { return zone.name === zoneName; })) {
                return;
            }
            state.zoneStyles.push({
                name: zoneName,
                color: paletteColor(state, feature, index),
                opacity: state.opacity,
                visible: true
            });
        });
    }

    function featureStyle(state, feature, index) {
        var zoneStyle = getZoneStyle(state, feature);
        var color = zoneStyle ? zoneStyle.color : paletteColor(state, feature, index || 0);
        var geometryType = feature.geometry && feature.geometry.type || state.definition.geometry;
        var isLine = /LineString/i.test(geometryType);
        return {
            color: state.definition.stroke || color,
            weight: isLine ? 2.2 : 1.1,
            opacity: state.opacity,
            fillColor: color,
            fillOpacity: zoneStyle ? zoneStyle.opacity : (state.definition.opacity || 0.3) * state.opacity
        };
    }

    function createLeafletLayer(state) {
        var featureIndex = 0;
        return L.geoJSON(state.data, {
            filter: function (feature) {
                var zoneStyle = getZoneStyle(state, feature);
                return !zoneStyle || zoneStyle.visible;
            },
            style: function (feature) {
                var style = featureStyle(state, feature, featureIndex);
                featureIndex += 1;
                return style;
            },
            pointToLayer: function (feature, latlng) {
                var color = paletteColor(state, feature, featureIndex);
                featureIndex += 1;
                return L.circleMarker(latlng, {
                    radius: state.id.indexOf('sitios') >= 0 ? 5 : 4.5,
                    color: state.definition.stroke || color,
                    weight: 1,
                    opacity: state.opacity,
                    fillColor: color,
                    fillOpacity: state.opacity
                });
            }
        });
    }

    function addStateToMap(state) {
        state.layer = createLeafletLayer(state);
        if (state.visible) {
            state.layer.addTo(map);
        }
    }

    function addLayerControls(state) {
        var item = document.createElement('div');
        var header = document.createElement('div');
        var visibilityLabel = document.createElement('label');
        var checkbox = document.createElement('input');
        var name = document.createElement('input');
        var color = document.createElement('input');
        var opacityRow = document.createElement('label');
        var opacityLabel = document.createElement('span');
        var opacity = document.createElement('input');
        var opacityValue = document.createElement('span');
        item.className = 'layer-item';
        header.className = 'layer-item-header';
        visibilityLabel.className = 'layer-visibility';
        checkbox.type = 'checkbox';
        checkbox.checked = state.visible;
        checkbox.disabled = !state.layer;
        checkbox.setAttribute('aria-label', 'Exibir ' + state.label);
        checkbox.addEventListener('change', function () {
            state.visible = checkbox.checked;
            if (state.visible) {
                state.layer.addTo(map);
                state.layer.bringToFront();
            } else {
                map.removeLayer(state.layer);
            }
            updateMapComposition();
        });
        var title = document.createElement('span');
        title.textContent = state.label;
        visibilityLabel.append(checkbox, title);

        color.type = 'color';
        color.className = 'layer-color';
        color.value = state.color;
        color.disabled = !state.layer;
        color.title = 'Cor da camada';
        color.setAttribute('aria-label', 'Cor da camada ' + state.label);
        color.addEventListener('input', function () {
            state.color = color.value;
            if (state.zoneStyles) {
                state.zoneStyles.forEach(function (zone) {
                    zone.color = color.value;
                    zone.colorInput.value = color.value;
                });
            }
            refreshLayer(state);
        });

        name.type = 'text';
        name.className = 'layer-name';
        name.maxLength = 70;
        name.value = state.label;
        name.disabled = !state.layer;
        name.setAttribute('aria-label', 'Nome apresentado para ' + state.label);
        name.addEventListener('input', function () {
            state.label = name.value.trim() || state.definition.name || 'Camada importada';
            title.textContent = state.label;
            updateMapComposition();
        });

        opacityRow.className = 'layer-opacity-row';
        opacityLabel.textContent = 'Opacidade';
        opacity.type = 'range';
        opacity.min = '10';
        opacity.max = '100';
        opacity.value = String(Math.round(state.opacity * 100));
        opacity.disabled = !state.layer;
        opacityValue.className = 'layer-opacity-value';
        opacityValue.textContent = opacity.value + '%';
        opacity.addEventListener('input', function () {
            state.opacity = Number(opacity.value) / 100;
            if (state.zoneStyles) {
                state.zoneStyles.forEach(function (zone) {
                    zone.opacity = state.opacity;
                    zone.opacityInput.value = opacity.value;
                    zone.opacityValue.textContent = opacity.value + '%';
                });
            }
            opacityValue.textContent = opacity.value + '%';
            refreshLayer(state);
        });
        opacityRow.append(opacityLabel, opacity, opacityValue);
        header.append(visibilityLabel, color);
        item.append(header, name, opacityRow);

        if (state.error) {
            var error = document.createElement('p');
            error.className = 'layer-error';
            error.textContent = state.error;
            item.appendChild(error);
        }
        elements.layerList.appendChild(item);
        if (state.zoneStyles) {
            addZoneControls(state, item);
        }
    }

    function addZoneControls(state, layerItem) {
        var zoneList = document.createElement('div');
        zoneList.className = 'zone-controls';
        state.zoneStyles.forEach(function (zone) {
            var zoneItem = document.createElement('div');
            var zoneHeader = document.createElement('div');
            var visibility = document.createElement('label');
            var checkbox = document.createElement('input');
            var zoneName = document.createElement('span');
            var color = document.createElement('input');
            var opacityRow = document.createElement('label');
            var opacityLabel = document.createElement('span');
            var opacity = document.createElement('input');
            var opacityValue = document.createElement('span');

            zoneItem.className = 'zone-item';
            zoneHeader.className = 'zone-item-header';
            visibility.className = 'zone-visibility';
            checkbox.type = 'checkbox';
            checkbox.checked = zone.visible;
            checkbox.disabled = !state.layer;
            checkbox.setAttribute('aria-label', 'Exibir ' + zone.name);
            checkbox.addEventListener('change', function () {
                zone.visible = checkbox.checked;
                refreshLayer(state);
            });
            zoneName.textContent = zone.name;
            visibility.append(checkbox, zoneName);

            color.type = 'color';
            color.className = 'layer-color';
            color.value = zone.color;
            zone.colorInput = color;
            color.disabled = !state.layer;
            color.setAttribute('aria-label', 'Cor de preenchimento de ' + zone.name);
            color.addEventListener('input', function () {
                zone.color = color.value;
                refreshLayer(state);
            });

            opacityRow.className = 'layer-opacity-row zone-opacity-row';
            opacityLabel.textContent = 'Preenchimento';
            opacity.type = 'range';
            opacity.min = '0';
            opacity.max = '100';
            opacity.value = String(Math.round(zone.opacity * 100));
            zone.opacityInput = opacity;
            opacity.disabled = !state.layer;
            opacityValue.className = 'layer-opacity-value';
            opacityValue.textContent = opacity.value + '%';
            opacity.addEventListener('input', function () {
                zone.opacity = Number(opacity.value) / 100;
                opacityValue.textContent = opacity.value + '%';
                refreshLayer(state);
            });
            opacityRow.append(opacityLabel, opacity, opacityValue);
            zoneHeader.append(visibility, color);
            zoneItem.append(zoneHeader, opacityRow);
            zoneList.appendChild(zoneItem);
        });
        layerItem.appendChild(zoneList);
    }

    function refreshLayer(state) {
        var wasVisible = state.visible && state.layer && map.hasLayer(state.layer);
        if (state.layer && map.hasLayer(state.layer)) {
            map.removeLayer(state.layer);
        }
        if (state.layer) {
            state.layer = createLeafletLayer(state);
            if (wasVisible) {
                state.layer.addTo(map);
            }
        }
        updateMapComposition();
    }

    function symbolClass(geometry) {
        if (/point/i.test(geometry)) {
            return 'is-point';
        }
        if (/line/i.test(geometry)) {
            return 'is-line';
        }
        return '';
    }

    function legendEntries(state) {
        if (state.zoneStyles) {
            return state.zoneStyles.filter(function (zone) { return zone.visible; }).map(function (zone) {
                return {
                    label: zone.name,
                    color: zone.color,
                    geometry: state.definition.geometry,
                    opacity: zone.opacity
                };
            });
        }
        var field = state.definition.legendField;
        var polygonOpacity = state.opacity * (state.definition.opacity || 1);
        if (!field) {
            var geometryTypes = [];
            state.data.features.forEach(function (feature) {
                var type = feature.geometry && feature.geometry.type || state.definition.geometry;
                if (geometryTypes.indexOf(type) === -1) {
                    geometryTypes.push(type);
                }
            });
            if (geometryTypes.length > 1) {
                return geometryTypes.map(function (type) {
                    var label = /point/i.test(type) ? 'Pontos' : (/line/i.test(type) ? 'Linhas' : 'Polígonos');
                    return { label: state.label + ' — ' + label, color: state.color, geometry: type, opacity: /polygon/i.test(type) ? polygonOpacity : state.opacity };
                });
            }
            return [{
                label: state.label,
                color: state.color,
                geometry: state.definition.geometry,
                opacity: /polygon/i.test(state.definition.geometry) ? polygonOpacity : state.opacity
            }];
        }
        var values = [];
        state.data.features.forEach(function (feature, index) {
            var value = feature.properties && feature.properties[field];
            if (value === undefined || value === null || value === '') {
                return;
            }
            var label = String(value);
            if (!values.some(function (item) { return item.label === label; })) {
                values.push({
                    label: label,
                    color: paletteColor(state, feature, index),
                    geometry: state.definition.geometry,
                    opacity: polygonOpacity
                });
            }
        });
        return values;
    }

    function renderLegend(container, activeStates) {
        container.replaceChildren();
        if (!activeStates.length) {
            var empty = document.createElement('p');
            empty.className = 'hint';
            empty.textContent = 'Ative camadas para montar a legenda.';
            container.appendChild(empty);
            return;
        }
        activeStates.forEach(function (state) {
            var entries = legendEntries(state);
            if (state.definition.legendField && !state.zoneStyles) {
                var group = document.createElement('p');
                group.className = 'legend-group-title';
                group.textContent = state.label;
                container.appendChild(group);
            }
            entries.forEach(function (entry) {
                var row = document.createElement('div');
                var swatch = document.createElement('span');
                var label = document.createElement('span');
                row.className = 'legend-row';
                swatch.className = 'legend-symbol ' + symbolClass(entry.geometry);
                swatch.style.backgroundColor = entry.geometry === 'line' ? 'transparent' : entry.color;
                swatch.style.borderColor = entry.geometry === 'line' ? entry.color : (state.definition.stroke || '#333');
                swatch.style.opacity = String(entry.opacity);
                if (entry.geometry === 'line') {
                    swatch.style.backgroundColor = entry.color;
                }
                label.textContent = entry.label;
                row.append(swatch, label);
                container.appendChild(row);
            });
        });
    }

    function formatCoordinate(value, isLatitude) {
        var absolute = Math.abs(value);
        var degrees = Math.floor(absolute);
        var minutes = Math.floor((absolute - degrees) * 60);
        var seconds = Math.round((((absolute - degrees) * 60) - minutes) * 60);
        if (seconds === 60) {
            seconds = 0;
            minutes += 1;
        }
        if (minutes === 60) {
            minutes = 0;
            degrees += 1;
        }
        var direction = isLatitude ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
        return degrees + '°' + String(minutes).padStart(2, '0') + '′' + String(seconds).padStart(2, '0') + '″' + direction;
    }

    function scaleDistance(meters) {
        if (!Number.isFinite(meters) || meters <= 0) {
            return 0;
        }
        var power = Math.pow(10, Math.floor(Math.log10(meters)));
        var fraction = meters / power;
        var nice = fraction >= 5 ? 5 : (fraction >= 2 ? 2 : 1);
        return nice * power;
    }

    function updateScaleAndCoordinates() {
        if (!map || !map.getBounds().isValid()) {
            return;
        }
        var bounds = map.getBounds();
        var size = map.getSize();
        var centerLat = bounds.getCenter().lat * Math.PI / 180;
        var metersAcross = (bounds.getEast() - bounds.getWest()) * 111320 * Math.cos(centerLat);
        var metersPerPixel = metersAcross / Math.max(size.x, 1);
        var scaleMeters = scaleDistance(metersPerPixel * 120);
        var barPixels = scaleMeters / metersPerPixel;
        var label = scaleMeters >= 1000
            ? (scaleMeters / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km'
            : Math.round(scaleMeters) + ' m';
        elements.scale.innerHTML = '<span>' + label + '</span><span class="scale-bar" style="width:' + Math.max(40, Math.min(120, barPixels)) + 'px"><span></span><span></span></span>';

        var lat = bounds.getCenter().lat;
        elements.coordinates.replaceChildren();
        [bounds.getWest(), bounds.getCenter().lng, bounds.getEast()].forEach(function (longitude) {
            var coordinate = document.createElement('span');
            coordinate.textContent = formatCoordinate(longitude, false);
            elements.coordinates.appendChild(coordinate);
        });
        elements.coordinates.setAttribute('aria-label', 'Longitudes no enquadramento; latitude central ' + formatCoordinate(lat, true));
    }

    function updateOverview() {
        if (!overviewMap || !map || !map.getBounds().isValid()) {
            return;
        }
        if (extentRectangle) {
            overviewMap.removeLayer(extentRectangle);
        }
        extentRectangle = L.rectangle(map.getBounds(), {
            color: '#df3f94',
            weight: 2,
            fillColor: '#df3f94',
            fillOpacity: 0.16
        }).addTo(overviewMap);
    }

    function updateMapComposition() {
        var activeStates = states.filter(function (state) {
            return state.visible && state.layer;
        });
        renderLegend(elements.legend, activeStates);
        elements.previewTitle.textContent = elements.title.value.trim() || 'Mapa sem título';
        var credits = basemapCredit();
        elements.previewSources.textContent = 'Fontes: ' + (elements.sources.value.trim() || 'não informadas') + (credits ? ' · ' + credits : '');
        elements.previewAuthor.textContent = elements.author.value.trim() ? 'Responsável: ' + elements.author.value.trim() : '';
        elements.previewDate.textContent = elements.date.value ? 'Data: ' + formatDate(elements.date.value) : '';
        updateScaleAndCoordinates();
        updateOverview();
    }

    function basemapCredit() {
        if (elements.basemap.value === 'streets') {
            return 'Mapa-base: Fontes Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, NGCC, OpenStreetMap e comunidade GIS';
        }
        if (elements.basemap.value === 'satellite') {
            return 'Imagem: Esri, Vantor, Earthstar Geographics e comunidade GIS';
        }
        return '';
    }

    function setBasemap(value) {
        if (baseLayer) {
            map.removeLayer(baseLayer);
            baseLayer = null;
        }
        if (value === 'streets') {
            baseLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 19,
                crossOrigin: true,
                attribution: 'Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, &copy; OpenStreetMap contributors, and the GIS User Community'
            });
        } else if (value === 'satellite') {
            baseLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 19,
                crossOrigin: true,
                attribution: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community'
            });
        }
        if (baseLayer) {
            baseLayer.addTo(map);
            baseLayer.bringToBack();
        }
        document.getElementById('main-map').style.backgroundColor = value === 'white' ? '#fff' : '#eef3f1';
        updateMapComposition();
    }

    function initializeMaps() {
        map = L.map('main-map', {
            zoomControl: true,
            minZoom: 3,
            maxZoom: 19,
            attributionControl: true
        }).setView([-28.2, -48.8], 9);
        overviewMap = L.map('overview-map', {
            zoomControl: false,
            attributionControl: true,
            dragging: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            touchZoom: false
        }).setView([-28.2, -48.8], 7);
        map.on('moveend zoomend', updateMapComposition);
        window.addEventListener('resize', function () {
            window.setTimeout(function () {
                map.invalidateSize();
                overviewMap.invalidateSize();
                updateMapComposition();
            }, 120);
        });
    }

    function loadOfficialLayers() {
        var failures = [];
        return Promise.all(catalog.map(function (definition) {
            return loadDefinition(definition)
                .catch(function (error) {
                    failures.push(definition.name + ': ' + error.message);
                    return {
                        id: definition.id,
                        definition: definition,
                        data: { features: [] },
                        label: definition.name,
                        color: definition.color,
                        opacity: definition.opacity,
                        visible: false,
                        layer: null,
                        error: error.message
                    };
                });
        })).then(function (loadedStates) {
            states = loadedStates;
            states.forEach(function (state) {
                if (!state.error) {
                    addStateToMap(state);
                    if (state.id === 'limite-apabf') {
                        boundaryState = state;
                        overviewBounds = getOverviewBounds(state.bounds);
                        overviewBaseLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                            maxZoom: 19,
                            crossOrigin: true,
                            attribution: 'Imagery &copy; Esri, Vantor, Earthstar Geographics, and the GIS User Community'
                        }).addTo(overviewMap);
                        overviewBoundaryCasing = L.geoJSON(state.data, {
                            style: { color: '#fff', weight: 4, opacity: 1, fillOpacity: 0 }
                        }).addTo(overviewMap);
                        overviewBoundary = L.geoJSON(state.data, {
                            style: { color: '#d0a800', weight: 2, opacity: 1, fillOpacity: 0 }
                        }).addTo(overviewMap);
                        overviewMap.invalidateSize({ pan: false });
                        overviewMap.fitBounds(L.latLngBounds(
                            [overviewBounds.south, overviewBounds.west],
                            [overviewBounds.north, overviewBounds.east]
                        ), { animate: false });
                    }
                }
                addLayerControls(state);
            });
            if (boundaryState && boundaryState.layer && boundaryState.layer.getBounds().isValid()) {
                if (boundaryState.visible) {
                    boundaryState.layer.bringToFront();
                }
                map.invalidateSize({ pan: false });
                map.fitBounds(boundaryState.layer.getBounds(), { padding: [22, 22] });
            }
            elements.catalogStatus.textContent = failures.length
                ? 'Camadas carregadas com ' + failures.length + ' indisponível(is). Consulte as mensagens abaixo.'
                : 'Camadas oficiais disponíveis carregadas.';
            elements.catalogStatus.classList.toggle('is-error', failures.length > 0);
            elements.mapStatus.textContent = boundaryState
                ? 'Dados locais carregados · limite da APABF em destaque no mapa de localização.'
                : 'O limite local da APABF não está disponível; mapa de localização sem limite.';
            updateMapComposition();
        });
    }

    function localName(node) {
        return node.localName || node.nodeName.split(':').pop();
    }

    function descendants(node, wantedName) {
        return Array.prototype.filter.call(node.getElementsByTagName('*'), function (child) {
            return localName(child) === wantedName;
        });
    }

    function parseCoordinates(node) {
        var values = (node.textContent || '').trim().split(/\s+/).filter(Boolean);
        return values.map(function (value) {
            var parts = value.split(',').map(Number);
            if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
                return null;
            }
            return [parts[0], parts[1]];
        }).filter(Boolean);
    }

    function parseKmlGeometry(node) {
        var name = localName(node);
        if (name === 'MultiGeometry') {
            return Array.prototype.slice.call(node.children).map(parseKmlGeometry).filter(Boolean);
        }
        if (name === 'Point' || name === 'LineString') {
            var coordinateNodes = descendants(node, 'coordinates');
            if (!coordinateNodes.length) {
                return null;
            }
            var coordinates = parseCoordinates(coordinateNodes[0]);
            if (!coordinates.length) {
                return null;
            }
            return name === 'Point'
                ? { type: 'Point', coordinates: coordinates[0] }
                : { type: 'LineString', coordinates: coordinates };
        }
        if (name === 'Polygon') {
            var rings = descendants(node, 'coordinates').map(parseCoordinates).filter(function (ring) {
                return ring.length >= 3;
            });
            return rings.length ? { type: 'Polygon', coordinates: rings } : null;
        }
        return null;
    }

    function parseKml(text, filename) {
        var documentXml = new DOMParser().parseFromString(text, 'application/xml');
        if (documentXml.getElementsByTagName('parsererror').length) {
            throw new Error('O conteúdo KML está malformado ou não é XML válido.');
        }
        var placemarks = Array.prototype.slice.call(documentXml.getElementsByTagName('*')).filter(function (node) {
            return localName(node) === 'Placemark';
        });
        var features = [];
        placemarks.forEach(function (placemark, index) {
            var nameNode = descendants(placemark, 'name')[0];
            var name = nameNode && nameNode.textContent.trim() || (filename + ' — feição ' + (index + 1));
            Array.prototype.slice.call(placemark.children).forEach(function (child) {
                var geometry = parseKmlGeometry(child);
                var geometries = Array.isArray(geometry) ? geometry : [geometry];
                geometries.filter(Boolean).forEach(function (item) {
                    features.push({
                        type: 'Feature',
                        properties: { name: name },
                        geometry: item
                    });
                });
            });
        });
        if (!features.length) {
            throw new Error('Nenhum ponto, linha ou polígono compatível foi encontrado no arquivo.');
        }
        return { type: 'FeatureCollection', features: features };
    }

    function readKmlFile(file) {
        var extension = file.name.toLowerCase().split('.').pop();
        if (extension === 'kml') {
            return file.text().then(function (text) {
                return parseKml(text, file.name);
            });
        }
        if (extension !== 'kmz') {
            return Promise.reject(new Error('Selecione um arquivo com extensão .kml ou .kmz.'));
        }
        if (!window.JSZip) {
            return Promise.reject(new Error('O leitor KMZ não carregou. Verifique a conexão e tente novamente.'));
        }
        return file.arrayBuffer().then(function (buffer) {
            return window.JSZip.loadAsync(buffer).catch(function () {
                throw new Error('O arquivo KMZ é inválido ou está corrompido. Selecione um KMZ válido e tente novamente.');
            });
        }).then(function (archive) {
            var candidates = archive.file(/\.kml$/i);
            if (!candidates.length) {
                throw new Error('O KMZ não contém um arquivo KML.');
            }
            candidates.sort(function (a, b) {
                return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            });
            return candidates[0].async('text').then(function (text) {
                return parseKml(text, file.name);
            });
        });
    }

    function importLocalFile(file) {
        if (!file) {
            return;
        }
        elements.importStatus.textContent = 'Lendo ' + file.name + ' localmente…';
        readKmlFile(file).then(function (data) {
            var definition = {
                id: 'importado-' + Date.now(),
                name: file.name.replace(/\.(kml|kmz)$/i, ''),
                source: 'Arquivo local do usuário: ' + file.name,
                geometry: data.features[0].geometry.type,
                color: '#d84daf',
                stroke: '#85236c',
                opacity: 0.62
            };
            var state = {
                id: definition.id,
                definition: definition,
                data: data,
                label: definition.name,
                color: definition.color,
                opacity: definition.opacity,
                visible: true,
                layer: null,
                bounds: getGeometryBounds(data),
                error: ''
            };
            if (!state.bounds) {
                throw new Error('Não foram encontradas coordenadas utilizáveis no arquivo.');
            }
            states.push(state);
            addStateToMap(state);
            addLayerControls(state);
            map.fitBounds(state.layer.getBounds(), { padding: [24, 24], maxZoom: 15 });
            elements.importStatus.textContent = file.name + ' importado localmente (' + data.features.length + ' feição(ões)).';
            updateMapComposition();
        }).catch(function (error) {
            elements.importStatus.textContent = 'Importação não concluída: ' + error.message;
            showToast('Não foi possível importar o arquivo: ' + error.message, true);
        }).finally(function () {
            elements.fileImport.value = '';
        });
    }

    function mercatorProject(longitude, latitude, zoom) {
        var worldSize = 256 * Math.pow(2, zoom);
        var limitedLatitude = Math.max(-85.0511287798, Math.min(85.0511287798, latitude));
        var sine = Math.sin(limitedLatitude * Math.PI / 180);
        return {
            x: (longitude + 180) / 360 * worldSize,
            y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * worldSize
        };
    }

    function mercatorUnproject(x, y, zoom) {
        var worldSize = 256 * Math.pow(2, zoom);
        var longitude = x / worldSize * 360 - 180;
        var n = Math.PI - 2 * Math.PI * y / worldSize;
        return { lon: longitude, lat: 180 / Math.PI * Math.atan(Math.sinh(n)) };
    }

    function projectBounds(bounds, zoom) {
        var northWest = mercatorProject(bounds.west, bounds.north, zoom);
        var southEast = mercatorProject(bounds.east, bounds.south, zoom);
        return {
            minX: Math.min(northWest.x, southEast.x),
            maxX: Math.max(northWest.x, southEast.x),
            minY: Math.min(northWest.y, southEast.y),
            maxY: Math.max(northWest.y, southEast.y)
        };
    }

    function tileUrl(source, z, x, y) {
        if (source === 'satellite') {
            return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x;
        }
        return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/' + z + '/' + y + '/' + x;
    }

    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            var image = new Image();
            image.crossOrigin = 'anonymous';
            image.onload = function () { resolve(image); };
            image.onerror = function () { reject(new Error('Uma imagem externa não pôde ser carregada com permissão de exportação (CORS).')); };
            image.src = url;
        });
    }

    function renderTileBackground(context, source, zoom, projectedBounds, scale, offsetX, offsetY) {
        if (source === 'white') {
            return Promise.resolve();
        }
        var worldSize = 256 * Math.pow(2, zoom);
        var minTileX = Math.max(0, Math.floor(projectedBounds.minX / 256));
        var maxTileX = Math.min(Math.pow(2, zoom) - 1, Math.floor((projectedBounds.maxX - 1) / 256));
        var minTileY = Math.max(0, Math.floor(projectedBounds.minY / 256));
        var maxTileY = Math.min(Math.pow(2, zoom) - 1, Math.floor((projectedBounds.maxY - 1) / 256));
        if (worldSize < projectedBounds.maxX || projectedBounds.minX < 0) {
            minTileX = Math.max(0, minTileX);
            maxTileX = Math.min(Math.pow(2, zoom) - 1, maxTileX);
        }
        var jobs = [];
        for (var y = minTileY; y <= maxTileY; y += 1) {
            for (var x = minTileX; x <= maxTileX; x += 1) {
                jobs.push({ x: x, y: y, promise: loadImage(tileUrl(source, zoom, x, y)) });
            }
        }
        return Promise.all(jobs.map(function (job) {
            return job.promise.then(function (image) {
                var x = offsetX + (job.x * 256 - projectedBounds.minX) * scale;
                var y = offsetY + (job.y * 256 - projectedBounds.minY) * scale;
                context.drawImage(image, x, y, 256 * scale, 256 * scale);
            });
        }));
    }

    function colorForFeature(state, feature, index) {
        return paletteColor(state, feature, index);
    }

    function drawPoint(context, coordinate, projection, color, stroke, opacity, radius, lineWidth) {
        var point = projection(coordinate[0], coordinate[1]);
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.globalAlpha = opacity;
        context.fillStyle = color;
        context.strokeStyle = stroke || '#333';
        context.lineWidth = lineWidth;
        context.fill();
        context.stroke();
        context.globalAlpha = 1;
    }

    function drawLine(context, coordinates, projection, color, lineWidth, opacity) {
        if (!coordinates || coordinates.length < 2) {
            return;
        }
        context.beginPath();
        coordinates.forEach(function (coordinate, index) {
            var point = projection(coordinate[0], coordinate[1]);
            if (index === 0) {
                context.moveTo(point.x, point.y);
            } else {
                context.lineTo(point.x, point.y);
            }
        });
        context.globalAlpha = opacity;
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.stroke();
        context.globalAlpha = 1;
    }

    function drawPolygon(context, rings, projection, color, stroke, fillOpacity, opacity, lineWidth, strokeOpacity) {
        if (!rings || !rings.length) {
            return;
        }
        context.beginPath();
        rings.forEach(function (ring) {
            ring.forEach(function (coordinate, index) {
                var point = projection(coordinate[0], coordinate[1]);
                if (index === 0) {
                    context.moveTo(point.x, point.y);
                } else {
                    context.lineTo(point.x, point.y);
                }
            });
            context.closePath();
        });
        context.globalAlpha = opacity * fillOpacity;
        context.fillStyle = color;
        try {
            context.fill('evenodd');
        } catch (error) {
            context.fill();
        }
        context.globalAlpha = strokeOpacity === undefined ? opacity : strokeOpacity;
        context.strokeStyle = stroke || color;
        context.lineWidth = lineWidth;
        context.lineJoin = 'round';
        context.stroke();
        context.globalAlpha = 1;
    }

    function drawGeometry(context, geometry, projection, color, stroke, opacity, fillOpacity, lineWidth, pointRadius, strokeOpacity) {
        if (!geometry) {
            return;
        }
        var coordinates = geometry.coordinates;
        switch (geometry.type) {
        case 'Point':
            drawPoint(context, coordinates, projection, color, stroke, opacity, pointRadius, lineWidth);
            break;
        case 'MultiPoint':
            coordinates.forEach(function (point) { drawPoint(context, point, projection, color, stroke, opacity, pointRadius, lineWidth); });
            break;
        case 'LineString':
            drawLine(context, coordinates, projection, color, lineWidth, opacity);
            break;
        case 'MultiLineString':
            coordinates.forEach(function (line) { drawLine(context, line, projection, color, lineWidth, opacity); });
            break;
        case 'Polygon':
            drawPolygon(context, coordinates, projection, color, stroke, fillOpacity, opacity, lineWidth, strokeOpacity);
            break;
        case 'MultiPolygon':
            coordinates.forEach(function (polygon) {
                drawPolygon(context, polygon, projection, color, stroke, fillOpacity, opacity, lineWidth, strokeOpacity);
            });
            break;
        default:
            break;
        }
    }

    function drawLayerFeatures(context, projection, outputRatio) {
        states.filter(function (state) { return state.visible && state.data && state.layer; })
            .sort(function (a, b) {
                function rank(state) {
                    return state.id.indexOf('importado-') === 0 ? 2 : (state.id === 'limite-apabf' ? 1 : 0);
                }
                return rank(a) - rank(b);
            })
            .forEach(function (state) {
                state.data.features.forEach(function (feature, index) {
                    var zoneStyle = getZoneStyle(state, feature);
                    if (zoneStyle && !zoneStyle.visible) {
                        return;
                    }
                    var color = zoneStyle ? zoneStyle.color : colorForFeature(state, feature, index);
                    var geometryType = feature.geometry && feature.geometry.type || state.definition.geometry;
                    drawGeometry(
                        context,
                        feature.geometry,
                        projection,
                        color,
                        state.definition.stroke || color,
                        zoneStyle ? 1 : state.opacity,
                        zoneStyle ? zoneStyle.opacity : (state.definition.opacity || 0.3),
                        /LineString/i.test(geometryType) ? 2.2 * outputRatio : 1.15 * outputRatio,
                        4.5 * outputRatio,
                        zoneStyle ? state.opacity : undefined
                    );
                });
            });
    }

    function renderScaleBar(context, x, y, mapWidth, metersPerPixel, scaleFactor) {
        var distance = scaleDistance(metersPerPixel * mapWidth * 0.24);
        var width = distance / metersPerPixel;
        var height = 3.2 * scaleFactor;
        context.fillStyle = '#111';
        context.fillRect(x, y, width / 2, height);
        context.fillStyle = '#fff';
        context.fillRect(x + width / 2, y, width / 2, height);
        context.strokeStyle = '#111';
        context.lineWidth = Math.max(1, scaleFactor);
        context.strokeRect(x, y, width, height);
        context.fillStyle = '#111';
        context.textAlign = 'center';
        context.font = 'bold ' + (3.2 * scaleFactor) + 'px Arial';
        var label = distance >= 1000
            ? (distance / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km'
            : Math.round(distance) + ' m';
        context.lineJoin = 'round';
        context.lineWidth = Math.max(1.5, scaleFactor * 0.9);
        context.strokeStyle = '#fff';
        context.strokeText('0', x, y - 2 * scaleFactor);
        context.strokeText(label, x + width, y - 2 * scaleFactor);
        context.fillText('0', x, y - 2 * scaleFactor);
        context.fillText(label, x + width, y - 2 * scaleFactor);
    }

    function drawNorthArrow(context, x, y, size) {
        context.save();
        context.translate(x, y);
        context.fillStyle = '#111';
        context.strokeStyle = '#111';
        context.lineWidth = Math.max(2, size * 0.05);
        context.beginPath();
        context.moveTo(0, -size);
        context.lineTo(size * 0.24, size * 0.25);
        context.lineTo(0, size * 0.08);
        context.lineTo(-size * 0.24, size * 0.25);
        context.closePath();
        context.strokeStyle = '#fff';
        context.lineWidth = Math.max(2, size * 0.13);
        context.stroke();
        context.strokeStyle = '#111';
        context.lineWidth = Math.max(2, size * 0.05);
        context.fill();
        context.fillStyle = '#fff';
        context.beginPath();
        context.moveTo(0, -size * 0.65);
        context.lineTo(0, size * 0.05);
        context.lineTo(-size * 0.11, size * 0.13);
        context.closePath();
        context.fill();
        context.font = 'bold ' + (size * 0.42) + 'px Arial';
        context.textAlign = 'center';
        context.fillStyle = '#111';
        context.lineJoin = 'round';
        context.lineWidth = Math.max(1.5, size * 0.07);
        context.strokeStyle = '#fff';
        context.strokeText('N', 0, size * 0.72);
        context.fillText('N', 0, size * 0.72);
        context.restore();
    }

    function formatDegree(value, isLatitude) {
        var absolute = Math.abs(value);
        var degrees = Math.floor(absolute);
        var minutes = Math.round((absolute - degrees) * 60);
        if (minutes === 60) {
            degrees += 1;
            minutes = 0;
        }
        var direction = isLatitude ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
        return degrees + '°' + String(minutes).padStart(2, '0') + '′' + direction;
    }

    function drawCoordinateFrame(context, frame, projection, inverseProjection, scaleFactor) {
        var tickCount = 4;
        context.save();
        context.font = 'bold ' + (2.5 * scaleFactor) + 'px Arial';
        context.fillStyle = '#222';
        context.strokeStyle = '#222';
        context.lineWidth = Math.max(1, scaleFactor);
        for (var i = 0; i <= tickCount; i += 1) {
            var x = frame.x + frame.width * i / tickCount;
            var topCoordinate = inverseProjection(x, frame.y);
            var bottomCoordinate = inverseProjection(x, frame.y + frame.height);
            context.beginPath();
            context.moveTo(x, frame.y);
            context.lineTo(x, frame.y + 3 * scaleFactor);
            context.moveTo(x, frame.y + frame.height - 3 * scaleFactor);
            context.lineTo(x, frame.y + frame.height);
            context.stroke();
            context.textAlign = 'center';
            context.lineJoin = 'round';
            context.lineWidth = Math.max(1.5, scaleFactor * 0.85);
            context.strokeStyle = '#fff';
            context.strokeText(formatDegree(topCoordinate.lon, false), x, frame.y - 2.5 * scaleFactor);
            context.strokeText(formatDegree(bottomCoordinate.lon, false), x, frame.y + frame.height + 4 * scaleFactor);
            context.fillStyle = '#222';
            context.fillText(formatDegree(topCoordinate.lon, false), x, frame.y - 2.5 * scaleFactor);
            context.fillText(formatDegree(bottomCoordinate.lon, false), x, frame.y + frame.height + 4 * scaleFactor);
        }
        for (var j = 0; j <= tickCount; j += 1) {
            var y = frame.y + frame.height * j / tickCount;
            var leftCoordinate = inverseProjection(frame.x, y);
            var rightCoordinate = inverseProjection(frame.x + frame.width, y);
            context.beginPath();
            context.moveTo(frame.x, y);
            context.lineTo(frame.x + 3 * scaleFactor, y);
            context.moveTo(frame.x + frame.width - 3 * scaleFactor, y);
            context.lineTo(frame.x + frame.width, y);
            context.stroke();
            context.textAlign = 'right';
            context.lineJoin = 'round';
            context.lineWidth = Math.max(1.5, scaleFactor * 0.85);
            context.strokeStyle = '#fff';
            context.strokeText(formatDegree(leftCoordinate.lat, true), frame.x - 3 * scaleFactor, y + 1 * scaleFactor);
            context.fillStyle = '#222';
            context.fillText(formatDegree(leftCoordinate.lat, true), frame.x - 3 * scaleFactor, y + 1 * scaleFactor);
        }
        context.restore();
    }

    function wrappedLines(context, text, maxWidth) {
        var words = String(text || '').split(/\s+/);
        var lines = [];
        var line = '';
        words.forEach(function (word) {
            if (context.measureText(word).width > maxWidth) {
                if (line) {
                    lines.push(line);
                    line = '';
                }
                var piece = '';
                Array.from(word).forEach(function (character) {
                    if (piece && context.measureText(piece + character).width > maxWidth) {
                        lines.push(piece);
                        piece = character;
                    } else {
                        piece += character;
                    }
                });
                line = piece;
                return;
            }
            var candidate = line ? line + ' ' + word : word;
            if (line && context.measureText(candidate).width > maxWidth) {
                lines.push(line);
                line = word;
            } else {
                line = candidate;
            }
        });
        if (line) {
            lines.push(line);
        }
        return lines;
    }

    function fitImage(context, image, x, y, width, height) {
        if (!image || !image.naturalWidth || !image.naturalHeight) {
            return;
        }
        var ratio = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        var drawWidth = image.naturalWidth * ratio;
        var drawHeight = image.naturalHeight * ratio;
        context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
    }

    function loadLogo(src) {
        return loadImage(src);
    }

    function renderOverview(context, x, y, width, height, scaleFactor, bounds) {
        context.fillStyle = '#f9fbfa';
        context.fillRect(x, y, width, height);
        context.strokeStyle = '#242b2c';
        context.lineWidth = Math.max(1.4, scaleFactor * 0.8);
        context.strokeRect(x, y, width, height);
        if (!boundaryState || !boundaryState.data || !boundaryState.bounds) {
            context.fillStyle = '#465356';
            context.textAlign = 'center';
            context.font = '14px Arial';
            context.fillText('Limite da APABF indisponível', x + width / 2, y + height / 2);
            return Promise.resolve();
        }

        var viewBounds = overviewBounds || getOverviewBounds(boundaryState.bounds);
        var zoom = 8;
        var projected = projectBounds(viewBounds, zoom);
        var padding = Math.min(width, height) * 0.03;
        var fit = Math.min((width - padding * 2) / (projected.maxX - projected.minX), (height - padding * 2) / (projected.maxY - projected.minY));
        var usedWidth = (projected.maxX - projected.minX) * fit;
        var usedHeight = (projected.maxY - projected.minY) * fit;
        var left = x + (width - usedWidth) / 2;
        var top = y + (height - usedHeight) / 2;
        var projection = function (longitude, latitude) {
            var point = mercatorProject(longitude, latitude, zoom);
            return { x: left + (point.x - projected.minX) * fit, y: top + (point.y - projected.minY) * fit };
        };
        context.save();
        context.beginPath();
        context.rect(x, y, width, height);
        context.clip();
        return renderTileBackground(context, 'satellite', zoom, projected, fit, left, top)
            .then(function () {
                context.strokeStyle = '#d0a800';
                context.lineWidth = Math.max(1.2, 0.35 * scaleFactor);
                boundaryState.data.features.forEach(function (feature) {
                    drawGeometry(context, feature.geometry, projection, '#d0a800', '#776600', 1, 0.1, Math.max(1.2, 0.35 * scaleFactor));
                });
                var topLeft = projection(bounds.west, bounds.north);
                var bottomRight = projection(bounds.east, bounds.south);
                var extentLeft = Math.min(topLeft.x, bottomRight.x);
                var extentRight = Math.max(topLeft.x, bottomRight.x);
                var extentTop = Math.min(topLeft.y, bottomRight.y);
                var extentBottom = Math.max(topLeft.y, bottomRight.y);
                var intersects = extentRight >= x && extentLeft <= x + width && extentBottom >= y && extentTop <= y + height;
                if (intersects) {
                    var clippedLeft = Math.max(x, extentLeft);
                    var clippedRight = Math.min(x + width, extentRight);
                    var clippedTop = Math.max(y, extentTop);
                    var clippedBottom = Math.min(y + height, extentBottom);
                    context.strokeStyle = '#d83d91';
                    context.lineWidth = Math.max(1.5, 0.45 * scaleFactor);
                    context.strokeRect(clippedLeft, clippedTop, clippedRight - clippedLeft, clippedBottom - clippedTop);
                }
                var arrowSize = Math.min(width, height) * 0.09;
                drawNorthArrow(context, x + width - arrowSize, y + arrowSize * 1.3, arrowSize);
            })
            .finally(function () {
                context.restore();
            });
    }

    function renderLegendCanvas(context, x, y, width, maxHeight, scaleFactor, activeStates) {
        var cursor = y;
        context.textAlign = 'left';
        activeStates.forEach(function (state) {
            var entries = legendEntries(state);
            if (state.definition.legendField && !state.zoneStyles) {
                context.fillStyle = '#202526';
                context.font = 'bold ' + (2.8 * scaleFactor) + 'px Arial';
                context.fillText(state.label, x, cursor + 2.8 * scaleFactor);
                cursor += 3.3 * scaleFactor;
            }
            entries.forEach(function (entry) {
                if (cursor > y + maxHeight) {
                    return;
                }
                var symbolWidth = 5 * scaleFactor;
                var symbolHeight = 3 * scaleFactor;
                var symbolY = cursor + 0.5 * scaleFactor;
                context.globalAlpha = entry.opacity;
                if (entry.geometry === 'point') {
                    context.beginPath();
                    context.arc(x + symbolWidth / 2, symbolY + symbolHeight / 2, 1.3 * scaleFactor, 0, Math.PI * 2);
                    context.fillStyle = entry.color;
                    context.fill();
                    context.strokeStyle = state.definition.stroke || '#333';
                    context.lineWidth = Math.max(1, scaleFactor);
                    context.stroke();
                } else if (entry.geometry === 'line') {
                    context.beginPath();
                    context.moveTo(x, symbolY + symbolHeight / 2);
                    context.lineTo(x + symbolWidth, symbolY + symbolHeight / 2);
                    context.strokeStyle = entry.color;
                    context.lineWidth = 0.6 * scaleFactor;
                    context.stroke();
                } else {
                    context.fillStyle = entry.color;
                    context.fillRect(x, symbolY, symbolWidth, symbolHeight);
                    context.strokeStyle = state.definition.stroke || '#333';
                    context.lineWidth = Math.max(1, scaleFactor);
                    context.strokeRect(x, symbolY, symbolWidth, symbolHeight);
                }
                context.globalAlpha = 1;
                context.fillStyle = '#202526';
                context.font = (2.5 * scaleFactor) + 'px Arial';
                var lines = wrappedLines(context, entry.label, width - symbolWidth - 2.5 * scaleFactor);
                lines.forEach(function (line, index) {
                    context.fillText(line, x + symbolWidth + 2 * scaleFactor, cursor + (2.6 + index * 2.8) * scaleFactor);
                });
                cursor += Math.max(3.1, lines.length * 2.8 + 0.5) * scaleFactor;
            });
        });
        if (!activeStates.length) {
            context.fillStyle = '#4e5a5d';
            context.font = (2.5 * scaleFactor) + 'px Arial';
            context.fillText('Nenhuma camada ativa.', x, y + 4 * scaleFactor);
        }
        return cursor;
    }

    function createPrintCanvas() {
        var orientation = elements.orientation.value;
        var width = orientation === 'portrait' ? 2480 : 3508;
        var height = orientation === 'portrait' ? 3508 : 2480;
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return { canvas: canvas, width: width, height: height, scaleFactor: width / (orientation === 'portrait' ? 210 : 297) };
    }

    function renderPrintComposition() {
        var target = createPrintCanvas();
        var canvas = target.canvas;
        var context = canvas.getContext('2d', { alpha: false });
        if (!context) {
            return Promise.reject(new Error('Não foi possível criar a área de composição no navegador.'));
        }
        var scaleFactor = target.scaleFactor;
        var width = target.width;
        var height = target.height;
        var bounds = map.getBounds();
        if (!bounds.isValid()) {
            return Promise.reject(new Error('O mapa ainda não possui uma extensão geográfica válida.'));
        }
        var mapBounds = {
            west: bounds.getWest(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            north: bounds.getNorth()
        };
        var zoom = Math.max(3, Math.min(17, Math.floor(map.getZoom())));
        var projectedBounds = projectBounds(mapBounds, zoom);
        var outer = 24 * scaleFactor;
        var frame = {
            x: 25 * scaleFactor,
            y: 30 * scaleFactor,
            width: (width - 51 * scaleFactor) * 0.64,
            height: height - 60 * scaleFactor
        };
        var fit = Math.min(frame.width / (projectedBounds.maxX - projectedBounds.minX), frame.height / (projectedBounds.maxY - projectedBounds.minY));
        var usedWidth = (projectedBounds.maxX - projectedBounds.minX) * fit;
        var usedHeight = (projectedBounds.maxY - projectedBounds.minY) * fit;
        var offsetX = frame.x + (frame.width - usedWidth) / 2;
        var offsetY = frame.y + (frame.height - usedHeight) / 2;
        var projection = function (longitude, latitude) {
            var point = mercatorProject(longitude, latitude, zoom);
            return { x: offsetX + (point.x - projectedBounds.minX) * fit, y: offsetY + (point.y - projectedBounds.minY) * fit };
        };
        var inverseProjection = function (x, y) {
            var px = projectedBounds.minX + (x - offsetX) / fit;
            var py = projectedBounds.minY + (y - offsetY) / fit;
            return mercatorUnproject(px, py, zoom);
        };
        elements.mapStatus.textContent = 'Compondo mapa-base e vetores…';
        context.fillStyle = '#fff';
        context.fillRect(0, 0, width, height);
        context.strokeStyle = '#242424';
        context.lineWidth = Math.max(2, 0.65 * scaleFactor);
        context.strokeRect(outer, outer, width - outer * 2, height - outer * 2);
        context.fillStyle = '#fff';
        context.fillRect(frame.x, frame.y, frame.width, frame.height);
        context.save();
        context.beginPath();
        context.rect(frame.x, frame.y, frame.width, frame.height);
        context.clip();

        return renderTileBackground(context, elements.basemap.value, zoom, projectedBounds, fit, offsetX, offsetY)
            .then(function () {
                elements.mapStatus.textContent = 'Desenhando ' + states.filter(function (state) { return state.visible && state.layer; }).length + ' camadas vetoriais…';
                drawLayerFeatures(context, projection, frame.width / Math.max(1, map.getSize().x));
                elements.mapStatus.textContent = 'Finalizando legenda e elementos cartográficos…';
                context.restore();
                context.strokeStyle = '#242424';
                context.lineWidth = Math.max(2, 0.65 * scaleFactor);
                context.strokeRect(frame.x, frame.y, frame.width, frame.height);
                drawCoordinateFrame(context, frame, projection, inverseProjection, scaleFactor);

                var centerLat = bounds.getCenter().lat * Math.PI / 180;
                var groundWidth = (bounds.getEast() - bounds.getWest()) * 111320 * Math.cos(centerLat);
                var metersPerPixel = groundWidth / Math.max(1, (projectedBounds.maxX - projectedBounds.minX) * fit);
                renderScaleBar(context, frame.x + frame.width * 0.61, frame.y + frame.height - 29 * scaleFactor, frame.width, metersPerPixel, scaleFactor);
                drawNorthArrow(context, frame.x + frame.width - 14 * scaleFactor, frame.y + 27 * scaleFactor, 12 * scaleFactor);

                var panelX = frame.x + frame.width + 4 * scaleFactor;
                var panelWidth = width - panelX - 27 * scaleFactor;
                var cursor = frame.y;
                var titleHeight = 26 * scaleFactor;
                context.fillStyle = '#d0eee8';
                context.fillRect(panelX, cursor, panelWidth, titleHeight);
                context.fillStyle = '#111';
                context.textAlign = 'center';
                context.font = 'bold ' + (4.8 * scaleFactor) + 'px Arial';
                var titleWidth = panelWidth - 8 * scaleFactor;
                var titleLines = wrappedLines(context, elements.title.value.trim() || 'Mapa sem título', titleWidth);
                var maxTitleLines = Math.max(1, Math.floor((titleHeight - 2 * scaleFactor) / (5.2 * scaleFactor)));
                if (titleLines.length > maxTitleLines) {
                    titleLines = titleLines.slice(0, maxTitleLines);
                    var lastLine = titleLines.length - 1;
                    while (titleLines[lastLine] && context.measureText(titleLines[lastLine] + '…').width > titleWidth) {
                        titleLines[lastLine] = titleLines[lastLine].slice(0, -1);
                    }
                    titleLines[lastLine] += '…';
                }
                var titleLineHeight = Math.min(5.2 * scaleFactor, (titleHeight - 2 * scaleFactor) / titleLines.length);
                titleLines.forEach(function (line, index) {
                    context.fillText(line, panelX + panelWidth / 2, cursor + titleHeight / 2 + (index - (titleLines.length - 1) / 2) * titleLineHeight);
                });
                cursor += titleHeight + 4 * scaleFactor;

                context.fillStyle = '#111';
                context.font = 'bold ' + (5 * scaleFactor) + 'px Arial';
                context.fillText('Legenda', panelX + panelWidth / 2, cursor);
                cursor += 3 * scaleFactor;
                var activeStates = states.filter(function (state) { return state.visible && state.layer; });
                cursor = renderLegendCanvas(context, panelX + 2 * scaleFactor, cursor, panelWidth - 4 * scaleFactor, 47 * scaleFactor, scaleFactor, activeStates) + 3 * scaleFactor;
                context.fillStyle = '#252c2d';
                context.textAlign = 'center';
                context.font = (2.5 * scaleFactor) + 'px Arial';
                var metadata = [
                    'Coordenadas geográficas · SIRGAS 2000 / EPSG:4674',
                    'Fontes: ' + (elements.sources.value.trim() || 'não informadas'),
                    'Satélite do mapa de localização: Esri, Vantor, Earthstar Geographics e comunidade GIS',
                    basemapCredit(),
                    elements.author.value.trim() ? 'Responsável: ' + elements.author.value.trim() : '',
                    elements.date.value ? 'Data: ' + formatDate(elements.date.value) : ''
                ].filter(Boolean);
                metadata.forEach(function (line) {
                    wrappedLines(context, line, panelWidth - 16 * scaleFactor).forEach(function (wrapped) {
                        cursor += 3 * scaleFactor;
                        context.fillText(wrapped, panelX + panelWidth / 2, cursor);
                    });
                });
                cursor += 2 * scaleFactor;
                context.font = 'bold ' + (4 * scaleFactor) + 'px Arial';
                context.fillText('Localização na APABF', panelX + panelWidth / 2, cursor + 4 * scaleFactor);
                var overviewY = cursor + 5 * scaleFactor;
                var logoHeight = 15 * scaleFactor;
                var overviewHeight = Math.max(30 * scaleFactor, frame.y + frame.height - overviewY - logoHeight - 17 * scaleFactor);
                var overviewWidth = Math.min(panelWidth - 6 * scaleFactor, overviewHeight * 0.54);
                var overviewX = panelX + (panelWidth - overviewWidth) / 2;
                return renderOverview(context, overviewX, overviewY, overviewWidth, overviewHeight, scaleFactor, mapBounds)
                    .then(function () {
                        context.font = (2.1 * scaleFactor) + 'px Arial';
                        context.fillStyle = '#4e5859';
                        context.textAlign = 'center';
                        context.fillText('Satélite: Esri, Vantor, Earthstar Geographics e comunidade GIS', panelX + panelWidth / 2, overviewY + overviewHeight + 2.4 * scaleFactor);
                        context.fillText('Retângulo: extensão do mapa principal · Limite: ICMBio', panelX + panelWidth / 2, overviewY + overviewHeight + 4.8 * scaleFactor);
                        elements.mapStatus.textContent = 'Incluindo logotipos institucionais…';
                        return Promise.all([
                            loadLogo('logos/APA%20da%20Baleia%20Franca.png'),
                            loadLogo('logos/icmbio%20horizontal%401000x-8.png')
                        ]);
                    }).then(function (logos) {
                    var logoY = frame.y + frame.height - logoHeight - 4.5 * scaleFactor;
                    fitImage(context, logos[0], panelX + panelWidth * 0.04, logoY, panelWidth * 0.42, logoHeight);
                    fitImage(context, logos[1], panelX + panelWidth * 0.54, logoY, panelWidth * 0.42, logoHeight);
                    context.textAlign = 'center';
                    context.fillStyle = '#4e5859';
                    context.font = (2 * scaleFactor) + 'px Arial';
                    context.fillText('Logotipos institucionais; não implica aprovação.', panelX + panelWidth / 2, frame.y + frame.height - 1.5 * scaleFactor);
                    context.strokeStyle = '#202526';
                    context.lineWidth = Math.max(2, 0.65 * scaleFactor);
                    context.strokeRect(panelX, frame.y, panelWidth, frame.height);
                    try {
                        canvas.toDataURL('image/png');
                    } catch (error) {
                        throw new Error('Uma imagem externa (mapa principal ou satélite da localização) bloqueou a exportação por CORS. Verifique a conexão e tente novamente; o satélite não será substituído silenciosamente.');
                    }
                    elements.mapStatus.textContent = 'Codificando a imagem final…';
                    return canvas;
                });
            }).catch(function (error) {
                context.restore();
                throw error;
            });
    }

    function fileBaseName() {
        var title = elements.title.value.trim() || 'mapa-apabf';
        return title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'mapa-apabf';
    }

    function downloadPng(canvas) {
        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) {
                if (!blob) {
                    reject(new Error('O navegador não conseguiu gerar o arquivo PNG.'));
                    return;
                }
                resolve(blob);
            }, 'image/png');
        }).then(function (blob) {
            return setPngDensity(blob, 300);
        }).then(function (blob) {
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = fileBaseName() + '-300dpi.png';
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        });
    }

    function pngCrc32(bytes, start, length) {
        var crc = 0xffffffff;
        for (var i = start; i < start + length; i += 1) {
            crc ^= bytes[i];
            for (var bit = 0; bit < 8; bit += 1) {
                crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
            }
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    function setPngDensity(blob, dpi) {
        return blob.arrayBuffer().then(function (buffer) {
            var source = new Uint8Array(buffer);
            var view = new DataView(buffer);
            var headerLength = view.getUint32(8);
            if (String.fromCharCode(source[12], source[13], source[14], source[15]) !== 'IHDR') {
                throw new Error('O navegador produziu um PNG inválido.');
            }
            var insertAt = 8 + 12 + headerLength;
            var output = new Uint8Array(source.length + 21);
            output.set(source.subarray(0, insertAt), 0);
            var chunk = output.subarray(insertAt, insertAt + 21);
            var chunkView = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            chunkView.setUint32(0, 9);
            chunk.set([112, 72, 89, 115], 4);
            var pixelsPerMeter = Math.round(dpi / 0.0254);
            chunkView.setUint32(8, pixelsPerMeter);
            chunkView.setUint32(12, pixelsPerMeter);
            chunk[16] = 1;
            chunkView.setUint32(17, pngCrc32(chunk, 4, 13));
            output.set(source.subarray(insertAt), insertAt + 21);
            return new Blob([output], { type: 'image/png' });
        });
    }

    function downloadPdf(canvas) {
        if (!window.jspdf || !window.jspdf.jsPDF) {
            return Promise.reject(new Error('A biblioteca de PDF não carregou. Verifique a conexão e tente novamente.'));
        }
        var orientation = elements.orientation.value;
        var pdf = new window.jspdf.jsPDF({
            orientation: orientation,
            unit: 'mm',
            format: 'a4',
            compress: true
        });
        var pageWidth = orientation === 'portrait' ? 210 : 297;
        var pageHeight = orientation === 'portrait' ? 297 : 210;
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, pageHeight, undefined, 'FAST');
        pdf.save(fileBaseName() + '-A4.pdf');
        return Promise.resolve();
    }

    function exportMap() {
        elements.exportButton.disabled = true;
        elements.exportButton.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Preparando arquivo…';
        showToast('Compondo mapa A4 em resolução de impressão…', false);
        window.setTimeout(function () {
            Promise.resolve().then(renderPrintComposition).then(function (canvas) {
                return elements.format.value === 'png' ? downloadPng(canvas) : downloadPdf(canvas);
            }).then(function () {
                showToast(elements.format.value === 'png'
                    ? 'PNG A4 em 300 dpi exportado (2480 × 3508 ou 3508 × 2480 px).'
                    : 'PDF A4 exportado com dimensões físicas de ' + (elements.orientation.value === 'portrait' ? '210 × 297' : '297 × 210') + ' mm.', false);
            }).catch(function (error) {
                showToast(error.message || 'A exportação falhou. Verifique as camadas e tente novamente.', true);
            }).finally(function () {
                elements.exportButton.disabled = false;
                elements.exportButton.innerHTML = '<i class="fas fa-download" aria-hidden="true"></i> Exportar mapa';
            });
        }, 50);
    }

    function bindControls() {
        elements.basemap.addEventListener('change', function () {
            setBasemap(elements.basemap.value);
        });
        [elements.title, elements.author, elements.sources, elements.date].forEach(function (input) {
            input.addEventListener('input', updateMapComposition);
            input.addEventListener('change', updateMapComposition);
        });
        elements.orientation.addEventListener('change', function () {
            var currentBounds = map.getBounds();
            elements.preview.classList.toggle('is-portrait', elements.orientation.value === 'portrait');
            window.setTimeout(function () {
                map.invalidateSize();
                if (currentBounds.isValid()) {
                    map.fitBounds(currentBounds, { animate: false });
                }
                overviewMap.invalidateSize();
                updateMapComposition();
            }, 60);
        });
        elements.fileImport.addEventListener('change', function () {
            importLocalFile(elements.fileImport.files && elements.fileImport.files[0]);
        });
        elements.exportButton.addEventListener('click', exportMap);
    }

    function start() {
        if (!window.L || !window.CATALOGO_GERADOR_MAPAS) {
            elements.mapStatus.textContent = 'Bibliotecas do mapa não carregaram. Abra o aplicativo usando um servidor web local.';
            elements.catalogStatus.textContent = 'Não foi possível iniciar o gerador.';
            elements.catalogStatus.classList.add('is-error');
            return;
        }
        elements.date.value = todayISO();
        initializeMaps();
        bindControls();
        setBasemap('white');
        loadOfficialLayers().catch(function (error) {
            elements.catalogStatus.textContent = 'Falha ao carregar o catálogo: ' + error.message;
            elements.catalogStatus.classList.add('is-error');
        });
    }

    start();
}());
