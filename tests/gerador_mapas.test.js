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
    assert.match(implementation, /renderScaleBar\(context, x, y, mapWidth, metersPerPixel, scaleFactor, rightInset\)[\s\S]*?mapWidth - rightInset - width/);
    assert.match(implementation, /frame\.x,[\s\S]*?frame\.y \+ frame\.height \* 0\.96 - 3\.2 \* scaleFactor,[\s\S]*?frame\.width \* 0\.05/);
    assert.match(implementation, /var northX = frame\.x \+ frame\.width \* 0\.96/);
    assert.match(implementation, /var northY = frame\.y \+ frame\.height \* 0\.075/);
    assert.match(implementation, /drawNorthArrow\(context, northX, northY, 5\.8 \* scaleFactor\)/);
    assert.doesNotMatch(implementation, /fillRect\(northX - 5 \* scaleFactor|strokeRect\(northX - 5 \* scaleFactor/);
    assert.match(implementation, /context\.rotate\(-Math\.PI \/ 2\)/);
    assert.match(implementation, /renderLegendCanvas\(context,[\s\S]*?legendMaxHeight/);
    assert.match(implementation, /mercatorMetersPerPixel\([\s\S]*?renderScaleBar/);
    assert.match(implementation, /exportTileZoom\(map\.getZoom\(\), outputRatio, 23\)/);
    assert.match(styles, /\.map-latitudes span\s*\{[^}]*rotate\(-90deg\)/s);
});

test('export requests proportionally sharper aligned imagery tiles and keeps 300 dpi page dimensions', function () {
    const geometry = require(path.join(ROOT, 'gerador-mapas-geometrias.js'));
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    assert.equal(geometry.exportTileZoom(9.8, 1, 23), 10);
    assert.equal(geometry.exportTileZoom(9.8, 2, 23), 11);
    assert.equal(geometry.exportTileZoom(9.8, 4.1, 23), 12);
    assert.equal(geometry.exportTileZoom(19, 8, 23), 22);
    assert.equal(geometry.exportTileZoom(19, 32, 23), 23);
    assert.equal(geometry.mercatorMetersPerPixel(0, 10, 1),
        156543.03392804097 / 1024);
    assert.ok(geometry.mercatorMetersPerPixel(60, 10, 1) <
        geometry.mercatorMetersPerPixel(0, 10, 1));
    assert.match(implementation, /orientation === 'portrait' \? 2480 : 3508/);
    assert.match(implementation, /orientation === 'portrait' \? 3508 : 2480/);
    assert.match(implementation, /width \/ \(orientation === 'portrait' \? 210 : 297\)/);
    assert.match(implementation, /var projectedBounds = projectBounds\(mapBounds, zoom\)/);
    assert.match(implementation, /var projection = function \(longitude, latitude\)[\s\S]*?zoom\)/);
});

test('map preview restores frame-relative furniture and gives the inset its own scale and north arrow', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const insetStart = page.indexOf('<div class="overview-frame">');
    const inset = page.slice(insetStart, page.indexOf('</section>', insetStart));
    const overviewRenderer = implementation.slice(
        implementation.indexOf('function renderOverview'),
        implementation.indexOf('function renderLegendCanvas')
    );

    assert.match(styles, /\.north-arrow\s*\{[^}]*top:\s*2\.5%;[^}]*right:\s*2\.2%/s);
    assert.match(styles, /\.preview-scale\s*\{[^}]*right:\s*5%;[^}]*bottom:\s*4%/s);
    assert.match(inset, /class="overview-north-arrow"/);
    assert.match(inset, /id="overview-scale"/);
    assert.match(styles, /\.overview-frame\s*\{[^}]*position:\s*relative/s);
    assert.match(implementation, /function updateOverviewScale\(\)[\s\S]*?var metersPerPixel = metersAcross/);
    assert.match(overviewRenderer, /drawNorthArrow\(context, x \+ width - arrowSize, y \+ arrowSize \* 1\.3, arrowSize\)/);
    assert.match(overviewRenderer, /var scalePadding = Math\.min\(width, height\) \* 0\.055/);
    assert.match(overviewRenderer, /renderScaleBar\([\s\S]*?x \+ scalePadding \* 1\.8,[\s\S]*?y \+ height - scalePadding \* 1\.8,/);
    assert.match(overviewRenderer, /GeradorGeometrias\.mercatorMetersPerPixel/);
    assert.match(overviewRenderer, /overviewMap\.getBounds\(\)/);
    assert.match(overviewRenderer, /exportTileZoom\(overviewMap\.getZoom\(\), overviewScale, 23\)/);
    assert.match(implementation, /scaleDistance\(metersPerPixel \* size\.x \* 0\.24\)/);
    assert.match(implementation, /scaleDistance\(metersPerPixel \* mapWidth \* 0\.24\)/);
    assert.match(implementation, /strokeText\('0', x, y - 2 \* scaleFactor\)/);
    assert.match(implementation, /context\.translate\(x, y\)/);
    assert.match(implementation, /context\.moveTo\(0, -size\)/);
});

