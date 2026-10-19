'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const processor = require('../scripts/trilha_acessos');
const routing = require('../Trilha Caminhos da Baleia Franca/js/trilha-acessos');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(
    ROOT,
    'Trilha Caminhos da Baleia Franca',
    'data',
    'TrilhaCaminhosdaBaleiaFranca_2.js'
);
const MAP_HTML = path.join(ROOT, 'Trilha Caminhos da Baleia Franca', 'index.html');
const ACCESS_DATA = path.join(ROOT, 'Trilha Caminhos da Baleia Franca', 'data', 'acessos-trilhas.geojson');
const RUNTIME_ACCESS_DATA = path.join(ROOT, 'Trilha Caminhos da Baleia Franca', 'data', 'acessos-trilhas-web.geojson');
const FONT_AWESOME = path.join(
    ROOT,
    'Trilha Caminhos da Baleia Franca',
    'css',
    'fontawesome-all.min.css'
);

function readCollection() {
    const source = fs.readFileSync(SOURCE, 'utf8');
    const context = {};
    require('node:vm').runInNewContext(source, context);
    return context.json_TrilhaCaminhosdaBaleiaFranca_2;
}

test('extracts the first and last endpoints for all 66 trail features', function () {
    const extracted = processor.extractAllEndpoints(readCollection(), 5);
    assert.equal(extracted.diagnostics.length, 66);
    assert.equal(extracted.endpoints.length, 132);
    assert.deepEqual(
        Array.from(extracted.endpoints.slice(0, 2), function (endpoint) {
            return endpoint.endpoint;
        }),
        ['inicial', 'final']
    );
    assert.equal(extracted.endpoints[0].trail_fid, '1');
});

test('rejects invalid and empty geometries and reports disconnected segments', function () {
    const empty = processor.extractTrailEndpoints({
        properties: { fid: 'empty', ID: 'empty', Nome: 'Vazia' },
        geometry: { type: 'MultiLineString', coordinates: [] }
    }, 5);
    assert.match(empty.error, /vazia/);
    assert.deepEqual(empty.endpoints, []);

    const invalid = processor.extractTrailEndpoints({
        properties: { fid: 'invalid' },
        geometry: { type: 'MultiLineString', coordinates: [[[181, 0]], [[1, 1]]] }
    }, 5);
    assert.match(invalid.error, /inválido/);

    const brokenSegment = processor.extractTrailEndpoints({
        properties: { fid: 'broken', ID: 'broken', Nome: 'Interrompida' },
        geometry: { type: 'MultiLineString', coordinates: [[[-48.8, -28.2], [NaN, 0], [-48.7, -28.2]]] }
    }, 5);
    assert.equal(brokenSegment.invalid_segment_count, 1);
    assert.match(brokenSegment.connectivity_assessment, /inconclusivo/);

    const disconnected = processor.extractTrailEndpoints({
        properties: { fid: 'separate', ID: '4', Nome: 'Separada', Município: 'Imbituba' },
        geometry: {
            type: 'MultiLineString',
            coordinates: [
                [[-48.8, -28.2], [-48.799, -28.2]],
                [[-48.7, -28.2], [-48.699, -28.2]]
            ]
        }
    }, 5);
    assert.equal(disconnected.disconnected_segments, true);
    assert.equal(disconnected.endpoints[0].coordinates[0], -48.8);
    assert.equal(disconnected.endpoints[1].coordinates[0], -48.699);
});

test('uses a configurable search radius and expands only for endpoints without candidates', async function () {
    const endpointA = {
        trail_fid: 'a', trail_id: '1', trail_name: 'Praia A', municipality: 'Imbituba',
        endpoint: 'inicial', coordinates: [-48.8, -28.2], disconnected_segments: false
    };
    const endpointB = {
        trail_fid: 'b', trail_id: '2', trail_name: 'Praia B', municipality: 'Garopaba',
        endpoint: 'final', coordinates: [-48.7, -28.2], disconnected_segments: false
    };
    const queriedRadii = [];
    const fetchFunction = async function (_url, request) {
        const query = new URLSearchParams(request.body).get('data');
        const radius = Number(/around:(\d+)/.exec(query)[1]);
        queriedRadii.push(radius);
        return {
            ok: true,
            json: async function () {
                return {
                    elements: radius === 300 ? [{
                        type: 'way',
                        id: 77,
                        center: { lat: -28.2, lon: -48.8 },
                        tags: { highway: 'footway', access: 'yes', name: 'Caminho OSM' }
                    }] : []
                };
            }
        };
    };

    const checkpoints = [];
    const candidates = await processor.collectCandidates(
        [endpointA, endpointB],
        { radius: 300, maxRadius: 1200 },
        fetchFunction,
        async function (snapshot) {
            checkpoints.push(snapshot.length);
        }
    );
    assert.deepEqual(queriedRadii, [300, 600, 1200]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].properties.trail_fid, 'a');
    assert.equal(candidates[0].properties.verification_status, 'pending');
    assert.ok(checkpoints.length >= 1);
});

