'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_FILE = path.join(
    ROOT,
    'Trilha Caminhos da Baleia Franca',
    'data',
    'TrilhaCaminhosdaBaleiaFranca_2.js'
);
const DEFAULT_OUTPUT = path.join(
    ROOT,
    'Trilha Caminhos da Baleia Franca',
    'data',
    'acessos-trilhas.geojson'
);
const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
];
const OSM_HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|track|path|footway|steps|pedestrian|cycleway|bridleway|road';
const DRIVABLE_HIGHWAYS = new Set([
    'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'living_street', 'service', 'track', 'road'
]);
const CONNECTED_SEGMENT_TOLERANCE_METERS = 5;
const OVERPASS_BATCH_SIZE = 12;
const OVERPASS_BATCH_DELAY_MS = 1200;

function parseOptions(args) {
    const options = {
        radius: 300,
        maxRadius: 1200,
        output: DEFAULT_OUTPUT
    };

    args.forEach(function (arg) {
        const match = /^--(radius|max-radius|output)=(.+)$/.exec(arg);
        if (!match) {
            throw new Error('Opção inválida: ' + arg);
        }
        if (match[1] === 'output') {
            options.output = path.resolve(match[2]);
            return;
        }
        const value = Number(match[2]);
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error('O valor de --' + match[1] + ' deve ser positivo.');
        }
        options[match[1] === 'max-radius' ? 'maxRadius' : 'radius'] = value;
    });

    if (options.maxRadius < options.radius) {
        throw new Error('--max-radius deve ser maior ou igual a --radius.');
    }
    return options;
}

function readTrailCollection(filePath) {
    const context = {};
    vm.runInNewContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
    const collection = context.json_TrilhaCaminhosdaBaleiaFranca_2;
    if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
        throw new Error('A fonte geográfica não contém uma FeatureCollection válida.');
    }
    return collection;
}

function validCoordinate(point) {
    return Array.isArray(point)
        && point.length >= 2
        && Number.isFinite(point[0])
        && Number.isFinite(point[1])
        && Math.abs(point[0]) <= 180
        && Math.abs(point[1]) <= 90;
}

function distanceMeters(first, second) {
    const radians = Math.PI / 180;
    const lat1 = first[1] * radians;
    const lat2 = second[1] * radians;
    const deltaLat = (second[1] - first[1]) * radians;
    const deltaLon = (second[0] - first[0]) * radians;
    const value = Math.sin(deltaLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function pointToSegmentDistanceMeters(point, first, second) {
    const radius = 6371008.8;
    const latitude = point[1] * Math.PI / 180;
    const project = function (coordinate) {
        return [
            radius * (coordinate[0] - point[0]) * Math.PI / 180 * Math.cos(latitude),
            radius * (coordinate[1] - point[1]) * Math.PI / 180
        ];
    };
    const start = project(first);
    const end = project(second);
    const deltaX = end[0] - start[0];
    const deltaY = end[1] - start[1];
    const denominator = deltaX * deltaX + deltaY * deltaY;
    const fraction = denominator
        ? Math.max(0, Math.min(1, -(start[0] * deltaX + start[1] * deltaY) / denominator))
        : 0;
    return Math.hypot(start[0] + fraction * deltaX, start[1] + fraction * deltaY);
}

function distanceToTrail(point, geometry) {
    let shortest = Infinity;
    (geometry && geometry.coordinates || []).forEach(function (line) {
        if (!Array.isArray(line) || !line.length) {
            return;
        }
        if (line.length === 1) {
            shortest = Math.min(shortest, distanceMeters(point, line[0]));
            return;
        }
        for (let index = 1; index < line.length; index += 1) {
            shortest = Math.min(
                shortest,
                pointToSegmentDistanceMeters(point, line[index - 1], line[index])
            );
        }
    });
    return shortest;
}

function isRestricted(tags) {
    const restrictionValues = ['no', 'private', 'customers', 'permit', 'agricultural', 'forestry'];
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
        const baseValue = String(restriction || '').split('@')[0].trim().toLowerCase();
        return restrictionValues.includes(baseValue);
    }) || tags.ford === 'yes' || tags.impassable === 'yes';
}

function accessTypeFor(tags) {
    if (tags.information === 'trailhead' || tags.highway === 'trailhead') {
        return 'trailhead';
    }
    if (['parking', 'parking_entrance', 'parking_space'].includes(tags.amenity)) {
        return 'parking';
    }
    if (tags.entrance && tags.entrance !== 'no') {
        return 'entrance';
    }
    if (['path', 'footway', 'steps', 'pedestrian', 'bridleway'].includes(tags.highway)) {
        return 'pedestrian_path';
    }
    return tags.highway ? 'road' : 'other';
}

