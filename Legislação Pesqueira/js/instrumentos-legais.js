(function (global) {
    'use strict';

    function normalizeLegalName(value) {
        return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
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

    function pointOnSegment(point, start, end) {
        var dx = end[0] - start[0];
        var dy = end[1] - start[1];
        var cross = (point[1] - start[1]) * dx - (point[0] - start[0]) * dy;
        var tolerance = 1e-12 * Math.max(1, Math.abs(dx), Math.abs(dy));
        if (Math.abs(cross) > tolerance) {
            return false;
        }
        return point[0] >= Math.min(start[0], end[0]) - tolerance &&
            point[0] <= Math.max(start[0], end[0]) + tolerance &&
            point[1] >= Math.min(start[1], end[1]) - tolerance &&
            point[1] <= Math.max(start[1], end[1]) + tolerance;
    }

    function pointInRing(point, ring) {
        var inside = false;
        for (var index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
            var start = ring[previous];
            var end = ring[index];
            if (pointOnSegment(point, start, end)) {
                return { inside: true, boundary: true };
            }
            if ((end[1] > point[1]) !== (start[1] > point[1]) &&
                point[0] < (start[0] - end[0]) * (point[1] - end[1]) /
                    (start[1] - end[1]) + end[0]) {
                inside = !inside;
            }
        }
        return { inside: inside, boundary: false };
    }

    function pointInPolygon(point, rings) {
        if (!rings.length) {
            return { inside: false, boundary: false };
        }
        var outer = pointInRing(point, rings[0]);
        if (!outer.inside) {
            return outer;
        }
        if (outer.boundary) {
            return outer;
        }
        for (var index = 1; index < rings.length; index += 1) {
            var hole = pointInRing(point, rings[index]);
            if (hole.boundary) {
                return { inside: true, boundary: true };
            }
            if (hole.inside) {
                return { inside: false, boundary: false };
            }
        }
        return { inside: true, boundary: false };
    }

    function polygonMatch(point, geometry) {
        var polygons = geometry.type === 'Polygon'
            ? [geometry.coordinates]
            : geometry.type === 'MultiPolygon'
                ? geometry.coordinates
                : [];
        var onBoundary = false;
        for (var index = 0; index < polygons.length; index += 1) {
            var result = pointInPolygon(point, polygons[index]);
            if (result.inside) {
                return { inside: true, boundary: result.boundary };
            }
            onBoundary = onBoundary || result.boundary;
        }
        return { inside: false, boundary: onBoundary };
    }

    function pointToSegmentDistanceMeters(point, start, end) {
        var metersPerDegree = Math.PI * 6371008.8 / 180;
        var latitudeScale = Math.cos(point[1] * Math.PI / 180);
        var px = point[0] * metersPerDegree * latitudeScale;
        var py = point[1] * metersPerDegree;
        var sx = start[0] * metersPerDegree * latitudeScale;
        var sy = start[1] * metersPerDegree;
        var ex = end[0] * metersPerDegree * latitudeScale;
        var ey = end[1] * metersPerDegree;
        var dx = ex - sx;
        var dy = ey - sy;
        var lengthSquared = dx * dx + dy * dy;
        var projection = lengthSquared
            ? Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lengthSquared))
            : 0;
        return Math.hypot(px - (sx + projection * dx), py - (sy + projection * dy));
    }

    function lineDistanceMeters(point, geometry) {
        var lines = geometry.type === 'LineString'
            ? [geometry.coordinates]
            : geometry.type === 'MultiLineString'
                ? geometry.coordinates
                : [];
        var minimumDistance = Infinity;
        lines.forEach(function (line) {
            for (var index = 1; index < line.length; index += 1) {
                minimumDistance = Math.min(
                    minimumDistance,
                    pointToSegmentDistanceMeters(point, line[index - 1], line[index])
                );
            }
        });
        return minimumDistance;
    }

    function create(map, leaflet, layerSpecs, categories) {
        var entries = [];
        var records = [];
        var recordBySourceId = new Map();

        layerSpecs.forEach(function (spec, specOrder) {
            if (!spec.layer || !spec.collection || !Array.isArray(spec.collection.features)) {
                throw new Error('Camada ou dados inválidos para a categoria ' + spec.category + '.');
            }
            var category = categories.find(function (item) {
                return item.key === spec.category;
            });
            if (!category) {
                throw new Error('Tipologia não configurada para a camada ' + spec.key + '.');
            }

            var renderedByFid = new Map();
            spec.layer.eachLayer(function (featureLayer) {
                var properties = featureLayer.feature && featureLayer.feature.properties;
                var fid = properties && properties.fid;
                if (fid === null || fid === undefined) {
                    throw new Error('Feição sem identificador na categoria ' + spec.category + '.');
                }
                var key = String(fid);
                if (!renderedByFid.has(key)) {
                    renderedByFid.set(key, []);
                }
                renderedByFid.get(key).push(featureLayer);
            });

            var specRecords = new Map();
            spec.collection.features.forEach(function (feature, featureOrder) {
                var properties = feature.properties || {};
                var fid = properties.fid;
                var legalName = String(properties['Instrumento Legal'] || '').trim();
                if (fid === null || fid === undefined || !legalName) {
                    throw new Error('Feição sem fid ou Instrumento Legal na categoria ' + spec.category + '.');
                }

                var sourceId = spec.key + ':' + String(fid);
                if (specRecords.has(String(fid))) {
                    throw new Error('fid duplicado na camada ' + spec.key + ': ' + fid);
                }
                var categoryKey = spec.category;
                var featureCategory = categories.find(function (item) {
                    return item.key === categoryKey;
                });
                if (!featureCategory) {
                    throw new Error('Tipologia não configurada para a feição ' + sourceId + '.');
                }

                var image = spec.legendImages[featureOrder];
                if (!image) {
                    throw new Error('Símbolo não configurado para ' + legalName + ' (' + sourceId + ').');
                }
                var entry = {
                    id: sourceId,
                    name: legalName,
                    category: categoryKey,
                    categoryOrder: specOrder,
                    order: spec.categoryOrderOverrides &&
                        spec.categoryOrderOverrides[String(fid)] !== undefined
                        ? spec.categoryOrderOverrides[String(fid)]
                        : featureOrder,
                    fid: String(fid),
                    layer: leaflet.layerGroup(),
                    symbols: [image],
                    records: []
                };
                entries.push(entry);

                var record = {
                    sourceId: sourceId,
                    fid: String(fid),
                    legalName: legalName,
                    category: featureCategory.label,
                    feature: feature,
                    layer: entry.layer,
                    featureLayers: []
                };
                specRecords.set(String(fid), record);
                recordBySourceId.set(sourceId, record);
                entry.records.push(record);
                records.push(record);
            });

            specRecords.forEach(function (record, fid) {
                var featureLayers = renderedByFid.get(fid) || [];
                if (!featureLayers.length) {
                    throw new Error('Feição ' + fid + ' não foi renderizada na camada ' + spec.key + '.');
                }
                featureLayers.forEach(function (featureLayer) {
                    record.featureLayers.push(featureLayer);
                    record.layer.addLayer(featureLayer);
                });
            });
        });

        entries.forEach(function (entry) {
            var displayName = entry.name;
            if (/^portaria ibama\/sc n° 54-n, de 9 de junho de 1999$/i.test(displayName)) {
                displayName = 'Portaria IBAMA/SC N° 54-N, de 9 de junho de 1999';
            }
            entry.label = entry.symbols.map(function (image) {
                return '<img src="legend/' + escapeHtml(image) +
                    '?v=2" alt="" aria-hidden="true" />';
            }).join(' ') + ' <span class="instrument-legal-name">' +
                escapeHtml(displayName) + '</span>';
        });

        var tree = {
            label: '<b>Instrumentos Legais</b>',
            children: categories.map(function (category) {
                return {
                    label: category.label,
                    children: entries.filter(function (entry) {
                        return entry.category === category.key;
                    }).sort(function (first, second) {
                        return first.order - second.order ||
                            first.name.localeCompare(second.name, 'pt-BR');
                    }).map(function (entry) {
                        return { label: entry.label, layer: entry.layer };
                    })
                };
            })
        };

        layerSpecs.forEach(function (spec) {
            map.removeLayer(spec.layer);
        });

        function focusRecord(record) {
            if (!record || !record.featureLayers.length) {
                throw new Error('Não foi possível localizar a feição solicitada no mapa.');
            }
            entries.forEach(function (entry) {
                if (entry.layer !== record.layer && map.hasLayer(entry.layer)) {
                    map.removeLayer(entry.layer);
                }
            });
            if (!map.hasLayer(record.layer)) {
                map.addLayer(record.layer);
            }
            var bounds = leaflet.featureGroup(record.featureLayers).getBounds();
            if (bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
            }
            global.setTimeout(function () {
                var popupLayer = record.featureLayers.find(function (featureLayer) {
                    return typeof featureLayer.openPopup === 'function';
                });
                if (popupLayer) {
                    popupLayer.openPopup(bounds.isValid() ? bounds.getCenter() : undefined);
                }
            }, 250);
        }

        function restoreAll() {
            entries.forEach(function (entry) {
                if (!map.hasLayer(entry.layer)) {
                    map.addLayer(entry.layer);
                }
            });
            var bounds = records.reduce(function (allBounds, record) {
                var recordBounds = leaflet.featureGroup(record.featureLayers).getBounds();
                if (recordBounds.isValid()) {
                    allBounds.extend(recordBounds);
                }
                return allBounds;
            }, leaflet.latLngBounds([]));
            if (bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
            }
        }

        function queryLocation(latlng, accuracyMeters) {
            if (!latlng || !Number.isFinite(latlng.lat) || !Number.isFinite(latlng.lng)) {
                throw new Error('Coordenadas inválidas para a consulta espacial.');
            }
            var point = [latlng.lng, latlng.lat];
            var accuracy = Number.isFinite(accuracyMeters) && accuracyMeters >= 0
                ? accuracyMeters
                : 0;
            var applicableRecords = [];
            var boundaryRecords = [];
            var nearbyLinearRecords = [];

            records.forEach(function (record) {
                var geometry = record.feature.geometry;
                if (!geometry || !Array.isArray(geometry.coordinates)) {
                    return;
                }
                if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
                    var match = polygonMatch(point, geometry);
                    if (match.inside) {
                        applicableRecords.push(record);
                        if (match.boundary) {
                            boundaryRecords.push(record);
                        }
                    }
                    return;
                }
                if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
                    var distanceMeters = lineDistanceMeters(point, geometry);
                    if (distanceMeters <= accuracy) {
                        nearbyLinearRecords.push({
                            record: record,
                            distanceMeters: distanceMeters,
                            accuracyMeters: accuracy
                        });
                    }
                }
            });

            return {
                applicableRecords: applicableRecords,
                boundaryRecords: boundaryRecords,
                nearbyLinearRecords: nearbyLinearRecords
            };
        }

        function activateRecords(matchingRecords) {
            matchingRecords.forEach(function (record) {
                if (!record || !record.layer || !map.hasLayer(record.layer)) {
                    if (record && record.layer) {
                        map.addLayer(record.layer);
                    }
                }
            });
        }

        return {
            tree: tree,
            entries: entries,
            records: records,
            recordBySourceId: recordBySourceId,
            focusRecord: focusRecord,
            restoreAll: restoreAll,
            queryLocation: queryLocation,
            activateRecords: activateRecords
        };
    }

    global.InstrumentosLegais = { create: create };
}(window));
