'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MAP_PAGE = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'index.html');
const MAP_SCRIPT = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'js', 'fauna-ocorrencias.js');
const MAP_INTERFACE = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'js', 'fauna-mapa-interface.js');
const MAP_STYLES = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'css', 'fauna-ocorrencias.css');

test('fauna occurrence map reuses the shared map UI and is available under Services', function () {
    const mapPage = fs.readFileSync(MAP_PAGE, 'utf8');
    const servicesPage = fs.readFileSync(path.join(ROOT, 'servicos.html'), 'utf8');

    assert.match(mapPage, /<body class="map-ui">/);
    assert.match(mapPage, /href="\.\.\/map-components\.css"/);
    assert.match(mapPage, /src="js\/fauna-ocorrencias\.js"/);
    assert.match(servicesPage, /Ocorrências de Fauna do PMP/);
    assert.match(servicesPage, /href="Ocorrencias de Fauna Registradas\/index\.html"/);
});

test('fauna map uses the shared navigation and welcome modal patterns', function () {
    const mapPage = fs.readFileSync(MAP_PAGE, 'utf8');

    assert.match(mapPage, /href="\.\.\/nav\.css"/);
    assert.match(mapPage, /<nav class="nav-bar" aria-label="Navegação principal"><\/nav>/);
    assert.match(mapPage, /<script src="\.\.\/nav\.js" data-base="\.\."><\/script>/);
    assert.match(mapPage, /data-tab="info"[\s\S]*Informações/);
    assert.match(mapPage, /data-tab="ajuda"[\s\S]*Ajuda/);
    assert.match(mapPage, /data-tab="pesquisa"[\s\S]*Pesquisa/);
    assert.match(mapPage, /Mapa de Ocorrências de Fauna – PMP/);
    assert.match(mapPage, /Não exibir novamente durante esta sessão/);
    assert.match(mapPage, /As fotografias apresentadas possuem finalidade ilustrativa/);
});

test('clusters use a smaller zoom-sensitive radius and retain spiderfy for overlapping points', function () {
    const mapPage = fs.readFileSync(MAP_PAGE, 'utf8');

    assert.match(mapPage, /maxClusterRadius:\s*function\s*\(zoom\)/);
    assert.match(mapPage, /if \(zoom >= 16\) return 20/);
    assert.match(mapPage, /if \(zoom >= 13\) return 28/);
    assert.match(mapPage, /if \(zoom >= 10\) return 38/);
    assert.match(mapPage, /return 45/);
    assert.match(mapPage, /spiderfyOnMaxZoom:\s*true/);
    assert.match(mapPage, /zoomToBoundsOnClick:\s*true/);
    assert.doesNotMatch(mapPage, /disableClusteringAtZoom:\s*\d+/);
});

test('filter controls use source fields and only update clusters when submitted', function () {
    const interfaceScript = fs.readFileSync(MAP_INTERFACE, 'utf8');
    const sourceScript = fs.readFileSync(
        path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'data', 'OcorrnciasdeFaunaindividual_1.js'),
        'utf8'
    );
    const serialized = sourceScript.slice(sourceScript.indexOf('=') + 1).trim().replace(/;\s*$/, '');
    const collection = JSON.parse(serialized);
    const propertyNames = Object.keys(collection.features[0].properties);

    [
        'Espécies - Espécie',
        'Nome Popular',
        'Espécies - Classe',
        'Data/Hora',
        'Data',
        'Cidade',
        'Trecho',
        'Condição',
        'OFAI - Sexo',
        'Necropsia - Sexo',
        'Estágio de desenvolvimento',
        'OFAI - Estágio de desenvolvimento',
        'Espécie ameaçada'
    ].forEach(function (field) {
        assert.ok(propertyNames.includes(field), 'missing source field: ' + field);
        assert.match(interfaceScript, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    assert.match(interfaceScript, /filterForm\.addEventListener\('submit'/);
    assert.match(interfaceScript, /cluster\.clearLayers\(\)/);
    assert.match(interfaceScript, /cluster\.addLayers/);
    assert.match(interfaceScript, /Nenhuma ocorrência corresponde à pesquisa/);
    assert.match(interfaceScript, /includes\(filters\.scientific\)/);
    assert.match(interfaceScript, /includes\(filters\.common\)/);
    assert.match(interfaceScript, /occurrenceDate < filters\.dateFrom/);
});

test('record modal uses a split desktop layout and stacks on small screens', function () {
    const helper = fs.readFileSync(MAP_SCRIPT, 'utf8');
    const styles = fs.readFileSync(MAP_STYLES, 'utf8');

    assert.match(helper, /fauna-record-modal__content/);
    assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\)\s+minmax\(0, 1fr\)/);
    assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?flex-direction:\s*column/);
    assert.match(styles, /fauna-record-table-wrapper[\s\S]*?overflow:\s*auto/);
});

