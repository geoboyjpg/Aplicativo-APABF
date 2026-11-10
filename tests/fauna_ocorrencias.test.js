'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MAP_PAGE = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'index.html');
const MAP_SCRIPT = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'js', 'fauna-ocorrencias.js');
const MAP_INTERFACE = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'js', 'fauna-mapa-interface.js');
const MAP_SEARCH = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'js', 'fauna-buscas.js');
const MAP_STYLES = path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'css', 'fauna-ocorrencias.css');
const MAP_DATA = path.join(
    ROOT,
    'Ocorrencias de Fauna Registradas',
    'data',
    'ocorrencias-fauna-2015-2025.js'
);

function readMapCollection() {
    const source = fs.readFileSync(MAP_DATA, 'utf8');
    return JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
}

function readYearDetails(year) {
    const sourcePath = path.join(
        ROOT,
        'Ocorrencias de Fauna Registradas',
        'data',
        'fauna-detalhes-' + year + '.js'
    );
    const source = fs.readFileSync(sourcePath, 'utf8');
    const assignment = 'window.FaunaOccurrenceDetailsData[' + JSON.stringify(String(year)) + '] = ';
    return JSON.parse(source.slice(source.indexOf(assignment) + assignment.length).trim().replace(/;\s*$/, ''));
}

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
    assert.match(mapPage, /src="data\/ocorrencias-fauna-2015-2025\.js"/);
    assert.match(mapPage, /Não exibir novamente durante esta sessão/);
    assert.match(mapPage, /As fotografias apresentadas possuem finalidade ilustrativa/);
});

