'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function criarAmbiente(opcoes = {}) {
    const html = fs.readFileSync(path.join(ROOT, 'desafio-360.html'), 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const elementos = new Map(ids.map((id) => [id, criarElemento(id)]));
    const eventosPanorama = [];
    const marcadores = [];
    const mapas = [];
    const scriptsMapa = [];
    const camadasTiles = [];
    const armazenamento = opcoes.armazenamento || new Map();
    let primeiraFalha = false;

    function criarElemento(id = '') {
        const listeners = {};
        const classes = new Set();
        return {
            id,
            children: [],
            hidden: id === 'tutorial-dialog',
            disabled: false,
            open: false,
            classList: {
                toggle(nome, ativo) {
                    if (ativo) classes.add(nome);
                    else classes.delete(nome);
                },
                contains(nome) { return classes.has(nome); }
            },
            addEventListener(tipo, callback) {
                (listeners[tipo] ||= []).push(callback);
            },
            dispatch(tipo, evento = {}) {
                (listeners[tipo] || []).forEach((callback) => callback(evento));
            },
            click() {
                if (!this.disabled) this.dispatch('click', { target: this });
            },
            append(...items) {
                this.children.push(...items);
            },
            appendChild(item) {
                this.children.push(item);
                return item;
            },
            replaceChildren(...items) {
                this.children = items;
            },
            setAttribute() {},
            focus() {},
            showModal() {
                this.open = true;
            },
            show() {
                this.open = true;
            },
            close() {
                this.open = false;
                this.dispatch('close');
            }
        };
    }

    const document = {
        getElementById(id) {
            if (!elementos.has(id)) elementos.set(id, criarElemento(id));
            return elementos.get(id);
        },
        createElement() {
            return criarElemento();
        },
        createTextNode(text) {
            return { textContent: text };
        },
        head: {
            appendChild(script) {
                scriptsMapa.push(script);
            }
        }
    };

    function criarMapa(element) {
        const layers = new Set();
        const listeners = {};
        const map = {
            element,
            layers,
            setView() { return this; },
            on(tipo, callback) { listeners[tipo] = callback; return this; },
            emit(tipo, evento) { listeners[tipo](evento); },
            addLayer(layer) { layers.add(layer); return this; },
            removeLayer(layer) { layers.delete(layer); return this; },
            eachLayer(callback) { [...layers].forEach(callback); },
            invalidateSize() {},
            fitBounds() {},
            remove() {}
        };
        mapas.push(map);
        return map;
    }

    function criarCamada() {
        const listeners = {};
        return {
            addTo(map) { map.addLayer(this); return this; },
            bindTooltip() { return this; },
            on(tipo, callback) { listeners[tipo] = callback; return this; },
            emit(tipo, evento) { if (listeners[tipo]) listeners[tipo](evento); },
            redraw() { this.redrawCount = (this.redrawCount || 0) + 1; return this; },
            setLatLng(ponto) { this.latlng = ponto; return this; }
        };
    }

    const L = {
        map: criarMapa,
        tileLayer(url, options) {
            const camada = criarCamada();
            camadasTiles.push({ url, options, camada });
            return camada;
        },
        marker(ponto, options) {
            const marcador = criarCamada();
            marcador.latlng = ponto;
            marcador.options = options;
            marcadores.push(marcador);
            return marcador;
        },
        divIcon(options) { return options; },
        circleMarker() { return criarCamada(); },
        polyline() { return criarCamada(); }
    };

    const window = {
        L: opcoes.leafletIndisponivel ? undefined : L,
        sessionStorage: {
            getItem(chave) { return armazenamento.get(chave) || null; },
            setItem(chave, valor) { armazenamento.set(chave, valor); }
        },
        localStorage: {
            getItem(chave) { return armazenamento.get(chave) || null; },
            setItem(chave, valor) { armazenamento.set(chave, valor); }
        },
        setTimeout(callback) { callback(); },
        scrollTo() {}
    };
    const math = Object.create(Math);
    math.random = () => 0;
    window.pannellum = {
        viewer(elementId, configuracao) {
            const panorama = {
                callbacks: {},
                on(tipo, callback) {
                    this.callbacks[tipo] = callback;
                    if (tipo === 'error' && configuracao.panorama === opcoes.falhaInicial && !primeiraFalha) {
                        primeiraFalha = true;
                        callback();
                    }
                    if (tipo === 'load' && (configuracao.panorama !== opcoes.falhaInicial || primeiraFalha)) callback();
                    return this;
                },
                destroy() {}
            };
            eventosPanorama.push({ elementId, configuracao, panorama });
            return panorama;
        }
    };

    const context = vm.createContext({ window, document, L, Math: math, Set, Number, Array, Boolean, String });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'dados', 'desafio-360-locais.js'), 'utf8'), context);
    const locais = context.window.APABF_DESAFIO_360_LOCAIS;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts', 'desafio-360.js'), 'utf8'), context);
    return { elementos, eventosPanorama, marcadores, mapas, locais, scriptsMapa, camadasTiles, window, L, armazenamento };
}

