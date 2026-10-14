(function (global) {
    'use strict';

    var layerDefinitions = [
        {
            name: 'Arrasto (áreas)',
            path: 'data/Arrasto_4.geojson',
            legendGroup: 'arrasto',
            legendOrder: 2,
            pane: 'pane_instrumentos_arrasto',
            zIndex: 402,
            colors: {
                '1': '#60a5fa',
                '2': '#1d4ed8',
                '3': '#2563eb',
                '4': '#0ea5e9'
            },
            legendItems: [
                ['1', 'Portaria SUDEPE N° N-26 de 1983'],
                ['2', 'Plano de Manejo APABF, 2018 - Normas ZMULT'],
                ['3', 'Portaria IBAMA N° 107-N de 1992'],
                ['4', 'Portaria SUDEPE N° 51-N de 26 de outubro de 1983']
            ]
        },
        {
            name: 'Outras Artes de Pesca (áreas)',
            path: 'data/OutrasArtesdePesca_3.geojson',
            legendGroup: 'outras_artes',
            legendOrder: 3,
            pane: 'pane_instrumentos_outras_artes',
            zIndex: 403,
            colors: {
                '5': '#075985',
                '6': '#2563eb',
                '7': '#0ea5e9',
                '8': '#60a5fa',
                '9': '#1e40af'
            },
            legendItems: [
                ['5', 'Portaria Interministerial SG-PR/MMA Nº 24 de 15 de maio de 2018'],
                ['6', 'Portaria Interministerial SG-PR/MMA Nº 24 de 15 de maio de 2018'],
                ['7', 'Plano de Manejo APABF, 2018 - Normas ZMULT'],
                ['8', 'Instrução Normativa MMA n° 41/2005'],
                ['9', 'Portaria IBAMA n° 5-N/1994']
            ]
        },
        {
            name: 'Proteção de Recursos Pesqueiros (áreas)',
            path: 'data/ProteodeRecursosPesqueiros_2.geojson',
            legendGroup: 'protecao_areas',
            legendOrder: 4,
            pane: 'pane_instrumentos_protecao_areas',
            zIndex: 404,
            colors: {
                '10': '#0369a1',
                '11': '#38bdf8',
                '12': '#1d4ed8',
                '13': '#0ea5e9',
                '14': '#60a5fa',
                '15': '#075985',
                '16': '#2563eb',
                '17': '#7dd3fc'
            },
            legendItems: [
                ['10', 'Instrução Normativa Interministerial MPA MMA nº 02/2009'],
                ['11', 'Plano de Manejo APABF, 2018 - Normas ZMULT'],
                ['12', 'Plano de Manejo APABF, 2018 - Normas ZCON'],
                ['13', 'Plano de Manejo APABF, 2018 - Normas ZMULT'],
                ['14', 'Plano de Manejo APABF, 2018 - Normas ZMULT'],
                ['15', 'Portaria IBAMA n° 115 N/1993'],
                ['16', 'Portaria Interministerial SG-PR/MMA Nº 24 de 15 de maio de 2018'],
                ['17', 'Portaria IBAMA N° 27-N de 1999']
            ]
        },
        {
            name: 'Redes de Emalhe (linhas)',
            path: 'data/RedesdeEmalhe_5.geojson',
            legendGroup: 'redes_emalhe',
            legendOrder: 1,
            pane: 'pane_instrumentos_redes_linhas',
            zIndex: 405,
            colors: {
                '1': '#075985',
                '2': '#38bdf8'
            },
            line: true,
            outlined: true,
            legendItems: [
                ['1', 'PORTARIA IBAMA/SC N° 54-N, DE 9 DE JUNHO DE 1999'],
                ['2', 'PORTARIA IBAMA/SC N° 54-N, DE 9 DE JUNHO DE 1999']
            ]
        },
        {
            name: 'Proteção de Recursos Pesqueiros (linhas)',
            path: 'data/ProteodeRecursosPesqueiros_6.geojson',
            legendGroup: 'protecao_linhas',
            legendOrder: 0,
            pane: 'pane_instrumentos_protecao_linhas',
            zIndex: 406,
            colors: {
                '1': '#1d4ed8',
                '2': '#7dd3fc'
            },
            line: true,
            outlined: true,
            legendItems: [
                ['1', 'Portaria IBAMA N° 27-N de 1999'],
                ['2', 'Portaria IBAMA N° 27-N de 1999']
            ]
        }
    ];

    var legendGroups = [
        { key: 'protecao_linhas', label: 'Proteção de Recursos Pesqueiros', order: 0 },
        { key: 'redes_emalhe', label: 'Redes de Emalhe', order: 1 },
        { key: 'arrasto', label: 'Arrasto', order: 2 },
        { key: 'outras_artes', label: 'Outras Artes de Pesca', order: 3 },
        { key: 'protecao_areas', label: 'Proteção de Recursos Pesqueiros', order: 4 }
    ];

    function normalizeLegalName(value) {
        return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
    }

    function createPopup(feature) {
        var container = document.createElement('div');
        var table = document.createElement('table');
        var properties = feature && feature.properties ? feature.properties : {};

        Object.keys(properties).forEach(function (key) {
            var value = properties[key];
            if (value === null || value === undefined || value === '') {
                return;
            }

            var row = document.createElement('tr');
            var heading = document.createElement('th');
            var cell = document.createElement('td');
            heading.scope = 'row';
            heading.textContent = key;
            cell.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
            row.appendChild(heading);
            row.appendChild(cell);
            table.appendChild(row);
        });

        if (!table.rows.length) {
            container.textContent = 'Esta feição não possui atributos disponíveis.';
        } else {
            container.appendChild(table);
        }
        return container;
    }

    function featureColor(definition, feature) {
        var properties = feature.properties || {};
        return definition.colors[String(properties.fid)] || '#1d4ed8';
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, function (character) {
            return {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[character];
        });
    }

    function legendSymbol(definition, color) {
        if (definition.line) {
            return '<span class="instrument-legend-symbol instrument-legend-symbol-line" style="--legend-color:' +
                color + '"></span>';
        }
        return '<span class="instrument-legend-symbol instrument-legend-symbol-polygon" style="--legend-color:' +
            color + '"></span>';
    }

    function renderLawLabel(entry) {
        var symbols = entry.symbols.map(function (symbol) {
            return legendSymbol(symbol.definition, symbol.color);
        }).join('');
        return (symbols ? '<span class="instrument-legend-symbols" aria-hidden="true">' + symbols + '</span>' : '') +
            '<span class="instrument-legend-text">' + escapeHtml(entry.name) + '</span>';
    }

    function featureStyle(definition, feature, outlined) {
        var color = featureColor(definition, feature);
        if (definition.line) {
            return {
                color: outlined ? '#e0f2fe' : color,
                weight: outlined ? 6 : 3.5,
                opacity: outlined ? 0.96 : 1,
                lineCap: 'butt',
                lineJoin: 'miter'
            };
        }
        return {
            color: '#082f49',
            weight: 1.2,
            opacity: 1,
            fillColor: color,
            fillOpacity: 0.42
        };
    }

    function createFeatureLayer(leaflet, definition, feature, state) {
        var options = {
            pane: definition.pane,
            style: function (feature) {
                return featureStyle(definition, feature, false);
            },
            onEachFeature: function (feature, layer) {
                layer.bindPopup(createPopup(feature), { maxHeight: 400 });
            }
        };

        var featureLayer;
        if (definition.outlined) {
            var outline = leaflet.geoJSON(feature, {
                pane: definition.pane,
                style: function (feature) {
                    return featureStyle(definition, feature, true);
                }
            });
            var coloredLines = leaflet.geoJSON(feature, options);
            featureLayer = leaflet.layerGroup([outline, coloredLines]);
        } else {
            featureLayer = leaflet.geoJSON(feature, options);
        }
        state.featureLayers.set(String(feature.properties && feature.properties.fid), featureLayer);
        return featureLayer;
    }

    function openFeaturePopup(featureLayer, latlng) {
        if (typeof featureLayer.openPopup === 'function') {
            featureLayer.openPopup(latlng);
            return;
        }
        if (typeof featureLayer.eachLayer === 'function') {
            featureLayer.eachLayer(function (childLayer) {
                openFeaturePopup(childLayer, latlng);
            });
        }
    }

    function create(leaflet) {
        var mapInstance;
        var entriesByName = new Map();
        var entriesByLayer = new Map();

        function getEntry(name, definition, featureOrder) {
            var key = normalizeLegalName(name);
            if (!key) {
                throw new Error('Feição sem o atributo Instrumento Legal.');
            }
            if (!entriesByName.has(key)) {
                var entry = {
                    name: String(name).trim(),
                    layer: leaflet.layerGroup(),
                    definitions: new Map(),
                    symbols: [],
                    group: legendGroups.find(function (group) {
                        return group.key === (definition && definition.legendGroup);
                    }),
                    order: definition ? definition.legendOrder * 1000 + featureOrder : Number.MAX_SAFE_INTEGER,
                    hasExternalFeatures: false,
                    controlEntry: null
                };
                if (!entry.group) {
                    throw new Error('Não foi possível determinar a tipologia do instrumento legal: ' + name);
                }
                entry.controlEntry = {
                    label: renderLawLabel(entry),
                    layer: entry.layer,
                    sortOrder: entry.order
                };
                entriesByName.set(key, entry);
                entriesByLayer.set(entry.layer, entry);
            } else if (definition) {
                var existingEntry = entriesByName.get(key);
                var group = legendGroups.find(function (item) {
                    return item.key === definition.legendGroup;
                });
                if (group && group.order < existingEntry.group.order) {
                    existingEntry.group = group;
                }
                existingEntry.order = Math.min(
                    existingEntry.order,
                    definition.legendOrder * 1000 + featureOrder
                );
                existingEntry.controlEntry.sortOrder = existingEntry.order;
            }
            return entriesByName.get(key);
        }

        function addSymbol(entry, definition, color, featureOrder) {
            var symbolExists = entry.symbols.some(function (symbol) {
                return symbol.definition === definition && symbol.color === color;
            });
            if (!symbolExists) {
                entry.symbols.push({
                    definition: definition,
                    color: color,
                    order: definition.legendOrder * 1000 + featureOrder
                });
                entry.symbols.sort(function (first, second) {
                    return first.order - second.order;
                });
            }
            entry.controlEntry.label = renderLawLabel(entry);
        }

        function addDefinitionToEntry(entry, definition) {
            entry.definitions.set(definition, definition);
        }

        layerDefinitions.forEach(function (definition) {
            definition.legendItems.forEach(function (item, index) {
                var entry = getEntry(item[1], definition, index);
                addDefinitionToEntry(entry, definition);
                addSymbol(entry, definition, definition.colors[item[0]], index);
            });
        });

        layerDefinitions.forEach(function (definition) {
            var state = {
                definition: definition,
                featureLayers: new Map(),
                featureEntries: new Map(),
                geojson: null,
                loadPromise: null
            };

            definition.state = state;
        });

        function loadDefinition(definition) {
            var state = definition.state;
            if (state.loadPromise) {
                return state.loadPromise;
            }
            if (state.geojson) {
                return Promise.resolve(state.geojson);
            }

            state.loadPromise = fetch(definition.path)
                .then(function (response) {
                    if (!response.ok) {
                        throw new Error('HTTP ' + response.status + ' ao carregar ' + definition.path);
                    }
                    return response.json();
                })
                .then(function (geojson) {
                    if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
                        throw new Error('GeoJSON inválido em ' + definition.path);
                    }
                    var featureEntries = new Map();
                    geojson.features.forEach(function (feature) {
                        var properties = feature.properties || {};
                        var fid = String(properties.fid);
                        var expectedItemIndex = definition.legendItems.findIndex(function (item) {
                            return String(item[0]) === fid;
                        });
                        var expectedItem = definition.legendItems[expectedItemIndex];
                        var legalName = properties['Instrumento Legal'];
                        if (expectedItemIndex === -1 ||
                            normalizeLegalName(expectedItem[1]) !== normalizeLegalName(legalName)) {
                            throw new Error('Vínculo entre feição e instrumento legal inválido em ' +
                                definition.path + ' (fid ' + fid + ').');
                        }
                        if (featureEntries.has(fid)) {
                            throw new Error('Identificador de feição duplicado em ' + definition.path +
                                ' (fid ' + fid + ').');
                        }
                        featureEntries.set(fid, getEntry(legalName, definition, expectedItemIndex));
                    });
                    state.geojson = geojson;
                    geojson.features.forEach(function (feature) {
                        var fid = String(feature.properties && feature.properties.fid);
                        if (state.featureLayers.has(fid)) {
                            return;
                        }
                        var featureLayer = createFeatureLayer(leaflet, definition, feature, state);
                        var entry = featureEntries.get(fid);
                        state.featureEntries.set(fid, entry);
                        entry.layer.addLayer(featureLayer);
                        addDefinitionToEntry(entry, definition);
                    });
                    return geojson;
                })
                .catch(function (error) {
                    state.loadPromise = null;
                    state.geojson = null;
                    state.featureLayers.forEach(function (featureLayer, fid) {
                        var entry = state.featureEntries.get(fid);
                        if (entry) {
                            entry.layer.removeLayer(featureLayer);
                        }
                    });
                    state.featureLayers.clear();
                    state.featureEntries.clear();
                    throw error;
                });

            return state.loadPromise;
        }

        function loadEntryDefinitions(entry) {
            return Promise.all(Array.from(entry.definitions.keys()).map(function (definition) {
                return loadDefinition(definition).catch(function (error) {
                    console.error('Não foi possível carregar a camada ' + definition.name + ':', error);
                });
            }));
        }

        return {
            definitions: layerDefinitions,
            legendTree: function () {
                return {
                    label: '<b>Instrumentos Legais 13_10</b>',
                    children: legendGroups.map(function (group) {
                        var children = Array.from(entriesByName.values())
                            .filter(function (entry) {
                                return entry.group.key === group.key;
                            })
                            .sort(function (first, second) {
                                return first.order - second.order ||
                                    first.name.localeCompare(second.name, 'pt-BR');
                            })
                            .map(function (entry) {
                                return entry.controlEntry;
                            });
                        return { label: group.label, children: children };
                    })
                };
            },
            registerFeature: function (legalName, typology, layer, symbol, legendGroup) {
                var entry = getEntry(legalName, {
                    legendGroup: legendGroup,
                    legendOrder: legendGroups.find(function (group) {
                        return group.key === legendGroup;
                    }).order
                }, Number.MAX_SAFE_INTEGER);
                entry.layer.addLayer(layer);
                entry.hasExternalFeatures = true;
                var symbolExists = entry.symbols.some(function (item) {
                    return item.typology === typology && item.color === symbol.color && item.line === symbol.line;
                });
                if (!symbolExists) {
                    entry.symbols.push({
                        definition: { line: Boolean(symbol.line) },
                        typology: typology,
                        color: symbol.color,
                        order: Number.MAX_SAFE_INTEGER
                    });
                }
                entry.symbols.sort(function (first, second) {
                    return first.order - second.order;
                });
                entry.controlEntry.label = renderLawLabel(entry);
                return entry.layer;
            },
            bind: function (targetMap) {
                mapInstance = targetMap;
                layerDefinitions.forEach(function (definition) {
                    targetMap.createPane(definition.pane);
                    targetMap.getPane(definition.pane).style.zIndex = definition.zIndex;
                    targetMap.getPane(definition.pane).style.pointerEvents = 'auto';
                });

                targetMap.on('overlayadd', function (event) {
                    var entry = entriesByLayer.get(event.layer);
                    if (entry) {
                        loadEntryDefinitions(entry);
                    }
                });
                entriesByName.forEach(function (entry) {
                    if (entry.hasExternalFeatures && !targetMap.hasLayer(entry.layer)) {
                        targetMap.addLayer(entry.layer);
                        loadEntryDefinitions(entry);
                    }
                });
            },
            loadSearchFeatures: function () {
                return Promise.all(layerDefinitions.map(function (definition) {
                    return loadDefinition(definition)
                        .then(function (geojson) {
                            return { definition: definition, features: geojson.features };
                        })
                        .catch(function (error) {
                            console.error('Não foi possível pesquisar a camada ' + definition.name + ':', error);
                            return { definition: definition, features: [], error: error };
                        });
                }));
            },
            focusFeature: function (definition, featureId) {
                var self = this;
                return loadDefinition(definition).then(function () {
                    var state = definition.state;
                    var featureLayer = state.featureLayers.get(String(featureId));
                    if (!featureLayer) {
                        throw new Error('A feição ' + featureId + ' não foi encontrada em ' + definition.path);
                    }
                    var entry = state.featureEntries.get(String(featureId));
                    if (!entry) {
                        throw new Error('O instrumento legal da feição ' + featureId + ' não foi encontrado.');
                    }
                    if (!mapInstance.hasLayer(entry.layer)) {
                        mapInstance.addLayer(entry.layer);
                    }
                    var bounds = featureLayer.getBounds();
                    if (bounds.isValid()) {
                        mapInstance.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
                    }
                    window.setTimeout(function () {
                        openFeaturePopup(featureLayer, bounds.isValid() ? bounds.getCenter() : undefined);
                    }, 250);
                    return self;
                });
            }
        };
    }

    global.InstrumentosCamadasNovas = { create: create };
}(window));
