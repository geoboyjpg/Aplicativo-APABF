(function (global) {
    'use strict';

    var layerDefinitions = [
        {
            name: 'Arrasto (áreas)',
            path: 'data/Arrasto_4.geojson',
            pane: 'pane_instrumentos_arrasto',
            zIndex: 402,
            colors: {
                '1': '#d7dd1d',
                '2': '#ec5a75',
                '3': '#ab6bd2',
                '4': '#49df6a'
            },
            legend: [
                ['#d7dd1d', 'Proibido arrasto cujas malhas no túnel e saco sejam &lt; 90mm'],
                ['#ec5a75', 'Proibido arrasto industrial'],
                ['#ab6bd2', 'Proibido arrasto para embarcações > 10 AB'],
                ['#49df6a', 'Proibido arrasto']
            ]
        },
        {
            name: 'Outras Artes de Pesca (áreas)',
            path: 'data/OutrasArtesdePesca_3.geojson',
            pane: 'pane_instrumentos_outras_artes',
            zIndex: 403,
            colors: {
                '5': '#dd5641',
                '6': '#51d761',
                '7': '#d254c3',
                '8': '#6dc2cd',
                '9': '#7f74d7'
            },
            legend: [
                ['#dd5641', 'Restrições sazonais de pesca'],
                ['#51d761', 'Proibido pesca de cerco'],
                ['#d254c3', 'Proibido pesca de tarrafa'],
                ['#6dc2cd', 'Proibido pesca subaquática'],
                ['#7f74d7', 'Proibido cerco flutuante']
            ]
        },
        {
            name: 'Proteção de Recursos Pesqueiros (áreas)',
            path: 'data/ProteodeRecursosPesqueiros_2.geojson',
            pane: 'pane_instrumentos_protecao_areas',
            zIndex: 404,
            colors: {
                '10': '#e19a21',
                '11': '#10e094',
                '12': '#e97478',
                '13': '#e180c4',
                '14': '#54beec',
                '15': '#c980f0',
                '16': '#75e471',
                '17': '#5c5ee6'
            },
            legend: [
                ['#e19a21', 'Proibido pesca da anchova'],
                ['#10e094', 'Proibido pesca amadora'],
                ['#e97478', 'Proibido qualquer tipo de pesca'],
                ['#e180c4', 'Restrições a esportes náuticos e pesca amadora na safra da tainha'],
                ['#54beec', 'Proibida pesca da tainha'],
                ['#c980f0', 'Proibido qualquer tipo de pesca'],
                ['#75e471', '15/03 a 15/09: proibido pesca, exceto tarrafa'],
                ['#5c5ee6', 'Proibido qualquer tipo de pesca']
            ]
        },
        {
            name: 'Redes de Emalhe (linhas)',
            path: 'data/RedesdeEmalhe_5.geojson',
            pane: 'pane_instrumentos_redes_linhas',
            zIndex: 405,
            colors: {
                '1': '#ff7500',
                '2': '#ee00ff'
            },
            line: true,
            legend: [
                ['#ff7500', 'Proíbe a utilização de redes de emalhar fixas'],
                ['#ee00ff', 'Permite redes de emalhar fixas, derivantes e arrasto de praia']
            ]
        },
        {
            name: 'Proteção de Recursos Pesqueiros (linhas)',
            path: 'data/ProteodeRecursosPesqueiros_6.geojson',
            pane: 'pane_instrumentos_protecao_linhas',
            zIndex: 406,
            colors: {
                '1': '#e77148',
                '2': '#14d500'
            },
            line: true,
            outlined: true,
            legend: [
                ['#e77148', 'Proteção de Recursos Pesqueiros (feição 1)'],
                ['#14d500', 'Proteção de Recursos Pesqueiros (feição 2)']
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

    function featureStyle(definition, feature, outlined) {
        var color = featureColor(definition, feature);
        if (definition.line) {
            return {
                color: outlined ? '#000000' : color,
                weight: outlined ? 4 : 3,
                opacity: 1,
                lineCap: 'butt',
                lineJoin: 'miter'
            };
        }
        return {
            color: '#232323',
            weight: 1,
            opacity: 1,
            fillColor: color,
            fillOpacity: 1
        };
    }

    function createLayer(leaflet, definition, geojson) {
        var options = {
            pane: definition.pane,
            style: function (feature) {
                return featureStyle(definition, feature, false);
            },
            onEachFeature: function (feature, layer) {
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
        var entries = layerDefinitions.map(function (definition) {
            var group = leaflet.layerGroup();
            var state = {
                definition: definition,
                group: group,
                loaded: false,
                loading: false
            };

            definition.state = state;

            return {
                label: '<b>' + definition.name + '</b><br />' + definition.legend.map(function (item) {
                    return '<span style="display:inline-block;width:12px;height:12px;background:' + item[0] +
                        ';border:1px solid #333;margin-right:5px;"></span>' + item[1];
                }).join('<br />'),
                layer: group
            };
        });

        return {
            entries: entries,
            bind: function (map) {
                layerDefinitions.forEach(function (definition) {
                    map.createPane(definition.pane);
                    map.getPane(definition.pane).style.zIndex = definition.zIndex;
                    map.getPane(definition.pane).style.pointerEvents = 'auto';
                });

                map.on('overlayadd', function (event) {
                    layerDefinitions.forEach(function (definition) {
                        var state = definition.state;
                        if (event.layer !== state.group || state.loaded || state.loading) {
                            return;
                        }

                        state.loading = true;
                        fetch(definition.path)
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
                                state.group.addLayer(createLayer(leaflet, definition, geojson));
                                state.loaded = true;
                            })
                            .catch(function (error) {
                                console.error('Não foi possível carregar a camada ' + definition.name + ':', error);
                            })
                            .finally(function () {
                                state.loading = false;
                            });
                    });
                });
            }
        };
    }

    global.InstrumentosCamadasNovas = { create: create };
}(window));