test('all local panorama records point to existing files and unique valid locations', function () {
    const context = vm.createContext({ window: {} });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'dados', 'desafio-360-locais.js'), 'utf8'), context);
    const locais = context.window.APABF_DESAFIO_360_LOCAIS;
    const ids = new Set();
    const imagens = locais.filter((local) => local.panoramaPath);
    const coordenadasEsperadas = {
        'lagoa-paes-leme': [-28.255493, -48.678423],
        arroio_corrente: [-28.686896, -49.028741],
        sambaqui: [-28.625851, -48.892682],
        itapiruba_promontorio: [-28.3384457, -48.6974602],
        dunas_itapiruba: [-28.313261, -48.7165489],
        praia_dagua: [-28.2148418, -48.6668129],
        dunas_riba: [-28.1855583, -48.6653938]
    };

    assert.equal(imagens.length, 7);
    Object.entries(coordenadasEsperadas).forEach(([id, coordenadas]) => {
        const local = locais.find((item) => item.id === id);
        assert.ok(local, `cenário ausente: ${id}`);
        assert.deepEqual([local.latitude, local.longitude], coordenadas, id);
    });
    locais.forEach((local) => {
        assert.ok(!ids.has(local.id), `identificador duplicado: ${local.id}`);
        ids.add(local.id);
        assert.ok(Number.isFinite(local.latitude) && local.latitude >= -90 && local.latitude <= 90);
        assert.ok(Number.isFinite(local.longitude) && local.longitude >= -180 && local.longitude <= 180);
        if (local.panoramaPath) {
            assert.match(local.panoramaPath, /^fotos_360\/[^/]+\.(jpe?g|png|webp)$/i);
            assert.ok(fs.existsSync(path.join(ROOT, ...local.panoramaPath.split('/'))), local.panoramaPath);
        }
    });
    assert.equal(locais.find((local) => local.id === 'porto-imbituba').panoramaPath, null);
});

test('the game is linked from Services and not from the homepage cards', function () {
    const homepage = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const services = fs.readFileSync(path.join(ROOT, 'servicos.html'), 'utf8');

    assert.doesNotMatch(homepage, /href="desafio-360\.html"/);
    assert.match(services, /href="desafio-360\.html"/);
});

