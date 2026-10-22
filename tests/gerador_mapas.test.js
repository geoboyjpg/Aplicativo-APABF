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
});

test('location inset retains provider credits without duplicating satellite attribution', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const sidebar = page.slice(page.indexOf('<aside class="preview-sidebar">'), page.indexOf('</aside>', page.indexOf('<aside class="preview-sidebar">')));

    assert.doesNotMatch(sidebar, /Localização na APABF/);
    assert.doesNotMatch(sidebar, /overview-caption/);
    assert.match(sidebar, /class="overview-frame"[\s\S]*?class="preview-logos"/);
    assert.match(styles, /\.preview-logos\s*\{[^}]*flex-direction:\s*column/s);
    assert.match(implementation, /attributionControl:\s*false/);
    assert.match(implementation, /Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community/);
    assert.match(implementation, /Imagem de satélite: Esri, Vantor, Earthstar Geographics e comunidade GIS/);
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

test('print composition retains top/left coordinate labels and anchors map furniture to the frame', function () {
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const frame = implementation.slice(implementation.indexOf('function drawCoordinateFrame'), implementation.indexOf('function wrappedLines'));
    assert.match(frame, /topCoordinate\.lon/);
    assert.match(frame, /leftCoordinate\.lat/);
    assert.doesNotMatch(frame, /bottomCoordinate|rightCoordinate/);
    assert.match(frame, /context\.strokeStyle = '#000'/);
    assert.match(implementation, /frame\.x \+ frame\.width \* 0\.72,[\s\S]*?frame\.y \+ frame\.height - 9 \* scaleFactor/);
    assert.match(implementation, /frame\.x \+ frame\.width - 12 \* scaleFactor/);
    assert.match(implementation, /context\.rotate\(-Math\.PI \/ 2\)/);
    assert.match(implementation, /renderLegendCanvas\(context,[\s\S]*?legendMaxHeight/);
    assert.match(implementation, /metersPerPixel = groundWidth[\s\S]*?renderScaleBar/);
    assert.match(styles, /\.map-latitudes span\s*\{[^}]*rotate\(-90deg\)/s);
});

test('imports selected KML/KMZ files without replacing layer state or the sidebar', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const geometry = fs.readFileSync(path.join(ROOT, 'gerador-mapas-geometrias.js'), 'utf8');
    assert.match(page, /id="file-import"[^>]*multiple/);
    assert.match(implementation, /mergeLayerStates\(loadedStates, states\)/);
    assert.match(geometry, /function mergeLayerStates\(loadedStates, existingStates\)/);
    assert.match(implementation, /function addLayerControls\(state\)[\s\S]*?elements\.layerList\.appendChild\(item\)/);
    assert.match(implementation, /function parseKml\(text, filename\)/);
    assert.match(implementation, /window\.JSZip\.loadAsync\(buffer\)/);
    assert.match(implementation, /candidates\[0\]\.async\('text'\)/);
    assert.match(implementation, /id: 'importado-' \+ Date\.now\(\) \+ '-' \+ \(\+\+manualSequence\)/);
});

test('concurrent catalog completion preserves imported and manually created layer objects', function () {
    const geometry = require(path.join(ROOT, 'gerador-mapas-geometrias.js'));
    const imported = { id: 'importado-teste', layer: { visible: true } };
    const manual = { id: 'manual-teste', layer: { visible: true } };
    const official = [{ id: 'zoneamento' }];
    const merged = geometry.mergeLayerStates(official, [imported, manual]);
    assert.deepEqual(merged, [official[0], imported, manual]);
    assert.equal(merged[1].layer, imported.layer);
    assert.equal(merged[2].layer, manual.layer);
});

test('layer loading isolates request failures and preserves independent state references', async function () {
    const geometry = require(path.join(ROOT, 'gerador-mapas-geometrias.js'));
    const available = { id: 'online-ok', visible: true, color: '#123456' };
    const definitions = [
        { id: 'online-ok', source: 'serviço de teste' },
        { id: 'online-fail', source: 'serviço indisponível' },
        { id: 'online-other', source: 'outro serviço' }
    ];
    const results = await geometry.loadLayersIndependently(definitions, function (definition) {
        if (definition.id === 'online-fail') {
            return Promise.reject(new Error('HTTP 503'));
        }
        return Promise.resolve(definition.id === 'online-ok' ? available : {
            id: definition.id,
            visible: false,
            color: '#abcdef'
        });
    });

    assert.equal(results.length, 3);
    assert.equal(results[0].state, available);
    assert.equal(results[0].error, null);
    assert.match(results[1].error.message, /HTTP 503/);
    assert.equal(results[2].state.id, 'online-other');
    assert.notEqual(results[0].state, results[2].state);
    assert.equal(available.visible, true);
});

test('undefined state regression is fixed at the geometry and layer-control scopes', function () {
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const bounds = implementation.slice(
        implementation.indexOf('function getGeometryBounds'),
        implementation.indexOf('function getOverviewBounds')
    );
    const controls = implementation.slice(
        implementation.indexOf('function addLayerControls'),
        implementation.indexOf('function addZoneControls')
    );
    assert.doesNotMatch(bounds, /\bstate\b|\bname\b|\btitle\b/);
    assert.match(controls, /state\.originalTitle = title/);
    assert.match(controls, /state\.legendInput = legendName/);
    assert.match(implementation, /function loadDefinition\(definition\)[\s\S]*?etapa: \s*\+[\s\S]*?cálculo da extensão geográfica/);
    assert.match(implementation, /Camadas carregadas com ' \+ failures\.length/);
    assert.match(implementation, /Tentar novamente/);
    assert.match(implementation, /loadLayersIndependently\(catalog, loadDefinition\)/);
});

test('layer list keeps one original name and the editable legend name, without the redundant display field', function () {
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const controls = implementation.slice(
        implementation.indexOf('function addLayerControls'),
        implementation.indexOf('function addZoneControls')
    );
    assert.match(controls, /title\.textContent = state\.originalName/);
    assert.match(controls, /legendName\.className = 'layer-legend-name'/);
    assert.match(controls, /state\.legendInput = legendName/);
    assert.doesNotMatch(controls, /className = 'layer-name'|append\(header, name\)/);
    assert.doesNotMatch(styles, /\.layer-name\s*\{/);
    assert.match(implementation, /zoneNameInput\.className = 'zone-name-input'/);
});

test('layer panel separates original, display, and legend names and supports live search', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    assert.match(page, /id="layer-search"/);
    assert.match(page, /id="clear-layer-search"/);
    assert.match(implementation, /originalName: definition\.name/);
    assert.match(implementation, /legendLabel: definition\.name/);
    assert.match(implementation, /names = \[state\.originalName, state\.label, state\.legendLabel\]/);
    assert.match(implementation, /state\.legendLabel = state\.originalName/);
    assert.match(implementation, /elements\.clearLayerSearch\.addEventListener\('click'/);
    assert.match(implementation, /item\.hidden = query && item\.dataset\.searchText\.indexOf\(query\) === -1/);
    assert.match(implementation, /names\.push\(zone\.name, zone\.displayLabel\)/);
    assert.match(implementation, /state\.zoneStyles\.forEach/);
    assert.match(implementation, /zone\.displayLabel = zoneNameInput\.value\.trim\(\) \|\| zone\.name/);
});

test('zone main layer omits aggregate style controls while individual zone controls remain', function () {
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    assert.match(implementation, /if \(!state\.zoneStyles\) \{[\s\S]*?color\.type = 'color'[\s\S]*?opacityRow/);
    assert.match(implementation, /zoneNameInput\.type = 'text'/);
    assert.match(implementation, /zone\.color = color\.value/);
    assert.match(implementation, /zone\.opacity = Number\(opacity\.value\) \/ 100/);
});

test('geographic decimal and DMS inputs validate ranges and hemispheres', function () {
    const geometry = require(path.join(ROOT, 'gerador-mapas-geometrias.js'));
    assert.deepEqual(geometry.geographicCoordinates({ latitude: '-28.5', longitude: '-48,75' }, 'decimal'), [-48.75, -28.5]);
    assert.deepEqual(geometry.geographicCoordinates({ latitude: '28 30 0 S', longitude: '48 45 0 W' }, 'dms'), [-48.75, -28.5]);
    assert.throws(function () {
        geometry.geographicCoordinates({ latitude: '91', longitude: '0' }, 'decimal');
    }, /Latitude fora/);
    assert.throws(function () {
        geometry.geographicCoordinates({ latitude: '28 60 0 N', longitude: '48 0 0 W' }, 'dms');
    }, /Minutos e segundos/);
    assert.throws(function () {
        geometry.geographicCoordinates({ latitude: '28 30 0 E', longitude: '48 0 0 W' }, 'dms');
    }, /hemisfério/);
});

test('coordinate conversion selects geographic and UTM source CRS and preserves E/N order', function () {
    const geometry = require(path.join(ROOT, 'gerador-mapas-geometrias.js'));
    const calls = [];
    function projection(source, target, coordinates) {
        calls.push({ source: source, target: target, coordinates: coordinates });
        return [-48.5, -28.2];
    }
    projection.defs = function (code, definition) {
        calls.push({ code: code, definition: definition });
    };
    assert.deepEqual(geometry.toSIRGAS2000(
        { latitude: '-28.2', longitude: '-48.5' },
        { crs: 'EPSG:4326', format: 'decimal' },
        projection
    ), [-48.5, -28.2]);
    assert.equal(calls.find(function (call) { return call.source; }).source, 'EPSG:4326');
    calls.length = 0;
    assert.deepEqual(geometry.toSIRGAS2000(
        { easting: '650000', northing: '6900000' },
        { crs: 'UTM', zone: '22', hemisphere: 'south' },
        projection
    ), [-48.5, -28.2]);
    assert.deepEqual(calls.find(function (call) { return call.coordinates; }).coordinates, [650000, 6900000]);
    assert.ok(calls.some(function (call) {
        return call.code === 'SIRGAS2000_UTM_22S' && call.definition.includes('+south');
    }));
    assert.throws(function () {
        geometry.toSIRGAS2000({ easting: '650000', northing: '6900000' },
            { crs: 'UTM', zone: '61', hemisphere: 'south' }, projection);
    }, /zona UTM/);
});

test('geographic and UTM forms render only the selected coordinate fields and clear stale values', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    assert.match(page, /value="EPSG:4674"/);
    assert.match(page, /value="EPSG:4326"/);
    assert.match(page, /value="UTM"/);
    assert.match(implementation, /if \(elements\.geometryCrs\.value === 'UTM'\)[\s\S]*?createCoordinateInput\(row, 'easting'[\s\S]*?createCoordinateInput\(row, 'northing'/);
    assert.match(implementation, /createCoordinateInput\(row, 'latitude'[\s\S]*?createCoordinateInput\(row, 'longitude'/);
    assert.match(implementation, /elements\.coordinateFormat\.hidden = isUtm/);
    assert.match(implementation, /elements\.utmOptions\.hidden = !isUtm/);
    assert.match(styles, /\.geometry-dialog \[hidden\]\s*\{\s*display:\s*none !important/s);
    assert.match(implementation, /input\.required = true/);
    const inputHelpers = implementation.slice(
        implementation.indexOf('var pointCoordinateValues'),
        implementation.indexOf('function createCoordinateInput')
    );
    assert.match(inputHelpers, /function clearGeometryInputValues\(\)/);
    assert.ok(
        implementation.indexOf('function clearGeometryInputValues') <
            implementation.indexOf('function createCoordinateInput'),
        'a limpeza dos valores deve estar no escopo compartilhado do formulário'
    );
    assert.match(implementation, /\[elements\.geometryCrs, elements\.coordinateFormat, elements\.utmZone, elements\.utmHemisphere\]/);
    assert.match(implementation, /function getPolygonCoordinates\(\)[\s\S]*?polygonVertexValues\.map/);
});

test('polygons close rings and reject too few, zero-area, and self-intersecting vertices', function () {
    const geometry = require(path.join(ROOT, 'gerador-mapas-geometrias.js'));
    const ring = geometry.closeAndValidatePolygon([[0, 0], [1, 0], [1, 1]]);
    assert.deepEqual(ring, [[0, 0], [1, 0], [1, 1], [0, 0]]);
    assert.throws(function () {
        geometry.closeAndValidatePolygon([[0, 0], [1, 1], [0, 0]]);
    }, /três vértices distintos/);
    assert.throws(function () {
        geometry.closeAndValidatePolygon([[0, 0], [1, 1], [2, 2]]);
    }, /área nula/);
    assert.throws(function () {
        geometry.closeAndValidatePolygon([[0, 0], [2, 2], [0, 2], [2, 0]]);
    }, /área nula|cruzam/);
    assert.throws(function () {
        geometry.closeAndValidatePolygon([[0, 0], [3, 3], [0, 2], [2, 0]]);
    }, /cruzam/);
});

test('manual geometry workflow includes preview, vertex editing, CRS metadata, and session-layer management', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const geometry = fs.readFileSync(path.join(ROOT, 'gerador-mapas-geometrias.js'), 'utf8');
    assert.match(page, /Adicionar ponto/);
    assert.match(page, /Adicionar polígono/);
    assert.match(implementation, /function updatePolygonPreview\(\)/);
    assert.match(geometry, /function closeAndValidatePolygon/);
    assert.match(implementation, /addLayerControls\(state\)/);
    assert.match(implementation, /sourceCrs: sourceCrs/);
    assert.match(implementation, /state\.manual/);
    assert.match(implementation, /function closeGeometryDialog\(\)/);
    assert.match(implementation, /polygonVertexValues\.push\(\{\}\)/);
    assert.match(implementation, /polygonVertexValues\.splice\(target, 0, moved\)/);
    assert.match(implementation, /polygonVertexValues\.splice\(index, 1\)/);
    assert.match(implementation, /map\.removeLayer\(previewGeometryLayer\)/);
    assert.match(implementation, /state\.sourceSettings = Object\.assign/);
});