test('manual point label keeps its source name without the unwanted outline', function () {
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const geometry = require(path.join(ROOT, 'gerador-mapas-geometrias.js'));

    assert.match(implementation, /GeradorGeometrias\.manualPointLabel\(state, feature\)/);
    assert.match(implementation, /layer\.bindTooltip\(label,[\s\S]*?permanent:\s*true[\s\S]*?className:\s*'manual-feature-label'/);
    const manualLabelStyles = styles.slice(
        styles.indexOf('.leaflet-tooltip.manual-feature-label'),
        styles.indexOf('.leaflet-tooltip.manual-feature-label::before')
    );
    const manualLabelRender = implementation.slice(
        implementation.indexOf('function drawLayerFeatures'),
        implementation.indexOf('function renderScaleBar')
    );
    assert.match(manualLabelStyles, /color:\s*#263238/);
    assert.doesNotMatch(manualLabelStyles, /text-stroke|paint-order|text-shadow/);
    assert.match(manualLabelRender, /context\.fillText\(label, point\.x \+ 8 \* outputRatio, point\.y\)/);
    assert.doesNotMatch(manualLabelRender, /strokeText\(label/);
    assert.match(implementation, /state\.data\.features\[0\]\.properties\.name = elements\.geometryName\.value/);
    const pointState = { manual: true, originalName: 'Marco costeiro' };
    assert.equal(geometry.manualPointLabel(pointState, {
        properties: { name: 'Marco costeiro' },
        geometry: { type: 'Point', coordinates: [-48.7, -28.2] }
    }), 'Marco costeiro');
    assert.equal(geometry.manualPointLabel({ manual: false, originalName: 'Ponto original' }, {
        properties: { name: 'Ponto original' },
        geometry: { type: 'Point', coordinates: [-48.7, -28.2] }
    }), '');
    ['LineString', 'Polygon', 'MultiPoint'].forEach(function (type) {
        assert.equal(geometry.manualPointLabel(pointState, {
            properties: { name: 'Rótulo que não é de ponto' },
            geometry: { type: type, coordinates: [] }
        }), '');
    });
});

test('legend symbol classification is shared by preview and export', function () {
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const geometry = require(path.join(ROOT, 'gerador-mapas-geometrias.js'));
    const canvasLegend = implementation.slice(
        implementation.indexOf('function renderLegendCanvas'),
        implementation.indexOf('function renderPortraitPanel')
    );

    assert.equal(geometry.geometrySymbolType('Point'), 'point');
    assert.equal(geometry.geometrySymbolType('MultiPoint'), 'point');
    assert.equal(geometry.geometrySymbolType('LineString'), 'line');
    assert.equal(geometry.geometrySymbolType('MultiLineString'), 'line');
    assert.equal(geometry.geometrySymbolType('Polygon'), 'polygon');
    assert.equal(geometry.geometrySymbolType('MultiPolygon'), 'polygon');
    assert.match(implementation, /geometrySymbolType\(state\.definition\.geometry\) \|\| 'polygon'/);
    assert.match(implementation, /geometrySymbolType\(type\) \|\| 'polygon'/);
    assert.match(canvasLegend, /entry\.geometry === 'point'/);
    assert.match(canvasLegend, /entry\.geometry === 'line'/);
});

test('legend outlines remain geometry-specific and print strokes stay proportional to preview', function () {
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const canvasLegend = implementation.slice(
        implementation.indexOf('function renderLegendCanvas'),
        implementation.indexOf('function renderPortraitPanel')
    );
    assert.match(styles, /\.legend-symbol\s*\{[^}]*border:\s*1px solid #333/s);
    assert.match(styles, /\.legend-symbol\.is-line\s*\{[^}]*border:\s*0/s);
    assert.match(styles, /\.legend-symbol\.is-point\s*\{[^}]*border-radius:\s*50%/s);
    assert.match(canvasLegend, /lineWidth = Math\.max\(1, scaleFactor \* 0\.18\)/);
    assert.doesNotMatch(canvasLegend, /scaleFactor \* 0\.65/);
});

test('title background follows wrapped text in preview and exported layouts', function () {
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    assert.match(styles, /\.preview-title-block\s*\{[^}]*width:\s*fit-content[^}]*max-width:\s*100%/s);
    assert.match(styles, /padding:\s*calc\(2\.5% \+ 9\.45px\)\s+2\.5%/);
    assert.match(implementation, /function drawTitleBlock\([\s\S]*?var blockWidth = Math\.min\(width, measuredWidth \+ horizontalPadding \* 2\)/);
    assert.match(implementation, /var verticalPadding = 3\.5 \* scaleFactor/);
    assert.match(implementation, /lines\.length \* effectiveLineHeight \+ 2 \* verticalPadding/);
    assert.match(implementation, /drawTitleBlock\([\s\S]*?elements\.title\.value\.trim\(\) \|\| 'Mapa sem título'/);
});

test('generator access gate validates the password before starting map features', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const accessSource = fs.readFileSync(path.join(ROOT, 'gerador-mapas-acesso.js'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const elements = {
        'generator-access-form': { addEventListener: function (type, handler) { this.submit = handler; } },
        'generator-password': { value: '', focus: function () {} },
        'generator-access': { hidden: false },
        'generator-access-error': { hidden: true, textContent: '' }
    };
    const context = {
        document: {
            getElementById: function (id) { return elements[id]; },
            body: { classList: { add: function (name) { context.unlockedClass = name; } } }
        },
        window: {}
    };
    vm.runInNewContext(accessSource, context);
    let starts = 0;
    context.window.GeradorMapasAcesso.requirePassword(function () { starts += 1; });

    elements['generator-password'].value = 'incorreta';
    elements['generator-access-form'].submit({ preventDefault: function () {} });
    assert.equal(starts, 0);
    assert.equal(elements['generator-access'].hidden, false);
    assert.equal(elements['generator-access-error'].hidden, false);
    assert.match(elements['generator-access-error'].textContent, /Senha incorreta/);
    assert.equal(elements['generator-password'].value, '');

    elements['generator-password'].value = 'baleialivre';
    elements['generator-access-form'].submit({ preventDefault: function () {} });
    assert.equal(starts, 1);
    assert.equal(elements['generator-access'].hidden, true);
    assert.equal(elements['generator-access-error'].hidden, true);
    assert.equal(elements['generator-password'].value, '');
    assert.equal(context.unlockedClass, 'generator-unlocked');
    assert.match(page, /id="generator-access-form"/);
    assert.match(page, /site estático[^<]*não protege o código nem os dados/);
    assert.match(styles, /body:not\(\.generator-unlocked\) > \.generator-layout/);
    assert.match(implementation, /GeradorMapasAcesso\.requirePassword\(start\)/);
});

test('institutional content uses the corrected whale and partial-municipality text', function () {
    const whalePage = fs.readFileSync(path.join(ROOT, 'baleia-franca.html'), 'utf8');
    const apaPage = fs.readFileSync(path.join(ROOT, 'sobre-apa.html'), 'utf8');
    assert.doesNotMatch(whalePage, /<h3>Turismo de Observação de Baleias<\/h3>/);
    assert.doesNotMatch(whalePage, /O turismo de observação de baleias tem crescido significativamente na região desde 1999/);
    assert.match(apaPage, /abrange parcialmente os territórios dos seguintes municípios de Santa Catarina/);
    const municipalitySection = apaPage.slice(apaPage.indexOf('<h2>Municípios Abrangidos</h2>'), apaPage.indexOf('<h2>Contato</h2>'));
    assert.deepEqual(
        Array.from(municipalitySection.matchAll(/<li>(.*?)<\/li>/g), function (match) { return match[1]; }),
        ['Florianópolis', 'Palhoça', 'Paulo Lopes', 'Garopaba', 'Imbituba', 'Laguna', 'Jaguaruna', 'Balneário Rincão']
    );
});

test('the APABF boundary preview and export both use the selected layer color', function () {
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const featureStyles = implementation.slice(
        implementation.indexOf('function featureStyle'),
        implementation.indexOf('function createLeafletLayer')
    );
    const exportDrawing = implementation.slice(
        implementation.indexOf('function drawLayerFeatures'),
        implementation.indexOf('function renderScaleBar')
    );
    assert.match(featureStyles, /color:\s*layerStrokeColor\(state, color\)/);
    const helperSource = implementation.match(/function layerStrokeColor\(state, color\)\s*\{[^}]+\}/)[0];
    const layerStrokeColor = vm.runInNewContext('(' + helperSource + ')');
    assert.equal(layerStrokeColor({ id: 'limite-apabf', definition: { stroke: '#fixed' } }, '#selected'), '#selected');
    assert.equal(layerStrokeColor({ id: 'other-layer', definition: { stroke: '#fixed' } }, '#selected'), '#fixed');
    assert.match(exportDrawing, /layerStrokeColor\(state, color\)/);
    assert.match(implementation, /function refreshLayer\(state\)[\s\S]*?state\.layer = createLeafletLayer\(state\)[\s\S]*?updateMapComposition\(\)/);
});

test('file import stays anchored to its visible control and preserves existing layers', function () {
    const page = fs.readFileSync(path.join(ROOT, 'gerador-mapas.html'), 'utf8');
    const styles = fs.readFileSync(path.join(ROOT, 'gerador-mapas.css'), 'utf8');
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const geometry = fs.readFileSync(path.join(ROOT, 'gerador-mapas-geometrias.js'), 'utf8');
    assert.match(page, /id="file-import"[^>]*multiple/);
    assert.match(page, /<label id="import-files" class="import-label">[\s\S]*?<input id="file-import" class="import-file-input" type="file"/);
    assert.match(styles, /\.import-file-input\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*opacity:\s*0/s);
    assert.doesNotMatch(page, /id="file-import"[^>]*(?:tabindex="-1"|aria-hidden="true"|visually-hidden)/);
    assert.doesNotMatch(implementation, /fileImport\.click\(\)|openImportPicker|restoreImportPanelScroll|fileImport\.addEventListener\('cancel'/);
    assert.match(implementation, /mergeLayerStates\(loadedStates, states\)/);
    assert.match(geometry, /function mergeLayerStates\(loadedStates, existingStates\)/);
    assert.match(implementation, /function addLayerControls\(state\)[\s\S]*?elements\.layerList\.appendChild\(item\)/);
    assert.match(implementation, /function parseKml\(text, filename\)/);
    assert.match(implementation, /window\.JSZip\.loadAsync\(buffer\)/);
    assert.match(implementation, /candidates\[0\]\.async\('text'\)/);
    assert.match(implementation, /id: 'importado-' \+ Date\.now\(\) \+ '-' \+ \(\+\+manualSequence\)/);
    assert.match(implementation, /fileImport\.addEventListener\('change', processSelectedFiles\)/);
    assert.match(implementation, /files\.reduce\(function \(queue, file\)/);
    assert.match(implementation, /states\.filter\(function \(candidate\) \{ return candidate !== state; \}\)/);
    const importBody = implementation.slice(
        implementation.indexOf('function importLocalFile'),
        implementation.indexOf('function processSelectedFiles')
    );
    assert.ok(importBody.indexOf('readKmlFile(file)') < importBody.indexOf('states.push(state)'));
    assert.match(importBody, /if \(state\.item\) \{\s*state\.item\.remove\(\)/);
});

test('the APABF boundary stays above official fills in preview and export', function () {
    const implementation = fs.readFileSync(path.join(ROOT, 'gerador-mapas.js'), 'utf8');
    const layerOrder = implementation.slice(
        implementation.indexOf('function layerDisplayRank'),
        implementation.indexOf('function updateMapComposition')
    );
    const drawing = implementation.slice(
        implementation.indexOf('function drawLayerFeatures'),
        implementation.indexOf('function renderScaleBar')
    );

    assert.match(layerOrder, /state\.id === 'limite-apabf'\)\s*\{\s*return 1/);
    assert.match(layerOrder, /state\.id\.indexOf\('importado-'\) === 0 \? 2 : 0/);
    assert.match(layerOrder, /state\.layer\.bringToFront\(\)/);
    assert.match(drawing, /sortLayerStates\(states\.filter/);
    assert.match(implementation, /function updateMapComposition\(\)\s*\{\s*if \(map\) \{\s*updateMapLayerOrder\(\)/);
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
    assert.match(implementation, /stage = 'cálculo da extensão geográfica'/);
    assert.match(implementation, /etapa: '\s*\+\s*stage/);
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
