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
        var locateButton = document.getElementById('btnCentralizar');
        var selectionDetails = document.getElementById('trail-selection-details');
        var selectionName = document.getElementById('trail-selection-name');
        var selectionSummary = document.getElementById('trail-selection-summary');
        var directionsLinks = document.getElementById('trail-directions-links');
        var googleMapsLink = document.getElementById('trail-google-maps-link');
        var wazeLink = document.getElementById('trail-waze-link');
        var findAccessButton = document.getElementById('trail-find-access');
        var routingStatus = document.getElementById('trail-routing-status');
        var navigation = global.TrilhaNavegacao;
        var navigationRequestId = 0;
        var selectedHalo = null;
        var selectedHighlight = null;
        var selectedTrail = null;
        var locationMarker = null;
        var locationAccuracy = null;

        if (!map || !leaflet || !navigation || !collection || !trailLayer) {
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

        function positionLocateButton() {
            var navigation = document.querySelector('.nav-bar');
            if (!navigation) {
                return;
            }
            var navigationTop = navigation.getBoundingClientRect().top;
            var viewportHeight = global.visualViewport
                ? global.visualViewport.height
                : global.innerHeight;
            locateButton.style.setProperty(
                '--trail-locate-bottom',
                Math.max(0, viewportHeight - navigationTop + 10) + 'px'
            );
        }

        global.requestAnimationFrame(positionLocateButton);
        global.addEventListener('resize', positionLocateButton);
        if (global.visualViewport) {
            global.visualViewport.addEventListener('resize', positionLocateButton);
        }
        if (global.ResizeObserver) {
            var navigation = document.querySelector('.nav-bar');
            if (navigation) {
                new global.ResizeObserver(positionLocateButton).observe(navigation);
            }
        }

        map.createPane('pane_trilha_selecionada_contorno');
        map.getPane('pane_trilha_selecionada_contorno').style.zIndex = 450;
        map.getPane('pane_trilha_selecionada');
        map.createPane('pane_trilha_selecionada');
        map.getPane('pane_trilha_selecionada').style.zIndex = 451;

        var overviewBounds = leaflet.latLngBounds(trailLayer.getBounds());

        function setUserLocation(position) {
            var latlng = leaflet.latLng(position.coords.latitude, position.coords.longitude);
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
            return [position.coords.longitude, position.coords.latitude];
        }

        function requestDirections() {
            if (!selectedTrail) {
                return;
            }
            var requestId = ++navigationRequestId;
            var trail = selectedTrail;
            directionsLinks.hidden = true;
            findAccessButton.disabled = true;
            routingStatus.textContent = 'Obtendo sua localização para selecionar o extremo mais próximo…';
            routingStatus.hidden = false;
            var geolocation = global.navigator && global.navigator.geolocation;
            if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
                routingStatus.textContent = 'Este navegador não disponibiliza geolocalização. Ela é necessária para determinar qual extremo da trilha está mais próximo.';
                findAccessButton.disabled = false;
                return;
            }
            geolocation.getCurrentPosition(function (position) {
                if (requestId !== navigationRequestId || !selectedTrail
                    || selectedTrail.id !== trail.id) {
                    return;
                }
                try {
                    var origin = setUserLocation(position);
                    var destination = navigation.closestEndpoint(trail.feature.geometry, origin);
                    googleMapsLink.href = navigation.googleMapsUrl(destination.coordinates);
                    wazeLink.href = navigation.wazeUrl(destination.coordinates);
                    directionsLinks.hidden = false;
                    routingStatus.textContent = 'Destino: extremo '
                        + (destination.end === 'start' ? 'inicial' : 'final')
                        + (navigation.geometryEndpoints(trail.feature.geometry).length > 2
                            ? ' do segmento ' + (destination.component + 1)
                            : '')
                        + ', a ' + Math.round(destination.distance) + ' m da sua localização.';
                    routingStatus.hidden = false;
                } catch (error) {
                    routingStatus.textContent = error.message;
                    routingStatus.hidden = false;
                } finally {
                    findAccessButton.disabled = false;
                }
            }, function (error) {
                if (requestId !== navigationRequestId || !selectedTrail
                    || selectedTrail.id !== trail.id) {
                    return;
                }
                routingStatus.textContent = error && error.code === 1
                    ? 'A permissão de localização é necessária para determinar qual extremo da trilha está mais próximo.'
                    : error && error.code === 3
                        ? 'A localização demorou para ser obtida. Tente novamente; ela é necessária para selecionar o extremo mais próximo.'
                        : 'Não foi possível obter sua localização. Ela é necessária para determinar qual extremo da trilha está mais próximo.';
                routingStatus.hidden = false;
                findAccessButton.disabled = false;
            }, {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 10000
            });
        }

        function updateSelectedTrailDetails() {
            if (!selectedTrail) {
                selectionDetails.hidden = true;
                directionsLinks.hidden = true;
                findAccessButton.hidden = true;
                routingStatus.hidden = true;
                return;
            }
            selectionName.textContent = selectedTrail.name || 'Trilha sem nome cadastrado';
            selectionSummary.textContent = [
                selectedTrail.distance ? 'Distância: ' + selectedTrail.distance : '',
                selectedTrail.municipalities.length
                    ? 'Município: ' + selectedTrail.municipalities.join(', ')
                    : ''
            ].filter(Boolean).join(' · ');
            selectionDetails.hidden = false;
            findAccessButton.hidden = false;
            findAccessButton.disabled = false;
            directionsLinks.hidden = true;
            routingStatus.hidden = true;
        }

        function updateResultSelection() {
            resultsList.querySelectorAll('[data-trail-id]').forEach(function (item) {
                var isSelected = selectedTrail && item.dataset.trailId === selectedTrail.id;
                item.classList.toggle('is-selected', Boolean(isSelected));
                var button = item.querySelector('.trail-locate-button');
                if (button) {
                    button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
                }
            });
            updateSelectedTrailDetails();
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
            if (!selectedTrail || selectedTrail.id !== trail.id) {
                navigationRequestId += 1;
            }
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

        function renderTrails(matches) {
            resultsList.replaceChildren();
            matches.forEach(function (trail) {
                var item = document.createElement('tr');
                var nameCell = document.createElement('td');
                var distanceCell = document.createElement('td');
                var municipalityCell = document.createElement('td');
                var actionCell = document.createElement('td');
                var locateButton = document.createElement('button');
                var searchIcon = document.createElement('i');

                item.className = 'trail-result';
                item.dataset.trailId = trail.id;
                nameCell.className = 'trail-result-name';
                nameCell.textContent = trail.name || 'Trilha sem nome cadastrado';
                distanceCell.textContent = trail.distance || '—';
                municipalityCell.textContent = trail.municipalities.join(', ') || '—';

                locateButton.type = 'button';
                locateButton.className = 'trail-locate-button';
                locateButton.setAttribute('aria-pressed', 'false');
                locateButton.title = 'Localizar esta trilha no mapa';
                locateButton.setAttribute('aria-label', 'Localizar ' + (trail.name || 'trilha sem nome'));
                searchIcon.className = 'fas fa-search';
                searchIcon.setAttribute('aria-hidden', 'true');
                locateButton.appendChild(searchIcon);
                locateButton.addEventListener('click', function (event) {
                    event.stopPropagation();
                    locateTrail(trail, true);
                });

                item.addEventListener('click', function () {
                    locateTrail(trail, true);
                });
                actionCell.appendChild(locateButton);
                item.append(nameCell, distanceCell, municipalityCell, actionCell);
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
                setUserLocation(position);
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
        findAccessButton.addEventListener('click', requestDirections);
        locateButton.addEventListener('click', function () {
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
