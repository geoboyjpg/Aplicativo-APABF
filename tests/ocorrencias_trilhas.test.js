'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const OCCURRENCES_PATH = path.join(ROOT, 'dados', 'ocorrencias_trilhas.geojson');
const CATALOG_PATH = path.join(ROOT, 'dados', 'catalogo_ocorrencias.json');
const TRAILS_PATH = path.join(ROOT, 'dados', 'trilhas_apabf.geojson');
const ORIGINAL_TRAILS_PATH = path.join(ROOT, 'dados', 'trilhas_apabf.original.geojson');

const EXPECTED_OCCURRENCE_FIELDS = [
    'ocorrencia_id',
    'trilha_fid',
    'categoria',
    'descricao',
    'data_identificacao',
    'situacao',
    'fotografias'
];
const EXPECTED_CATEGORIES = [
    'erosao_solo',
    'obstrucao_vegetacao',
    'problemas_sinalizacao',
    'problemas_acesso',
    'situacao_risco',
    'necessidade_manutencao',
    'outros'
];
const EXPECTED_SITUATIONS = [
    'pendente_avaliacao',
    'necessita_intervencao',
    'em_atendimento',
    'resolvida',
    'nao_requer_intervencao'
];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

test('occurrence GeoJSON and catalog are valid JSON with an empty Point collection', function () {
    const collection = readJson(OCCURRENCES_PATH);
    const catalog = readJson(CATALOG_PATH);

    assert.equal(collection.type, 'FeatureCollection');
    assert.deepEqual(collection.features, []);
    assert.ok(Array.isArray(catalog.categorias));
    assert.ok(Array.isArray(catalog.situacoes));
});

test('categories and situations have unique stable keys and valid configuration', function () {
    const catalog = readJson(CATALOG_PATH);
    const categoryKeys = catalog.categorias.map(function (category) {
        return category.chave;
    });
    const situationKeys = catalog.situacoes.map(function (situation) {
        return situation.chave;
    });

    assert.deepEqual(categoryKeys, EXPECTED_CATEGORIES);
    assert.equal(new Set(categoryKeys).size, categoryKeys.length);
    catalog.categorias.forEach(function (category) {
        assert.ok(isNonEmptyString(category.nome));
        assert.ok(isNonEmptyString(category.descricao));
        assert.equal(typeof category.ativo, 'boolean');
        assert.match(category.identificacao_visual.cor, /^#[0-9A-Fa-f]{6}$/);
        assert.match(category.identificacao_visual.icone, /^fa-[a-z0-9-]+$/);
    });

    assert.deepEqual(situationKeys, EXPECTED_SITUATIONS);
    assert.equal(new Set(situationKeys).size, situationKeys.length);
    catalog.situacoes.forEach(function (situation) {
        assert.ok(isNonEmptyString(situation.rotulo));
        assert.equal(typeof situation.ativo, 'boolean');
        assert.match(situation.identificacao_visual.cor, /^#[0-9A-Fa-f]{6}$/);
        assert.ok(isNonEmptyString(situation.identificacao_visual.icone));
    });
});

test('occurrences have unique permanent IDs, valid trail/category/status references and 2D Point coordinates', function () {
    const collection = readJson(OCCURRENCES_PATH);
    const catalog = readJson(CATALOG_PATH);
    const trails = readJson(TRAILS_PATH);
    const trailIds = new Set(trails.features.map(function (feature) {
        return String(feature.properties.fid);
    }));
    const categoryKeys = new Set(catalog.categorias.map(function (category) {
        return category.chave;
    }));
    const situationKeys = new Set(catalog.situacoes.map(function (situation) {
        return situation.chave;
    }));
    const occurrenceIds = new Set();

    collection.features.forEach(function (feature) {
        assert.equal(feature.type, 'Feature');
        assert.equal(feature.geometry.type, 'Point');
        assert.ok(Array.isArray(feature.geometry.coordinates));
        assert.equal(feature.geometry.coordinates.length, 2);
        const [longitude, latitude] = feature.geometry.coordinates;
        assert.ok(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180);
        assert.ok(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90);

        const properties = feature.properties;
        EXPECTED_OCCURRENCE_FIELDS.forEach(function (field) {
            assert.ok(Object.hasOwn(properties, field), 'missing occurrence field: ' + field);
        });
        assert.ok(isNonEmptyString(properties.ocorrencia_id));
        assert.ok(!occurrenceIds.has(properties.ocorrencia_id), 'duplicate occurrence ID: ' + properties.ocorrencia_id);
        occurrenceIds.add(properties.ocorrencia_id);
        assert.ok(trailIds.has(String(properties.trilha_fid)), 'unknown trail fid: ' + properties.trilha_fid);
        assert.ok(categoryKeys.has(properties.categoria), 'unknown category: ' + properties.categoria);
        assert.ok(isNonEmptyString(properties.descricao));
        assert.match(properties.data_identificacao, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(situationKeys.has(properties.situacao), 'unknown situation: ' + properties.situacao);
        assert.ok(Array.isArray(properties.fotografias));
        assert.ok(properties.fotografias.every(isNonEmptyString));
    });
});

test('existing trail features, attributes, geometry, Z coordinates and order match the source', function () {
    const trails = readJson(TRAILS_PATH);
    const original = readJson(ORIGINAL_TRAILS_PATH);

    assert.equal(trails.type, 'FeatureCollection');
    assert.equal(trails.name, original.name);
    assert.equal(trails.features.length, original.features.length);
    trails.features.forEach(function (feature, index) {
        const source = original.features[index];
        const normalizedProperties = Object.assign({}, feature.properties, {
            fid: Number(feature.properties.fid),
            ID: Number(feature.properties.ID)
        });

        assert.equal(feature.type, source.type);
        assert.deepEqual(normalizedProperties, source.properties);
        assert.deepEqual(feature.geometry, source.geometry);
        assert.equal(String(feature.properties.fid), String(source.properties.fid));
        assert.equal(String(feature.properties.ID), String(source.properties.ID));
        assert.ok(!Object.hasOwn(feature.properties, 'manutencao'));
    });
});