function evidenceFor(tags) {
    const evidence = [];
    if (tags.information === 'trailhead' || tags.highway === 'trailhead') {
        evidence.push('OSM identifica explicitamente um início de trilha.');
    }
    if (['parking', 'parking_entrance', 'parking_space'].includes(tags.amenity)) {
        evidence.push('OSM identifica estacionamento ou acesso a estacionamento.');
    }
    if (tags.entrance && tags.entrance !== 'no') {
        evidence.push('OSM identifica uma entrada.');
    }
    if (tags.access === 'yes' || tags.access === 'permissive' || tags.access === 'public'
        || tags.foot === 'yes' || tags.foot === 'permissive' || tags.foot === 'designated') {
        evidence.push('OSM contém uma indicação explícita de acesso permitido.');
    }
    return evidence;
}

function confidenceFor(properties, trailDistanceMeters) {
    if (properties.verification_status === 'verified'
        && String(properties.verification_source || '').trim()) {
        return 'confirmed';
    }
    const tags = properties.element_tags || {};
    const explicitTrailhead = tags.information === 'trailhead' || tags.highway === 'trailhead';
    const publicParking = ['parking', 'parking_entrance', 'parking_space'].includes(tags.amenity)
        && (tags.access === 'yes' || tags.access === 'permissive' || tags.access === 'public');
    return trailDistanceMeters <= 50 && (explicitTrailhead || publicParking)
        && !isRestricted(tags)
        ? 'probable'
        : 'unconfirmed';
}

function candidateSource(feature) {
    const properties = feature.properties || {};
    return {
        candidate_id: properties.candidate_id,
        endpoint: properties.endpoint,
        distance_m: properties.distance_m,
        search_radius_m: properties.search_radius_m,
        element_type: properties.element_type,
        element_id: properties.element_id,
        element_name: properties.element_name,
        element_tags: properties.element_tags || {},
        access_type: properties.access_type,
        verification_status: properties.verification_status,
        verification_source: properties.verification_source || '',
        verified_by: properties.verified_by || '',
        verified_at: properties.verified_at || '',
        review_notes: properties.review_notes || '',
        source_url: properties.source_url,
        evidence: properties.evidence || []
    };
}

function deduplicateCandidates(features) {
    const groups = new Map();
    features.forEach(function (feature) {
        const properties = feature.properties || {};
        const tags = properties.element_tags || {};
        const restricted = properties.verification_status === 'discarded' ? 'restricted' : 'eligible';
        const key = String(properties.trail_fid) + ':'
            + feature.geometry.coordinates[0].toFixed(5) + ','
            + feature.geometry.coordinates[1].toFixed(5) + ':'
            + accessTypeFor(tags) + ':' + restricted;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(feature);
    });
    return Array.from(groups.values()).map(function (group) {
        const sorted = group.slice().sort(function (first, second) {
            const rank = function (feature) {
                const properties = feature.properties || {};
                if (properties.verification_status === 'verified'
                    && String(properties.verification_source || '').trim()) {
                    return 0;
                }
                return properties.confidence === 'probable' ? 1 : 2;
            };
            return rank(first) - rank(second)
                || (first.properties.trail_distance_m || Infinity)
                    - (second.properties.trail_distance_m || Infinity)
                || (first.properties.distance_m || Infinity)
                    - (second.properties.distance_m || Infinity);
        });
        const winner = sorted[0];
        const endpointAssociations = new Set();
        const sources = new Map();
        group.forEach(function (feature) {
            const properties = feature.properties || {};
            (properties.endpoint_associations || [properties.endpoint]).forEach(function (endpoint) {
                if (endpoint) {
                    endpointAssociations.add(endpoint);
                }
            });
            (properties.duplicate_sources || []).forEach(function (source) {
                if (source.endpoint) {
                    endpointAssociations.add(source.endpoint);
                }
                if (source.candidate_id) {
                    sources.set(source.candidate_id, source);
                }
            });
        });
        group.filter(function (feature) {
            return feature !== winner;
        }).forEach(function (feature) {
            const source = candidateSource(feature);
            if (source.candidate_id) {
                sources.set(source.candidate_id, source);
            }
        });
        return {
            ...winner,
            properties: {
                ...winner.properties,
                endpoint_associations: Array.from(endpointAssociations),
                duplicate_sources: Array.from(sources.values())
            }
        };
    });
}

