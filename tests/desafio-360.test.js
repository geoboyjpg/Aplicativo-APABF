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
    const listenersJanela = {};
    const camadasTiles = [];
    const armazenamento = opcoes.armazenamento || new Map();
    let primeiraFalha = false;
    let ordemTopLayer = 0;

    function criarElemento(id = '') {
        const listeners = {};
        const classes = new Set();
        return {
            id,
            children: [],
            hidden: id === 'tutorial-dialog',
            disabled: false,
            open: false,
            style: {},
            dataset: {},
            classList: {
                toggle(nome, ativo) {
                    if (ativo === undefined) {
                        if (classes.has(nome)) classes.delete(nome);
                        else classes.add(nome);
                    } else if (ativo) {
                        classes.add(nome);
                    } else {
                        classes.delete(nome);
                    }
                    return classes.has(nome);
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
                if (!this.disabled) this.dispatch('click', { target: this, stopPropagation() {} });
            },
            append(...items) {
                this.children.push(...items);
            },
            appendChild(item) {
                if (item.parentElement) {
                    item.parentElement.children = item.parentElement.children.filter((child) => child !== item);
                }
                this.children.push(item);
                item.parentElement = this;
                return item;
            },
            replaceChildren(...items) {
                this.children = items;
            },
            setAttribute() {},
            matches(selector) {
                return selector === ':popover-open' && Boolean(this.popoverOpen);
            },
            showPopover() {
                this.popoverOpen = true;
                this.topLayerOrder = ++ordemTopLayer;
            },
            hidePopover() {
                this.popoverOpen = false;
            },
            focus() {},
            showModal() {
                this.open = true;
                this.topLayerOrder = ++ordemTopLayer;
            },
            show() {
                this.open = true;
                this.topLayerOrder = ++ordemTopLayer;
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

    function criarMapa(element, options) {
        const layers = new Set();
        const listeners = {};
        const map = {
            element,
            layers,
            options,
            setView(center, zoom) { this.center = center; this.zoom = zoom; return this; },
            latLngToContainerPoint() { return { x: 200, y: 120 }; },
            on(tipo, callback) { listeners[tipo] = callback; return this; },
            emit(tipo, evento) { listeners[tipo](evento); },
            addLayer(layer) { layers.add(layer); return this; },
            removeLayer(layer) { layers.delete(layer); return this; },
            eachLayer(callback) { [...layers].forEach(callback); },
            invalidateSize() {},
            fitBounds() {},
            remove() {}
        };
        ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard'].forEach((nome) => {
            map[nome] = {
                enabled: true,
                enable() { this.enabled = true; },
                disable() { this.enabled = false; }
            };
        });
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
        control: {
            zoom(options) {
                return {
                    options,
                    addTo(map) {
                        map.zoomControl = this;
                        return this;
                    }
                };
            }
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
        addEventListener(tipo, callback) {
            (listenersJanela[tipo] ||= []).push(callback);
        },
        dispatch(tipo, evento = {}) {
            (listenersJanela[tipo] || []).forEach((callback) => callback(evento));
        },
        setTimeout(callback) { callback(); },
        clearTimeout() {},
        matchMedia() { return { matches: Boolean(opcoes.mobile) }; },
        scrollTo() {}
    };
    const math = Object.create(Math);
    math.random = opcoes.random || (() => 0);
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
    if (opcoes.locais) context.window.APABF_DESAFIO_360_LOCAIS = opcoes.locais;
    const locais = context.window.APABF_DESAFIO_360_LOCAIS;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts', 'desafio-360.js'), 'utf8'), context);
    if (opcoes.escolhaInicial !== null) {
        const escolha = opcoes.escolhaInicial || 'play';
        elementos.get(escolha === 'tutorial' ? 'learn-to-play-button' : 'skip-tutorial-button').click();
    }
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
    const panoramaMarkup = html.match(/<div id="panorama"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
    const roundHeader = html.match(/<header class="round-heading">([\s\S]*?)<\/header>/)?.[1] || '';

    assert.match(html, /<dialog id="tutorial-dialog"[^>]+hidden/);
    assert.doesNotMatch(panoramaMarkup, /tutorial-panorama-guide/);
    assert.ok(roundHeader.indexOf('class="challenge-back"') < roundHeader.indexOf('id="tutorial-button"'));
    assert.match(css, /\.round-heading > \.challenge-back\s*\{[^}]*order:\s*1/);
    assert.match(css, /#tutorial-button\s*\{[^}]*order:\s*2/);
    assert.match(css, /\.round-heading > div:first-of-type\s*\{[^}]*order:\s*3/s);
    assert.match(css, /\.round-heading\s*\{[^}]*right:\s*max\(12px,[^}]*flex-wrap:\s*wrap/s);
    assert.match(css, /\.round-actions\s*\{[^}]*display:\s*contents/s);
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.round-heading\s*\{[^}]*max-width:\s*calc\(100vw - 16px\)/s);
    assert.equal([...html.matchAll(/<link[^>]+href="[^"]*desafio-360\.css"/g)].length, 1);
    assert.equal([...html.matchAll(/<script[^>]+src="[^"]*scripts\/desafio-360\.js"/g)].length, 1);
    assert.match(css, /\.game-layout,\s*\.panorama-card,\s*\.panorama-stage\s*\{[^}]*height:\s*100dvh/s);
    assert.match(css, /\.tutorial-dialog\s*\{[^}]*pointer-events:\s*none/s);
    assert.match(css, /\.tutorial-actions button\s*\{[^}]*pointer-events:\s*auto/s);
    assert.match(css, /\.panorama-stage\.is-result #panorama\s*\{\s*display:\s*block/s);
    assert.match(css, /\.result-panel\s*\{[^}]*position:\s*fixed/s);
    assert.match(css, /\.result-panel\.is-expanded\s*\{[^}]*height:\s*min\(78dvh/s);
    assert.match(css, /\.round-heading\s*\{[^}]*env\(safe-area-inset-top/s);
    assert.doesNotMatch(css.match(/\.round-heading\s*\{[^}]*\}/s)?.[0] || '', /backdrop-filter/);
    assert.match(css, /\.tutorial-dialog\[open\]\s*\{[^}]*inset:[\s\S]*?auto auto/s);
    assert.match(css, /\.tutorial-panorama-drag::after\s*\{[^}]*color:\s*#f4c95d[^}]*opacity:\s*1/s);
    assert.match(css, /\.panorama-stage\.tutorial-panorama-drag \.tutorial-panorama-guide/);
    assert.doesNotMatch(css, /\.panorama-view\.tutorial-panorama-interacting\s*~/);
    assert.match(css, /\.tutorial-panorama-guide\s*>\s*i:nth-child\(2\)[\s\S]*?animation:\s*tutorial-hand-sweep/);
    assert.match(css, /\.tutorial-panorama-guide\s*\{[^}]*top:\s*50%;[^}]*left:\s*50%/s);
    assert.match(css, /\.confirm-button\.tutorial-target::after\s*\{[^}]*top:\s*calc\(50% \+ 3px\);[^}]*left:\s*calc\(50% \+ 3px\)/s);
    assert.match(css, /\.challenge-header\s*\{[^}]*left:\s*max\(20px,/s);
    assert.match(css, /\.round-actions\s*\{[^}]*left:\s*8px/s);
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.challenge-header\s*\{[^}]*left:\s*max\(14px,/s);
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.round-actions\s*\{[^}]*left:\s*6px/s);
    assert.match(css, /\.tutorial-expand-cursor::after,[\s\S]*?\.confirm-button\.tutorial-target::after/);
    assert.match(css, /@keyframes tutorial-button-pulse/);
    assert.match(css, /\.guess-map\.is-tutorial-static \.leaflet-control-zoom/);
    assert.match(css, /\.panorama-card > \.section-heading\s*\{\s*display:\s*none/s);
    assert.doesNotMatch(css, /\.panorama-card \.section-heading\s*\{\s*display:\s*none/s);
    assert.match(css, /\.tutorial-panorama-moved::before,[\s\S]*?opacity:\s*1/);
    assert.match(css, /\.tutorial-map-pick::before\s*\{\s*content:\s*none/s);

    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /@media \(max-width: 700px\) and \(max-height: 520px\)/);
});

test('game starts with a local panorama, preserves map guess, scores once, and advances without reload', function () {
    const jogo = criarAmbiente();
    const primeiro = jogo.locais.find((local) => local.panoramaPath === jogo.eventosPanorama[0].configuracao.panorama);
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
    const layout = elemento('result-panel').children.find((child) => child.className === 'result-layout');
    const infoResultado = layout.children[1];
    assert.match(infoResultado.children[0].children[0].children[1].textContent, new RegExp(primeiro.nome));
    assert.match(infoResultado.children[1].children[0].children[1].textContent, /5\.000 \/ 5\.000 pontos/);
    assert.equal(layout.children[0].children[0].className, 'result-map');
    assert.match(jogo.marcadores[1].options.icon.html, /result-marker-guess/);
    assert.match(jogo.marcadores[2].options.icon.html, /result-marker-correct/);
    assert.equal(jogo.mapas.length, 2);

    infoResultado.children[4].children[0].click();
    assert.equal(jogo.eventosPanorama.length, 2);
    assert.notEqual(jogo.eventosPanorama[1].configuracao.panorama, primeiro.panoramaPath);
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
    const primeiroPonto = { lat: local.latitude + 0.01, lng: local.longitude + 0.01 };
    jogo.mapas[0].emit('click', { latlng: primeiroPonto });
    assert.equal(jogo.elementos.get('confirm-button').disabled, false);
    assert.equal(jogo.elementos.get('map-dialog').open, true);
    assert.deepEqual(jogo.marcadores[0].latlng, primeiroPonto);
    const segundoPonto = { lat: primeiroPonto.lat + 0.01, lng: primeiroPonto.lng - 0.01 };
    jogo.mapas[0].emit('click', { latlng: segundoPonto });
    assert.deepEqual(jogo.marcadores[0].latlng, segundoPonto);
    assert.equal(jogo.elementos.get('map-dialog').open, true);
    clicar('confirm-button');
    assert.equal(jogo.elementos.get('result-panel').hidden, false);
    assert.equal(jogo.elementos.get('map-dialog').open, false);
});

test('expanded map reuses the Leaflet instance, preserves the guess, and separates zoom controls', function () {
    const jogo = criarAmbiente({ escolhaInicial: 'skip' });
    const elemento = (id) => jogo.elementos.get(id);
    const mapa = jogo.mapas[0];
    const palpite = { lat: -28.42, lng: -48.71 };

    assert.equal(mapa.options.zoomControl, false);
    assert.equal(mapa.zoomControl.options.position, 'topright');
    mapa.emit('click', { latlng: palpite });
    const marcador = jogo.marcadores[0];

    elemento('expand-map-button').click();
    assert.equal(elemento('map-dialog').open, true);
    assert.equal(elemento('map-dialog').topLayerOrder > 0, true);
    assert.equal(elemento('game-panel').classList.contains('is-map-expanded'), true);
    assert.equal(mapa.dragging.enabled, true);
    assert.equal(mapa.scrollWheelZoom.enabled, true);
    assert.equal(elemento('guess-map').parentElement.id, 'map-dialog-slot');
    assert.equal(jogo.mapas.length, 1);
    assert.equal(marcador.latlng, palpite);

    const novoPalpite = { lat: -28.31, lng: -48.68 };
    mapa.emit('click', { latlng: novoPalpite });
    assert.equal(elemento('map-dialog').open, true);
    assert.equal(jogo.marcadores[0], marcador);
    assert.deepEqual(marcador.latlng, novoPalpite);
    assert.equal(elemento('confirm-button').disabled, false);
    elemento('close-map-button').click();

    assert.equal(elemento('map-dialog').open, false);
    assert.equal(elemento('game-panel').classList.contains('is-map-expanded'), false);
    assert.equal(mapa.dragging.enabled, true);
    assert.equal(mapa.scrollWheelZoom.enabled, true);
    assert.equal(elemento('guess-map').parentElement.id, 'map-inline-slot');
    assert.equal(jogo.mapas[0], mapa);
    assert.equal(jogo.marcadores[0], marcador);
    assert.deepEqual(marcador.latlng, novoPalpite);
    assert.equal(elemento('confirm-button').disabled, false);

    elemento('expand-map-button').click();
    assert.equal(elemento('map-dialog').open, true);
    mapa.emit('click', { latlng: { lat: -28.2, lng: -48.6 } });
    elemento('confirm-button').click();
    assert.equal(elemento('result-panel').hidden, false);
    assert.equal(elemento('map-dialog').open, false);
});

test('minimized map enables the shared confirmation only after selecting a point', function () {
    const jogo = criarAmbiente({ mobile: true });
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
    const painelResultado = jogo.elementos.get('result-panel');
    const controlePainel = painelResultado.children.find((child) => child.className === 'result-sheet-toggle');
    controlePainel.click();
    assert.equal(painelResultado.classList.contains('is-expanded'), true);
    assert.equal(painelResultado.popoverOpen, true);
    controlePainel.click();
    assert.equal(painelResultado.classList.contains('is-expanded'), false);
    assert.equal(painelResultado.popoverOpen, false);
    controlePainel.dispatch('pointerdown', { clientY: 120 });
    controlePainel.dispatch('pointerup', { clientY: 70 });
    controlePainel.click();
    assert.equal(painelResultado.classList.contains('is-expanded'), true);
});

test('three rounds draw distinct geographic locations and a new session shuffles a fresh sequence', function () {
    let sorteios = 0;
    const jogo = criarAmbiente({
        random() {
            sorteios += 1;
            return sorteios <= 6 ? 0 : 0.999999;
        }
    });
    const vistos = [];

    for (let rodada = 0; rodada < 3; rodada += 1) {
        const panorama = jogo.eventosPanorama[rodada].configuracao.panorama;
        const local = jogo.locais.find((item) => item.panoramaPath === panorama);
        vistos.push(local);
        jogo.mapas[0].emit('click', { latlng: { lat: local.latitude, lng: local.longitude } });
        jogo.elementos.get('confirm-button').click();
        if (rodada < 2) jogo.elementos.get('result-panel').children.find((child) => child.className === 'result-layout')
            .children[1].children[4].children[0].click();
    }

    assert.equal(new Set(vistos.map((local) => local.latitude.toFixed(6) + ',' + local.longitude.toFixed(6))).size, 3, JSON.stringify(vistos.map((local) => local.panoramaPath)));
    const sequenciaAnterior = jogo.eventosPanorama.slice(0, 3).map((evento) => evento.configuracao.panorama);
    jogo.elementos.get('new-location-button').click();
    assert.equal(jogo.elementos.get('final-panel').hidden, false);
    jogo.elementos.get('restart-button').click();
    for (let rodada = 0; rodada < 3; rodada += 1) {
        const panorama = jogo.eventosPanorama[3 + rodada].configuracao.panorama;
        const local = jogo.locais.find((item) => item.panoramaPath === panorama);
        jogo.mapas[0].emit('click', { latlng: { lat: local.latitude, lng: local.longitude } });
        jogo.elementos.get('confirm-button').click();
        if (rodada < 2) jogo.elementos.get('result-panel').children.find((child) => child.className === 'result-layout')
            .children[1].children[4].children[0].click();
    }
    const novaSequencia = jogo.eventosPanorama.slice(3, 6).map((evento) => evento.configuracao.panorama);
    assert.equal(new Set(novaSequencia).size, 3);
    assert.notDeepEqual(novaSequencia, sequenciaAnterior);
});

test('duplicate coordinates are treated as the same location and fewer than three locations do not repeat', function () {
    const locais = criarAmbiente().locais.filter((local) => local.panoramaPath).slice(0, 2);
    const duplicado = { ...locais[0], id: 'outra-fotografia-mesmo-local', nome: 'Mesmo local, outra foto', panoramaPath: 'fotos_360/lagoa_arroio_corrente.jpg' };
    const jogo = criarAmbiente({ locais: [...locais, duplicado], random: () => 0 });

    for (let rodada = 0; rodada < 2; rodada += 1) {
        const local = jogo.locais.find((item) => item.panoramaPath === jogo.eventosPanorama[rodada].configuracao.panorama);
        jogo.mapas[0].emit('click', { latlng: { lat: local.latitude, lng: local.longitude } });
        jogo.elementos.get('confirm-button').click();
        if (rodada === 0) jogo.elementos.get('result-panel').children.find((child) => child.className === 'result-layout')
            .children[1].children[4].children[0].click();
    }
    jogo.elementos.get('new-location-button').click();

    assert.equal(jogo.eventosPanorama.length, 2);
    assert.equal(jogo.elementos.get('final-panel').hidden, false);
    assert.equal(jogo.elementos.get('final-score').textContent, '10.000 / 10.000 pontos');
});

test('first visit asks whether to learn; skipping starts the official game', function () {
    const jogo = criarAmbiente({ escolhaInicial: null });
    const elemento = (id) => jogo.elementos.get(id);

    assert.equal(elemento('tutorial-choice-dialog').open, true);
    assert.equal(jogo.eventosPanorama.length, 0);
    elemento('skip-tutorial-button').click();
    assert.equal(elemento('tutorial-choice-dialog').open, false);
    assert.equal(elemento('round-title').textContent, 'Desafio 1 de 3');
    assert.equal(jogo.eventosPanorama.length, 1);
    assert.equal(jogo.window.localStorage.getItem('apabf-desafio-360-tutorial-apresentado'), 'true');

    const proximaVisita = criarAmbiente({ armazenamento: jogo.armazenamento });
    assert.equal(proximaVisita.elementos.get('tutorial-choice-dialog').open, false);
    assert.equal(proximaVisita.elementos.get('round-title').textContent, 'Desafio 1 de 3');
    proximaVisita.elementos.get('tutorial-button').click();
    assert.equal(proximaVisita.elementos.get('tutorial-step-label').textContent, 'Etapa 1 de 5');
    assert.equal(proximaVisita.elementos.get('round-title').textContent, 'Demonstração guiada');
});

test('guided tutorial requires real actions and does not count its demonstration as an official round', function () {
    const jogo = criarAmbiente({ escolhaInicial: 'tutorial', mobile: true });
    const elemento = (id) => jogo.elementos.get(id);
    const local = jogo.locais.find((item) => item.panoramaPath);

    assert.equal(elemento('tutorial-choice-dialog').open, false);
    assert.equal(elemento('tutorial-dialog').open, true);
    assert.equal(elemento('tutorial-step-label').textContent, 'Etapa 1 de 5');
    assert.match(elemento('tutorial-copy').textContent, /Arraste a imagem para a esquerda e para a direita/);
    elemento('panorama').dispatch('pointerdown', { clientX: 100, clientY: 100 });
    assert.equal(elemento('panorama').classList.contains('tutorial-panorama-interacting'), false);

    elemento('tutorial-next').click();
    assert.equal(elemento('tutorial-step-label').textContent, 'Etapa 2 de 5');
    assert.equal(elemento('expand-map-button').classList.contains('tutorial-target'), true);
    assert.equal(elemento('tutorial-next').disabled, true);
    elemento('expand-map-button').click();
    assert.equal(elemento('map-dialog').open, true);
    assert.equal(elemento('game-panel').classList.contains('is-map-expanded'), true);
    assert.equal(elemento('tutorial-step-label').textContent, 'Etapa 3 de 5');
    assert.equal(elemento('guess-map').classList.contains('is-tutorial-static'), true);
    ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard'].forEach((nome) => {
        assert.equal(jogo.mapas[0][nome].enabled, false, `${nome} deve ficar desabilitado durante a etapa ampliada`);
    });
    assert.equal(jogo.mapas[0].center[0], local.latitude);
    assert.equal(elemento('guess-map').children[0].style.left, '200px');

    const pontoErrado = { lat: local.latitude + 0.02, lng: local.longitude };
    jogo.mapas[0].emit('click', { latlng: pontoErrado });
    assert.deepEqual(jogo.marcadores[0].latlng, pontoErrado);
    assert.equal(elemento('confirm-button').disabled, true);
    assert.equal(elemento('map-dialog').open, true);
    assert.equal(elemento('tutorial-step-label').textContent, 'Etapa 3 de 5');

    const pontoCorreto = { lat: local.latitude, lng: local.longitude };
    jogo.mapas[0].emit('click', { latlng: pontoCorreto });
    assert.deepEqual(jogo.marcadores[0].latlng, pontoCorreto);
    assert.equal(elemento('confirm-button').disabled, false);
    assert.equal(elemento('map-dialog').open, true);
    assert.equal(elemento('tutorial-step-label').textContent, 'Etapa 4 de 5');
    assert.equal(elemento('guess-map').classList.contains('is-tutorial-static'), false);
    ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard'].forEach((nome) => {
        assert.equal(jogo.mapas[0][nome].enabled, true, `${nome} deve ser restaurado ao sair da etapa ampliada`);
    });
    assert.equal(elemento('confirm-button').classList.contains('tutorial-target'), true);
    elemento('confirm-button').click();

    assert.equal(elemento('map-dialog').open, false);
    assert.equal(elemento('tutorial-step-label').textContent, 'Etapa 5 de 5');
    assert.match(elemento('tutorial-copy').textContent, /Prepare-se para explorar a APA da Baleia Franca/);
    assert.equal(elemento('result-panel').hidden, false);
    const controleResultado = elemento('result-panel').children.find((child) => child.className === 'result-sheet-toggle');
    controleResultado.click();
    assert.equal(elemento('result-panel').popoverOpen, true);
    assert.ok(elemento('result-panel').topLayerOrder > elemento('tutorial-dialog').topLayerOrder);
    controleResultado.click();
    assert.equal(elemento('result-panel').popoverOpen, false);
    const resultado = elemento('result-panel').children.find((child) => child.className === 'result-layout');
    const informacoes = resultado.children[1];
    assert.match(informacoes.children[0].children[0].children[1].textContent, new RegExp(local.nome));
    assert.match(informacoes.children[1].children[0].children[1].textContent, /5\.000 \/ 5\.000 pontos/);
    assert.match(informacoes.children[3].children[3].textContent, /pontuação diminui conforme aumenta a distância/);
    assert.equal(elemento('round-title').textContent, 'Demonstração guiada');

    elemento('tutorial-button').click();
    assert.equal(elemento('tutorial-step-label').textContent, 'Etapa 1 de 5');
    assert.match(elemento('tutorial-copy').textContent, /Arraste a imagem/);
    elemento('tutorial-skip').click();
    assert.equal(elemento('round-title').textContent, 'Desafio 1 de 3');
    assert.equal(jogo.eventosPanorama.length, 3);

    for (let rodada = 0; rodada < 3; rodada += 1) {
        const panorama = jogo.eventosPanorama[rodada + 2].configuracao.panorama;
        const localOficial = jogo.locais.find((item) => item.panoramaPath === panorama);
        jogo.mapas[0].emit('click', { latlng: { lat: localOficial.latitude, lng: localOficial.longitude } });
        elemento('confirm-button').click();
        if (rodada < 2) {
            elemento('result-panel').children.find((child) => child.className === 'result-layout')
                .children[1].children[4].children[0].click();
        }
    }
    elemento('new-location-button').click();
    assert.equal(elemento('round-summary').children.length, 3);
    assert.equal(elemento('final-score').textContent, '15.000 / 15.000 pontos');
});

test('closing the expanded tutorial map restores interactions and reopening freezes them again', function () {
    const jogo = criarAmbiente({ escolhaInicial: 'tutorial' });
    const elemento = (id) => jogo.elementos.get(id);
    const mapa = jogo.mapas[0];

    elemento('tutorial-next').click();
    elemento('expand-map-button').click();
    assert.equal(elemento('guess-map').classList.contains('is-tutorial-static'), true);
    elemento('close-map-button').click();
    assert.equal(elemento('guess-map').classList.contains('is-tutorial-static'), false);
    assert.equal(mapa.dragging.enabled, true);
    assert.equal(mapa.scrollWheelZoom.enabled, true);

    elemento('expand-map-button').click();
    assert.equal(elemento('guess-map').classList.contains('is-tutorial-static'), true);
    assert.equal(mapa.dragging.enabled, false);
    assert.equal(mapa.scrollWheelZoom.enabled, false);
    elemento('tutorial-skip').click();
    assert.equal(elemento('guess-map').classList.contains('is-tutorial-static'), false);
    assert.equal(mapa.dragging.enabled, true);
    assert.equal(mapa.scrollWheelZoom.enabled, true);
});

test('failed panorama offers retry and an alternate without recording a result', function () {
    const locais = criarAmbiente({ falhaInicial: 'fotos_360/DJI_0222-web.jpg', random: () => 0.999999 });
    assert.equal(locais.elementos.get('panorama-error-actions').hidden, false);
    assert.equal(locais.elementos.get('retry-panorama-button').hidden, false);
    assert.equal(locais.elementos.get('error-new-location-button').hidden, false);
    locais.elementos.get('error-new-location-button').click();
    assert.equal(locais.eventosPanorama.length, 2);
    assert.equal(locais.eventosPanorama[1].configuracao.panorama, 'fotos_360/lagoa_arroio_corrente.jpg');
    assert.equal(locais.elementos.get('result-panel').hidden, true);
});

test('retry reloads a failed local panorama in the same round', function () {
    const jogo = criarAmbiente({ falhaInicial: 'fotos_360/DJI_0222-web.jpg', random: () => 0.999999 });
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
