'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MAP_PAGES = [
    'Ocorrencias de Fauna/index.html',
    'Trilha Caminhos da Baleia Franca/index.html',
    'Legislação Pesqueira/index.html',
    'Zoneamento APABF/index.html',
    'Fiscalização/index.html'
];

test('interactive maps use the shared navbar implementation and stylesheet', function () {
    const sharedNavCss = fs.readFileSync(path.join(ROOT, 'nav.css'), 'utf8');
    assert.match(sharedNavCss, /\.nav-bar\s*\{[^}]*box-sizing:\s*border-box\s*!important/s);
    assert.match(sharedNavCss, /\.nav-bar \.nav-btn-label\s*\{[^}]*white-space:\s*normal\s*!important/s);
    MAP_PAGES.forEach(function (relativePage) {
        const pagePath = path.join(ROOT, relativePage);
        const html = fs.readFileSync(pagePath, 'utf8');
        const pageDirectory = path.dirname(pagePath);

        assert.match(html, /<nav class="nav-bar"[^>]*><\/nav>/, relativePage);
        assert.match(html, /<script src="\.\.\/nav\.js" data-base="\.\."><\/script>/, relativePage);
        assert.match(html, /<link rel="stylesheet" href="\.\.\/nav\.css">/, relativePage);
        assert.ok(fs.existsSync(path.join(pageDirectory, '..', 'nav.js')), relativePage);
        assert.ok(fs.existsSync(path.join(pageDirectory, '..', 'nav.css')), relativePage);
    });
});

test('all maps with an initial popup apply the shared popup components', function () {
    MAP_PAGES.forEach(function (relativePage) {
        const pagePath = path.join(ROOT, relativePage);
        const html = fs.readFileSync(pagePath, 'utf8');
        const pageDirectory = path.dirname(pagePath);
        assert.match(html, /<body class="map-ui">/, relativePage);
        assert.match(html, /class="map-popup-overlay"/, relativePage);
        assert.match(html, /class="map-popup map-popup--modal map-popup--welcome"/, relativePage);
        assert.match(html, /<h2[^>]*class="[^"]*map-popup__title--modal/, relativePage);
        assert.match(html, /href="\.\.\/map-components\.css"/, relativePage);
        assert.ok(fs.existsSync(path.join(pageDirectory, '..', 'map-components.css')), relativePage);
    });
});

test('fauna navigation no longer carries conflicting local navbar rules or markup', function () {
    const html = fs.readFileSync(path.join(ROOT, 'Ocorrencias de Fauna', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /\.nav-bar\s*\{|\.nav-btn\s*\{/);
    assert.match(html, /class="nav-bar" aria-label="Navegação principal"><\/nav>/);
    assert.match(html, /src="\.\.\/nav\.js" data-base="\.\."/);
    assert.match(html, /all\.min\.css/);
});

test('shared navigation displays the updated labels without changing their destinations', function () {
    const navigation = fs.readFileSync(path.join(ROOT, 'nav.js'), 'utf8');
    const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    assert.match(navigation, /href: base \+ 'Ocorrencias de Fauna\/index\.html', icon: 'fa-camera', label: 'Registros'/);
    assert.match(navigation, /href: base \+ 'Legislação Pesqueira\/index\.html', icon: 'fa-gavel', label: 'Legislação'/);
    assert.doesNotMatch(navigation, /label: 'Ocorrências'|label: 'Instrumentos Legais'/);
    assert.match(homepage, /<span class="nav-btn-label">Registros<\/span>/);
    assert.match(homepage, /<span class="nav-btn-label">Legislação<\/span>/);
});

test('general environmental laws are separate official external links', function () {
    const page = fs.readFileSync(path.join(ROOT, 'Legislação Pesqueira', 'index.html'), 'utf8');
    const section = page.slice(
        page.indexOf('class="environmental-legislation"'),
        page.indexOf('</section>', page.indexOf('class="environmental-legislation"'))
    );

    assert.match(section, /Legislação ambiental geral/);
    assert.match(section, /Lei nº 9\.605\/1998 — Crimes Ambientais/);
    assert.match(section, /Decreto nº 6\.514\/2008 — Infrações Ambientais/);
    assert.match(section, /href="https:\/\/www\.planalto\.gov\.br\/ccivil_03\/leis\/l9605\.htm" target="_blank" rel="noopener noreferrer"/);
    assert.match(section, /href="https:\/\/www\.planalto\.gov\.br\/ccivil_03\/_ato2007-2010\/2008\/decreto\/d6514\.htm" target="_blank" rel="noopener noreferrer"/);
});

test('both location controls use one fresh geolocation and spatial-query routine', function () {
    const interfaceScript = fs.readFileSync(
        path.join(ROOT, 'Legislação Pesqueira', 'js', 'instrumentos-interface.js'),
        'utf8'
    );

    assert.equal((interfaceScript.match(/getCurrentPosition\(/g) || []).length, 1);
    assert.match(interfaceScript, /btnCentralizar'\)\.addEventListener\('click', function \(\) \{\s*requestCurrentLocation\('map'\);/);
    assert.match(interfaceScript, /initialLocationButton\.addEventListener\('click', function \(\) \{[\s\S]*?requestCurrentLocation\('welcome'\);/);
    assert.match(interfaceScript, /var latlng = global\.L\.latLng\(coordinates\.latitude, coordinates\.longitude\);[\s\S]*?legalLayers\.queryLocation\(latlng, accuracy\)/);
    assert.match(interfaceScript, /maximumAge:\s*0/);
});

test('trail map shares the homepage navigation icon library and removes local popup sizing overrides', function () {
    const page = fs.readFileSync(
        path.join(ROOT, 'Trilha Caminhos da Baleia Franca', 'index.html'),
        'utf8'
    );
    const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(homepage, /font-awesome\/6\.4\.0\/css\/all\.min\.css/);
    assert.match(page, /font-awesome\/6\.4\.0\/css\/all\.min\.css/);
    assert.match(page, /<script src="\.\.\/nav\.js" data-base="\.\."><\/script>/);
    assert.doesNotMatch(
        fs.readFileSync(
            path.join(ROOT, 'Trilha Caminhos da Baleia Franca', 'css', 'trilhas-interface.css'),
            'utf8'
        ),
        /trail-welcome-card|\.trail-welcome\s*\{/
    );
    assert.match(page, /class="map-popup map-popup--modal map-popup--welcome"/);
    assert.match(page, /Explore trilhas localizadas na Área de Proteção Ambiental da Baleia Franca e conheça caminhos que conectam paisagens naturais, comunidades e o patrimônio ambiental da região/s);
    assert.match(page, /<h3 class="map-popup__subtitle">Como utilizar o mapa<\/h3>/);
    assert.match(page, /<ul class="map-popup__list">/);
    assert.match(page, /use “Como chegar” para abrir o destino em um aplicativo externo, quando disponível/s);
    assert.match(page, /id="btnExplorarMapa" class="map-ui-button map-ui-button--primary"/);
});