function enrichCandidates(collection, trailFeatures, generatedAt) {
    const trailsById = new Map(trailFeatures.map(function (feature) {
        return [String(feature.properties.fid), feature];
    }));
    const enrichedFeatures = deduplicateCandidates(collection.features.map(function (feature) {
        const properties = feature.properties || {};
        const trail = trailsById.get(String(properties.trail_fid));
        if (!trail || !validCoordinate(feature.geometry && feature.geometry.coordinates)) {
            return feature;
        }
        const tags = properties.element_tags || {};
        const trailDistance = distanceToTrail(feature.geometry.coordinates, trail.geometry);
        const updatedProperties = {
            ...properties,
            trail_distance_m: Number(trailDistance.toFixed(2)),
            access_type: accessTypeFor(tags),
            evidence: evidenceFor(tags),
            source_updated_at: properties.source_updated_at || collection.metadata.generated_at,
            last_updated: generatedAt
        };
        if (isRestricted(tags)) {
            updatedProperties.verification_status = 'discarded';
            updatedProperties.notes = 'Atributos OSM indicam restrição incompatível com o acesso à trilha.';
        }
        updatedProperties.confidence = confidenceFor(updatedProperties, trailDistance);
        return { ...feature, properties: updatedProperties };
    }));
    const endpointSearches = (collection.metadata.endpoint_searches || []).map(function (search) {
        const key = [search.trail_fid, search.endpoint].join(':');
        const related = enrichedFeatures.filter(function (feature) {
            const endpoints = feature.properties.endpoint_associations
                || [feature.properties.endpoint];
            return endpoints.some(function (endpoint) {
                return [feature.properties.trail_fid, endpoint].join(':') === key;
            });
        });
        return {
            ...search,
            status: related.length ? 'candidates identified' : 'no candidates found',
            candidate_count: related.length,
            largest_search_radius_m: related.length
                ? Math.max.apply(null, related.map(function (feature) {
                    return feature.properties.search_radius_m || 0;
                }))
                : collection.metadata.maximum_search_radius_m
        };
    });
    const enriched = {
        ...collection,
        metadata: {
            ...collection.metadata,
            candidates_found: enrichedFeatures.length,
            duplicate_candidate_records_removed: (collection.metadata.duplicate_candidate_records_removed || 0)
                + collection.features.length - enrichedFeatures.length,
            endpoint_searches: endpointSearches,
            data_quality_updated_at: generatedAt,
            candidates_pending: enrichedFeatures.filter(function (feature) {
                return feature.properties.verification_status === 'pending';
            }).length,
            candidates_discarded: enrichedFeatures.filter(function (feature) {
                return feature.properties.verification_status === 'discarded';
            }).length,
            candidates_verified: enrichedFeatures.filter(function (feature) {
                return feature.properties.verification_status === 'verified';
            }).length,
            candidate_status_counts: {
                confirmed: enrichedFeatures.filter(function (feature) {
                    return feature.properties.confidence === 'confirmed';
                }).length,
                probable: enrichedFeatures.filter(function (feature) {
                    return feature.properties.confidence === 'probable';
                }).length,
                unconfirmed: enrichedFeatures.filter(function (feature) {
                    return feature.properties.confidence === 'unconfirmed'
                        && feature.properties.verification_status !== 'discarded';
                }).length,
                discarded: enrichedFeatures.filter(function (feature) {
                    return feature.properties.verification_status === 'discarded';
                }).length
            },
            verification_policy: 'Confirmação exige fonte de verificação registrada; probabilidade exige evidência OSM explícita de início de trilha ou estacionamento público a até 50 m da geometria.'
        },
        features: enrichedFeatures
    };
    return enriched;
}

function extractTrailEndpoints(feature, toleranceMeters) {
    const properties = feature && feature.properties ? feature.properties : {};
    const geometry = feature && feature.geometry;
    const result = {
        trail_fid: properties.fid === undefined ? null : String(properties.fid),
        trail_id: properties.ID === undefined ? '' : String(properties.ID),
        trail_name: String(properties['Nome'] || ''),
        municipality: String(properties['Município'] || ''),
        geometry_type: geometry && geometry.type ? geometry.type : '',
        segment_count: 0,
        invalid_segment_count: 0,
        disconnected_segments: false,
        connectivity_assessment: 'not assessed',
        segment_gaps_m: [],
        endpoints: [],
        error: ''
    };

    if (!geometry || geometry.type !== 'MultiLineString' || !Array.isArray(geometry.coordinates)) {
        result.error = 'Geometria ausente ou não é MultiLineString.';
        return result;
    }
    if (result.trail_fid === null) {
        result.error = 'A feição não possui fid para associar os candidatos.';
        return result;
    }

    const coordinates = geometry.coordinates;
    result.segment_count = coordinates.length;
    if (!coordinates.length
        || !Array.isArray(coordinates[0])
        || !coordinates[0].length
        || !Array.isArray(coordinates[coordinates.length - 1])
        || !coordinates[coordinates.length - 1].length) {
        result.error = 'Geometria vazia ou sem primeiro/último vértice.';
        return result;
    }

    const firstPoint = coordinates[0][0];
    const lastSegment = coordinates[coordinates.length - 1];
    const lastPoint = lastSegment[lastSegment.length - 1];
    if (!validCoordinate(firstPoint) || !validCoordinate(lastPoint)) {
        result.error = 'Primeiro ou último vértice inválido.';
        return result;
    }

    let previousNonemptySegment = null;
    coordinates.forEach(function (segment) {
        if (!Array.isArray(segment) || !segment.length) {
            result.invalid_segment_count += 1;
            previousNonemptySegment = null;
            return;
        }
        const start = segment[0];
        const end = segment[segment.length - 1];
        if (!segment.every(validCoordinate)) {
            result.invalid_segment_count += 1;
            previousNonemptySegment = null;
            return;
        }
        if (previousNonemptySegment) {
            const gap = distanceMeters(previousNonemptySegment, start);
            result.segment_gaps_m.push(Number(gap.toFixed(2)));
            if (gap > toleranceMeters) {
                result.disconnected_segments = true;
            }
        }
        previousNonemptySegment = end;
    });

    result.connectivity_assessment = result.invalid_segment_count
        ? 'inconclusivo: há segmentos inválidos ou vazios'
        : result.disconnected_segments
            ? 'desconectado'
            : 'contíguo dentro da tolerância de ' + toleranceMeters + ' m';
    result.endpoints = [
        { endpoint: 'inicial', coordinates: firstPoint.slice(0, 2) },
        { endpoint: 'final', coordinates: lastPoint.slice(0, 2) }
    ];
    return result;
}