test('iNaturalist lookups require research-grade live community identifications', function () {
    const helper = fs.readFileSync(MAP_SCRIPT, 'utf8');

    assert.match(helper, /photo_license:\s*'cc0,cc-by,cc-by-sa'/);
    assert.match(helper, /quality_grade:\s*'research'/);
    assert.match(helper, /identifications:\s*'most_agree'/);
    assert.match(helper, /term_id:\s*String\(lifeStatusTermId\)/);
    assert.match(helper, /term_value_id:\s*String\(aliveTermValueId\)/);
    assert.match(helper, /lifeStatusTermId = 17/);
    assert.match(helper, /aliveTermValueId = 18/);
    assert.match(helper, /identifications_most_agree === true/);
    assert.match(helper, /community_taxon_id\) === Number\(taxon\.id\)/);
    assert.match(helper, /observation\.captive === false/);
    assert.match(helper, /statusAnnotations\.length > 0/);
    assert.match(helper, /controlled_value_id\) === aliveTermValueId/);
    assert.match(helper, /inaturalist-open-data\.s3\.amazonaws\.com/);
    assert.match(helper, /'cc-by-sa':[\s\S]*priority: 1/);
    assert.match(helper, /https:\/\/www\.inaturalist\.org\/observations\//);
    assert.match(helper, /attribution: \(observation\.user && \(observation\.user\.name \|\| observation\.user\.login\)\)/);
    assert.match(helper, /Crédito do fotógrafo\/observador:/);
    assert.match(helper, /Licença:/);
    assert.match(helper, /localStorage/);
    assert.match(helper, /pendingRequests/);
    assert.match(helper, /1100 - \(Date\.now\(\) - lastRequestAt\)/);
});

test('photo gallery prefers distinct observations and lazy-loads each selected image', function () {
    const helper = fs.readFileSync(MAP_SCRIPT, 'utf8');

    assert.match(helper, /distinctObservations\.slice\(0, 5\)/);
    assert.match(helper, /candidates\.push\(\{[\s\S]*?\}\);\s*return candidates;/);
    assert.match(helper, /gallery\.length > 1/);
    assert.match(helper, /fauna-gallery__arrow--previous/);
    assert.match(helper, /fauna-gallery__arrow--next/);
    assert.match(helper, /\(index \+ 1\) \+ ' de ' \+ gallery\.length/);
    assert.match(helper, /selectIndex\(0\)/);
    assert.match(helper, /image\.src = photo\.imageUrl/);
    assert.match(helper, /Fotografia ilustrativa indisponível para esta espécie\./);
});

test('record details retain source attribute names and represent empty values', function () {
    const helper = fs.readFileSync(MAP_SCRIPT, 'utf8');

    assert.match(helper, /Object\.keys\(properties\)\.forEach/);
    assert.match(helper, /if \(key === 'fid'\)/);
    assert.match(helper, /isEmpty\(properties\[key\]\) \? 'Não informado'/);
    assert.match(helper, /map-popup__table-wrapper fauna-record-table-wrapper/);
    assert.match(helper, /Ver mais informações/);
    assert.match(helper, /event\.key === 'Escape'/);
});
