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

test('services opens the map generator without a homepage or quick-nav shortcut', function () {
    const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const services = fs.readFileSync(path.join(ROOT, 'servicos.html'), 'utf8');
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const navigation = fs.readFileSync(path.join(ROOT, 'nav.js'), 'utf8');
    assert.doesNotMatch(homepage, /href="gerador-mapas\.html"/);
    assert.match(services, /href="gerador-mapas\.html"/);
    assert.doesNotMatch(navigation, /gerador-mapas\.html/);
    assert.match(page, /id="main-map"/);
    assert.match(page, /id="overview-map"/);
});

test('fixed quick navigation reserves safe bottom space on scrollable pages', function () {
    const styles = fs.readFileSync(path.join(ROOT, 'nav.css'), 'utf8');
    assert.match(styles, /body:has\(\.nav-bar\):not\(\.map-ui\)\s*\{[^}]*padding-bottom:[^}]*safe-area-inset-bottom/s);
    assert.match(styles, /\.nav-bar\s*\{[^}]*position:\s*fixed/s);
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
    assert.match(styles, /\.overview-frame\s*\{[^}]*width:\s*clamp\([^}]*height:\s*100%/s);
    assert.match(implementation, /function renderOverview[\s\S]*?renderTileBackground\(context, 'satellite'/);
    assert.match(implementation, /overviewWidth = overviewHeight \* 0\.56/);
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

    test('location inset is paired with stacked logos and credits remain outside the map', function () {
        const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
        const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
        const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
        const sidebar = page.slice(page.indexOf('<aside class="preview-sidebar">'), page.indexOf('</aside>', page.indexOf('<aside class="preview-sidebar">')));

        assert.doesNotMatch(sidebar, /Localização na APABF/);
        assert.doesNotMatch(sidebar, /overview-caption/);
        assert.match(sidebar, /class="overview-frame"[\s\S]*?class="preview-logos"/);
        assert.match(styles, /\.preview-logos\s*\{[^}]*flex-direction:\s*column/s);
        assert.match(implementation, /attributionControl:\s*false/);
        assert.match(implementation, /Satélite da localização: Esri, Vantor, Earthstar Geographics/);
        assert.match(implementation, /weight:\s*1\.2,\s*opacity:\s*1,\s*fillOpacity:\s*0/);
    });

    test('legend can switch columns and explicitly report configured omissions', function () {
        const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
        const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
        const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
        assert.match(page, /id="legend-limit"/);
        assert.match(styles, /\.legend-list\.is-two-columns/);
        assert.match(implementation, /entryItems\.length > 8 \? 2 : 1/);
        assert.match(implementation, /Mais ' \+ legend\.omitted \+ ' itens não exibidos/);
        assert.match(implementation, /essential:\s*Boolean\(state\.zoneStyles\)/);
    });

    test('print composition uses dynamic two-column legends and rotated left coordinates', function () {
        const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
        const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
        assert.match(implementation, /context\.rotate\(-Math\.PI \/ 2\)/);
        assert.match(implementation, /renderLegendCanvas\(context,[\s\S]*?legendMaxHeight/);
        assert.match(implementation, /metersPerPixel = groundWidth[\s\S]*?renderScaleBar/);
        assert.match(styles, /\.map-latitudes span\s*\{[^}]*rotate\(-90deg\)/s);
    });
});