function extractAllEndpoints(collection, toleranceMeters) {
    const diagnostics = collection.features.map(function (feature) {
        return extractTrailEndpoints(feature, toleranceMeters);
    });
    const endpoints = diagnostics.flatMap(function (diagnostic) {
        if (diagnostic.error || diagnostic.trail_fid === null) {
            return [];
        }
        return diagnostic.endpoints.map(function (endpoint) {
            return {
                ...endpoint,
                trail_fid: diagnostic.trail_fid,
                trail_id: diagnostic.trail_id,
                trail_name: diagnostic.trail_name,
                municipality: diagnostic.municipality,
                disconnected_segments: diagnostic.disconnected_segments,
                invalid_segment_count: diagnostic.invalid_segment_count
            };
        });
    });
    return { endpoints, diagnostics };
}

function createOverpassQuery(endpoints, radiusMeters) {
    const selectors = endpoints.map(function (endpoint) {
        const longitude = endpoint.coordinates[0];
        const latitude = endpoint.coordinates[1];
        const around = '(around:' + radiusMeters + ',' + latitude + ',' + longitude + ')';
        return [
            '  way' + around + '["highway"~"^(' + OSM_HIGHWAYS + ')$"];',
            '  node' + around + '[entrance];',
            '  nw' + around + '[~"^(amenity|tourism|leisure)$"~"^(parking|parking_entrance|parking_space|information|attraction|park|nature_reserve)$"];',
            '  node' + around + '[information~"^(trailhead|guidepost)$"];'
        ].join('\n');
    });
    return '[out:json][timeout:90];\n(\n' + selectors.join('\n')
        + '\n);\nout center tags;';
}

function osmLocation(element, reference) {
    if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
        return {
            coordinates: [element.lon, element.lat],
            coordinateSource: 'OpenStreetMap node'
        };
    }
    if (element.center && Number.isFinite(element.center.lat) && Number.isFinite(element.center.lon)) {
        return {
            coordinates: [element.center.lon, element.center.lat],
            coordinateSource: 'centro aproximado da geometria OpenStreetMap'
        };
    }
    if (Array.isArray(element.geometry) && element.geometry.length) {
        const validPoints = element.geometry
            .filter(function (point) {
                return Number.isFinite(point.lon) && Number.isFinite(point.lat);
            })
            .map(function (point) {
                return [point.lon, point.lat];
            });
        if (validPoints.length) {
            validPoints.sort(function (first, second) {
                return distanceMeters(reference.coordinates, first)
                    - distanceMeters(reference.coordinates, second);
            });
            return {
                coordinates: validPoints[0],
                coordinateSource: 'vértice mais próximo da geometria OpenStreetMap'
            };
        }
    }
    return null;
}

function candidateStatus(tags) {
    if (isRestricted(tags)) {
        return {
            status: 'discarded',
            note: 'Atributos OSM indicam restrição incompatível com o acesso à trilha.'
        };
    }
    if (['yes', 'permissive', 'public'].includes(String(tags.access || '').toLowerCase())
        || ['yes', 'permissive', 'designated'].includes(String(tags.foot || '').toLowerCase())) {
        return {
            status: 'pending',
            note: 'Há indicação OSM favorável, mas é necessária verificação humana.'
        };
    }
    return {
        status: 'pending',
        note: 'A proximidade não comprova conexão, acesso público ou viabilidade.'
    };
}

