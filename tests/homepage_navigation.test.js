'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function localTargetExists(page, href) {
    const target = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    return fs.existsSync(path.resolve(path.dirname(page), target));
}

test('homepage retains the four original main options and adds fauna and trails', function () {
    const mainCards = Array.from(
        homepage.matchAll(/<a href="([^"]+)" class="main-card">([\s\S]*?)<\/a>/g),
        function (match) {
            return { href: match[1], content: match[2] };
        }
    );
    const labels = mainCards.map(function (card) {
        return card.content.match(/<h2>(.*?)<\/h2>/)[1];
    });

    assert.deepEqual(labels, [
        'A Baleia Franca',
        'Conheça a APA',
        'Serviços',
        'Dados geográficos',
        'Ocorrências de Fauna',
        'Trilhas'
    ]);
    assert.equal(mainCards.length, 6);
    mainCards.forEach(function (card) {
        assert.ok(localTargetExists(path.join(ROOT, 'index.html'), card.href), card.href);
    });
});

test('homepage cards use three desktop columns and a compact mobile column', function () {
    assert.match(homepage, /\.main-cards\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
    assert.match(homepage, /@media \(max-width: 700px\)[\s\S]*?\.main-cards\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(homepage, /@media \(max-height: 700px\) and \(orientation: portrait\)[\s\S]*?\.page-footer\.home-footer\s*\{\s*display:\s*none/);
});

test('fauna and 360 game reuse existing destinations outside Services', function () {
    const services = fs.readFileSync(path.join(ROOT, 'servicos.html'), 'utf8');
    const faunaHref = 'Ocorrencias%20de%20Fauna%20Registradas/index.html';
    const gameHref = 'desafio-360.html';

    assert.match(homepage, new RegExp('href="' + faunaHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'));
    assert.match(homepage, /href="desafio-360\.html" class="secondary-link"><i class="fas fa-compass"/);
    assert.match(homepage, /href="noticias-publicacoes\.html" class="secondary-link"/);
    assert.ok(localTargetExists(path.join(ROOT, 'index.html'), 'noticias-publicacoes.html'));
    assert.doesNotMatch(services, /href="Ocorrencias de Fauna Registradas\/index\.html"/);
    assert.doesNotMatch(services, /href="desafio-360\.html"/);
    ['SISBIO', 'Autorização de Eventos', 'Autorização Direta', 'Gerador de Mapas'].forEach(function (service) {
        assert.ok(services.includes(service), service);
    });
    assert.ok(localTargetExists(path.join(ROOT, 'index.html'), faunaHref));
    assert.ok(localTargetExists(path.join(ROOT, 'index.html'), gameHref));
});

test('trails page moves the existing trail-map link from About APA', function () {
    const aboutApa = fs.readFileSync(path.join(ROOT, 'sobre-apa.html'), 'utf8');
    const trailsPage = fs.readFileSync(path.join(ROOT, 'trilhas.html'), 'utf8');
    const trailMapHref = 'Trilha%20Caminhos%20da%20Baleia%20Franca/index.html';

    assert.doesNotMatch(aboutApa, /Trilha%20Caminhos%20da%20Baleia%20Franca\/index\.html/);
    assert.match(trailsPage, /Mapa de Trilhas/);
    assert.match(trailsPage, new RegExp('href="' + trailMapHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'));
    assert.ok(localTargetExists(path.join(ROOT, 'trilhas.html'), trailMapHref));
    assert.match(homepage, /href="trilhas\.html" class="main-card"/);
});

test('the existing quick-navigation destinations and order remain unchanged', function () {
    const navigation = fs.readFileSync(path.join(ROOT, 'nav.js'), 'utf8');
    const originalItems = [
        "href: base + 'index.html', icon: 'fa-home', label: 'Início'",
        "href: base + 'Zoneamento APABF/index.html', icon: 'fa-map', label: 'Mapa'",
        "href: base + 'Fiscalização/index.html', icon: 'fa-shield-alt', label: 'Fiscalização'",
        "href: base + 'Ocorrencias de Fauna/index.html', icon: 'fa-camera', label: 'Registros'",
        "href: base + 'Legislação Pesqueira/index.html', icon: 'fa-gavel', label: 'Legislação'"
    ];
    let previousIndex = -1;

    originalItems.forEach(function (item) {
        const index = navigation.indexOf(item);
        assert.ok(index > previousIndex, item);
        previousIndex = index;
    });
    assert.equal((navigation.match(/\{ href: base \+/g) || []).length, 5);
});