test('reports an Overpass failure instead of returning partial results', async function () {
    await assert.rejects(
        processor.collectCandidates([{
            trail_fid: 'a',
            endpoint: 'inicial',
            coordinates: [-48.8, -28.2]
        }], { radius: 300, maxRadius: 300 }, async function () {
            return {
                ok: false,
                status: 400,
                headers: { get: function () { return null; } }
            };
        }),
        /HTTP 400/
    );
});

test('retries transient Overpass errors on another endpoint', async function () {
    const urls = [];
    const elements = await processor.fetchOverpass([{
        coordinates: [-48.8, -28.2]
    }], 300, async function (url) {
        urls.push(url);
        return urls.length === 1
            ? {
                ok: false,
                status: 502,
                headers: { get: function () { return '0.001'; } }
            }
            : { ok: true, json: async function () { return { elements: [] }; } };
    });
    assert.deepEqual(urls, processor.OVERPASS_URLS.slice(0, 2));
    assert.deepEqual(elements, []);
});

test('never treats access restrictions as verified', function () {
    assert.equal(processor.candidateStatus({ access: 'yes' }).status, 'pending');
    assert.equal(processor.candidateStatus({ access: 'private' }).status, 'discarded');
    assert.equal(processor.candidateStatus({ motor_vehicle: 'no' }).status, 'discarded');
    assert.equal(processor.candidateStatus({ foot: 'no' }).status, 'discarded');
    assert.equal(processor.candidateStatus({ access: 'agricultural' }).status, 'discarded');
    assert.equal(processor.candidateStatus({ 'motor_vehicle:conditional': 'no @ (Mo-Fr)' }).status, 'discarded');
    assert.equal(processor.candidateStatus({}).status, 'pending');
});

test('Overpass query uses the configured radius and OSM way data', function () {
    const query = processor.createOverpassQuery([{
        coordinates: [-48.8, -28.2]
    }], 600);
    assert.match(query, /around:600,-28\.2,-48\.8/);
    assert.match(query, /out center tags/);
    assert.match(query, /\[entrance\]/);
    assert.match(query, /parking/);
});

test('search radius can be configured from the command line', function () {
    const options = processor.parseOptions(['--radius=450', '--max-radius=1800']);
    assert.equal(options.radius, 450);
    assert.equal(options.maxRadius, 1800);
    assert.throws(function () {
        processor.parseOptions(['--radius=1200', '--max-radius=600']);
    }, /maior ou igual/);
});

test('preserves a reviewed access only when it includes a verification source', function () {
    const candidate = {
        type: 'Feature',
        id: '1:inicial:way:9',
        geometry: { type: 'Point', coordinates: [-48, -28] },
        properties: {
            candidate_id: '1:inicial:way:9',
            verification_status: 'pending',
            longitude: -48,
            latitude: -28
        }
    };
    const oldFeature = {
        ...candidate,
        geometry: { type: 'Point', coordinates: [-48.1, -28.1] },
        properties: {
            ...candidate.properties,
            verification_status: 'verified',
            verification_source: 'Vistoria de campo',
            longitude: -48.1,
            latitude: -28.1
        }
    };
    const preserved = processor.preserveVerification([candidate], [oldFeature])[0];
    assert.equal(preserved.properties.verification_status, 'verified');
    assert.equal(preserved.geometry.coordinates[0], -48.1);
    assert.equal(processor.preserveVerification([candidate], [{
        ...oldFeature,
        properties: { ...oldFeature.properties, verification_source: '' }
    }])[0].properties.verification_status, 'pending');
});

test('measures candidate distance to all multipart trail segments', function () {
    const geometry = {
        type: 'MultiLineString',
        coordinates: [
            [[-49, -28], [-48, -28]],
            [[-48.8, -28.5], [-48.8, -28.4]]
        ]
    };
    const distance = processor.distanceToTrail([-48.5, -28.001], geometry);
    assert.ok(distance > 100 && distance < 120);
    assert.ok(processor.distanceToTrail([-48.8, -28.45], geometry) < 0.1);
});