function isCandidateElement(element) {
    const tags = element.tags || {};
    const highway = String(tags.highway || '').toLowerCase();
    const entrance = String(tags.entrance || '').toLowerCase();
    const accessAmenity = ['parking', 'parking_entrance', 'parking_space'].includes(
        String(tags.amenity || '').toLowerCase()
    );
    const visitorFeature = ['information', 'attraction'].includes(
        String(tags.tourism || '').toLowerCase()
    ) || ['park', 'nature_reserve'].includes(String(tags.leisure || '').toLowerCase());
    const trailInformation = ['trailhead', 'guidepost'].includes(
        String(tags.information || '').toLowerCase()
    );
    const entranceNode = element.type === 'node'
        && entrance !== ''
        && entrance !== 'no';
    return (element.type === 'way' && OSM_HIGHWAYS.split('|').includes(highway))
        || entranceNode
        || accessAmenity
        || visitorFeature
        || trailInformation;
}

function makeCandidate(reference, element, radiusMeters) {
    const tags = element.tags || {};
    if (!isCandidateElement(element)) {
        return null;
    }
    const location = osmLocation(element, reference);
    if (!location) {
        return null;
    }
    const distance = distanceMeters(reference.coordinates, location.coordinates);
    if (distance > radiusMeters) {
        return null;
    }
    const status = candidateStatus(tags);
    const elementName = String(tags.name || tags.highway || tags.entrance || tags.amenity || '');
    const id = [
        reference.trail_fid,
        reference.endpoint,
        element.type,
        element.id
    ].join(':');
    return {
        type: 'Feature',
        id: id,
        geometry: { type: 'Point', coordinates: location.coordinates },
        properties: {
            candidate_id: id,
            trail_fid: reference.trail_fid,
            trail_id: reference.trail_id,
            trail_name: reference.trail_name,
            municipality: reference.municipality,
            endpoint: reference.endpoint,
            latitude: location.coordinates[1],
            longitude: location.coordinates[0],
            distance_m: Number(distance.toFixed(2)),
            search_radius_m: radiusMeters,
            element_type: element.type,
            element_id: String(element.id),
            element_name: elementName,
            element_tags: tags,
            coordinate_source: location.coordinateSource,
            source: 'OpenStreetMap / Overpass API',
            source_url: 'https://www.openstreetmap.org/' + element.type + '/' + element.id,
            verification_status: status.status,
            access_signal: tags.access || tags.foot || 'not specified',
            connectivity: 'not assessed',
            trail_has_disconnected_segments: reference.disconnected_segments,
            trail_invalid_segment_count: reference.invalid_segment_count || 0,
            notes: status.note
        }
    };
}

async function fetchOverpass(endpoints, radiusMeters, fetchFunction) {
    const query = createOverpassQuery(endpoints, radiusMeters);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let response;
        try {
            response = await fetchFunction(OVERPASS_URLS[attempt], {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'user-agent': 'Aplicativo-APABF-trilha-access-candidates/1.0 (open data preprocessing)'
                },
                body: new URLSearchParams({ data: query }),
                signal: AbortSignal.timeout(120000)
            });
        } catch (error) {
            if (attempt === 2) {
                throw error;
            }
            await new Promise(function (resolve) {
                setTimeout(resolve, 5000 * (attempt + 1));
            });
            continue;
        }

        if (!response.ok) {
            if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
                throw new Error('Overpass API respondeu HTTP ' + response.status + '.');
            }
            const retryAfter = Number(response.headers && response.headers.get('retry-after'));
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 60000)
                : 5000 * (attempt + 1);
            await new Promise(function (resolve) {
                setTimeout(resolve, delay);
            });
            continue;
        }

        const result = await response.json();
        if (!result || !Array.isArray(result.elements)) {
            throw new Error('A resposta da Overpass API não contém elementos válidos.');
        }
        return result.elements;
    }
    throw new Error('Não foi possível obter uma resposta completa da Overpass API.');
}

function radiusSequence(initialRadius, maxRadius) {
    const radii = [initialRadius];
    while (radii[radii.length - 1] < maxRadius) {
        radii.push(Math.min(maxRadius, radii[radii.length - 1] * 2));
    }
    return radii;
}

async function collectCandidates(endpoints, options, fetchFunction, onBatch) {
    const found = new Map();
    const searched = new Set();
    const radii = radiusSequence(options.radius, options.maxRadius);

    for (const radius of radii) {
        const activeEndpoints = endpoints.filter(function (endpoint) {
            if (searched.has(endpointKey(endpoint))) {
                return false;
            }
            return true;
        });
        if (!activeEndpoints.length) {
            break;
        }
        const endpointKeysWithCandidates = new Set();
        for (let start = 0; start < activeEndpoints.length; start += OVERPASS_BATCH_SIZE) {
            const batch = activeEndpoints.slice(start, start + OVERPASS_BATCH_SIZE);
            const elements = await fetchOverpass(batch, radius, fetchFunction);
            batch.forEach(function (endpoint) {
                elements.forEach(function (element) {
                    const candidate = makeCandidate(endpoint, element, radius);
                    if (!candidate) {
                        return;
                    }
                    const key = endpointKey(endpoint);
                    endpointKeysWithCandidates.add(key);
                    const existing = found.get(candidate.id);
                    if (!existing || candidate.properties.distance_m < existing.properties.distance_m) {
                        found.set(candidate.id, candidate);
                    }
                });
            });
            if (typeof onBatch === 'function') {
                await onBatch(Array.from(found.values()), {
                    radius_m: radius,
                    endpoints_processed: Math.min(start + batch.length, activeEndpoints.length),
                    endpoints_in_batch: batch.length
                });
            }
            if (start + OVERPASS_BATCH_SIZE < activeEndpoints.length) {
                await new Promise(function (resolve) {
                    setTimeout(resolve, OVERPASS_BATCH_DELAY_MS);
                });
            }
        }
        activeEndpoints.forEach(function (endpoint) {
            const key = endpointKey(endpoint);
            if (endpointKeysWithCandidates.has(key)
                && Array.from(found.values()).some(function (candidate) {
                    return endpointKey(candidate.properties) === key
                        && candidate.properties.verification_status !== 'discarded';
                })) {
                searched.add(key);
            }
        });
    }
    return Array.from(found.values());
}

