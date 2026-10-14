(function (global) {
    'use strict';

    function featureValue(feature, keys) {
        var properties = feature.properties || {};
        for (var index = 0; index < keys.length; index += 1) {
            var value = properties[keys[index]];
            if (value !== null && value !== undefined && String(value).trim()) {
                return String(value).trim();
            }
        }
        return '';
    }

    function initialize() {
        var legalLayers = global.instrumentosLegais;
        if (!global.map || !legalLayers) {
            throw new Error('O mapa de legislação pesqueira não foi inicializado.');
        }

        var tableBody = document.getElementById('table-body');
        var searchInput = document.getElementById('search-input');
        var searchStatus = document.getElementById('search-status');
        var sidebar = document.getElementById('sidebar');
        var sidebarOverlay = document.getElementById('sidebarOverlay');
        var popupAjuda = document.getElementById('popupAjuda');
        var initialPopup = document.getElementById('popupInicial');
        var initialLocationButton = document.getElementById('btnConsultarLocalizacao');
        var initialLocationStatus = document.getElementById('location-query-status');
        var locationMarker = null;
        var locationCircle = null;

        function focusRecord(record) {
            try {
                legalLayers.focusRecord(record);
            } catch (error) {
                console.error('Não foi possível localizar a feição no mapa:', error);
                searchStatus.textContent = 'Não foi possível localizar esta feição no mapa.';
            }
        }

        function renderRecords(records) {
            tableBody.replaceChildren();
            records.forEach(function (record) {
                var feature = record.feature;
                var properties = feature.properties || {};
                var row = document.createElement('tr');
                var legalCell = document.createElement('td');
                var descriptionCell = document.createElement('td');
                var coverageCell = document.createElement('td');
                var actionCell = document.createElement('td');
                var locateButton = document.createElement('button');

                legalCell.textContent = record.legalName;
                legalCell.style.fontWeight = '600';
                descriptionCell.textContent = featureValue(feature, ['Descrição', 'Descricao', 'Legenda 2', 'Legenda']);
                coverageCell.textContent = featureValue(feature, ['Abrangência', 'Agrangência', 'Abrangencia']) ||
                    record.category;
                row.dataset.searchText = (record.category + ' ' + JSON.stringify(properties))
                    .toLocaleLowerCase('pt-BR');
                row.addEventListener('click', function () {
                    focusRecord(record);
                });

                locateButton.type = 'button';
                locateButton.className = 'locate-btn';
                locateButton.textContent = '⌖';
                locateButton.title = 'Localizar esta feição no mapa';
                locateButton.setAttribute('aria-label', 'Localizar ' + record.legalName);
                locateButton.addEventListener('click', function (event) {
                    event.stopPropagation();
                    focusRecord(record);
                });

                actionCell.appendChild(locateButton);
                row.append(legalCell, descriptionCell, coverageCell, actionCell);
                tableBody.appendChild(row);
            });
        }

        function filterRecords() {
            searchStatus.classList.remove(
                'map-popup__status',
                'map-popup__status--success',
                'map-popup__status--warning'
            );
            var query = searchInput.value.trim().toLocaleLowerCase('pt-BR');
            var matches = legalLayers.records.filter(function (record) {
                return !query || (record.category + ' ' + JSON.stringify(record.feature.properties || {}))
                    .toLocaleLowerCase('pt-BR').indexOf(query) !== -1;
            });
            renderRecords(matches);
            searchStatus.textContent = query
                ? matches.length + (matches.length === 1 ? ' feição encontrada.' : ' feições encontradas.')
                : '';
        }

        function buildLocationPopup(event, results) {
            var content = document.createElement('div');
            content.className = 'map-popup map-popup--location location-legal-query';
            var title = document.createElement('h3');
            title.textContent = 'Legislação representada nesta localização';
            content.appendChild(title);

            var coordinates = document.createElement('p');
            coordinates.className = 'location-query-coordinates';
            coordinates.textContent = 'Coordenadas: ' +
                event.latlng.lat.toFixed(5) + ', ' + event.latlng.lng.toFixed(5);
            content.appendChild(coordinates);

            var tableWrapper = document.createElement('div');
            tableWrapper.className = 'map-popup__table-wrapper location-query-table-wrapper';
            var table = document.createElement('table');
            table.className = 'map-popup__table location-query-table';
            var header = document.createElement('thead');
            var headerRow = document.createElement('tr');
            ['Instrumento legal', 'Descrição', 'Abrangência'].forEach(function (label) {
                var cell = document.createElement('th');
                cell.textContent = label;
                headerRow.appendChild(cell);
            });
            header.appendChild(headerRow);
            table.appendChild(header);
            var body = document.createElement('tbody');
            var seenRows = new Set();
            results.applicableRecords.forEach(function (record) {
                var feature = record.feature;
                var description = featureValue(feature, ['Descrição', 'Descricao', 'Legenda 2', 'Legenda']) ||
                    'Descrição não cadastrada';
                var coverage = featureValue(feature, ['Abrangência', 'Agrangência', 'Abrangencia']) ||
                    record.category;
                var type = featureValue(feature, ['Tipo']);
                var coverageText = coverage + (type && type !== coverage ? ' · Tipologia: ' + type : '');
                var key = [
                    record.legalName.toLocaleLowerCase('pt-BR'),
                    description.toLocaleLowerCase('pt-BR'),
                    coverageText.toLocaleLowerCase('pt-BR')
                ].join('|');
                if (seenRows.has(key)) {
                    return;
                }
                seenRows.add(key);

                var row = document.createElement('tr');
                [record.legalName, description, coverageText].forEach(function (text) {
                    var cell = document.createElement('td');
                    cell.textContent = text;
                    row.appendChild(cell);
                });
                body.appendChild(row);
            });
            if (!results.applicableRecords.length) {
                var emptyRow = document.createElement('tr');
                var emptyCell = document.createElement('td');
                emptyCell.colSpan = 3;
                emptyCell.textContent = 'Nenhum instrumento poligonal foi identificado para esta posição.';
                emptyRow.appendChild(emptyCell);
                body.appendChild(emptyRow);
            }
            table.appendChild(body);
            tableWrapper.appendChild(table);
            content.appendChild(tableWrapper);

            if (results.boundaryRecords.length) {
                var boundaryNote = document.createElement('p');
                boundaryNote.className = 'map-popup__status map-popup__status--warning location-query-note';
                boundaryNote.textContent = 'A posição coincide com o limite de uma ou mais áreas; essas áreas foram incluídas pela regra de borda inclusiva.';
                content.appendChild(boundaryNote);
            }
            if (results.nearbyLinearRecords.length) {
                var linearNote = document.createElement('div');
                linearNote.className = 'map-popup__status map-popup__status--warning location-query-note';
                var noteText = document.createElement('p');
                noteText.textContent = 'Há feições lineares dentro da margem de precisão informada pelo GPS. Elas não foram classificadas como aplicáveis automaticamente:';
                linearNote.appendChild(noteText);
                var list = document.createElement('ul');
                results.nearbyLinearRecords.forEach(function (candidate) {
                    var item = document.createElement('li');
                    item.textContent = candidate.record.legalName + ' — ' +
                        candidate.record.category + ' (' +
                        Math.round(candidate.distanceMeters) + ' m da posição; precisão GPS de ' +
                        Math.round(candidate.accuracyMeters) + ' m).';
                    list.appendChild(item);
                });
                linearNote.appendChild(list);
                content.appendChild(linearNote);
            }

            var disclaimer = document.createElement('p');
            disclaimer.className = 'map-popup__description location-query-disclaimer';
            disclaimer.textContent = 'Consulta baseada nas geometrias e informações representadas neste aplicativo; não substitui a interpretação oficial das normas.';
            content.appendChild(disclaimer);
            return content;
        }

        function setLocationButton(button, busy) {
            button.disabled = busy;
            button.textContent = busy
                ? (button === initialLocationButton ? 'Obtendo localização...' : 'Consultando...')
                : (button === initialLocationButton ? '📍 Usar minha localização' : 'Centralizar');
            button.setAttribute('aria-busy', busy ? 'true' : 'false');
        }

        function showLocationError(source, message) {
            if (source === 'welcome') {
                initialLocationStatus.classList.remove('map-popup__status--info');
                initialLocationStatus.classList.add('map-popup__status', 'map-popup__status--error');
                initialLocationStatus.textContent = message;
                return;
            }
            global.alert(message);
        }

        function handleLocation(position, source) {
            var coordinates = position.coords;
            var latlng = global.L.latLng(coordinates.latitude, coordinates.longitude);
            var accuracy = coordinates.accuracy;
            global.map.setView(latlng, Math.min(16, global.map.getMaxZoom()));
            if (locationMarker) {
                global.map.removeLayer(locationMarker);
            }
            if (locationCircle) {
                global.map.removeLayer(locationCircle);
                locationCircle = null;
            }
            locationMarker = global.L.circleMarker(latlng, {
                radius: 8,
                fillColor: '#2196f3',
                color: '#fff',
                weight: 3,
                opacity: 1,
                fillOpacity: 1
            }).addTo(global.map);
            if (Number.isFinite(accuracy) && accuracy > 0) {
                locationCircle = global.L.circle(latlng, {
                    radius: accuracy,
                    color: '#2196f3',
                    fillColor: '#2196f3',
                    fillOpacity: 0.15,
                    weight: 1,
                    interactive: false
                }).addTo(global.map);
            }

            var results = legalLayers.queryLocation(latlng, accuracy);
            legalLayers.activateRecords(results.applicableRecords);
            if (source === 'welcome') {
                initialPopup.style.display = 'none';
                searchInput.value = '';
                renderRecords(results.applicableRecords);
                if (results.applicableRecords.length) {
                    searchStatus.className = 'map-popup__status map-popup__status--success';
                    searchStatus.textContent = results.applicableRecords.length +
                        (results.applicableRecords.length === 1
                            ? ' feição com incidência espacial identificada neste ponto.'
                            : ' feições com incidência espacial identificadas neste ponto.');
                } else {
                    searchStatus.className = 'map-popup__status map-popup__status--warning';
                    searchStatus.textContent = 'Nenhum instrumento com incidência espacial identificável foi encontrado para o ponto consultado. Isso não significa que a pesca esteja liberada.';
                }
                if (results.nearbyLinearRecords.length) {
                    searchStatus.textContent += ' Há feições lineares próximas dentro da margem de precisão do GPS, mas elas não foram classificadas como aplicáveis.';
                }
                sidebar.classList.add('open');
                sidebarOverlay.classList.add('active');
                document.getElementById('map').style.filter = 'grayscale(35%) brightness(0.92)';
                document.querySelectorAll('.tab-button').forEach(function (tab) {
                    tab.classList.toggle('active', tab.dataset.tab === 'instrumentos');
                    tab.setAttribute('aria-selected', tab.dataset.tab === 'instrumentos' ? 'true' : 'false');
                });
                document.querySelectorAll('.tab-content').forEach(function (content) {
                    content.classList.toggle('active', content.id === 'tab-instrumentos');
                });
                global.map.invalidateSize();
                return results;
            }

            global.L.popup({
                maxWidth: 560,
                maxHeight: Math.round(global.innerHeight * 0.65),
                className: 'location-legal-popup'
            }).setLatLng(latlng)
                .setContent(buildLocationPopup({ latlng: latlng }, results))
                .openOn(global.map);
            return results;
        }

        function geolocationErrorMessage(error) {
            if (global.isSecureContext === false) {
                return 'A localização só pode ser acessada em uma conexão segura. Abra o aplicativo usando HTTPS e tente novamente.';
            }
            if (error && error.code === 1) {
                return 'A permissão de localização foi negada. Ela é necessária para consultar os instrumentos aplicáveis à sua posição.';
            }
            if (error && error.code === 3) {
                return 'A localização demorou para ser obtida. Verifique o sinal do dispositivo e tente novamente.';
            }
            return 'Não foi possível obter sua localização. Verifique as configurações de localização do dispositivo e tente novamente.';
        }

        function requestCurrentLocation(button, source) {
            setLocationButton(button, true);
            if (source === 'welcome') {
                initialLocationStatus.classList.remove('map-popup__status--error');
                initialLocationStatus.classList.add('map-popup__status', 'map-popup__status--info');
                initialLocationStatus.textContent = 'Obtendo sua localização atual…';
            } else {
                global.map.closePopup();
            }

            var geolocation = global.navigator && global.navigator.geolocation;
            if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
                setLocationButton(button, false);
                showLocationError(source, global.isSecureContext === false
                    ? 'A localização exige uma conexão segura. Abra o aplicativo usando HTTPS e tente novamente.'
                    : 'Este navegador não disponibiliza a localização. Verifique se o acesso está habilitado e tente novamente.');
                return;
            }

            try {
                geolocation.getCurrentPosition(function (position) {
                    try {
                        handleLocation(position, source);
                        if (source === 'welcome') {
                            searchInput.focus();
                        }
                    } catch (error) {
                        console.error('Não foi possível consultar os instrumentos nesta localização:', error);
                        showLocationError(source, 'A localização foi obtida, mas não foi possível consultar as feições legais. Tente novamente.');
                    } finally {
                        setLocationButton(button, false);
                    }
                }, function (error) {
                    setLocationButton(button, false);
                    showLocationError(source, geolocationErrorMessage(error));
                }, {
                    enableHighAccuracy: true,
                    maximumAge: 0,
                    timeout: 10000
                });
            } catch (error) {
                setLocationButton(button, false);
                showLocationError(source, geolocationErrorMessage(error));
            }
        }

        function closeSidebar() {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            document.getElementById('map').style.filter = 'none';
        }

        document.getElementById('sidebarToggle').addEventListener('click', function () {
            sidebar.classList.add('open');
            sidebarOverlay.classList.add('active');
            document.getElementById('map').style.filter = 'grayscale(35%) brightness(0.92)';
        });
        document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
        sidebarOverlay.addEventListener('click', closeSidebar);

        document.querySelectorAll('.tab-button').forEach(function (button) {
            button.addEventListener('click', function () {
                document.querySelectorAll('.tab-button').forEach(function (tab) {
                    tab.classList.toggle('active', tab === button);
                });
                document.querySelectorAll('.tab-content').forEach(function (content) {
                    content.classList.toggle('active', content.id === 'tab-' + button.dataset.tab);
                });
                if (button.dataset.tab === 'instrumentos') {
                    searchInput.focus();
                }
            });
        });

        searchInput.addEventListener('input', filterRecords);
        document.getElementById('restore-all-btn').addEventListener('click', function () {
            legalLayers.restoreAll();
        });
        document.getElementById('btnAbrirAjuda').addEventListener('click', function () {
            popupAjuda.style.display = 'flex';
        });

        document.getElementById('btnCentralizar').addEventListener('click', function () {
            requestCurrentLocation(this, 'map');
        });
        initialLocationButton.addEventListener('click', function () {
            initialLocationStatus.textContent = '';
            initialLocationStatus.classList.remove(
                'map-popup__status',
                'map-popup__status--info',
                'map-popup__status--error'
            );
            requestCurrentLocation(this, 'welcome');
        });

        popupAjuda.addEventListener('click', function (event) {
            if (event.target === popupAjuda) {
                popupAjuda.style.display = 'none';
            }
        });
        document.getElementById('popupAjudaClose').addEventListener('click', function () {
            popupAjuda.style.display = 'none';
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                closeSidebar();
                popupAjuda.style.display = 'none';
                document.getElementById('popupInicial').style.display = 'none';
            }
        });

        global.FecharPopup = function () {
            document.getElementById('popupInicial').style.display = 'none';
            global.map.invalidateSize();
        };

        renderRecords(legalLayers.records);
        document.getElementById('popupInicial').style.display = 'flex';
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
}(window));
