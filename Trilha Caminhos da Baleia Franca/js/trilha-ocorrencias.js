(function (root, factory) {
    'use strict';

    var occurrences = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = occurrences;
    } else {
        root.TrilhaOcorrencias = occurrences;
        if (root.document) {
            occurrences.initialize(root);
        }
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
    'use strict';

    var isLocalHost = global && global.location
        && (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1');
    var API_BASE_URL = isLocalHost
        ? 'http://localhost:8787'
        : 'https://apabf-trilhas-api.gerhard-henrique23.workers.dev';
    var initializedMaps = new WeakSet();
    var locationPicking = false;

    function normalizeId(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function isNonEmptyString(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    function isValidDate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }
        var date = new Date(value + 'T00:00:00Z');
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }

    function validateCatalog(catalog) {
        if (!catalog || !Array.isArray(catalog.categorias) || !Array.isArray(catalog.situacoes)) {
            throw new Error('O catálogo não contém listas válidas de categorias e situações.');
        }
        [
            { entries: catalog.categorias, label: 'nome' },
            { entries: catalog.situacoes, label: 'rotulo' }
        ].forEach(function (group) {
            var keys = new Set();
            group.entries.forEach(function (entry) {
                if (!entry || !isNonEmptyString(entry.chave) || keys.has(entry.chave)
                    || !isNonEmptyString(entry[group.label]) || typeof entry.ativo !== 'boolean'
                    || !entry.identificacao_visual
                    || !/^#[0-9A-Fa-f]{6}$/.test(entry.identificacao_visual.cor)
                    || !/^fa-[a-z0-9-]+$/.test(entry.identificacao_visual.icone)) {
                    throw new Error('O catálogo contém uma categoria ou situação inválida.');
                }
                keys.add(entry.chave);
            });
        });
    }

    function validateOccurrenceCollection(collection, catalog) {
        if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
            throw new Error('A API não retornou uma FeatureCollection válida de ocorrências.');
        }
        var categoryKeys = new Set(catalog.categorias.map(function (entry) {
            return entry.chave;
        }));
        var situationKeys = new Set(catalog.situacoes.map(function (entry) {
            return entry.chave;
        }));
        var identifiers = new Set();

        collection.features.forEach(function (feature) {
            var properties = feature && feature.properties;
            var geometry = feature && feature.geometry;
            var coordinates = geometry && geometry.coordinates;
            if (!feature || feature.type !== 'Feature' || !properties
                || !geometry || geometry.type !== 'Point' || !Array.isArray(coordinates)
                || coordinates.length !== 2 || !Number.isFinite(coordinates[0])
                || coordinates[0] < -180 || coordinates[0] > 180
                || !Number.isFinite(coordinates[1]) || coordinates[1] < -90 || coordinates[1] > 90) {
                throw new Error('Foi encontrada uma ocorrência sem ponto geográfico 2D válido.');
            }
            if (!isNonEmptyString(properties.ocorrencia_id)
                || identifiers.has(properties.ocorrencia_id)
                || !isNonEmptyString(normalizeId(properties.trilha_fid))
                || !categoryKeys.has(properties.categoria)
                || (properties.descricao !== null && typeof properties.descricao !== 'string')
                || !isValidDate(properties.data_identificacao)
                || (properties.situacao !== null && !situationKeys.has(properties.situacao))
                || !Array.isArray(properties.fotografias)) {
                throw new Error('Foi encontrada uma ocorrência com atributos inválidos ou referências ausentes.');
            }
            identifiers.add(properties.ocorrencia_id);
        });
    }

    function getMarkerVisuals(catalog, categoryKey, situationKey) {
        var category = catalog.categorias.find(function (entry) {
            return entry.chave === categoryKey;
        });
        var situation = catalog.situacoes.find(function (entry) {
            return entry.chave === situationKey;
        });
        if (!category || (!situation && situationKey !== null)) {
            throw new Error('Não há identificação visual configurada para a categoria ou situação.');
        }
        if (!situation) {
            situation = {
                rotulo: 'Situação não informada',
                identificacao_visual: {
                    cor: '#6B7280',
                    icone: 'fa-circle-question'
                }
            };
        }
        return {
            categoryName: category.nome,
            categoryColor: category.identificacao_visual.cor,
            categoryIcon: category.identificacao_visual.icone,
            situationLabel: situation.rotulo,
            situationColor: situation.identificacao_visual.cor,
            situationIcon: situation.identificacao_visual.icone
        };
    }

    function filterOccurrences(records, filters) {
        var criteria = filters || {};
        return records.filter(function (record) {
            var properties = record.properties;
            var date = properties.data_identificacao;
            return (!criteria.trailId || normalizeId(properties.trilha_fid) === String(criteria.trailId))
                && (!criteria.category || properties.categoria === criteria.category)
                && (!criteria.situation || properties.situacao === criteria.situation)
                && (!criteria.dateFrom || date >= criteria.dateFrom)
                && (!criteria.dateTo || date <= criteria.dateTo);
        });
    }

    function resolveTrailName(collection, trailId) {
        var feature = collection && Array.isArray(collection.features)
            ? collection.features.find(function (trail) {
                return trail && trail.properties
                    && normalizeId(trail.properties.fid) === normalizeId(trailId);
            })
            : null;
        var name = feature && feature.properties && feature.properties.Nome;
        return isNonEmptyString(name) ? name.trim() : null;
    }

    function buildTrailOptions(collection, records) {
        var options = [];
        var seen = new Set();
        if (collection && Array.isArray(collection.features)) {
            collection.features.forEach(function (feature) {
                var properties = feature && feature.properties;
                var id = properties && normalizeId(properties.fid);
                if (!id || seen.has(id)) {
                    return;
                }
                seen.add(id);
                options.push({
                    chave: id,
                    nome: (isNonEmptyString(properties.Nome) ? properties.Nome.trim() : 'Trilha')
                        + ' (' + id + ')'
                });
            });
        }
        if (!options.length) {
            records.forEach(function (record) {
                var id = normalizeId(record.properties.trilha_fid);
                if (id && !seen.has(id)) {
                    seen.add(id);
                    options.push({ chave: id, nome: 'Trilha ' + id });
                }
            });
        }
        return options;
    }

    function photoApiUrl(path) {
        if (typeof path !== 'string'
            || !/^\/api\/ocorrencias\/[A-Za-z0-9_-]+\/fotografias\/[0-9a-f-]{36}(?:\/miniatura)?$/i.test(path)) {
            return null;
        }
        return API_BASE_URL + path;
    }

    function openPhotoViewer(photos, initialIndex) {
        var dialog = document.createElement('dialog');
        dialog.className = 'occurrence-photo-viewer';
        dialog.setAttribute('aria-label', 'Galeria de fotografias');
        var image = document.createElement('img');
        var status = document.createElement('p');
        var actions = document.createElement('div');
        actions.className = 'occurrence-photo-viewer__actions';
        var previous = document.createElement('button');
        previous.type = 'button';
        previous.textContent = 'Anterior';
        var close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Fechar';
        var next = document.createElement('button');
        next.type = 'button';
        next.textContent = 'Próxima';
        actions.append(previous, status, next, close);
        dialog.append(image, actions);
        var currentIndex = initialIndex;

        function showPhoto(index) {
            currentIndex = (index + photos.length) % photos.length;
            image.onerror = function () {
                image.removeAttribute('src');
                status.textContent = 'Imagem indisponível.';
            };
            var imageUrl = photoApiUrl(photos[currentIndex].url);
            if (imageUrl) {
                image.src = imageUrl;
            } else {
                image.removeAttribute('src');
                status.textContent = 'Imagem indisponível.';
            }
            image.alt = 'Fotografia ' + (currentIndex + 1) + ' de ' + photos.length;
            status.textContent = (currentIndex + 1) + ' de ' + photos.length;
        }

        previous.addEventListener('click', function () {
            showPhoto(currentIndex - 1);
        });
        next.addEventListener('click', function () {
            showPhoto(currentIndex + 1);
        });
        close.addEventListener('click', function () {
            dialog.close();
            dialog.remove();
        });
        dialog.addEventListener('close', function () {
            dialog.remove();
        });
        document.body.appendChild(dialog);
        showPhoto(currentIndex);
        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }
    }

    function popupContent(record, trailCollection, visuals) {
        var properties = record.properties;
        var content = document.createElement('div');
        content.className = 'occurrence-popup';
        var trailId = normalizeId(properties.trilha_fid);
        var trailName = resolveTrailName(trailCollection, trailId);
        [
            ['Categoria', visuals.categoryName],
            ['Descrição', properties.descricao || 'Sem descrição informada.'],
            ['Data de identificação', properties.data_identificacao],
            ['Situação', visuals.situationLabel],
            ['Trilha relacionada', trailName
                ? trailId + ' — ' + trailName
                : trailId]
        ].forEach(function (item) {
            var row = document.createElement('p');
            var label = document.createElement('strong');
            label.textContent = item[0] + ': ';
            row.append(label, document.createTextNode(String(item[1])));
            content.appendChild(row);
        });
        var photos = Array.isArray(properties.fotografias)
            ? properties.fotografias.filter(function (photo) {
                return photo && typeof photo === 'object'
                    && isNonEmptyString(photo.url);
            })
            : [];
        if (photos.length) {
            var gallery = document.createElement('section');
            gallery.className = 'occurrence-gallery';
            var title = document.createElement('strong');
            title.textContent = 'Fotografias (' + photos.length + ')';
            var thumbnails = document.createElement('div');
            thumbnails.className = 'occurrence-gallery__thumbnails';
            photos.forEach(function (photo, index) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'occurrence-gallery__thumbnail';
                button.setAttribute('aria-label', 'Abrir fotografia ' + (index + 1));
                var image = document.createElement('img');
                image.alt = 'Miniatura da fotografia ' + (index + 1);
                image.loading = 'lazy';
                image.dataset.photoUrl = photoApiUrl(photo.miniatura_url || photo.url)
                    ? photo.miniatura_url || photo.url
                    : '';
                image.onerror = function () {
                    image.removeAttribute('src');
                    image.alt = 'Imagem indisponível';
                    button.disabled = true;
                };
                button.appendChild(image);
                button.disabled = !image.dataset.photoUrl || !photoApiUrl(photo.url);
                button.addEventListener('click', function () {
                    if (!button.disabled) {
                        openPhotoViewer(photos, index);
                    }
                });
                thumbnails.appendChild(button);
            });
            gallery.append(title, thumbnails);
            content.appendChild(gallery);
        }
        return {
            content: content,
            activatePhotos: function () {
                Array.from(content.querySelectorAll('img[data-photo-url]')).forEach(function (image) {
                    if (!image.getAttribute('src')) {
                        var imageUrl = photoApiUrl(image.dataset.photoUrl);
                        if (imageUrl) {
                            image.src = imageUrl;
                        } else {
                            image.alt = 'Imagem indisponível';
                        }
                    }
                });
            }
        };
    }

    function createMarkerIcon(leaflet, visuals) {
        var icon = document.createElement('span');
        icon.className = 'occurrence-marker';
        icon.setAttribute('aria-hidden', 'true');
        icon.style.setProperty('--occurrence-category-color', visuals.categoryColor);
        icon.style.setProperty('--occurrence-situation-color', visuals.situationColor);

        var categorySymbol = document.createElement('i');
        categorySymbol.classList.add('fas', visuals.categoryIcon);
        categorySymbol.className += ' occurrence-marker__category';
        icon.appendChild(categorySymbol);

        var situationBadge = document.createElement('span');
        situationBadge.className = 'occurrence-marker__situation';
        var situationSymbol = document.createElement('i');
        situationSymbol.classList.add('fas', visuals.situationIcon);
        situationBadge.appendChild(situationSymbol);
        icon.appendChild(situationBadge);

        return leaflet.divIcon({
            className: 'occurrence-marker-icon',
            html: icon,
            iconSize: [38, 38],
            iconAnchor: [19, 19],
            popupAnchor: [0, -18]
        });
    }

    function initialize(global) {
        var map = global.map;
        var leaflet = global.L;
        var status = document.getElementById('occurrence-status');
        var actionStatus = document.getElementById('occurrence-action-status');
        var formStatus = document.getElementById('occurrence-form-status');
        var locationStatus = document.getElementById('occurrence-location-status');
        var filtersForm = document.getElementById('occurrence-filters');
        var registrationForm = document.getElementById('occurrence-registration-form');
        if (!map || !leaflet || !status || !filtersForm || !registrationForm
            || typeof global.fetch !== 'function' || initializedMaps.has(map)) {
            return;
        }

        var queryView = document.getElementById('occurrence-query-view');
        var registrationView = document.getElementById('occurrence-registration-view');
        var registrationTrail = document.getElementById('occurrence-registration-trail');
        var registrationCategory = document.getElementById('occurrence-registration-category');
        var registrationDescription = document.getElementById('occurrence-registration-description');
        var registrationDate = document.getElementById('occurrence-registration-date');
        var locationButton = document.getElementById('occurrence-pick-location');
        var submitButton = document.getElementById('occurrence-submit');
        var cancelFormButton = document.getElementById('occurrence-cancel-form');
        var photoCameraButton = document.getElementById('occurrence-photo-camera');
        var photoGalleryButton = document.getElementById('occurrence-photo-gallery');
        var photoCameraInput = document.getElementById('occurrence-photo-camera-input');
        var photoGalleryInput = document.getElementById('occurrence-photo-gallery-input');
        var photoPreviews = document.getElementById('occurrence-photo-previews');
        var photoStatus = document.getElementById('occurrence-photo-status');
        var occurrenceLayer = null;
        var locationMarker = null;
        var selectedCoordinates = null;
        var records = [];
        var trailCollection = global.json_TrilhaCaminhosdaBaleiaFranca_2 || null;
        var catalog = null;
        var loadState = 'loading';
        var loadError = null;
        var mutationVersion = 0;
        var submitting = false;
        var selectedPhotos = [];
        var selectingPhotos = false;

        initializedMaps.add(map);

        function setStatus(element, message, state) {
            if (!element) {
                return;
            }
            element.textContent = message;
            if (state) {
                element.dataset.state = state;
            } else {
                delete element.dataset.state;
            }
        }

        function fetchJson(url, options) {
            return global.fetch(url, options).then(function (response) {
                return response.json().catch(function () {
                    return null;
                }).then(function (body) {
                    if (!response.ok) {
                        var apiError = new Error(
                            body && typeof body.error === 'string'
                                ? body.error
                                : 'A API respondeu com HTTP ' + response.status + '.'
                        );
                        apiError.status = response.status;
                        throw apiError;
                    }
                    if (body === null) {
                        throw new Error('A API retornou uma resposta JSON inválida.');
                    }
                    return body;
                });
            });
        }

        function requestErrorMessage(error, action) {
            if (error && error.status === 404) {
                return action === 'load'
                    ? 'A consulta de ocorrências ainda não está disponível na API.'
                    : 'O cadastro ainda não está disponível na API. Tente novamente mais tarde.';
            }
            if (error && error.status === 429) {
                return 'Muitos envios em pouco tempo. Aguarde um minuto e tente novamente.';
            }
            if (error && error.status === 422) {
                return error.message || 'A trilha selecionada não foi reconhecida pela API.';
            }
            if (error && error.status === 503) {
                return error.message || 'O serviço de ocorrências está temporariamente indisponível.';
            }
            if (error && error.message && error.status) {
                return error.message;
            }
            return action === 'load'
                ? 'Não foi possível carregar as ocorrências da API. Os filtros continuam disponíveis.'
                : 'Não foi possível enviar o cadastro. Verifique sua conexão e tente novamente.';
        }

        function appendOptions(select, entries, keyField, labelField, placeholder) {
            if (!select) {
                return;
            }
            var selected = select.value;
            select.replaceChildren();
            var placeholderOption = document.createElement('option');
            placeholderOption.value = '';
            placeholderOption.textContent = placeholder;
            select.appendChild(placeholderOption);
            entries.forEach(function (entry) {
                var option = document.createElement('option');
                option.value = String(entry[keyField]);
                option.textContent = String(entry[labelField]);
                select.appendChild(option);
            });
            if (Array.from(select.options).some(function (option) {
                return option.value === selected;
            })) {
                select.value = selected;
            }
        }

        function filters() {
            return {
                trailId: document.getElementById('occurrence-filter-trail').value,
                category: document.getElementById('occurrence-filter-category').value,
                situation: document.getElementById('occurrence-filter-situation').value,
                dateFrom: document.getElementById('occurrence-filter-date-from').value,
                dateTo: document.getElementById('occurrence-filter-date-to').value
            };
        }

        function populateTrailFilter() {
            appendOptions(
                document.getElementById('occurrence-filter-trail'),
                buildTrailOptions(trailCollection, records),
                'chave',
                'nome',
                'Todas as trilhas'
            );
        }

        function populateRegistrationTrails() {
            var options = buildTrailOptions(trailCollection, []);
            appendOptions(registrationTrail, options, 'chave', 'nome', 'Selecione uma trilha');
            registrationTrail.disabled = options.length === 0;
            if (!options.length) {
                setStatus(formStatus, 'A lista de trilhas ainda não está disponível.', 'error');
            }
        }

        function applyFilters() {
            if (!occurrenceLayer) {
                return;
            }
            var matchingRecords = filterOccurrences(records, filters());
            occurrenceLayer.clearLayers();
            matchingRecords.forEach(function (record) {
                occurrenceLayer.addLayer(record.marker);
            });
            if (!records.length && loadState === 'error') {
                status.textContent = requestErrorMessage(loadError, 'load');
                status.dataset.state = 'error';
            } else if (!records.length && loadState === 'loading') {
                status.textContent = 'Carregando ocorrências…';
                status.dataset.state = 'loading';
            } else if (!records.length) {
                status.textContent = 'Nenhuma ocorrência cadastrada.';
                status.dataset.state = 'empty';
            } else if (!matchingRecords.length) {
                status.textContent = 'Nenhuma ocorrência corresponde aos filtros selecionados.';
                status.dataset.state = 'empty';
            } else {
                status.textContent = matchingRecords.length
                    + (matchingRecords.length === 1
                        ? ' ocorrência visível no mapa.'
                        : ' ocorrências visíveis no mapa.');
                status.dataset.state = 'ready';
            }
        }

        function populateLegend() {
            var legend = document.getElementById('occurrence-status-legend');
            legend.replaceChildren();
            catalog.situacoes.forEach(function (situation) {
                var item = document.createElement('li');
                var symbol = document.createElement('i');
                symbol.classList.add('fas', situation.identificacao_visual.icone);
                symbol.style.color = situation.identificacao_visual.cor;
                symbol.setAttribute('aria-hidden', 'true');
                var label = document.createElement('span');
                label.textContent = situation.rotulo;
                item.append(symbol, label);
                legend.appendChild(item);
            });
        }

        function populateCatalogOptions() {
            appendOptions(
                document.getElementById('occurrence-filter-category'),
                catalog.categorias,
                'chave',
                'nome',
                'Todas as categorias'
            );
            appendOptions(
                document.getElementById('occurrence-filter-situation'),
                catalog.situacoes,
                'chave',
                'rotulo',
                'Todas as situações'
            );
            appendOptions(
                registrationCategory,
                catalog.categorias.filter(function (category) {
                    return category.ativo;
                }),
                'chave',
                'nome',
                'Selecione uma categoria'
            );
            populateLegend();
        }

        function createRecord(feature) {
            var properties = feature.properties;
            var visuals = getMarkerVisuals(catalog, properties.categoria, properties.situacao);
            var label = visuals.categoryName + ' — ' + visuals.situationLabel;
            var marker = leaflet.marker(
                [feature.geometry.coordinates[1], feature.geometry.coordinates[0]],
                {
                    pane: 'pane_ocorrencias_trilhas',
                    icon: createMarkerIcon(leaflet, visuals),
                    title: label,
                    alt: label,
                    riseOnHover: true
                }
            );
            var record = { feature: feature, properties: properties, marker: marker };
            marker.bindTooltip(label);
            var popup = popupContent(record, trailCollection, visuals);
            marker.bindPopup(popup.content, { maxWidth: 360 });
            marker.on('click', function () {
                popup = popupContent(record, trailCollection, visuals);
                marker.setPopupContent(popup.content);
            });
            marker.on('popupopen', function () {
                popup.activatePhotos();
            });
            return record;
        }

        function replaceRecords(collection) {
            validateOccurrenceCollection(collection, catalog);
            records = collection.features.map(createRecord);
            populateTrailFilter();
            applyFilters();
        }

        function upsertRecord(feature) {
            validateOccurrenceCollection({
                type: 'FeatureCollection',
                features: [feature]
            }, catalog);
            var record = createRecord(feature);
            var index = records.findIndex(function (existing) {
                return existing.properties.ocorrencia_id === feature.properties.ocorrencia_id;
            });
            if (index === -1) {
                records.push(record);
            } else {
                records[index] = record;
            }
            populateTrailFilter();
            applyFilters();
        }

        function setLocationPicking(active) {
            locationPicking = active;
            locationButton.setAttribute('aria-pressed', active ? 'true' : 'false');
            locationButton.innerHTML = active
                ? '<i class="fas fa-times" aria-hidden="true"></i> Cancelar marcação'
                : selectedCoordinates
                    ? '<i class="fas fa-map-marker-alt" aria-hidden="true"></i> Alterar localização no mapa'
                    : '<i class="fas fa-map-marker-alt" aria-hidden="true"></i> Marcar localização no mapa';
            if (map.getContainer) {
                map.getContainer().classList.toggle('occurrence-location-picking', active);
            }
        }

        function removeLocationMarker() {
            if (locationMarker) {
                map.removeLayer(locationMarker);
                locationMarker = null;
            }
        }

        function formatCoordinates(coordinates) {
            return coordinates[1].toFixed(5) + ', ' + coordinates[0].toFixed(5);
        }

        function handleMapClick(event) {
            if (!locationPicking || !event || !event.latlng
                || !Number.isFinite(event.latlng.lat) || !Number.isFinite(event.latlng.lng)
                || event.latlng.lat < -90 || event.latlng.lat > 90
                || event.latlng.lng < -180 || event.latlng.lng > 180) {
                return;
            }
            selectedCoordinates = [event.latlng.lng, event.latlng.lat];
            removeLocationMarker();
            locationMarker = leaflet.circleMarker(event.latlng, {
                radius: 9,
                color: '#125f5f',
                weight: 3,
                fillColor: '#fff',
                fillOpacity: 1
            });
            map.addLayer(locationMarker);
            setLocationPicking(false);
            setStatus(
                locationStatus,
                'Localização selecionada (latitude, longitude): ' + formatCoordinates(selectedCoordinates) + '.',
                'ready'
            );
        }

        function localToday() {
            var today = new Date();
            return today.getFullYear() + '-'
                + String(today.getMonth() + 1).padStart(2, '0') + '-'
                + String(today.getDate()).padStart(2, '0');
        }

        function clearSelectedPhotos() {
            selectedPhotos.forEach(function (photo) {
                if (photo.previewUrl && global.URL && typeof global.URL.revokeObjectURL === 'function') {
                    global.URL.revokeObjectURL(photo.previewUrl);
                }
            });
            selectedPhotos = [];
            photoPreviews.replaceChildren();
            photoCameraInput.value = '';
            photoGalleryInput.value = '';
            setStatus(photoStatus, '', '');
        }

        function renderPhotoPreviews() {
            photoPreviews.replaceChildren();
            selectedPhotos.forEach(function (photo, index) {
                var item = document.createElement('li');
                item.className = 'occurrence-photo-preview';
                var image = document.createElement('img');
                image.src = photo.previewUrl;
                image.alt = 'Prévia da fotografia ' + (index + 1);
                var removeButton = document.createElement('button');
                removeButton.type = 'button';
                removeButton.setAttribute('aria-label', 'Remover fotografia ' + (index + 1));
                removeButton.innerHTML = '<i class="fas fa-times" aria-hidden="true"></i>';
                removeButton.addEventListener('click', function () {
                    if (global.URL && typeof global.URL.revokeObjectURL === 'function') {
                        global.URL.revokeObjectURL(photo.previewUrl);
                    }
                    selectedPhotos.splice(index, 1);
                    renderPhotoPreviews();
                    setStatus(photoStatus, selectedPhotos.length + ' fotografia(s) selecionada(s).', '');
                });
                item.append(image, removeButton);
                photoPreviews.appendChild(item);
            });
        }

        function makeThumbnail(file) {
            if (typeof global.createImageBitmap !== 'function') {
                return Promise.reject(new Error('Este navegador não consegue preparar miniaturas.'));
            }
            return global.createImageBitmap(file).then(function (bitmap) {
                var canvas = document.createElement('canvas');
                var scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                var context = canvas.getContext('2d');
                if (!context) {
                    bitmap.close();
                    throw new Error('Não foi possível preparar a miniatura.');
                }
                context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                bitmap.close();
                return new Promise(function (resolve, reject) {
                    canvas.toBlob(function (blob) {
                        if (blob) {
                            resolve(blob);
                        } else {
                            reject(new Error('Não foi possível preparar a miniatura.'));
                        }
                    }, 'image/webp', 0.78);
                });
            });
        }

        function addSelectedPhotos(fileList) {
            var files = Array.from(fileList || []);
            if (!files.length || selectingPhotos) {
                return;
            }
            if (selectedPhotos.length + files.length > 5) {
                setStatus(photoStatus, 'É possível selecionar no máximo 5 fotografias.', 'error');
                return;
            }
            if (files.some(function (file) {
                return file.size < 1 || file.size > 5 * 1024 * 1024
                    || ['image/jpeg', 'image/png', 'image/webp'].indexOf(file.type) === -1;
            })) {
                setStatus(photoStatus, 'Selecione imagens JPEG, PNG ou WebP de até 5 MB.', 'error');
                return;
            }
            selectingPhotos = true;
            photoCameraButton.disabled = true;
            photoGalleryButton.disabled = true;
            setStatus(photoStatus, 'Preparando fotografias…', 'loading');
            var createdPreviewUrls = [];
            Promise.all(files.map(function (file) {
                return makeThumbnail(file).then(function (thumbnail) {
                    var previewUrl = global.URL.createObjectURL(file);
                    createdPreviewUrls.push(previewUrl);
                    return {
                        file: file,
                        thumbnail: thumbnail,
                        previewUrl: previewUrl
                    };
                });
            })).then(function (photos) {
                selectedPhotos = selectedPhotos.concat(photos);
                renderPhotoPreviews();
                setStatus(photoStatus, selectedPhotos.length + ' fotografia(s) selecionada(s).', '');
            }).catch(function (error) {
                createdPreviewUrls.forEach(function (previewUrl) {
                    if (global.URL && typeof global.URL.revokeObjectURL === 'function') {
                        global.URL.revokeObjectURL(previewUrl);
                    }
                });
                console.error('Falha ao preparar fotografias selecionadas.', error);
                setStatus(photoStatus, error.message || 'Não foi possível preparar as fotografias.', 'error');
            }).finally(function () {
                selectingPhotos = false;
                photoCameraButton.disabled = false;
                photoGalleryButton.disabled = false;
                photoCameraInput.value = '';
                photoGalleryInput.value = '';
            });
        }

        function resetRegistration() {
            registrationForm.reset();
            clearSelectedPhotos();
            registrationDate.value = localToday();
            registrationDescription.value = '';
            registrationTrail.value = '';
            registrationCategory.value = '';
            selectedCoordinates = null;
            removeLocationMarker();
            setLocationPicking(false);
            setStatus(locationStatus, 'Nenhuma localização selecionada.', '');
            setStatus(formStatus, '', '');
        }

        function showQuery() {
            setLocationPicking(false);
            registrationView.hidden = true;
            queryView.hidden = false;
            resetRegistration();
        }

        function showRegistration() {
            setStatus(actionStatus, '', '');
            setStatus(formStatus, '', '');
            registrationDate.value = localToday();
            queryView.hidden = true;
            registrationView.hidden = false;
            registrationTrail.focus();
        }

        function populateFiltersAndBindEvents() {
            populateCatalogOptions();
            populateTrailFilter();
            occurrenceLayer = leaflet.featureGroup();
            map.createPane('pane_ocorrencias_trilhas');
            map.getPane('pane_ocorrencias_trilhas').style.zIndex = 460;
            map.addLayer(occurrenceLayer);
            filtersForm.addEventListener('submit', function (event) {
                event.preventDefault();
                applyFilters();
            });
            filtersForm.addEventListener('change', applyFilters);
            document.getElementById('occurrence-filter-reset').addEventListener('click', function () {
                filtersForm.reset();
                applyFilters();
            });
            applyFilters();
        }

        function loadOccurrences() {
            var versionAtRequest = mutationVersion;
            fetchJson(API_BASE_URL + '/api/ocorrencias').then(function (collection) {
                validateOccurrenceCollection(collection, catalog);
                if (versionAtRequest !== mutationVersion) {
                    return;
                }
                loadState = 'ready';
                loadError = null;
                replaceRecords(collection);
            }).catch(function (error) {
                if (versionAtRequest !== mutationVersion) {
                    return;
                }
                loadState = 'error';
                loadError = error;
                console.error('Falha ao carregar ocorrências pela API.', error);
                applyFilters();
            });
        }

        function handleSubmit(event) {
            event.preventDefault();
            if (submitting) {
                return;
            }
            if (!registrationTrail.value || !registrationCategory.value
                || !isValidDate(registrationDate.value)) {
                setStatus(formStatus, 'Informe a trilha, a categoria e uma data válida.', 'error');
                return;
            }
            if (!selectedCoordinates
                || !Number.isFinite(selectedCoordinates[0]) || !Number.isFinite(selectedCoordinates[1])) {
                setStatus(formStatus, 'Marque a localização da ocorrência no mapa antes de enviar.', 'error');
                return;
            }

            var payload = {
                trilha_fid: registrationTrail.value,
                categoria: registrationCategory.value,
                descricao: registrationDescription.value.trim(),
                data_identificacao: registrationDate.value,
                coordinates: selectedCoordinates.slice()
            };
            var requestOptions = { method: 'POST' };
            if (selectedPhotos.length) {
                var formData = new global.FormData();
                formData.append('occurrence', JSON.stringify(payload));
                selectedPhotos.forEach(function (photo) {
                    formData.append('photo', photo.file, photo.file.name);
                    formData.append('thumbnail', photo.thumbnail, 'miniatura.webp');
                });
                requestOptions.body = formData;
            } else {
                requestOptions.headers = { 'Content-Type': 'application/json' };
                requestOptions.body = JSON.stringify(payload);
            }
            submitting = true;
            submitButton.disabled = true;
            cancelFormButton.disabled = true;
            locationButton.disabled = true;
            photoCameraButton.disabled = true;
            photoGalleryButton.disabled = true;
            setStatus(formStatus, 'Enviando cadastro…', 'loading');

            fetchJson(API_BASE_URL + '/api/ocorrencias', requestOptions).then(function (feature) {
                upsertRecord(feature);
                mutationVersion += 1;
                if (loadState === 'loading') {
                    loadState = 'partial';
                }
                setStatus(actionStatus, 'Ocorrência cadastrada com sucesso.', 'success');
                showQuery();
            }).catch(function (error) {
                console.error('Falha ao enviar o cadastro de ocorrência.', error);
                setStatus(formStatus, requestErrorMessage(error, 'submit'), 'error');
            }).finally(function () {
                submitting = false;
                submitButton.disabled = false;
                cancelFormButton.disabled = false;
                locationButton.disabled = false;
                photoCameraButton.disabled = false;
                photoGalleryButton.disabled = false;
            });
        }

        photoCameraButton.addEventListener('click', function () {
            photoCameraInput.click();
        });
        photoGalleryButton.addEventListener('click', function () {
            photoGalleryInput.click();
        });
        photoCameraInput.addEventListener('change', function (event) {
            addSelectedPhotos(event.target.files);
        });
        photoGalleryInput.addEventListener('change', function (event) {
            addSelectedPhotos(event.target.files);
        });
        document.getElementById('occurrence-open-form').addEventListener('click', showRegistration);
        cancelFormButton.addEventListener('click', function () {
            showQuery();
            setStatus(actionStatus, '', '');
        });
        locationButton.addEventListener('click', function () {
            if (locationPicking) {
                setLocationPicking(false);
                setStatus(
                    locationStatus,
                    selectedCoordinates
                        ? 'Marcação cancelada; a localização selecionada foi mantida.'
                        : 'Marcação cancelada. Nenhuma localização selecionada.',
                    ''
                );
                return;
            }
            setLocationPicking(true);
            setStatus(
                locationStatus,
                selectedCoordinates
                    ? 'Clique no mapa para substituir a localização atual.'
                    : 'Aguardando clique no mapa para definir a localização.',
                'loading'
            );
        });
        registrationForm.addEventListener('submit', handleSubmit);
        map.on('click', handleMapClick);
        setLocationPicking(false);
        registrationDate.value = localToday();

        if (trailCollection) {
            populateRegistrationTrails();
        }
        var trailDataReady = global.trailDataReady;
        if (trailDataReady && typeof trailDataReady.then === 'function') {
            trailDataReady.then(function (collection) {
                trailCollection = collection;
                populateTrailFilter();
                populateRegistrationTrails();
                records.forEach(function (record) {
                    var visuals = getMarkerVisuals(
                        catalog,
                        record.properties.categoria,
                        record.properties.situacao
                    );
                    record.marker.setPopupContent(popupContent(record, trailCollection, visuals));
                });
            }).catch(function () {
                registrationTrail.disabled = true;
                setStatus(formStatus, 'Não foi possível carregar as trilhas para o cadastro.', 'error');
            });
        } else {
            registrationTrail.disabled = true;
        }

        fetchJson('../dados/catalogo_ocorrencias.json').then(function (loadedCatalog) {
            validateCatalog(loadedCatalog);
            catalog = loadedCatalog;
            populateFiltersAndBindEvents();
            loadOccurrences();
        }).catch(function (error) {
            loadState = 'error';
            console.error('Falha ao carregar o catálogo de ocorrências.', error);
            setStatus(status, 'Não foi possível carregar o catálogo. As trilhas continuam disponíveis.', 'error');
            setStatus(formStatus, 'O formulário não pode ser carregado no momento.', 'error');
        });
    }

    return {
        buildTrailOptions: buildTrailOptions,
        filterOccurrences: filterOccurrences,
        getMarkerVisuals: getMarkerVisuals,
        initialize: initialize,
        isPickingLocation: function () {
            return locationPicking;
        },
        resolveTrailName: resolveTrailName,
        validateCatalog: validateCatalog,
        validateOccurrenceCollection: validateOccurrenceCollection
    };
}));
