(function (root, factory) {
    'use strict';

    var routing = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = routing;
    } else {
        root.TrilhaAcessos = routing;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var OSRM_BASE_URL = 'https://router.project-osrm.org';
    var MAX_CANDIDATES = 50;
    var MAX_NEAREST_CHECKS = 15;
    var MAX_SNAP_DISTANCE_METERS = 60;
    var DRIVABLE_HIGHWAYS = new Set([
        'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
        'living_street', 'service', 'track', 'road'
    ]);

    function validPoint(point) {
        return Array.isArray(point)
            && point.length >= 2
            && Number.isFinite(point[0])
            && Number.isFinite(point[1])
            && Math.abs(point[0]) <= 180
            && Math.abs(point[1]) <= 90;
    }

    function isRestricted(tags) {
        var restrictionValues = ['no', 'private', 'customers', 'permit', 'agricultural', 'forestry'];
        return [
            tags.access,
            tags.vehicle,
            tags.motor_vehicle,
            tags.motorcar,
            tags.foot
        ].some(function (restriction) {
            return restrictionValues.includes(String(restriction || '').toLowerCase());
        }) || [
            tags['access:conditional'],
            tags['vehicle:conditional'],
            tags['motor_vehicle:conditional'],
            tags['foot:conditional']
        ].some(function (restriction) {
            var baseValue = String(restriction || '').split('@')[0].trim().toLowerCase();
            return restrictionValues.includes(baseValue);
        }) || Boolean(tags.ford === 'yes' || tags.impassable === 'yes');
    }

    function evidenceRank(feature) {
        var properties = feature.properties || {};
        if (properties.verification_status === 'verified'
            && String(properties.verification_source || '').trim()) {
            return 0;
        }
        var tags = properties.element_tags || {};
        var trailhead = tags.information === 'trailhead' || tags.highway === 'trailhead';
        var publicParking = ['parking', 'parking_entrance', 'parking_space'].includes(tags.amenity)
            && ['yes', 'permissive', 'public'].includes(String(tags.access || '').toLowerCase());
        return trailhead || publicParking ? 1 : 2;
    }

    function trailGapFor(properties) {
        return Number.isFinite(properties.trail_distance_m)
            ? properties.trail_distance_m
            : properties.distance_m;
    }

    function trailGapLabel(meters) {
        return Number.isFinite(meters)
            ? formatDistance(meters) + ' em linha reta da trilha'
            : 'distância até a trilha indisponível';
    }

    function isDrivingCandidate(feature, trailId) {
        if (!feature || !feature.geometry || feature.geometry.type !== 'Point'
            || !validPoint(feature.geometry.coordinates) || !feature.properties) {
            return false;
        }
        var properties = feature.properties;
        if (String(properties.trail_fid) !== String(trailId)
            || properties.verification_status === 'discarded'
            || !Number.isFinite(trailGapFor(properties))
            || isRestricted(properties.element_tags || {})) {
            return false;
        }
        var tags = properties.element_tags || {};
        var highway = String(tags.highway || '').toLowerCase();
        var parking = tags.amenity === 'parking'
            || tags.amenity === 'parking_entrance'
            || tags.amenity === 'parking_space';
        return DRIVABLE_HIGHWAYS.has(highway) || parking;
    }

    function candidateIdentity(feature) {
        var properties = feature.properties;
        return String(properties.candidate_id
            || (properties.element_type && properties.element_id
                ? properties.element_type + '/' + properties.element_id
                : feature.geometry.coordinates.join(',')));
    }

    function selectCandidates(features, trailId, maxCandidates) {
        var seenLocations = new Set();
        var limit = Number.isInteger(maxCandidates) && maxCandidates > 0
            ? Math.min(maxCandidates, MAX_CANDIDATES)
            : MAX_CANDIDATES;
        return features.filter(function (feature) {
            return isDrivingCandidate(feature, trailId);
        }).sort(function (first, second) {
            return evidenceRank(first) - evidenceRank(second)
                || trailGapFor(first.properties) - trailGapFor(second.properties)
                || candidateIdentity(first).localeCompare(candidateIdentity(second));
        }).filter(function (feature) {
            var coordinates = feature.geometry.coordinates;
            var key = coordinates[0].toFixed(5) + ',' + coordinates[1].toFixed(5);
            if (seenLocations.has(key)) {
                return false;
            }
            seenLocations.add(key);
            return true;
        }).slice(0, limit);
    }

    function coordinateString(coordinates) {
        return coordinates[0] + ',' + coordinates[1];
    }

    function tableUrl(origin, candidates) {
        if (!validPoint(origin) || !candidates.length) {
            throw new Error('Origem e ao menos um acesso válido são necessários.');
        }
        var points = [origin].concat(candidates.map(function (candidate) {
            return candidate.geometry.coordinates;
        }));
        var destinations = candidates.map(function (_candidate, index) {
            return index + 1;
        }).join(';');
        return OSRM_BASE_URL + '/table/v1/driving/'
            + points.map(coordinateString).join(';')
            + '?sources=0&destinations=' + destinations + '&annotations=distance,duration';
    }

    function nearestUrl(candidates) {
        if (!Array.isArray(candidates) || candidates.length !== 1) {
            throw new Error('A verificação OSRM Nearest aceita exatamente um acesso por consulta.');
        }
        return OSRM_BASE_URL + '/nearest/v1/driving/'
            + coordinateString(candidates[0].geometry.coordinates)
            + '?number=1';
    }

    function haversine(first, second) {
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

    function confidenceFor(feature, routable) {
        var properties = feature.properties;
        var hasReview = properties.verification_status === 'verified'
            && String(properties.verification_source || '').trim();
        if (hasReview) {
            return 'confirmed';
        }
        var tags = properties.element_tags || {};
        var explicitTrailhead = tags.information === 'trailhead' || tags.highway === 'trailhead';
        var publicParking = ['parking', 'parking_entrance', 'parking_space'].includes(tags.amenity)
            && ['yes', 'permissive', 'public'].includes(String(tags.access || '').toLowerCase());
        if (routable && trailGapFor(properties) <= 50 && (explicitTrailhead || publicParking)) {
            return 'probable';
        }
        return 'unconfirmed';
    }

    function buildResult(feature, snappedPoint, route, snapDistance) {
        if (!validPoint(snappedPoint) || !Number.isFinite(snapDistance)
            || snapDistance > MAX_SNAP_DISTANCE_METERS) {
            return null;
        }
        var routable = snapDistance <= MAX_SNAP_DISTANCE_METERS;
        var result = {
            feature: feature,
            destination: snappedPoint,
            snapDistance: snapDistance,
            routeDistance: routable && route && Number.isFinite(route.distance) ? route.distance : null,
            routeDuration: routable && route && Number.isFinite(route.duration) ? route.duration : null,
            trailGap: trailGapFor(feature.properties),
            confidence: confidenceFor(feature, routable)
        };
        result.estimatedRouteDuration = result.routeDuration;
        return result;
    }

    function parseTableResults(data, candidates) {
        if (!data || data.code !== 'Ok'
            || !Array.isArray(data.destinations)
            || !Array.isArray(data.sources)
            || !Array.isArray(data.durations)
            || !Array.isArray(data.distances)
            || !Array.isArray(data.durations[0])
            || !Array.isArray(data.distances[0])) {
            throw new Error('O serviço de roteamento não encontrou rotas viárias utilizáveis.');
        }
        var originSnapDistance = data.sources[0] && data.sources[0].distance;
        if (!Number.isFinite(originSnapDistance) || originSnapDistance > 1000) {
            throw new Error('A localização atual está muito distante da rede viária para estimar uma rota confiável.');
        }
        return candidates.map(function (candidate, index) {
            var waypoint = data.destinations[index];
            var duration = data.durations[0][index];
            var distance = data.distances[0][index];
            if (!waypoint || !validPoint(waypoint.location)
                || !Number.isFinite(duration) || !Number.isFinite(distance)) {
                return null;
            }
            var snapDistance = Number.isFinite(waypoint.distance)
                ? waypoint.distance
                : haversine(candidate.geometry.coordinates, waypoint.location);
            var result = buildResult(candidate, waypoint.location, {
                distance: distance,
                duration: duration
            }, snapDistance);
            if (result) {
                result.originSnapDistance = originSnapDistance;
            }
            return result;
        }).filter(Boolean).sort(function (first, second) {
            return evidenceRank(first.feature) - evidenceRank(second.feature)
                || first.estimatedRouteDuration - second.estimatedRouteDuration
                || first.trailGap - second.trailGap;
        });
    }

    function parseNearestResults(data, candidates) {
        if (!data || data.code !== 'Ok' || !Array.isArray(data.waypoints)) {
            throw new Error('O serviço de roteamento não identificou destinos na rede viária.');
        }
        var results = candidates.map(function (candidate, index) {
            var waypoint = data.waypoints[index];
            if (!waypoint || !validPoint(waypoint.location)
                || !Number.isFinite(waypoint.distance)) {
                return null;
            }
            return buildResult(candidate, waypoint.location, null, waypoint.distance);
        }).filter(Boolean);
        return sortNearestResults(results);
    }

    function sortNearestResults(results) {
        return results.sort(function (first, second) {
            return evidenceRank(first.feature) - evidenceRank(second.feature)
                || first.snapDistance - second.snapDistance
                || first.trailGap - second.trailGap;
        });
    }

    function googleMapsUrl(coordinates) {
        if (!validPoint(coordinates)) {
            throw new Error('Coordenada de destino inválida.');
        }
        return 'https://www.google.com/maps/dir/?api=1&destination='
            + encodeURIComponent(coordinates[1] + ',' + coordinates[0])
            + '&travelmode=driving';
    }

    function wazeUrl(coordinates) {
        if (!validPoint(coordinates)) {
            throw new Error('Coordenada de destino inválida.');
        }
        return 'https://waze.com/ul?ll='
            + encodeURIComponent(coordinates[1] + ',' + coordinates[0])
            + '&navigate=yes';
    }

    function formatDistance(meters) {
        return meters < 1000
            ? Math.round(meters) + ' m'
            : (meters / 1000).toFixed(1).replace('.', ',') + ' km';
    }

    function formatDuration(seconds) {
        var minutes = Math.round(seconds / 60);
        if (minutes < 60) {
            return minutes + ' min';
        }
        var hours = Math.floor(minutes / 60);
        var remainder = minutes % 60;
        return hours + ' h' + (remainder ? ' ' + remainder + ' min' : '');
    }

    return {
        MAX_CANDIDATES: MAX_CANDIDATES,
        MAX_NEAREST_CHECKS: MAX_NEAREST_CHECKS,
        MAX_SNAP_DISTANCE_METERS: MAX_SNAP_DISTANCE_METERS,
        confidenceFor: confidenceFor,
        evidenceRank: evidenceRank,
        formatDistance: formatDistance,
        formatDuration: formatDuration,
        googleMapsUrl: googleMapsUrl,
        haversine: haversine,
        isDrivingCandidate: isDrivingCandidate,
        nearestUrl: nearestUrl,
        parseNearestResults: parseNearestResults,
        parseTableResults: parseTableResults,
        selectCandidates: selectCandidates,
        sortNearestResults: sortNearestResults,
        trailGapLabel: trailGapLabel,
        tableUrl: tableUrl,
        wazeUrl: wazeUrl
    };
}));