function endpointKey(endpoint) {
    return [endpoint.trail_fid, endpoint.endpoint].join(':');
}

function preserveVerification(candidates, existingFeatures) {
    const existing = new Map();
    (existingFeatures || []).forEach(function (feature) {
        const properties = feature && feature.properties;
        if (properties && properties.candidate_id) {
            existing.set(properties.candidate_id, feature);
        }
        (properties && properties.duplicate_sources || []).forEach(function (source) {
            if (source.candidate_id) {
                existing.set(source.candidate_id, {
                    geometry: feature.geometry,
                    properties: source
                });
            }
        });
    });
    return candidates.map(function (candidate) {
        const oldFeature = existing.get(candidate.properties.candidate_id);
        const oldProperties = oldFeature && oldFeature.properties;
        if (!oldProperties
            || oldProperties.verification_status !== 'verified'
            || !String(oldProperties.verification_source || '').trim()) {
            return candidate;
        }
        return {
            ...candidate,
            geometry: oldFeature.geometry,
            properties: {
                ...candidate.properties,
                latitude: Number.isFinite(oldProperties.latitude)
                    ? oldProperties.latitude
                    : candidate.properties.latitude,
                longitude: Number.isFinite(oldProperties.longitude)
                    ? oldProperties.longitude
                    : candidate.properties.longitude,
                verification_status: 'verified',
                verification_source: oldProperties.verification_source,
                verified_by: oldProperties.verified_by || '',
                verified_at: oldProperties.verified_at || '',
                review_notes: oldProperties.review_notes || ''
            }
        };
    });
}

function mergeCandidateFeatures(discovered, existingFeatures, preserveMissing) {
    const merged = preserveVerification(discovered, existingFeatures);
    const included = new Set(merged.map(function (feature) {
        return feature.properties.candidate_id;
    }));
    (existingFeatures || []).forEach(function (feature) {
        const properties = feature && feature.properties;
        if (!properties || !properties.candidate_id || included.has(properties.candidate_id)) {
            return;
        }
        if (preserveMissing === 'all'
            || (properties.verification_status === 'verified'
                && String(properties.verification_source || '').trim())) {
            merged.push(feature);
            included.add(properties.candidate_id);
        }
    });
    return merged;
}

function summarize(diagnostics, endpoints, candidates, options) {
    const endpointSearches = endpoints.map(function (endpoint) {
        const relatedCandidates = candidates.filter(function (candidate) {
            return endpointKey(candidate.properties) === endpointKey(endpoint);
        });
        const pendingCandidates = relatedCandidates.filter(function (candidate) {
            return candidate.properties.verification_status === 'pending';
        });
        return {
            trail_fid: endpoint.trail_fid,
            trail_id: endpoint.trail_id,
            trail_name: endpoint.trail_name,
            municipality: endpoint.municipality,
            endpoint: endpoint.endpoint,
            coordinates: endpoint.coordinates,
            status: relatedCandidates.length ? 'candidates identified' : 'no candidates found',
            candidate_count: relatedCandidates.length,
            largest_search_radius_m: pendingCandidates.length
                ? Math.max.apply(null, relatedCandidates.map(function (candidate) {
                    return candidate.properties.search_radius_m;
                }))
                : options.maxRadius
        };
    });
    return {
        source: 'OpenStreetMap via Overpass API',
        generated_at: new Date().toISOString(),
        query_scope: 'Vias tagged highway, acessos entrance, estacionamentos, equipamentos turísticos, parques e informações de trilha.',
        trail_features_processed: diagnostics.length,
        search_radius_m: options.radius,
        maximum_search_radius_m: options.maxRadius,
        valid_trails: diagnostics.filter(function (item) {
            return !item.error && item.invalid_segment_count === 0;
        }).length,
        invalid_geometries: diagnostics.filter(function (item) {
            return Boolean(item.error) || item.invalid_segment_count > 0;
        }).length,
        endpoints_processed: endpoints.length,
        trails_with_disconnected_segments: diagnostics.filter(function (item) {
            return item.disconnected_segments;
        }).length,
        trails_with_invalid_segments: diagnostics.filter(function (item) {
            return item.invalid_segment_count > 0;
        }).length,
        candidates_found: candidates.length,
        candidates_pending: candidates.filter(function (item) {
            return item.properties.verification_status === 'pending';
        }).length,
        candidates_discarded: candidates.filter(function (item) {
            return item.properties.verification_status === 'discarded';
        }).length,
        candidates_verified: candidates.filter(function (item) {
            return item.properties.verification_status === 'verified';
        }).length,
        verification_policy: 'Proximidade ou tags OSM não confirmam acesso; revisão humana/fonte confiável é necessária.',
        endpoint_searches: endpointSearches,
        geometry_diagnostics: diagnostics
    };
}