test('deduplicates coincident candidates while retaining endpoint and OSM evidence', function () {
    const candidate = function (id, endpoint, name) {
        return {
            type: 'Feature',
            id: id,
            geometry: { type: 'Point', coordinates: [-48.5, -28] },
            properties: {
                candidate_id: id,
                trail_fid: '1',
                endpoint: endpoint,
                distance_m: 20,
                element_type: 'way',
                element_id: id,
                element_name: name,
                element_tags: { highway: 'residential', name: name },
                verification_status: 'pending',
                verification_source: '',
                source_url: 'https://www.openstreetmap.org/way/' + id
            }
        };
    };
    const enriched = processor.enrichCandidates({
        type: 'FeatureCollection',
        metadata: { generated_at: '2026-01-01T00:00:00.000Z' },
        features: [
            candidate('201', 'inicial', 'Rua A'),
            candidate('202', 'final', 'Rua B')
        ]
    }, [{
        type: 'Feature',
        properties: { fid: '1' },
        geometry: { type: 'MultiLineString', coordinates: [[[-48.5, -28.001], [-48.5, -27.999]]] }
    }], '2026-01-02T00:00:00.000Z');
    assert.equal(enriched.features.length, 1);
    assert.deepEqual(enriched.features[0].properties.endpoint_associations, ['inicial', 'final']);
    assert.equal(enriched.features[0].properties.duplicate_sources.length, 1);
    assert.equal(enriched.metadata.candidates_found, 1);
});

test('runtime candidates carry line distance, preserve duplicate provenance, and exclude restricted roads', function () {
    const feature = function (id, coordinates, tags) {
        return {
            type: 'Feature',
            id: id,
            geometry: { type: 'Point', coordinates: coordinates },
            properties: {
                candidate_id: id,
                trail_fid: '1',
                trail_id: '1',
                trail_name: 'Trilha teste',
                endpoint: 'inicial',
                distance_m: 25,
                trail_distance_m: 12,
                element_type: 'way',
                element_id: id,
                element_tags: tags,
                verification_status: 'pending',
                confidence: 'unconfirmed',
                source_url: 'https://www.openstreetmap.org/way/' + id
            }
        };
    };
    const runtime = processor.createRuntimeCollection({
        type: 'FeatureCollection',
        metadata: {
            source: 'OSM',
            generated_at: '2026-01-01T00:00:00.000Z',
            trail_features_processed: 66,
            verification_policy: 'review required'
        },
        features: [
            feature('101', [-49.1, -28.1], { highway: 'residential' }),
            feature('102', [-49.100001, -28.100001], { highway: 'service' }),
            feature('103', [-49.2, -28.2], { highway: 'residential', motor_vehicle: 'no' })
        ]
    });
    assert.equal(runtime.features.length, 1);
    assert.equal(runtime.metadata.duplicate_locations_removed, 1);
    assert.equal(runtime.features[0].properties.trail_distance_m, 12);
    assert.equal(runtime.features[0].properties.duplicate_sources.length, 1);
});

test('the Trails menu icon exists in the bundled Font Awesome font', function () {
    const html = fs.readFileSync(MAP_HTML, 'utf8');
    const icons = fs.readFileSync(FONT_AWESOME, 'utf8');
    assert.match(html, /data-tab="trilhas"[^>]*>\s*<i class="fas fa-map-signs"/);
    assert.match(icons, /fa-map-signs:before\{content:"\\f277"\}/);
    assert.match(html, /data-tab="ajuda"[^>]*>\s*<i class="fas fa-question-circle"/);
    assert.match(html, /data-tab="info"[^>]*>\s*<i class="fas fa-info-circle"/);
});

