'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const navigation = require('../Trilha Caminhos da Baleia Franca/js/trilha-navegacao');
const trailData = require('../Trilha Caminhos da Baleia Franca/js/trilha-dados');

test('finds valid endpoints for every original trail without altering its geometry', function () {
    const sourcePath = path.join(
        __dirname,
        '..',
        'dados',
        'trilhas_apabf.geojson'
    );
    const collection = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const features = collection.features;
    assert.equal(features.length, 66);
    assert.deepEqual(features.map(function (feature) {
        return feature.properties.fid;
    }), Array.from({ length: 66 }, function (_, index) {
        return String(index + 1);
    }));
    features.forEach(function (feature) {
        assert.ok(
            navigation.geometryEndpoints(feature.geometry).length >= 2,
            'Trilha sem dois extremos válidos: ' + feature.properties.fid
        );
    });
});

test('prepared GeoJSON retains every original attribute and 3D vertex', function () {
    const originalPath = path.join(__dirname, '..', 'dados', 'trilhas_apabf.original.geojson');
    const preparedPath = path.join(__dirname, '..', 'dados', 'trilhas_apabf.geojson');
    const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
    const prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8'));

    assert.equal(prepared.type, 'FeatureCollection');
    assert.equal(prepared.crs, undefined);
    assert.equal(prepared.features.length, original.features.length);
    prepared.features.forEach(function (feature, index) {
        const source = original.features[index];
        assert.equal(feature.properties.fid, String(source.properties.fid));
        assert.equal(feature.properties.ID, String(source.properties.ID));
        ['Nome', 'Distância', 'Município'].forEach(function (property) {
            assert.equal(feature.properties[property], source.properties[property]);
        });
        assert.deepEqual(feature.geometry, source.geometry);
    });
});

test('loads the trail layer from GeoJSON and waits for it before initializing the interface', function () {
    const html = fs.readFileSync(
        path.join(__dirname, '..', 'Trilha Caminhos da Baleia Franca', 'index.html'),
        'utf8'
    );
    const interfaceSource = fs.readFileSync(
        path.join(__dirname, '..', 'Trilha Caminhos da Baleia Franca', 'js', 'trilhas-interface.js'),
        'utf8'
    );

    assert.match(html, /<script src="js\/trilha-dados\.js"><\/script>/);
    assert.match(html, /TrilhaDados\.load\(/);
    assert.match(html, /apiUrl: 'https:\/\/apabf-trilhas-api\.gerhard-henrique23\.workers\.dev\/api\/trilhas'/);
    assert.match(html, /fallbackUrl: '\.\.\/dados\/trilhas_apabf\.geojson'/);
    assert.match(html, /trailDataReady\.catch/);
    assert.match(html, /new L\.geoJson\(collection/);
    assert.doesNotMatch(html, /<script src="data\/TrilhaCaminhosdaBaleiaFranca_2\.js"><\/script>/);
    assert.match(interfaceSource, /trailDataReady\.then\(initializeWithTrailData\)/);
});

test('loads API GeoJSON first and preserves its collection and 3D geometry', async function () {
    const collection = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'dados', 'trilhas_apabf.geojson'),
        'utf8'
    ));
    const requestedUrls = [];

    const loaded = await trailData.load({
        apiUrl: 'https://api.example.test/api/trilhas',
        fallbackUrl: '../dados/trilhas_apabf.geojson',
        fetch: async function (url) {
            requestedUrls.push(url);
            return { ok: true, json: async function () { return collection; } };
        },
        logger: { warn: function () { assert.fail('API válida não deve acionar o fallback.'); } }
    });

    assert.deepEqual(requestedUrls, ['https://api.example.test/api/trilhas']);
    assert.equal(loaded, collection);
    assert.equal(loaded.features.length, 66);
    assert.equal(loaded.features[0].geometry.coordinates[0][0].length, 3);
});

test('falls back to local GeoJSON when the API fails or returns invalid data', async function () {
    const localCollection = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'dados', 'trilhas_apabf.geojson'),
        'utf8'
    ));
    const invalidCollection = JSON.parse(JSON.stringify(localCollection));
    invalidCollection.features[0].geometry.coordinates[0][0] = [-49, -28];
    const requestedUrls = [];
    const warnings = [];

    const loaded = await trailData.load({
        apiUrl: 'https://api.example.test/api/trilhas',
        fallbackUrl: '../dados/trilhas_apabf.geojson',
        fetch: async function (url) {
            requestedUrls.push(url);
            if (url === 'https://api.example.test/api/trilhas') {
                return { ok: true, json: async function () { return invalidCollection; } };
            }
            return { ok: true, json: async function () { return localCollection; } };
        },
        logger: { warn: function (message, error) { warnings.push({ message: message, error: error }); } }
    });

    assert.deepEqual(requestedUrls, [
        'https://api.example.test/api/trilhas',
        '../dados/trilhas_apabf.geojson'
    ]);
    assert.equal(loaded, localCollection);
    assert.equal(loaded.features.length, 66);
    assert.match(warnings[0].message, /utilizando o GeoJSON local/);
    assert.match(warnings[0].error.message, /coordenada XYZ inválida/);
});

test('uses local GeoJSON when the API request returns an HTTP error', async function () {
    const localCollection = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'dados', 'trilhas_apabf.geojson'),
        'utf8'
    ));
    const requestedUrls = [];

    const loaded = await trailData.load({
        apiUrl: 'https://api.example.test/api/trilhas',
        fallbackUrl: '../dados/trilhas_apabf.geojson',
        fetch: async function (url) {
            requestedUrls.push(url);
            return url === 'https://api.example.test/api/trilhas'
                ? { ok: false, status: 503 }
                : { ok: true, json: async function () { return localCollection; } };
        },
        logger: { warn: function () {} }
    });

    assert.deepEqual(requestedUrls, [
        'https://api.example.test/api/trilhas',
        '../dados/trilhas_apabf.geojson'
    ]);
    assert.equal(loaded, localCollection);
});

test('uses local GeoJSON when the API request cannot reach the server', async function () {
    const localCollection = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'dados', 'trilhas_apabf.geojson'),
        'utf8'
    ));
    const requestedUrls = [];

    const loaded = await trailData.load({
        apiUrl: 'https://api.example.test/api/trilhas',
        fallbackUrl: '../dados/trilhas_apabf.geojson',
        fetch: async function (url) {
            requestedUrls.push(url);
            if (url === 'https://api.example.test/api/trilhas') {
                throw new Error('Network unavailable');
            }
            return { ok: true, json: async function () { return localCollection; } };
        },
        logger: { warn: function () {} }
    });

    assert.deepEqual(requestedUrls, [
        'https://api.example.test/api/trilhas',
        '../dados/trilhas_apabf.geojson'
    ]);
    assert.equal(loaded, localCollection);
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