function createRuntimeCollection(collection) {
    const eligible = collection.features.filter(function (feature) {
        const properties = feature.properties || {};
        const tags = properties.element_tags || {};
        const highway = String(tags.highway || '').toLowerCase();
        const parking = ['parking', 'parking_entrance', 'parking_space'].includes(
            String(tags.amenity || '').toLowerCase()
        );
        return properties.verification_status !== 'discarded'
            && !isRestricted(tags)
            && (DRIVABLE_HIGHWAYS.has(highway) || parking);
    }).map(function (feature) {
        const properties = feature.properties;
        const tags = properties.element_tags || {};
        const runtimeTags = {};
        [
            'highway', 'amenity', 'name', 'entrance', 'access',
            'vehicle', 'motor_vehicle', 'motorcar', 'foot', 'ford', 'impassable',
            'information', 'tourism', 'leisure', 'access:conditional',
            'vehicle:conditional', 'motor_vehicle:conditional', 'foot:conditional'
        ].forEach(function (key) {
            if (tags[key] !== undefined) {
                runtimeTags[key] = tags[key];
            }
        });
        return {
            type: 'Feature',
            id: feature.id,
            geometry: feature.geometry,
            properties: {
                candidate_id: properties.candidate_id,
                trail_fid: properties.trail_fid,
                trail_id: properties.trail_id,
                trail_name: properties.trail_name,
                municipality: properties.municipality,
                endpoint: properties.endpoint,
                endpoint_associations: properties.endpoint_associations || [properties.endpoint],
                distance_m: properties.distance_m,
                trail_distance_m: properties.trail_distance_m,
                element_type: properties.element_type,
                element_id: properties.element_id,
                element_name: properties.element_name,
                element_tags: runtimeTags,
                verification_status: properties.verification_status,
                verification_source: properties.verification_source || '',
                duplicate_sources: properties.duplicate_sources || [],
                confidence: properties.confidence || 'unconfirmed',
                evidence: properties.evidence || [],
                access_type: properties.access_type || accessTypeFor(tags),
                source_updated_at: properties.source_updated_at
                    || collection.metadata.generated_at,
                last_updated: properties.last_updated || collection.metadata.generated_at,
                source: properties.source,
                source_url: properties.source_url
            }
        };
    });
    const deduplicated = new Map();
    const runtimeSource = function (feature) {
        const properties = feature.properties;
        return {
            candidate_id: properties.candidate_id,
            endpoint: properties.endpoint,
            distance_m: properties.distance_m,
            element_type: properties.element_type,
            element_id: properties.element_id,
            element_name: properties.element_name,
            element_tags: properties.element_tags,
            access_type: properties.access_type,
            confidence: properties.confidence,
            evidence: properties.evidence,
            verification_status: properties.verification_status,
            verification_source: properties.verification_source,
            source_url: properties.source_url
        };
    };
    const mergeSources = function (sources) {
        const unique = new Map();
        sources.forEach(function (source) {
            if (source && source.candidate_id) {
                unique.set(source.candidate_id, source);
            }
        });
        return Array.from(unique.values());
    };
    eligible.forEach(function (feature) {
        const coordinates = feature.geometry.coordinates;
        const key = String(feature.properties.trail_fid) + ':'
            + coordinates[0].toFixed(5) + ',' + coordinates[1].toFixed(5);
        const previous = deduplicated.get(key);
        if (!previous) {
            feature.properties.duplicate_sources = feature.properties.duplicate_sources || [];
            deduplicated.set(key, feature);
            return;
        }
        const existingSources = previous.properties.duplicate_sources || [];
        const incomingSources = feature.properties.duplicate_sources || [];
        const confidenceRank = function (confidence) {
            return confidence === 'confirmed' ? 0 : confidence === 'probable' ? 1 : 2;
        };
        const betterRepresentative = confidenceRank(feature.properties.confidence)
            < confidenceRank(previous.properties.confidence)
            || (feature.properties.confidence === previous.properties.confidence
                && Number(feature.properties.trail_distance_m)
                    < Number(previous.properties.trail_distance_m));
        if (betterRepresentative) {
            feature.properties.endpoint_associations = Array.from(new Set(
                (feature.properties.endpoint_associations || [])
                    .concat(previous.properties.endpoint_associations || [])
            ));
            feature.properties.duplicate_sources = mergeSources(
                incomingSources.concat(existingSources, [runtimeSource(previous)])
            );
            deduplicated.set(key, feature);
        } else {
            previous.properties.endpoint_associations = Array.from(new Set(
                (previous.properties.endpoint_associations || [])
                    .concat(feature.properties.endpoint_associations || [])
            ));
            previous.properties.duplicate_sources = mergeSources(
                existingSources.concat(incomingSources, [runtimeSource(feature)])
            );
        }
    });
    const features = Array.from(deduplicated.values());
    const trailIds = new Set(features.map(function (feature) {
        return String(feature.properties.trail_fid);
    }));
    const expectedTrailIds = (collection.metadata.geometry_diagnostics || []).map(function (item) {
        return String(item.trail_fid);
    });
    return {
        type: 'FeatureCollection',
        name: 'acessos_rodoviarios_candidatos_trilhas_apabf',
        metadata: {
            source: collection.metadata.source,
            generated_at: collection.metadata.generated_at,
            route_candidate_count: features.length,
            duplicate_locations_removed: eligible.length - features.length,
            trail_features_processed: collection.metadata.trail_features_processed,
            trails_with_route_candidates: trailIds.size,
            trail_ids_without_route_candidates: expectedTrailIds.filter(function (id) {
                return !trailIds.has(id);
            }),
            verification_policy: collection.metadata.verification_policy,
            data_quality_updated_at: collection.metadata.data_quality_updated_at,
            candidate_status_counts: collection.metadata.candidate_status_counts
        },
        features: features
    };
}

