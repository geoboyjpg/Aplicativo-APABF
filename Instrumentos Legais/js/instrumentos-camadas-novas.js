(function (global) {
    'use strict';

    var layerDefinitions = [
        {
            name: 'Arrasto (áreas)',
            path: 'data/Arrasto_4.geojson',
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
        return definition.colors[String(properties.fid)] || '#12647a';
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

    function layerLegend(definition) {
        return definition.legendItems.map(function (item) {
            var color = definition.colors[item[0]];
            return '<span class="instrument-legend-entry">' + legendSymbol(definition, color) +
                '<span>' + escapeHtml(item[1]) + '</span></span>';
        }).join('');
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

    function createLayer(leaflet, definition, geojson, state) {
        var options = {
            pane: definition.pane,
            style: function (feature) {
                return featureStyle(definition, feature, false);
            },
            onEachFeature: function (feature, layer) {
                state.featureLayers.set(String(feature.properties && feature.properties.fid), layer);
                layer.bindPopup(createPopup(feature), { maxHeight: 400 });
            }
        };

        if (definition.outlined) {
            var outline = leaflet.geoJSON(geojson, {
                pane: definition.pane,
                style: function (feature) {
                    return featureStyle(definition, feature, true);
                }
            });
            var coloredLines = leaflet.geoJSON(geojson, options);
            return leaflet.layerGroup([outline, coloredLines]);
        }
        return leaflet.geoJSON(geojson, options);
    }

    function create(leaflet) {
        var mapInstance;
        var entries = layerDefinitions.map(function (definition) {
            var state = {
                definition: definition,
                group: leaflet.layerGroup(),
                featureLayers: new Map(),
                geojson: null,
                loadPromise: null
            };

            definition.state = state;

            return {
                label: '<span class="instrument-legend-layer">' + layerLegend(definition) + '</span>',
                layer: state.group
            };
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
                    state.geojson = geojson;
                    state.group.addLayer(createLayer(leaflet, definition, geojson, state));
                    return geojson;
                })
                .catch(function (error) {
                    state.loadPromise = null;
                    throw error;
                });

            return state.loadPromise;
        }

        return {
            entries: entries,
            definitions: layerDefinitions,
            bind: function (targetMap) {
                mapInstance = targetMap;
                layerDefinitions.forEach(function (definition) {
                    targetMap.createPane(definition.pane);
                    targetMap.getPane(definition.pane).style.zIndex = definition.zIndex;
                    targetMap.getPane(definition.pane).style.pointerEvents = 'auto';
                });

                targetMap.on('overlayadd', function (event) {
                    layerDefinitions.forEach(function (definition) {
                        if (event.layer === definition.state.group) {
                            loadDefinition(definition).catch(function (error) {
                                console.error('Não foi possível carregar a camada ' + definition.name + ':', error);
                            });
                        }
                    });
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
                    if (!mapInstance.hasLayer(state.group)) {
                        mapInstance.addLayer(state.group);
                    }
                    var bounds = featureLayer.getBounds();
                    if (bounds.isValid()) {
                        mapInstance.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
                    }
                    window.setTimeout(function () {
                        if (typeof featureLayer.openPopup === 'function') {
                            featureLayer.openPopup(bounds.isValid() ? bounds.getCenter() : undefined);
                        }
                    }, 250);
                    return self;
                });
            }
        };
    }

    global.InstrumentosCamadasNovas = { create: create };
}(window));
