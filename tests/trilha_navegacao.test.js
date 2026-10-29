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

test('uses the first valid endpoint when no user location is available', function () {
    const geometry = {
        type: 'MultiLineString',
        coordinates: [
            [[-49, -28], [-48.99, -28]],
            [[-48.7, -28], [-48.6, -28]]
        ]
    };
    const destination = navigation.closestEndpoint(geometry);
    assert.equal(destination.component, 0);
    assert.equal(destination.end, 'start');
    assert.deepEqual(destination.coordinates, [-49, -28]);
    assert.equal(destination.distance, null);
    assert.equal(
        navigation.googleMapsUrl(destination.coordinates),
        'https://www.google.com/maps/dir/?api=1&destination=-28%2C-49'
    );
    assert.equal(
        navigation.wazeUrl(destination.coordinates),
        'https://waze.com/ul?ll=-28%2C-49&navigate=yes'
    );
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

test('loads the navigation module before the interface and calls its exported API', function () {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'Trilha Caminhos da Baleia Franca', 'index.html'),
        'utf8'
    );
    assert.ok(
        html.indexOf('js/trilha-navegacao.js')
            < html.indexOf('js/trilhas-interface.js')
    );
    const interfaceSource = fs.readFileSync(
        path.join(__dirname, '..', 'Trilha Caminhos da Baleia Franca', 'js', 'trilhas-interface.js'),
        'utf8'
    );
    assert.match(interfaceSource, /trailNavigation\.closestEndpoint/);
    assert.doesNotMatch(interfaceSource, /var navigation\s*=/);
});

test('navigation bar home icon and fauna page links resolve to existing app pages', function () {
    const root = path.join(__dirname, '..');
    const mapHtml = fs.readFileSync(
        path.join(root, 'Trilha Caminhos da Baleia Franca', 'index.html'),
        'utf8'
    );
    const navScriptTag = /<script src="\.\.\/nav\.js" data-base="\.\."><\/script>/.exec(mapHtml);
    assert.ok(navScriptTag, 'O mapa deve carregar a navegação compartilhada com base relativa.');

    const navSource = fs.readFileSync(path.join(root, 'nav.js'), 'utf8');
    assert.match(navSource, /icon:\s*'fa-home', label:\s*'Início'/);
    assert.match(navSource, /href:\s*base \+ 'index\.html', icon:\s*'fa-home'/);
    assert.match(navSource, /href:\s*base \+ 'Ocorrencias de Fauna\/index\.html'/);

    const iconCss = fs.readFileSync(
        path.join(root, 'Trilha Caminhos da Baleia Franca', 'css', 'fontawesome-all.min.css'),
        'utf8'
    );
    assert.match(iconCss, /\.fa-home:before\{content:/);

    const deployedMapUrl = new URL(
        'Trilha%20Caminhos%20da%20Baleia%20Franca/index.html',
        'https://example.github.io/apabf/'
    );
    const baseUrl = new URL('../', deployedMapUrl);
    const homeUrl = new URL('index.html', baseUrl);
    const faunaUrl = new URL('Ocorrencias%20de%20Fauna/index.html', baseUrl);
    assert.equal(homeUrl.href, 'https://example.github.io/apabf/index.html');
    assert.equal(
        faunaUrl.href,
        'https://example.github.io/apabf/Ocorrencias%20de%20Fauna/index.html'
    );
    assert.ok(fs.existsSync(path.join(root, 'index.html')));
    assert.ok(fs.existsSync(path.join(root, 'Ocorrencias de Fauna', 'index.html')));

    const homepageHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(homepageHtml, /href="Ocorrencias de Fauna\/index\.html"[^>]*aria-label="Registros"/);
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