function writeJsonAtomically(filePath, value) {
    const temporaryPath = filePath + '.tmp';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function persistCollections(options, collection) {
    const runtimeOutput = path.join(
        path.dirname(options.output),
        path.basename(options.output).replace(/\.geojson$/i, '-web.geojson')
    );
    writeJsonAtomically(options.output, collection);
    writeJsonAtomically(runtimeOutput, createRuntimeCollection(collection));
}

function buildCollection(extracted, candidates, options, trails, generatedAt) {
    return enrichCandidates({
        type: 'FeatureCollection',
        name: 'candidatos_acessos_trilhas_apabf',
        crs: {
            type: 'name',
            properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' }
        },
        metadata: summarize(extracted.diagnostics, extracted.endpoints, candidates, options),
        features: candidates
    }, trails, generatedAt);
}

async function run(options) {
    const collection = readTrailCollection(SOURCE_FILE);
    const extracted = extractAllEndpoints(collection, CONNECTED_SEGMENT_TOLERANCE_METERS);
    const existing = fs.existsSync(options.output)
        ? JSON.parse(fs.readFileSync(options.output, 'utf8'))
        : null;
    const oldFeatures = existing && Array.isArray(existing.features) ? existing.features : [];
    const generatedAt = new Date().toISOString();
    const checkpoint = function (discovered) {
        const partial = mergeCandidateFeatures(
            discovered,
            oldFeatures,
            'all'
        );
        const partialCollection = buildCollection(
            extracted,
            partial,
            options,
            collection.features,
            generatedAt
        );
        persistCollections(options, partialCollection);
    };
    const discovered = await collectCandidates(
        extracted.endpoints,
        options,
        global.fetch,
        checkpoint
    );
    const candidates = mergeCandidateFeatures(discovered, oldFeatures, 'verified');
    const result = buildCollection(extracted, candidates, options, collection.features, generatedAt);
    const runtimeOutput = path.join(
        path.dirname(options.output),
        path.basename(options.output).replace(/\.geojson$/i, '-web.geojson')
    );
    persistCollections(options, result);
    console.log(JSON.stringify({
        output: options.output,
        runtime_output: runtimeOutput,
        ...result.metadata
    }, null, 2));
}

if (require.main === module) {
    try {
        run(parseOptions(process.argv.slice(2))).catch(function (error) {
            console.error('Falha ao concluir a busca de acessos. Confira os arquivos de saída: os lotes concluídos foram salvos incrementalmente.');
            console.error(error);
            process.exitCode = 1;
        });
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    candidateStatus,
    collectCandidates,
    createOverpassQuery,
    createRuntimeCollection,
    confidenceFor,
    distanceMeters,
    distanceToTrail,
    deduplicateCandidates,
    enrichCandidates,
    extractAllEndpoints,
    extractTrailEndpoints,
    fetchOverpass,
    isCandidateElement,
    isRestricted,
    mergeCandidateFeatures,
    OVERPASS_URLS,
    makeCandidate,
    parseOptions,
    preserveVerification,
    radiusSequence
};