test('saved candidates retain valid coordinates and their source trail association', function () {
    const collection = readCollection();
    const knownTrailIds = new Set(collection.features.map(function (feature) {
        return String(feature.properties.fid);
    }));
    const candidates = JSON.parse(fs.readFileSync(ACCESS_DATA, 'utf8'));
    assert.equal(candidates.metadata.trail_features_processed, 66);
    assert.equal(candidates.metadata.endpoints_processed, 132);
    assert.equal(candidates.metadata.endpoint_searches.length, 132);
    candidates.features.forEach(function (feature) {
        assert.equal(feature.geometry.type, 'Point');
        assert.ok(Number.isFinite(feature.geometry.coordinates[0]));
        assert.ok(Number.isFinite(feature.geometry.coordinates[1]));
        assert.ok(knownTrailIds.has(String(feature.properties.trail_fid)));
        assert.ok(['pending', 'discarded', 'verified'].includes(
            feature.properties.verification_status
        ));
        assert.ok(Number.isFinite(feature.properties.trail_distance_m));
        assert.ok(feature.properties.trail_distance_m <= feature.properties.distance_m + 1);
        assert.ok(Array.isArray(feature.properties.evidence));
        assert.ok(feature.properties.last_updated);
        assert.ok(feature.properties.source_updated_at);
    });
    assert.equal(candidates.features.length, candidates.metadata.candidates_found);
    assert.equal(
        new Set(candidates.features.map(function (feature) {
            const restricted = feature.properties.verification_status === 'discarded'
                ? 'restricted'
                : 'eligible';
            return [
                feature.properties.trail_fid,
                feature.geometry.coordinates.map(function (coordinate) {
                    return coordinate.toFixed(5);
                }).join(','),
                feature.properties.access_type,
                restricted
            ].join(':');
        })).size,
        candidates.features.length
    );
});

test('runtime GeoJSON is compact and contains only driving-route candidates', function () {
    const source = JSON.parse(fs.readFileSync(ACCESS_DATA, 'utf8'));
    const runtime = JSON.parse(fs.readFileSync(RUNTIME_ACCESS_DATA, 'utf8'));
    assert.equal(runtime.metadata.trail_features_processed, 66);
    assert.ok(runtime.features.length < source.features.length);
    assert.equal(
        new Set(runtime.features.map(function (feature) {
            return String(feature.properties.trail_fid) + ':'
                + feature.geometry.coordinates.map(function (coordinate) {
                    return coordinate.toFixed(5);
                }).join(',');
        })).size,
        runtime.features.length
    );
    runtime.features.forEach(function (feature) {
        assert.ok(['primary', 'secondary', 'tertiary', 'unclassified', 'residential',
            'living_street', 'service', 'track', 'road'].includes(
            feature.properties.element_tags.highway
        ) || ['parking', 'parking_entrance', 'parking_space'].includes(
            feature.properties.element_tags.amenity
        ));
        assert.ok(Number.isFinite(feature.properties.trail_distance_m));
        assert.ok(['confirmed', 'probable', 'unconfirmed'].includes(feature.properties.confidence));
        assert.ok(feature.properties.source_url);
    });
});

test('selects only car-route candidates belonging to the selected trail', function () {
    const features = JSON.parse(fs.readFileSync(ACCESS_DATA, 'utf8')).features;
    const selected = routing.selectCandidates(features, '1');
    assert.ok(selected.length > 0);
    assert.ok(selected.length <= routing.MAX_CANDIDATES);
    selected.forEach(function (feature) {
        assert.equal(String(feature.properties.trail_fid), '1');
        assert.notEqual(feature.properties.element_tags.highway, 'path');
        assert.notEqual(feature.properties.element_tags.highway, 'footway');
    });
    assert.equal(routing.selectCandidates(features, 'no-such-trail').length, 0);
});

test('rejects restrictions and does not infer confidence from proximity alone', function () {
    const candidate = {
        geometry: { type: 'Point', coordinates: [-49.1, -28.3] },
        properties: {
            trail_fid: '1',
            distance_m: 20,
            verification_status: 'pending',
            element_tags: { highway: 'residential' }
        }
    };
    assert.equal(routing.isDrivingCandidate(candidate, '1'), true);
    assert.equal(routing.isDrivingCandidate({
        ...candidate,
        properties: {
            ...candidate.properties,
            element_tags: { highway: 'residential', access: 'private' }
        }
    }, '1'), false);
    assert.equal(routing.isDrivingCandidate({
        ...candidate,
        properties: {
            ...candidate.properties,
            element_tags: { highway: 'residential', 'access:conditional': 'private @ (night)' }
        }
    }, '1'), false);
    assert.equal(routing.confidenceFor(candidate, true), 'unconfirmed');
    const taggedTrailhead = {
        ...candidate,
        properties: {
            ...candidate.properties,
            trail_distance_m: 25,
            element_tags: { highway: 'residential', information: 'trailhead' }
        }
    };
    assert.equal(routing.confidenceFor(taggedTrailhead, true), 'probable');
    assert.equal(routing.confidenceFor({
        ...taggedTrailhead,
        properties: { ...taggedTrailhead.properties, trail_distance_m: 75 }
    }, true), 'unconfirmed');
    assert.equal(routing.confidenceFor({
        ...candidate,
        properties: { ...candidate.properties, distance_m: 75 }
    }, true), 'unconfirmed');
    assert.equal(routing.confidenceFor({
        ...candidate,
        properties: {
            ...candidate.properties,
            verification_status: 'verified',
            verification_source: 'revisão documentada'
        }
    }, true), 'confirmed');
});

