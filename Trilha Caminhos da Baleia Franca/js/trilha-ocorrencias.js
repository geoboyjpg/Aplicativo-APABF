(function (root, factory) {
    'use strict';

    var occurrences = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = occurrences;
    } else {
        root.TrilhaOcorrencias = occurrences;
        if (root.document) {
            occurrences.initialize(root);
        }
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function normalizeId(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function isNonEmptyString(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    function isValidDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
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
            throw new Error('O arquivo de ocorrências não contém uma FeatureCollection válida.');
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
            var coordinates = feature && feature.geometry && feature.geometry.coordinates;
            if (!feature || feature.type !== 'Feature' || !properties
                || feature.geometry.type !== 'Point' || !Array.isArray(coordinates)
                || coordinates.length !== 2 || !Number.isFinite(coordinates[0])
                || coordinates[0] < -180 || coordinates[0] > 180
                || !Number.isFinite(coordinates[1]) || coordinates[1] < -90 || coordinates[1] > 90) {
                throw new Error('Foi encontrada uma ocorrência sem ponto geográfico 2D válido.');
            }
            if (!isNonEmptyString(properties.ocorrencia_id)
                || identifiers.has(properties.ocorrencia_id)
                || !isNonEmptyString(normalizeId(properties.trilha_fid))
                || !categoryKeys.has(properties.categoria)
                || !isNonEmptyString(properties.descricao)
                || !isValidDate(properties.data_identificacao)
                || !situationKeys.has(properties.situacao)
                || !Array.isArray(properties.fotografias)
                || !properties.fotografias.every(isNonEmptyString)) {
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
        if (!category || !situation) {
            throw new Error('Não há identificação visual configurada para a categoria ou situação.');
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

    function popupContent(record, trailCollection, visuals) {
        var properties = record.properties;
        var content = document.createElement('div');
        content.className = 'occurrence-popup';
        var trailId = normalizeId(properties.trilha_fid);
        var trailName = resolveTrailName(trailCollection, trailId);
        [
            ['Categoria', visuals.categoryName],
            ['Descrição', properties.descricao],
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
        return content;
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
        var filtersForm = document.getElementById('occurrence-filters');
        if (!map || !leaflet || !status || !filtersForm || typeof global.fetch !== 'function') {
            return;
        }

        var occurrenceLayer = null;
        var records = [];
        var trailCollection = global.json_TrilhaCaminhosdaBaleiaFranca_2 || null;

        function fetchJson(url) {
            return global.fetch(url).then(function (response) {
                if (!response.ok) {
                    throw new Error('Servidor respondeu com HTTP ' + response.status + '.');
                }
                return response.json();
            });
        }

        function appendOptions(select, entries, keyField, labelField, placeholder) {
            var selected = select.value;
            select.replaceChildren();
            var allOption = document.createElement('option');
            allOption.value = '';
            allOption.textContent = placeholder;
            select.appendChild(allOption);
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

        function populateTrailFilter() {
            var options = [];
            var seen = new Set();
            if (trailCollection && Array.isArray(trailCollection.features)) {
                trailCollection.features.forEach(function (feature) {
                    var properties = feature && feature.properties;
                    var id = properties && normalizeId(properties.fid);
                    if (!id || seen.has(id)) {
                        return;
                    }
                    seen.add(id);
                    options.push({
                        id: id,
                        label: (isNonEmptyString(properties.Nome) ? properties.Nome.trim() : 'Trilha')
                            + ' (' + id + ')'
                    });
                });
            }
            if (!options.length) {
                records.forEach(function (record) {
                    var id = normalizeId(record.properties.trilha_fid);
                    if (id && !seen.has(id)) {
                        seen.add(id);
                        options.push({ id: id, label: 'Trilha ' + id });
                    }
                });
            }
            appendOptions(
                document.getElementById('occurrence-filter-trail'),
                options.map(function (option) {
                    return { chave: option.id, nome: option.label };
                }),
                'chave',
                'nome',
                'Todas as trilhas'
            );
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

        function applyFilters() {
            if (!occurrenceLayer) {
                return;
            }
            var matchingRecords = filterOccurrences(records, filters());
            occurrenceLayer.clearLayers();
            matchingRecords.forEach(function (record) {
                occurrenceLayer.addLayer(record.marker);
            });
            if (!records.length) {
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

        function populateLegend(catalog) {
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

        function addOccurrences(collection, catalog) {
            validateOccurrenceCollection(collection, catalog);
            occurrenceLayer = leaflet.featureGroup();
            map.createPane('pane_ocorrencias_trilhas');
            map.getPane('pane_ocorrencias_trilhas').style.zIndex = 460;
            records = collection.features.map(function (feature) {
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
                marker.bindTooltip(label);
                var record = { feature: feature, properties: properties, marker: marker };
                marker.bindPopup(popupContent(record, trailCollection, visuals), { maxWidth: 360 });
                marker.on('click', function () {
                    marker.setPopupContent(popupContent(record, trailCollection, visuals));
                });
                return record;
            });
            map.addLayer(occurrenceLayer);
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
            populateTrailFilter();
            populateLegend(catalog);
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

        Promise.all([
            fetchJson('../dados/ocorrencias_trilhas.geojson'),
            fetchJson('../dados/catalogo_ocorrencias.json')
        ]).then(function (data) {
            validateCatalog(data[1]);
            addOccurrences(data[0], data[1]);
            var trailDataReady = global.trailDataReady;
            if (trailDataReady && typeof trailDataReady.then === 'function') {
                trailDataReady.then(function (collection) {
                    trailCollection = collection;
                    populateTrailFilter();
                    records.forEach(function (record) {
                        var trailId = normalizeId(record.properties.trilha_fid);
                        if (!resolveTrailName(collection, trailId)) {
                            console.warn('Ocorrência associada a um fid de trilha inexistente:', trailId);
                        }
                        var visuals = getMarkerVisuals(
                            data[1],
                            record.properties.categoria,
                            record.properties.situacao
                        );
                        record.marker.setPopupContent(popupContent(record, trailCollection, visuals));
                    });
                }, function () {
                    return null;
                });
            }
        }).catch(function (error) {
            status.textContent = 'Não foi possível carregar as ocorrências. As trilhas continuam disponíveis.';
            status.dataset.state = 'error';
            console.error('Falha ao carregar os dados das ocorrências.', error);
        });
    }

    return {
        filterOccurrences: filterOccurrences,
        getMarkerVisuals: getMarkerVisuals,
        initialize: initialize,
        resolveTrailName: resolveTrailName,
        validateCatalog: validateCatalog,
        validateOccurrenceCollection: validateOccurrenceCollection
    };
}));