test('immersive layout keeps the panorama interactive behind a click-through tutorial and result panel', function () {
    const html = fs.readFileSync(path.join(ROOT, 'desafio-360.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'desafio-360.css'), 'utf8');

    assert.match(html, /<section id="tutorial-dialog"[^>]+hidden/);
    assert.match(css, /\.game-layout,\s*\.panorama-card,\s*\.panorama-stage\s*\{[^}]*height:\s*100dvh/s);
    assert.match(css, /\.tutorial-dialog\s*\{[^}]*pointer-events:\s*none/s);
    assert.match(css, /\.tutorial-actions button\s*\{[^}]*pointer-events:\s*auto/s);
    assert.match(css, /\.panorama-stage\.is-result #panorama\s*\{\s*display:\s*block/s);
    assert.match(css, /\.result-panel\s*\{[^}]*position:\s*fixed/s);
});

test('game starts with a local panorama, preserves map guess, scores once, and advances without reload', function () {
    const jogo = criarAmbiente();
    const [primeiro, segundo] = jogo.locais.filter((local) => local.panoramaPath);
    const elemento = (id) => jogo.elementos.get(id);

    assert.equal(jogo.eventosPanorama[0].configuracao.panorama, primeiro.panoramaPath);
    assert.equal(elemento('new-location-button').disabled, true);

    const coordenada = { lat: primeiro.latitude, lng: primeiro.longitude };
    jogo.mapas[0].emit('click', { latlng: coordenada });
    const marcador = jogo.marcadores[0];
    elemento('expand-map-button').click();
    assert.equal(elemento('map-dialog').open, true);
    elemento('confirm-button').click();
    assert.equal(elemento('map-dialog').open, false);
    assert.equal(jogo.marcadores[0], marcador);

    elemento('confirm-button').click();
    elemento('confirm-button').click();
    assert.equal(elemento('result-panel').hidden, false);
    assert.equal(elemento('panorama-stage').classList.contains('is-result'), true);
    const infoResultado = elemento('result-panel').children[0].children[1];
    assert.match(infoResultado.children[0].children[0].children[1].textContent, new RegExp(primeiro.nome));
    assert.match(infoResultado.children[1].children[0].children[1].textContent, /5\.000 \/ 5\.000 pontos/);
    assert.equal(elemento('result-panel').children[0].children[0].children[0].className, 'result-map');
    assert.match(jogo.marcadores[1].options.icon.html, /result-marker-guess/);
    assert.match(jogo.marcadores[2].options.icon.html, /result-marker-correct/);
    assert.equal(jogo.mapas.length, 2);

    infoResultado.children[4].children[0].click();
    assert.equal(jogo.eventosPanorama.length, 2);
    assert.equal(jogo.eventosPanorama[1].configuracao.panorama, segundo.panoramaPath);
    assert.equal(elemento('result-panel').hidden, true);
    assert.equal(elemento('panorama-stage').classList.contains('is-result'), false);
    assert.equal(elemento('confirm-button').disabled, true);
    assert.equal(elemento('panorama-title').textContent, 'Observe a paisagem');
    assert.equal(jogo.mapas[0].layers.has(marcador), false);
});

test('expanded-map confirmation without a selected point explains how to continue', function () {
    const jogo = criarAmbiente();
    const clicar = (id) => jogo.elementos.get(id).click();

    clicar('expand-map-button');
    clicar('confirm-button');

    assert.equal(jogo.elementos.get('map-dialog').open, true);
    assert.equal(jogo.elementos.get('result-panel').hidden, true);
    assert.match(jogo.elementos.get('map-dialog-status').textContent, /Ainda não há um ponto selecionado/);
    const local = jogo.locais.find((item) => item.panoramaPath);
    jogo.mapas[0].emit('click', { latlng: { lat: local.latitude, lng: local.longitude } });
    assert.equal(jogo.elementos.get('confirm-button').disabled, false);
    clicar('confirm-button');
    assert.equal(jogo.elementos.get('result-panel').hidden, false);
    assert.equal(jogo.elementos.get('map-dialog').open, false);
});

test('minimized map enables the shared confirmation only after selecting a point', function () {
    const jogo = criarAmbiente();
    const confirmar = jogo.elementos.get('confirm-button');

    assert.equal(confirmar.disabled, true);
    confirmar.click();
    assert.equal(jogo.elementos.get('result-panel').hidden, true);

    const local = jogo.locais.find((item) => item.panoramaPath);
    jogo.mapas[0].emit('click', { latlng: { lat: local.latitude, lng: local.longitude } });
    assert.equal(confirmar.disabled, false);
    assert.equal(confirmar.classList.contains('is-ready'), true);
    confirmar.click();

    assert.equal(jogo.elementos.get('result-panel').hidden, false);
    assert.equal(confirmar.hidden, true);
});

test('tutorial navigates, demonstrates the expanded map, can be skipped, and can be reopened', function () {
    const jogo = criarAmbiente();
    const elemento = (id) => jogo.elementos.get(id);

    assert.equal(elemento('tutorial-dialog').hidden, false);
    assert.match(elemento('tutorial-copy').textContent, /Arraste a imagem/);
    elemento('panorama').dispatch('pointerdown', { clientX: 100, clientY: 100 });
    elemento('panorama').dispatch('pointermove', { clientX: 130, clientY: 101 });
    assert.match(elemento('tutorial-copy').textContent, /Ótimo!/);
    elemento('tutorial-next').click();
    assert.match(elemento('tutorial-copy').textContent, /Utilize o mapa/);
    assert.equal(elemento('expand-map-button').classList.contains('tutorial-target'), true);

    elemento('tutorial-next').click();
    assert.equal(elemento('map-dialog').open, true);
    assert.equal(elemento('guess-map').classList.contains('tutorial-map-pick'), true);
    const local = jogo.locais.find((item) => item.panoramaPath);
    jogo.mapas[0].emit('click', { latlng: { lat: local.latitude, lng: local.longitude } });
    assert.match(elemento('tutorial-copy').textContent, /Confirme sua localização/);
    assert.equal(elemento('map-dialog').open, false);
    elemento('tutorial-skip').click();

    assert.equal(elemento('tutorial-dialog').hidden, true);
    assert.equal(jogo.window.localStorage.getItem('apabf-desafio-360-tutorial-apresentado'), 'true');
    elemento('tutorial-button').click();
    assert.equal(elemento('tutorial-dialog').hidden, false);
    assert.match(elemento('tutorial-copy').textContent, /Arraste a imagem/);

    const proximaVisita = criarAmbiente({ armazenamento: jogo.armazenamento });
    assert.equal(proximaVisita.elementos.get('tutorial-dialog').hidden, true);
    proximaVisita.elementos.get('tutorial-button').click();
    assert.equal(proximaVisita.elementos.get('tutorial-dialog').hidden, false);
});

test('failed panorama offers retry and an alternate without recording a result', function () {
    const locais = criarAmbiente({ falhaInicial: 'fotos_360/DJI_0222-web.jpg' });
    assert.equal(locais.elementos.get('panorama-error-actions').hidden, false);
    assert.equal(locais.elementos.get('retry-panorama-button').hidden, false);
    assert.equal(locais.elementos.get('error-new-location-button').hidden, false);
    locais.elementos.get('error-new-location-button').click();
    assert.equal(locais.eventosPanorama.length, 2);
    assert.equal(locais.eventosPanorama[1].configuracao.panorama, 'fotos_360/lagoa_arroio_corrente.jpg');
    assert.equal(locais.elementos.get('result-panel').hidden, true);
});

test('retry reloads a failed local panorama in the same round', function () {
    const jogo = criarAmbiente({ falhaInicial: 'fotos_360/DJI_0222-web.jpg' });
    jogo.elementos.get('retry-panorama-button').click();

    assert.equal(jogo.eventosPanorama.length, 2);
    assert.equal(jogo.eventosPanorama[1].configuracao.panorama, 'fotos_360/DJI_0222-web.jpg');
    assert.equal(jogo.elementos.get('panorama-error-actions').hidden, true);
    assert.equal(jogo.elementos.get('result-panel').hidden, true);
    assert.equal(jogo.elementos.get('new-location-button').disabled, true);
});

test('three confirmed rounds retain their scores and produce the final summary', function () {
    const jogo = criarAmbiente();
    const clicar = (id) => jogo.elementos.get(id).click();

    for (let rodada = 0; rodada < 3; rodada += 1) {
        const panorama = jogo.eventosPanorama[rodada].configuracao.panorama;
        const local = jogo.locais.find((item) => item.panoramaPath === panorama);
        jogo.mapas[0].emit('click', { latlng: { lat: local.latitude, lng: local.longitude } });
        clicar('confirm-button');
        if (rodada < 2) clicar('new-location-button');
    }

    clicar('new-location-button');
    assert.equal(jogo.elementos.get('game-panel').hidden, true);
    assert.equal(jogo.elementos.get('final-panel').hidden, false);
    assert.equal(jogo.elementos.get('final-score').textContent, '15.000 / 15.000 pontos');
    assert.equal(jogo.elementos.get('round-summary').children.length, 3);
});

test('Leaflet CDN fallback loads the map without restarting the current game', async function () {
    const jogo = criarAmbiente({ leafletIndisponivel: true });

    assert.equal(jogo.scriptsMapa.length, 1);
    assert.match(jogo.scriptsMapa[0].src, /cdn\.jsdelivr\.net\/npm\/leaflet@1\.9\.4/);
    jogo.scriptsMapa[0].onerror();
    assert.equal(jogo.scriptsMapa.length, 2);
    assert.match(jogo.scriptsMapa[1].src, /unpkg\.com\/leaflet@1\.9\.4/);
    assert.match(jogo.elementos.get('leaflet-stylesheet').href, /unpkg\.com\/leaflet@1\.9\.4/);
    jogo.window.L = jogo.L;
    jogo.scriptsMapa[1].onload();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(jogo.mapas.length, 1);
    assert.equal(jogo.camadasTiles[0].url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    assert.match(jogo.camadasTiles[0].options.attribution, /OpenStreetMap/);
    assert.equal(jogo.eventosPanorama.length, 1);
    const mapa = jogo.mapas[0];
    const camada = [...mapa.layers][0];
    camada.emit('tileerror');
    assert.equal(jogo.elementos.get('retry-map-button').hidden, false);
    jogo.elementos.get('retry-map-button').click();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(jogo.mapas.length, 1);
    assert.equal(camada.redrawCount, 1);
    assert.equal(jogo.eventosPanorama.length, 1);
});

test('map retry recovers after both CDNs fail without discarding the panorama round', async function () {
    const jogo = criarAmbiente({ leafletIndisponivel: true });

    jogo.scriptsMapa[0].onerror();
    jogo.scriptsMapa[1].onerror();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(jogo.elementos.get('retry-map-button').hidden, false);
    assert.equal(jogo.eventosPanorama.length, 1);

    jogo.elementos.get('retry-map-button').click();
    assert.equal(jogo.scriptsMapa.length, 3);
    jogo.window.L = jogo.L;
    jogo.scriptsMapa[2].onload();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(jogo.mapas.length, 1);
    assert.equal(jogo.eventosPanorama.length, 1);
    assert.equal(jogo.elementos.get('round-title').textContent, 'Desafio 1 de 3');
});