test('clusters use a smaller zoom-sensitive radius and retain spiderfy for overlapping points', function () {
    const mapPage = fs.readFileSync(MAP_PAGE, 'utf8');

    assert.match(mapPage, /maxClusterRadius:\s*function\s*\(zoom\)/);
    assert.match(mapPage, /radius:\s*5\.0/);
    assert.match(mapPage, /if \(zoom >= 16\) return 12/);
    assert.match(mapPage, /if \(zoom >= 13\) return 20/);
    assert.match(mapPage, /if \(zoom >= 10\) return 30/);
    assert.match(mapPage, /return 38/);
    assert.match(mapPage, /spiderfyOnMaxZoom:\s*true/);
    assert.match(mapPage, /zoomToBoundsOnClick:\s*true/);
    assert.match(mapPage, /chunkedLoading:\s*true/);
    assert.match(mapPage, /cluster_OcorrnciasdeFaunaindividual_1\.addLayers\([\s\S]*?layer_OcorrnciasdeFaunaindividual_1\.getLayers\(\)/);
    assert.doesNotMatch(mapPage, /disableClusteringAtZoom:\s*\d+/);
});

test('filter controls use source fields and only update clusters when submitted', function () {
    const interfaceScript = fs.readFileSync(MAP_INTERFACE, 'utf8');
    const collection = readMapCollection();
    const propertyNames = new Set();
    collection.features.forEach(function (feature) {
        Object.keys(feature.properties).forEach(function (field) {
            propertyNames.add(field);
        });
    });

    [
        'Espécies - Espécie',
        'OFAI - Espécie do indivíduo',
        'Necropsia - Espécie do indivíduo',
        'Nome Popular',
        'Espécies - Classe',
        'Data/Hora',
        'Data',
        'Cidade',
        'Trecho',
        'Instituição executora',
        'Condição',
        'OFAI - Sexo',
        'Necropsia - Sexo',
        'Estágio de desenvolvimento',
        'OFAI - Estágio de desenvolvimento',
        'Espécie ameaçada'
    ].forEach(function (field) {
        assert.ok(propertyNames.has(field), 'missing source field: ' + field);
        assert.match(interfaceScript, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    assert.match(interfaceScript, /filterForm\.addEventListener\('submit'/);
    assert.match(interfaceScript, /cluster\.clearLayers\(\)/);
    assert.match(interfaceScript, /cluster\.addLayers/);
    assert.match(interfaceScript, /Nenhuma ocorrência corresponde à pesquisa/);
    assert.match(interfaceScript, /faunaSearch\.matches\(properties, filterFields\.species, filters\.species\)/);
    assert.match(interfaceScript, /faunaSearch\.matches\(properties, filterFields\.common, filters\.commonName\)/);
    assert.match(interfaceScript, /filterFields\.institution, filters\.institution/);
    assert.match(interfaceScript, /occurrenceDate < filters\.dateFrom/);
    assert.match(fs.readFileSync(MAP_SEARCH, 'utf8'), /event\.key === 'ArrowDown'/);
    assert.match(fs.readFileSync(MAP_SEARCH, 'utf8'), /event\.key === 'Enter'/);
    assert.match(fs.readFileSync(MAP_SEARCH, 'utf8'), /event\.key === 'ArrowUp'/);
    assert.match(fs.readFileSync(MAP_SEARCH, 'utf8'), /event\.key === 'Escape'/);
});

test('scientific and common-name autocomplete are independent and use all occurrence records', function () {
    const mapPage = fs.readFileSync(MAP_PAGE, 'utf8');
    const interfaceScript = fs.readFileSync(MAP_INTERFACE, 'utf8');
    const collection = readMapCollection();
    const records = collection.features.map(function (feature) {
        return feature.properties;
    });
    const institutions = new Set(records.map(function (properties) {
        return properties['Instituição executora'];
    }).filter(Boolean));
    const individualIds = records.map(function (properties) {
        return properties['Identificador do indivíduo'];
    });

    assert.match(mapPage, /role="combobox"/);
    assert.match(mapPage, /role="listbox"/);
    assert.match(mapPage, /Buscar por nome científico/);
    assert.match(mapPage, /Buscar por nome popular/);
    assert.match(mapPage, /fauna-common-name-suggestions/);
    assert.match(mapPage, /fauna-filter-institution/);
    assert.match(interfaceScript, /fields: filterFields\.species/);
    assert.match(interfaceScript, /fields: filterFields\.common/);
    assert.match(interfaceScript, /commonNameSearch\.clear\(\)/);
    assert.equal(collection.features.length, 27476);
    assert.equal(institutions.size, 6);
    assert.deepEqual([...institutions].sort(), [
        'PBF - Instituto Australis',
        'R3 ANIMAL',
        'Trecho 01',
        'Trecho 02',
        'Trecho 03',
        'UDESC'
    ]);
    assert.equal(individualIds.length, 27476);
    assert.ok(individualIds.every(function (identifier) {
        return identifier !== null && identifier !== undefined && String(identifier).trim() !== '';
    }));
    assert.equal(new Set(individualIds.map(String)).size, individualIds.length);
    assert.equal(records.filter(function (properties) {
        return !properties['Espécies - Espécie'];
    }).length, 721);
    assert.ok(collection.features.every(function (feature) {
        const [longitude, latitude] = feature.geometry.coordinates;
        return longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
    }));
});

test('lazy detail partitions preserve every occurrence and original source attribute', function () {
    const collection = readMapCollection();
    const mapIds = new Set(collection.features.map(function (feature) {
        return String(feature.properties['Identificador da ocorrência']);
    }));
    const detailIds = new Set();
    let detailCount = 0;

    for (let year = 2015; year <= 2025; year += 1) {
        const detail = readYearDetails(year);
        assert.ok(detail.fields.includes('Fotos'));
        assert.ok(detail.fields.includes('Nome Popular'));
        assert.ok(detail.fields.includes('Espécies - Espécie'));
        Object.keys(detail.records).forEach(function (id) {
            const values = detail.records[id];
            assert.equal(values.length, detail.fields.length);
            assert.ok(!detailIds.has(id), 'duplicate detail record: ' + id);
            detailIds.add(id);
            detailCount += 1;
        });
    }

    assert.equal(detailCount, 27476);
    assert.deepEqual(detailIds, mapIds);
});

test('search suggestions and filters match only their own field and normalize accents and case', function () {
    const search = require(MAP_SEARCH);
    const records = [
        { properties: { scientific: 'Chelonia mydas', common: 'Tartaruga-verde' } },
        { properties: { scientific: 'chelONia MYDAS', common: 'Tartaruga-verde' } },
        { properties: { scientific: 'Spheniscus magellanicus', common: 'Pinguim-de-Magalhães' } }
    ];
    const scientific = search.buildSuggestions(records, ['scientific']);
    const popular = search.buildSuggestions(records, ['common']);

    assert.deepEqual(scientific.map(function (item) { return item.label; }), [
        'Chelonia mydas',
        'Spheniscus magellanicus'
    ]);
    assert.deepEqual(popular.map(function (item) { return item.label; }), [
        'Pinguim-de-Magalhães',
        'Tartaruga-verde'
    ]);
    assert.equal(search.matches(records[0].properties, ['scientific'], {
        query: 'tartaruga',
        selected: null
    }), false);
    assert.equal(search.matches(records[0].properties, ['common'], {
        query: 'chelonia',
        selected: null
    }), false);
    assert.equal(search.matches(records[2].properties, ['common'], {
        query: 'pinguim-de-magalhaes',
        selected: null
    }), true);
    assert.equal(search.matches(records[1].properties, ['scientific'], {
        query: 'Chelonia MYDAS',
        selected: 'chelonia mydas'
    }), true);
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
    assert.match(helper, /imageLink\.hidden = true/);
    assert.match(helper, /fauna-gallery__error/);
    assert.match(helper, /Fotografia ilustrativa indisponível para esta espécie\./);
    assert.match(helper, /Imagem ilustrativa da espécie – não corresponde necessariamente ao indivíduo registrado\./);
});

test('SIMBA photos are occurrence-specific and require explicit consent before loading', function () {
    const helper = fs.readFileSync(MAP_SCRIPT, 'utf8');
    const manifest = fs.readFileSync(
        path.join(ROOT, 'Ocorrencias de Fauna Registradas', 'data', 'fotos-individuos-autorizadas.js'),
        'utf8'
    );
    const styles = fs.readFileSync(MAP_STYLES, 'utf8');

    assert.match(helper, /Identificador da ocorrência/);
    assert.match(helper, /Identificador do indivíduo/);
    assert.match(helper, /global\.FaunaOccurrencePhotos/);
    assert.match(helper, /entry\.authorized === true/);
    assert.match(helper, /String\(entry\.occurrenceId \|\| ''\) === occurrenceId/);
    assert.match(helper, /String\(entry\.individualId \|\| ''\) === individualId/);
    assert.match(helper, /Registro fotográfico do indivíduo – SIMBA/);
    assert.match(helper, /Algumas fotografias podem apresentar animais mortos, feridos, em decomposição ou submetidos a procedimentos de atendimento e análise\./);
    assert.match(helper, /'Ver fotografia'/);
    assert.match(helper, /'Visualizar fotografia'/);
    assert.match(helper, /'Cancelar'/);
    assert.match(helper, /confirmButton\.addEventListener\('click', function \(\) \{[\s\S]*?selectIndividualIndex\(0\);/);
    assert.match(helper, /'Ocultar fotografia'/);
    assert.match(helper, /Não foi possível carregar a fotografia do SIMBA/);
    assert.match(helper, /'Tentar novamente'/);
    assert.match(helper, /Fotografias ilustrativas da espécie – iNaturalist/);
    assert.match(helper, /Ampliar fotografia em uma nova guia/);
    assert.match(helper, /Origem da fotografia/);
    assert.match(manifest, /Object\.create\(null\)/);
    assert.match(manifest, /FaunaOccurrencePhotos/);
    assert.match(manifest, /Key by occurrence ID/);
    assert.doesNotMatch(manifest, /https?:\/\//);
    assert.match(styles, /fauna-individual-photos__confirmation\[hidden\]/);
    assert.match(styles, /fauna-individual-photos__viewer\[hidden\]/);
});

test('record details retain source attribute names and represent empty values', function () {
    const helper = fs.readFileSync(MAP_SCRIPT, 'utf8');

    assert.match(helper, /loadOccurrenceDetails/);
    assert.match(helper, /data\/fauna-detalhes-/);
    assert.match(helper, /Object\.keys\(properties\)\.forEach/);
    assert.match(helper, /if \(key === 'fid'\)/);
    assert.match(helper, /isEmpty\(properties\[key\]\) \? 'Não informado'/);
    assert.match(helper, /map-popup__table-wrapper fauna-record-table-wrapper/);
    assert.match(helper, /Ver mais informações/);
    assert.match(helper, /event\.key === 'Escape'/);
});
