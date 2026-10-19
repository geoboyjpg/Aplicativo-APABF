(function (root, factory) {
    'use strict';

    var navigation = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = navigation;
    } else {
        root.TrilhaNavegacao = navigation;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function validPoint(point) {
        return Array.isArray(point)
            && point.length >= 2
            && Number.isFinite(point[0])
            && Number.isFinite(point[1])
            && Math.abs(point[0]) <= 180
            && Math.abs(point[1]) <= 90;
    }

    function geometryEndpoints(geometry) {
        if (!geometry) {
            return [];
        }
        var lines = geometry.type === 'LineString'
            ? [geometry.coordinates]
            : geometry.type === 'MultiLineString'
                ? geometry.coordinates
                : [];
        if (!Array.isArray(lines)) {
            return [];
        }
        return lines.flatMap(function (line, index) {
            if (!Array.isArray(line) || !line.length) {
                return [];
            }
            var first = line[0];
            var last = line[line.length - 1];
            return [
                { component: index, end: 'start', coordinates: first },
                { component: index, end: 'end', coordinates: last }
            ].filter(function (endpoint) {
                return validPoint(endpoint.coordinates);
            });
        });
    }

    function distanceMeters(first, second) {
        var radians = Math.PI / 180;
        var latitudeOne = first[1] * radians;
        var latitudeTwo = second[1] * radians;
        var deltaLatitude = (second[1] - first[1]) * radians;
        var deltaLongitude = (second[0] - first[0]) * radians;
        var term = Math.sin(deltaLatitude / 2) ** 2
            + Math.cos(latitudeOne) * Math.cos(latitudeTwo)
                * Math.sin(deltaLongitude / 2) ** 2;
        return 6371008.8 * 2 * Math.atan2(Math.sqrt(term), Math.sqrt(1 - term));
    }

    function closestEndpoint(geometry, userCoordinates) {
        if (!validPoint(userCoordinates)) {
            throw new Error('Coordenadas da localização atual inválidas.');
        }
        var endpoints = geometryEndpoints(geometry);
        if (!endpoints.length) {
            throw new Error('A geometria da trilha não possui extremos válidos.');
        }
        return endpoints.reduce(function (closest, endpoint) {
            var distance = distanceMeters(userCoordinates, endpoint.coordinates);
            return !closest || distance < closest.distance
                ? {
                    ...endpoint,
                    coordinates: endpoint.coordinates.slice(0, 2),
                    distance: distance
                }
                : closest;
        }, null);
    }

    function googleMapsUrl(coordinates) {
        if (!validPoint(coordinates)) {
            throw new Error('Coordenadas do destino inválidas.');
        }
        return 'https://www.google.com/maps/dir/?api=1&destination='
            + encodeURIComponent(coordinates[1] + ',' + coordinates[0]);
    }

    function wazeUrl(coordinates) {
        if (!validPoint(coordinates)) {
            throw new Error('Coordenadas do destino inválidas.');
        }
        return 'https://waze.com/ul?ll='
            + encodeURIComponent(coordinates[1] + ',' + coordinates[0])
            + '&navigate=yes';
    }

    return {
        closestEndpoint: closestEndpoint,
        distanceMeters: distanceMeters,
        geometryEndpoints: geometryEndpoints,
        googleMapsUrl: googleMapsUrl,
        wazeUrl: wazeUrl
    };
}));
