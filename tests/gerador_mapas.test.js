'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function loadCatalog() {
    const context = { window: {} };
    const catalogSource = fs.readFileSync(path.join(ROOT, 'catalogo-gerador-mapas.js'), 'utf8');
    vm.runInNewContext(catalogSource, context);
    return { context, definitions: context.window.CATALOGO_GERADOR_MAPAS };
}

function loadLayerData(context, definition) {
    const sourcePath = path.join(ROOT, ...definition.url.split('/'));
    assert.ok(fs.existsSync(sourcePath), 'camada ausente: ' + definition.url);
    if (definition.format === 'geojson') {
        return JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    }
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
    return context[definition.globalName];
}

test('homepage and services open the map generator', function () {
    const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const services = fs.readFileSync(path.join(ROOT, 'servicos.html'), 'utf8');
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    assert.match(homepage, /href="gerador-mapas\.html"[^>]*>[\s\S]*?<h2>Gerador de Mapas<\/h2>/);
    assert.match(services, /href="gerador-mapas\.html"/);
    assert.match(page, /id="main-map"/);
    assert.match(page, /id="overview-map"/);
});

test('generator catalog references available geographic sources and real feature collections', function () {
    const loaded = loadCatalog();
    assert.ok(Array.isArray(loaded.definitions));
    assert.ok(loaded.definitions.some(function (item) { return item.id === 'limite-apabf'; }));
    assert.ok(loaded.definitions.some(function (item) { return item.id === 'zoneamento'; }));

    loaded.definitions.forEach(function (definition) {
        const data = loadLayerData(loaded.context, definition);
        assert.equal(data.type, 'FeatureCollection', definition.name);
        assert.ok(data.features.length > 0, definition.name + ' sem feições');
        data.features.forEach(function (feature) {
            assert.ok(feature.geometry && feature.geometry.type, definition.name + ' com geometria vazia');
        });
    });
});

test('zone controls are based on the nine descriptive source categories', function () {
    const loaded = loadCatalog();
    const definition = loaded.definitions.find(function (item) { return item.id === 'zoneamento'; });
    const data = loadLayerData(loaded.context, definition);
    const zones = new Set(data.features.map(function (feature) {
        return feature.properties[definition.legendField];
    }));
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');

    assert.equal(definition.legendField, 'Zonas');
    assert.equal(zones.size, 9);
    assert.ok(Array.from(zones).every(function (name) { return typeof name === 'string' && !/^fid$/i.test(name); }));
    assert.match(implementation, /function addZoneControls\(state, layerItem\)/);
    assert.match(implementation, /filter: function \(feature\)/);
    assert.match(implementation, /zoneStyle\.opacity/);
});

test('map inset exports satellite tiles and the configuration panel scrolls independently', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');

    assert.match(page, /class="config-scroll"/);
    assert.match(page, /class="config-footer"/);
    assert.match(styles, /\.config-scroll\s*\{[^}]*overflow-y:\s*auto/s);
    assert.match(styles, /\.overview-frame\s*\{[^}]*aspect-ratio:\s*0\.56/s);
    assert.match(implementation, /function renderOverview[\s\S]*?renderTileBackground\(context, 'satellite'/);
    assert.match(implementation, /server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/);
});

test('cartographic text uses a white outline instead of a shadow', function () {
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');

    assert.doesNotMatch(styles, /text-shadow/);
    assert.match(styles, /\.map-coordinates span\s*\{[^}]*-webkit-text-stroke/s);
    assert.match(implementation, /context\.strokeText\(formatDegree/);
    assert.match(implementation, /context\.strokeText\(label/);
});

test('composition uses the requested existing institutional logos', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    [
        'logos/APA da Baleia Franca.png',
        'logos/icmbio horizontal@1000x-8.png'
    ].forEach(function (relativePath) {
        assert.ok(fs.existsSync(path.join(ROOT, relativePath)));
        const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
        assert.ok(page.includes(encodedPath));
    });
});
