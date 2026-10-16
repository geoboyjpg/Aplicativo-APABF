(function (global) {
    'use strict';

    function normalizeSearch(value) {
        return String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase('pt-BR');
    }

    function municipalities(value) {
        return String(value || '')
            .split(',')
            .map(function (name) {
                return name.trim();
            })
            .filter(function (name, index, names) {
                return name && names.indexOf(name) === index;
            });
    }

    function initialize() {
        var map = global.map;
        var leaflet = global.L;
        var collection = global.json_TrilhaCaminhosdaBaleiaFranca_2;
        var trailLayer = global.layer_TrilhaCaminhosdaBaleiaFranca_2;
        var searchInput = document.getElementById('trail-search');
        var searchStatus = document.getElementById('trail-search-status');
        var resultsList = document.getElementById('trail-results');
        var sidebar = document.getElementById('sidebar');
        var sidebarOverlay = document.getElementById('sidebarOverlay');
        var selectedHalo = null;
        var selectedHighlight = null;
        var selectedTrail = null;
        var locationMarker = null;
        var locationAccuracy = null;

        if (!map || !leaflet || !collection || !trailLayer) {
            throw new Error('O mapa ou os dados das trilhas não foram inicializados.');
        }

        var renderedLayers = new Map();
        trailLayer.eachLayer(function (featureLayer) {
            var properties = featureLayer.feature && featureLayer.feature.properties;
            var fid = properties && properties.fid;
            if (fid === null || fid === undefined) {
                throw new Error('Foi encontrada uma trilha sem identificador.');
            }
            var key = String(fid);
            if (renderedLayers.has(key)) {
                throw new Error('Identificador de trilha duplicado: ' + key);
            }
            renderedLayers.set(key, featureLayer);
        });

        var trails = collection.features.map(function (feature) {
            var properties = feature.properties || {};
            var fid = properties.fid;
            var key = String(fid);
            var featureLayer = renderedLayers.get(key);
            if (fid === null || fid === undefined || !featureLayer) {
                throw new Error('Não foi possível associar a trilha ao identificador ' + key + '.');
            }
            return {
                id: key,
                feature: feature,
                layer: featureLayer,
                name: String(properties['Nome'] || '').trim(),
                distance: String(properties['Distância'] || '').trim(),
                municipalities: municipalities(properties['Município'])
            };
        });

        if (trails.length !== renderedLayers.size) {
            throw new Error('A quantidade de trilhas carregadas diverge dos dados geográficos.');
        }

        var countsByName = new Map();
        trails.forEach(function (trail) {
            var key = normalizeSearch(trail.name);
            countsByName.set(key, (countsByName.get(key) || 0) + 1);
        });

        map.createPane('pane_trilha_selecionada_contorno');
        map.getPane('pane_trilha_selecionada_contorno').style.zIndex = 450;
        map.getPane('pane_trilha_selecionada');
        map.createPane('pane_trilha_selecionada');
        map.getPane('pane_trilha_selecionada').style.zIndex = 451;

        var overviewBounds = leaflet.latLngBounds(trailLayer.getBounds());

        function updateResultSelection() {
            resultsList.querySelectorAll('[data-trail-id]').forEach(function (item) {
                var isSelected = selectedTrail && item.dataset.trailId === selectedTrail.id;
                item.classList.toggle('is-selected', Boolean(isSelected));
                var button = item.querySelector('.trail-locate-button');
                if (button) {
                    button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
                }
            });
        }

        function clearHighlight() {
            if (selectedHalo && map.hasLayer(selectedHalo)) {
                map.removeLayer(selectedHalo);
            }
            if (selectedHighlight && map.hasLayer(selectedHighlight)) {
                map.removeLayer(selectedHighlight);
            }
            selectedHalo = null;
            selectedHighlight = null;
            selectedTrail = null;
            updateResultSelection();
        }

        function setHighlight(trail) {
            if (selectedHalo && map.hasLayer(selectedHalo)) {
                map.removeLayer(selectedHalo);
            }
            if (selectedHighlight && map.hasLayer(selectedHighlight)) {
                map.removeLayer(selectedHighlight);
            }

            selectedTrail = trail;
            selectedHalo = leaflet.geoJSON(trail.feature, {
                pane: 'pane_trilha_selecionada_contorno',
                interactive: false,
                style: {
                    color: '#102d20',
                    opacity: 0.96,
                    weight: 10,
                    lineCap: 'round',
                    lineJoin: 'round'
                }
            }).addTo(map);
            selectedHighlight = leaflet.geoJSON(trail.feature, {
                pane: 'pane_trilha_selecionada',
                interactive: false,
                style: {
                    color: '#76ff03',
                    opacity: 1,
                    weight: 6,
                    lineCap: 'round',
                    lineJoin: 'round'
                }
            }).addTo(map);
            updateResultSelection();
        }

        function fitTrailBounds(bounds) {
            var size = map.getSize();
            var panelWidth = sidebar.classList.contains('open')
                ? sidebar.getBoundingClientRect().width
                : 0;
            var leftPadding = Math.min(Math.ceil(panelWidth + 24), Math.floor(size.x * 0.58));
            map.fitBounds(bounds, {
                paddingTopLeft: [leftPadding, 54],
                paddingBottomRight: [24, 110],
                maxZoom: 16
            });
        }

        function locateTrail(trail, openPopup) {
            if (!trail) {
                return;
            }
            if (!map.hasLayer(trailLayer)) {
                map.addLayer(trailLayer);
            }
            setHighlight(trail);

            if (global.innerWidth <= 700 && sidebar.classList.contains('open')) {
                closeSidebar();
            }
            var bounds = trail.layer.getBounds();
            if (bounds.isValid()) {
                fitTrailBounds(bounds);
            }
            if (openPopup) {
                trail.layer.openPopup(bounds.isValid() ? bounds.getCenter() : undefined);
            }
        }

        function appendDetail(container, label, value, className) {
            if (!value) {
                return;
            }
            var detail = document.createElement('span');
            detail.className = className;
            detail.textContent = value;
            container.appendChild(detail);
        }

        function renderTrails(matches) {
            resultsList.replaceChildren();
            matches.forEach(function (trail) {
                var item = document.createElement('li');
                var heading = document.createElement('h5');
                var route = document.createElement('p');
                var routeSwatch = document.createElement('i');
                var details = document.createElement('div');
                var locateButton = document.createElement('button');

                item.className = 'trail-result';
                item.dataset.trailId = trail.id;
                heading.className = 'trail-result-name';
                heading.textContent = trail.name || 'Trilha sem nome cadastrado';
                route.className = 'trail-result-route';
                routeSwatch.className = 'trail-legend-line';
                routeSwatch.setAttribute('aria-hidden', 'true');
                route.append(routeSwatch, document.createTextNode('Traçado representado no mapa'));
                details.className = 'trail-result-details';
                appendDetail(details, 'distance', trail.distance
                    ? 'Distância informada: ' + trail.distance
                    : '', 'trail-result-distance');
                appendDetail(details, 'municipalities', trail.municipalities.length
                    ? 'Município' + (trail.municipalities.length > 1 ? 's' : '') + ': ' +
                        trail.municipalities.join(', ')
                    : '', 'trail-result-municipality');

                if ((countsByName.get(normalizeSearch(trail.name)) || 0) > 1) {
                    var disambiguation = trail.municipalities.length
                        ? trail.municipalities.join(', ')
                        : 'Percurso ' + (trail.feature.properties.ID || trail.id);
                    if (trail.municipalities.length) {
                        var sameMunicipality = trails.some(function (other) {
                            return other.id !== trail.id &&
                                normalizeSearch(other.name) === normalizeSearch(trail.name) &&
                                normalizeSearch(other.municipalities.join(', ')) ===
                                    normalizeSearch(trail.municipalities.join(', '));
                        });
                        if (sameMunicipality) {
                            disambiguation += ' · Percurso ' +
                                (trail.feature.properties.ID || trail.id);
                        }
                    }
                    heading.appendChild(document.createTextNode(' — ' + disambiguation));
                }

                locateButton.type = 'button';
                locateButton.className = 'trail-locate-button map-ui-button map-ui-button--primary';
                locateButton.setAttribute('aria-pressed', 'false');
                locateButton.innerHTML = '<i class="fas fa-search-location" aria-hidden="true"></i> Localizar';
                locateButton.addEventListener('click', function (event) {
                    event.stopPropagation();
                    locateTrail(trail, true);
                });

                item.addEventListener('click', function () {
                    locateTrail(trail, true);
                });
                item.append(heading, route, details, locateButton);
                resultsList.appendChild(item);
            });
            updateResultSelection();
        }

        function filterTrails() {
            var query = normalizeSearch(searchInput.value);
            var matches = trails.filter(function (trail) {
                if (!query) {
                    return true;
                }
                var searchableValues = [trail.name].concat(trail.municipalities);
                return searchableValues.some(function (value) {
                    return normalizeSearch(value).indexOf(query) !== -1;
                });
            });
            renderTrails(matches);
            searchStatus.textContent = matches.length
                ? matches.length + (matches.length === 1 ? ' trilha encontrada.' : ' trilhas encontradas.')
                : 'Nenhuma trilha encontrada para esta pesquisa.';
        }

        function closeSidebar() {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            document.getElementById('map').style.filter = 'none';
            map.invalidateSize();
        }

        function openSidebar() {
            sidebar.classList.add('open');
            sidebarOverlay.classList.add('active');
            document.getElementById('map').style.filter = 'grayscale(25%) brightness(0.95)';
            map.invalidateSize();
        }

        function restoreOverview() {
            clearHighlight();
            map.closePopup();
            if (overviewBounds.isValid()) {
                fitTrailBounds(overviewBounds);
            }
        }

        function locateUser(button) {
            var geolocation = global.navigator && global.navigator.geolocation;
            if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
                global.alert('Este navegador não disponibiliza a localização. Verifique se o acesso está habilitado.');
                return;
            }
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            geolocation.getCurrentPosition(function (position) {
                var latlng = leaflet.latLng(position.coords.latitude, position.coords.longitude);
                map.setView(latlng, Math.min(16, map.getMaxZoom()));
                if (locationMarker) {
                    map.removeLayer(locationMarker);
                }
                if (locationAccuracy) {
                    map.removeLayer(locationAccuracy);
                    locationAccuracy = null;
                }
                locationMarker = leaflet.circleMarker(latlng, {
                    radius: 8,
                    fillColor: '#0876a5',
                    color: '#fff',
                    weight: 3,
                    opacity: 1,
                    fillOpacity: 1
                }).addTo(map);
                if (Number.isFinite(position.coords.accuracy) && position.coords.accuracy > 0) {
                    locationAccuracy = leaflet.circle(latlng, {
                        radius: position.coords.accuracy,
                        color: '#0876a5',
                        fillColor: '#0876a5',
                        fillOpacity: 0.12,
                        weight: 1,
                        interactive: false
                    }).addTo(map);
                }
                button.disabled = false;
                button.removeAttribute('aria-busy');
            }, function (error) {
                button.disabled = false;
                button.removeAttribute('aria-busy');
                var message = error && error.code === 1
                    ? 'A permissão de localização foi negada.'
                    : error && error.code === 3
                        ? 'A localização demorou para ser obtida. Tente novamente.'
                        : 'Não foi possível obter sua localização.';
                global.alert(message);
            }, {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 10000
            });
        }

        trails.forEach(function (trail) {
            trail.layer.on('click', function () {
                setHighlight(trail);
            });
        });

        document.getElementById('sidebarToggle').addEventListener('click', openSidebar);
        document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
        sidebarOverlay.addEventListener('click', closeSidebar);
        document.querySelectorAll('.tab-button').forEach(function (button) {
            button.addEventListener('click', function () {
                document.querySelectorAll('.tab-button').forEach(function (tab) {
                    var active = tab === button;
                    tab.classList.toggle('active', active);
                    tab.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                document.querySelectorAll('.tab-content').forEach(function (content) {
                    content.classList.toggle('active', content.id === 'tab-' + button.dataset.tab);
                });
                if (button.dataset.tab === 'trilhas') {
                    searchInput.focus();
                }
            });
        });
        searchInput.addEventListener('input', filterTrails);
        document.getElementById('restore-overview').addEventListener('click', restoreOverview);
        document.getElementById('btnCentralizar').addEventListener('click', function () {
            locateUser(this);
        });
        document.getElementById('btnExplorarMapa').addEventListener('click', function () {
            document.getElementById('popupInicial').style.display = 'none';
            map.invalidateSize();
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                closeSidebar();
                document.getElementById('popupInicial').style.display = 'none';
            }
        });

        filterTrails();
        map.fitBounds(overviewBounds, { padding: [32, 32], maxZoom: 13 });
        map.invalidateSize();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
}(window));