test('builds Google Maps and Waze links for OSRM-snapped coordinates', function () {
    const coordinates = [-49.1234, -28.5678];
    assert.equal(
        routing.googleMapsUrl(coordinates),
        'https://www.google.com/maps/dir/?api=1&destination=-28.5678%2C-49.1234&travelmode=driving'
    );
    assert.equal(
        routing.wazeUrl(coordinates),
        'https://waze.com/ul?ll=-28.5678%2C-49.1234&navigate=yes'
    );
    assert.match(routing.tableUrl([-49, -28], [{
        geometry: { coordinates: [-49.1, -28.1] }
    }]), /table\/v1\/driving/);
    assert.match(routing.nearestUrl([{
        geometry: { coordinates: [-49.1, -28.1] }
    }]), /nearest\/v1\/driving/);
    assert.match(
        routing.nearestUrl([{ geometry: { coordinates: [-49.1, -28.1] } }]),
        /driving\/-49\.1,-28\.1\?number=1$/
    );
    assert.throws(function () {
        routing.nearestUrl([
            { geometry: { coordinates: [-49.1, -28.1] } },
            { geometry: { coordinates: [-49.2, -28.2] } }
        ]);
    }, /exatamente um acesso/);
});

test('parses individual nearest checks for use without geolocation', function () {
    const candidate = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-49.1, -28.1] },
        properties: {
            candidate_id: 'single',
            trail_fid: '1',
            distance_m: 25,
            trail_distance_m: 12,
            verification_status: 'pending',
            element_tags: { highway: 'residential' }
        }
    };
    const result = routing.parseNearestResults({
        code: 'Ok',
        waypoints: [{ location: [-49.1001, -28.1001], distance: 8 }]
    }, [candidate]);
    assert.equal(result.length, 1);
    assert.equal(result[0].routeDistance, null);
    assert.equal(result[0].trailGap, 12);
    assert.equal(routing.MAX_NEAREST_CHECKS, 15);
});

test('ranks by road travel time without inventing a walking-time estimate', function () {
    const candidate = function (id, trailGap) {
        return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-49 + Number(id) / 100, -28] },
            properties: {
                candidate_id: id,
                trail_fid: '1',
                distance_m: trailGap,
                verification_status: 'pending',
                element_tags: { highway: 'residential' }
            }
        };
    };
    const candidates = [candidate('a', 40), candidate('b', 80)];
    const results = routing.parseTableResults({
        code: 'Ok',
        sources: [{ location: [-49, -28], distance: 0 }],
        destinations: [
            { location: [-48.99, -28], distance: 5 },
            { location: [-48.98, -28], distance: 5 }
        ],
        distances: [[3000, 1000]],
        durations: [[600, 150]]
    }, candidates);
    assert.equal(results[0].feature.properties.candidate_id, 'b');
    assert.equal(results[0].routeDistance, 1000);
    assert.equal(results[0].confidence, 'unconfirmed');
    assert.equal(results[0].estimatedRouteDuration, 150);
});

test('refuses off-network destinations and reports routing failures', function () {
    const candidate = {
        geometry: { type: 'Point', coordinates: [-49, -28] },
        properties: {
            trail_fid: '1',
            distance_m: 10,
            verification_status: 'pending',
            element_tags: { highway: 'residential' }
        }
    };
    assert.deepEqual(routing.parseNearestResults({
        code: 'Ok',
        waypoints: [{ location: [-49.01, -28], distance: 120 }]
    }, [candidate]), []);
    assert.throws(function () {
        routing.parseTableResults({ code: 'NoTable' }, [candidate]);
    }, /não encontrou rotas viárias/);
    assert.throws(function () {
        routing.parseTableResults({
            code: 'Ok',
            sources: [{ distance: 1500 }],
            destinations: [],
            distances: [[]],
            durations: [[]]
        }, [candidate]);
    }, /muito distante da rede viária/);
});
