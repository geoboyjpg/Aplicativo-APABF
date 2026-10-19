'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const navigation = require('../Trilha Caminhos da Baleia Franca/js/trilha-navegacao');

test('finds valid endpoints for every original trail without altering its geometry', function () {
    const sourcePath = path.join(
        __dirname,
        '..',
        'Trilha Caminhos da Baleia Franca',
        'data',
        'TrilhaCaminhosdaBaleiaFranca_2.js'
    );
    const context = {};
    require('node:vm').runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
    const features = context.json_TrilhaCaminhosdaBaleiaFranca_2.features;
    assert.equal(features.length, 66);
    features.forEach(function (feature) {
        assert.ok(
            navigation.geometryEndpoints(feature.geometry).length >= 2,
            'Trilha sem dois extremos válidos: ' + feature.properties.fid
        );
    });
});

test('selects the closest real endpoint across disconnected MultiLineString parts', function () {
    const geometry = {
        type: 'MultiLineString',
        coordinates: [
            [[-49, -28], [-48.99, -28], [-48.98, -28]],
            [[-48.7, -28], [-48.6, -28]]
        ]
    };

    assert.deepEqual(
        navigation.geometryEndpoints(geometry).map(function (endpoint) {
            return [endpoint.component, endpoint.end];
        }),
        [[0, 'start'], [0, 'end'], [1, 'start'], [1, 'end']]
    );
    const closest = navigation.closestEndpoint(geometry, [-48.59, -28]);
    assert.equal(closest.component, 1);
    assert.equal(closest.end, 'end');
    assert.deepEqual(closest.coordinates, [-48.6, -28]);
    assert.ok(closest.distance > 0);
});

test('ignores intermediate vertices and invalid endpoints when choosing a destination', function () {
    const geometry = {
        type: 'LineString',
        coordinates: [[-49, -28], [-48.5, -28], [-48.1, -28]]
    };
    assert.equal(navigation.closestEndpoint(geometry, [-48.51, -28]).end, 'end');
    assert.throws(function () {
        navigation.closestEndpoint({
            type: 'LineString',
            coordinates: [[181, 0], [182, 0]]
        }, [-48, -28]);
    }, /extremos válidos/);
});

test('builds external navigation links using latitude,longitude destination coordinates', function () {
    const coordinates = [-49.1234, -28.5678];
    assert.equal(
        navigation.googleMapsUrl(coordinates),
        'https://www.google.com/maps/dir/?api=1&destination=-28.5678%2C-49.1234'
    );
    assert.equal(
        navigation.wazeUrl(coordinates),
        'https://waze.com/ul?ll=-28.5678%2C-49.1234&navigate=yes'
    );
    assert.throws(function () {
        navigation.googleMapsUrl([181, -28]);
    }, /inválidas/);
});
