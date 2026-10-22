(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.GeradorGeometrias = api;
    }
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    var geographicDefinitions = {
        'EPSG:4674': '+proj=longlat +ellps=GRS80 +no_defs +type=crs',
        'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs'
    };

    function parseAxis(value, axis, format) {
        var maximum = axis === 'latitude' ? 90 : 180;
        var parsed;
        if (format === 'dms') {
            var text = String(value || '').trim().toUpperCase();
            var match = text.match(/^([+-]?\d+(?:[.,]\d+)?)\D+(\d+(?:[.,]\d+)?)\D+(\d+(?:[.,]\d+)?)(?:\D*?([NSEW]))?$/);
            if (!match) {
                throw new Error('Informe graus, minutos e segundos; use N/S para latitude ou E/W para longitude.');
            }
            var degrees = Number(match[1].replace(',', '.'));
            var minutes = Number(match[2].replace(',', '.'));
            var seconds = Number(match[3].replace(',', '.'));
            var hemisphere = match[4] || '';
            if (minutes >= 60 || seconds >= 60 || minutes < 0 || seconds < 0) {
                throw new Error('Minutos e segundos devem estar entre 0 e 59.');
            }
            if (hemisphere && ((axis === 'latitude' && !/[NS]/.test(hemisphere)) ||
                (axis === 'longitude' && !/[EW]/.test(hemisphere)))) {
                throw new Error('O hemisfério informado não corresponde à coordenada.');
            }
            if (degrees < 0 && hemisphere) {
                throw new Error('Use o sinal negativo ou o hemisfério, não ambos.');
            }
            parsed = Math.abs(degrees) + minutes / 60 + seconds / 3600;
            if (degrees < 0 || hemisphere === 'S' || hemisphere === 'W') {
                parsed *= -1;
            }
        } else {
            var decimal = String(value || '').trim().replace(',', '.');
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal)) {
                throw new Error('Informe uma coordenada em graus decimais válida.');
            }
            parsed = Number(decimal);
        }
        if (!Number.isFinite(parsed) || Math.abs(parsed) > maximum) {
            throw new Error((axis === 'latitude' ? 'Latitude' : 'Longitude') +
                ' fora do intervalo permitido (±' + maximum + '°).');
        }
        return parsed;
    }

    function geographicCoordinates(values, format) {
        return [
            parseAxis(values.longitude, 'longitude', format),
            parseAxis(values.latitude, 'latitude', format)
        ];
    }

    function utmCrs(zone, hemisphere) {
        var numericZone = Number(zone);
        if (!Number.isInteger(numericZone) || numericZone < 1 || numericZone > 60) {
            throw new Error('A zona UTM deve ser um número inteiro entre 1 e 60.');
        }
        if (hemisphere !== 'north' && hemisphere !== 'south') {
            throw new Error('Selecione o hemisfério norte ou sul.');
        }
        var code = 'SIRGAS2000_UTM_' + numericZone + (hemisphere === 'south' ? 'S' : 'N');
        var definition = '+proj=utm +zone=' + numericZone +
            (hemisphere === 'south' ? ' +south' : '') + ' +ellps=GRS80 +units=m +no_defs +type=crs';
        return { code: code, definition: definition };
    }

    function toSIRGAS2000(values, settings, projection) {
        var source;
        var coordinates;
        var utmDetails;
        if (typeof projection !== 'function' || typeof projection.defs !== 'function') {
            throw new Error('A biblioteca de conversão de coordenadas não está disponível.');
        }
        if (settings.crs === 'UTM') {
            var easting = Number(String(values.easting || '').trim().replace(',', '.'));
            var northing = Number(String(values.northing || '').trim().replace(',', '.'));
            if (!Number.isFinite(easting) || !Number.isFinite(northing) ||
                easting < 100000 || easting > 900000 || northing < 0 || northing > 10000000) {
                throw new Error('Informe coordenadas UTM E/N válidas em metros.');
            }
            var utm = utmCrs(settings.zone, settings.hemisphere);
            projection.defs(utm.code, utm.definition);
            source = utm.code;
            utmDetails = { zone: Number(settings.zone), hemisphere: settings.hemisphere };
            coordinates = [easting, northing];
        } else {
            source = settings.crs;
            if (!geographicDefinitions[source]) {
                throw new Error('Selecione um sistema de coordenadas de entrada reconhecido.');
            }
            coordinates = geographicCoordinates(values, settings.format);
        }

        Object.keys(geographicDefinitions).forEach(function (code) {
            projection.defs(code, geographicDefinitions[code]);
        });
        var transformed = source === 'EPSG:4674'
            ? coordinates
            : projection(source, 'EPSG:4674', coordinates);
        if (!transformed || !Number.isFinite(transformed[0]) || !Number.isFinite(transformed[1]) ||
            Math.abs(transformed[0]) > 180 || Math.abs(transformed[1]) > 90) {
            throw new Error('A conversão não produziu coordenadas válidas em SIRGAS 2000.');
        }
        if (utmDetails) {
            var actualHemisphere = transformed[1] < 0 ? 'south' : 'north';
            var actualZone = Math.min(60, Math.max(1, Math.floor((transformed[0] + 180) / 6) + 1));
            if (actualHemisphere !== utmDetails.hemisphere || actualZone !== utmDetails.zone ||
                transformed[1] < -80 || transformed[1] > 84) {
                throw new Error('As coordenadas não correspondem à zona e ao hemisfério UTM selecionados.');
            }
        }
        return transformed;
    }

    function orientation(a, b, c) {
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }

    function segmentsIntersect(a, b, c, d) {
        var abC = orientation(a, b, c);
        var abD = orientation(a, b, d);
        var cdA = orientation(c, d, a);
        var cdB = orientation(c, d, b);
        function onSegment(start, end, point, crossProduct) {
            return Math.abs(crossProduct) < 1e-12 &&
                point[0] >= Math.min(start[0], end[0]) && point[0] <= Math.max(start[0], end[0]) &&
                point[1] >= Math.min(start[1], end[1]) && point[1] <= Math.max(start[1], end[1]);
        }
        return (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
            ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) ||
            onSegment(a, b, c, abC) || onSegment(a, b, d, abD) ||
            onSegment(c, d, a, cdA) || onSegment(c, d, b, cdB);
    }

    function closeAndValidatePolygon(vertices) {
        if (!Array.isArray(vertices) || vertices.length < 3) {
            throw new Error('Um polígono precisa de pelo menos três vértices.');
        }
        var distinct = [];
        vertices.forEach(function (vertex) {
            if (!Array.isArray(vertex) || vertex.length < 2 ||
                !Number.isFinite(vertex[0]) || !Number.isFinite(vertex[1]) ||
                Math.abs(vertex[0]) > 180 || Math.abs(vertex[1]) > 90) {
                throw new Error('Um ou mais vértices possuem coordenadas inválidas.');
            }
            if (!distinct.some(function (other) { return other[0] === vertex[0] && other[1] === vertex[1]; })) {
                distinct.push(vertex);
            }
        });
        if (distinct.length < 3) {
            throw new Error('O polígono precisa de pelo menos três vértices distintos.');
        }
        var ring = vertices.map(function (vertex) { return [vertex[0], vertex[1]]; });
        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
            ring.push([ring[0][0], ring[0][1]]);
        }
        var area = 0;
        for (var index = 0; index < ring.length - 1; index += 1) {
            area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
        }
        if (Math.abs(area) < 1e-12) {
            throw new Error('Os vértices formam uma área nula.');
        }
        var segmentCount = ring.length - 1;
        for (var first = 0; first < segmentCount; first += 1) {
            for (var second = first + 1; second < segmentCount; second += 1) {
                if (second === first + 1 || (first === 0 && second === segmentCount - 1)) {
                    continue;
                }
                if (segmentsIntersect(ring[first], ring[first + 1], ring[second], ring[second + 1])) {
                    throw new Error('O polígono possui segmentos que se cruzam.');
                }
            }
        }
        return ring;
    }

    function mergeLayerStates(loadedStates, existingStates) {
        var loadedIds = loadedStates.map(function (state) { return state.id; });
        return loadedStates.concat(existingStates.filter(function (state) {
            return loadedIds.indexOf(state.id) === -1;
        }));
    }

    return {
        parseAxis: parseAxis,
        geographicCoordinates: geographicCoordinates,
        toSIRGAS2000: toSIRGAS2000,
        closeAndValidatePolygon: closeAndValidatePolygon,
        mergeLayerStates: mergeLayerStates
    };
}));
