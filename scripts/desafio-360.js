(function () {
    'use strict';

    var lugares = window.APABF_DESAFIO_360_LOCAIS || [];
    var maxPontos = 5000;
    var distanciaSemPontos = 20000;
    var maxRodadas = 3;
    var chaveUltimoLocal = 'apabf-desafio-360-ultimo-local';
    var chaveTutorialApresentado = 'apabf-desafio-360-tutorial-apresentado';
    var etapaTutorial = 0;
    var tutorialAtivo = false;
    var tutorialLocalSelecionado = false;
    var etapasTutorial = [
        {
            alvo: 'panorama',
            titulo: 'Explore o ambiente!',
            texto: 'Arraste a imagem para a esquerda e para a direita e observe tudo ao seu redor. Você pode girar a câmera para explorar a paisagem.'
        },
        {
            alvo: 'expand-map-button',
            titulo: 'Encontre sua localização!',
            texto: 'Agora vamos descobrir onde esta fotografia foi registrada. Abra o mapa para visualizar a região e escolher o local correto.'
        },
        {
            alvo: 'guess-map',
            titulo: 'Marque a localização!',
            texto: 'Observe o mapa. Esta fotografia foi registrada neste ponto. Clique no local indicado para registrar seu palpite.'
        },
        {
            alvo: 'confirm-button',
            titulo: 'Muito bem!',
            texto: 'Agora que você marcou sua localização, basta confirmar o palpite para descobrir a distância e a pontuação obtida.'
        },
        {
            alvo: 'result-panel',
            titulo: 'Pronto!',
            texto: 'Agora você já sabe como funciona o Desafio 360°. Prepare-se para explorar a APA da Baleia Franca e testar seus conhecimentos!'
        }
    ];
    var estado = {
        rodada: 0,
        rodadasPlanejadas: 0,
        palpite: null,
        resultados: [],
        candidatos: [],
        sequenciaLocais: [],
        proximoLocal: 0,
        locaisIndisponiveis: new Set(),
        ultimoLocalId: '',
        localAtual: null,
        mapa: null,
        camadaBaseMapa: null,
        marcadorPalpite: null,
        panorama: null,
        panoramaPronto: false,
        panoramaComErro: false,
        carregamentoLeaflet: null,
        tilesCarregados: false,
        tilesComErro: false,
        tokenPanorama: 0,
        mapaResultado: null,
        localDemonstracao: null,
        cursorTutorialMapa: null
    };

    var jogo = document.getElementById('game-panel');
    var final = document.getElementById('final-panel');
    var mapaElement = document.getElementById('guess-map');
    var slotMapaEmLinha = document.getElementById('map-inline-slot');
    var slotMapaDialogo = document.getElementById('map-dialog-slot');
    var slotConfirmacaoEmLinha = document.getElementById('map-confirm-slot');
    var slotConfirmacaoDialogo = document.getElementById('map-dialog-actions');
    var dialogoMapa = document.getElementById('map-dialog');
    var dialogoEscolhaTutorial = document.getElementById('tutorial-choice-dialog');
    var dialogoTutorial = document.getElementById('tutorial-dialog');
    var botaoAmpliarMapa = document.getElementById('expand-map-button');
    var botaoNovaLocalizacao = document.getElementById('new-location-button');
    var botaoConfirmar = document.getElementById('confirm-button');
    var statusMapa = document.getElementById('map-status');
    var statusMapaDialogo = document.getElementById('map-dialog-status');
    var botaoTentarMapa = document.getElementById('retry-map-button');
    var statusPanorama = document.getElementById('panorama-status');
    var acoesErroPanorama = document.getElementById('panorama-error-actions');
    var painelResultado = document.getElementById('result-panel');
    var palcoPanorama = document.getElementById('panorama-stage');

    function formatarDistancia(metros) {
        return metros < 1000
            ? Math.round(metros).toLocaleString('pt-BR') + ' m'
            : (metros / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';
    }

    function calcularDistancia(a, b) {
        var radianos = Math.PI / 180;
        var latitude1 = a.lat * radianos;
        var latitude2 = b.lat * radianos;
        var deltaLatitude = (b.lat - a.lat) * radianos;
        var deltaLongitude = (b.lng - a.lng) * radianos;
        var haversine = Math.sin(deltaLatitude / 2) ** 2
            + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
    }

    function calcularPontos(distancia) {
        return Math.max(0, Math.round(maxPontos * (1 - distancia / distanciaSemPontos)));
    }

    function setStatus(element, texto, erro) {
        element.textContent = texto;
        element.classList.toggle('is-error', Boolean(erro));
    }

    function atualizarBotaoConfirmar() {
        var pronto = Boolean(estado.mapa && estado.panoramaPronto && estado.palpite)
            && estado.resultados.length <= estado.rodada
            && (!tutorialAtivo || etapaTutorial !== 2 || tutorialLocalSelecionado)
            && !estado.panoramaComErro;
        botaoConfirmar.disabled = !pronto;
        botaoConfirmar.classList.toggle('is-ready', pronto);
    }

    function carregarLeaflet() {
        if (window.L) {
            return Promise.resolve();
        }
        if (estado.carregamentoLeaflet) {
            return estado.carregamentoLeaflet;
        }

        var urls = [
            'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
            'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
        ];
        estado.carregamentoLeaflet = new Promise(function (resolve, reject) {
            function carregarProximaUrl(indice, erroAnterior) {
                if (window.L) {
                    resolve();
                    return;
                }
                if (indice >= urls.length) {
                    estado.carregamentoLeaflet = null;
                    reject(erroAnterior || new Error('Leaflet não ficou disponível após carregar os CDNs.'));
                    return;
                }

                if (indice > 0) {
                    var folhaLeaflet = document.getElementById('leaflet-stylesheet');
                    if (folhaLeaflet) {
                        folhaLeaflet.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
                    }
                }
                var script = document.createElement('script');
                script.src = urls[indice];
                script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
                script.crossOrigin = 'anonymous';
                script.onload = function () {
                    if (window.L) {
                        resolve();
                    } else {
                        carregarProximaUrl(indice + 1, new Error('O script carregou, mas não registrou window.L.'));
                    }
                };
                script.onerror = function () {
                    carregarProximaUrl(indice + 1, new Error('Falha ao carregar Leaflet de ' + urls[indice]));
                };
                document.head.appendChild(script);
            }
            carregarProximaUrl(0);
        });
        return estado.carregamentoLeaflet;
    }

    function eCenarioValido(local) {
        return Boolean(local)
            && typeof local.id === 'string'
            && typeof local.nome === 'string'
            && typeof local.panoramaPath === 'string'
            && /^fotos_360\/[^/]+\.(?:jpe?g|png|webp)$/i.test(local.panoramaPath)
            && Number.isFinite(local.latitude)
            && local.latitude >= -90
            && local.latitude <= 90
            && Number.isFinite(local.longitude)
            && local.longitude >= -180
            && local.longitude <= 180;
    }

    function chaveGeografica(local) {
        return local.latitude.toFixed(6) + ',' + local.longitude.toFixed(6);
    }

    function prepararSequenciaDaPartida() {
        var vistos = new Set();
        estado.sequenciaLocais = estado.candidatos.filter(function (local) {
            var chave = chaveGeografica(local);
            if (vistos.has(chave)) {
                return false;
            }
            vistos.add(chave);
            return true;
        });
        for (var indice = estado.sequenciaLocais.length - 1; indice > 0; indice -= 1) {
            var aleatorio = Math.floor(Math.random() * (indice + 1));
            var temporario = estado.sequenciaLocais[indice];
            estado.sequenciaLocais[indice] = estado.sequenciaLocais[aleatorio];
            estado.sequenciaLocais[aleatorio] = temporario;
        }
        if (estado.sequenciaLocais.length > 1
            && estado.sequenciaLocais[0].id === estado.ultimoLocalId) {
            var outroLocal = estado.sequenciaLocais.findIndex(function (local) {
                return local.id !== estado.ultimoLocalId;
            });
            var primeiro = estado.sequenciaLocais[0];
            estado.sequenciaLocais[0] = estado.sequenciaLocais[outroLocal];
            estado.sequenciaLocais[outroLocal] = primeiro;
        }
        estado.rodadasPlanejadas = Math.min(maxRodadas, estado.sequenciaLocais.length);
        estado.proximoLocal = 0;
    }

    function lerUltimoLocal() {
        try {
            return window.sessionStorage.getItem(chaveUltimoLocal) || '';
        } catch (erro) {
            return '';
        }
    }

    function registrarUltimoLocal(id) {
        estado.ultimoLocalId = id;
        try {
            window.sessionStorage.setItem(chaveUltimoLocal, id);
        } catch (erro) {
            // A sessão continua funcional quando o armazenamento do navegador está bloqueado.
        }
    }

    function candidatosDisponiveis() {
        return estado.sequenciaLocais.slice(estado.proximoLocal).filter(function (local) {
            return !estado.locaisIndisponiveis.has(local.id);
        });
    }

    function limparMarcadorDoPalpite() {
        if (estado.marcadorPalpite && estado.mapa) {
            estado.mapa.removeLayer(estado.marcadorPalpite);
        }
        estado.marcadorPalpite = null;
        estado.palpite = null;
        atualizarBotaoConfirmar();
    }

    function limparMapaDePalpite() {
        limparMarcadorDoPalpite();
        if (estado.mapa) {
            estado.mapa.eachLayer(function (layer) {
                if (layer !== estado.camadaBaseMapa && layer !== estado.marcadorPalpite) {
                    estado.mapa.removeLayer(layer);
                }
            });
            estado.mapa.setView([-28.235, -48.668], 10);
            estado.mapa.invalidateSize();
        }
    }

    function atualizarCursorTutorialMapa() {
        var cursor = estado.cursorTutorialMapa;
        if (!cursor || !estado.mapa || !estado.localDemonstracao) {
            return;
        }
        var visivel = tutorialAtivo
            && etapaTutorial === 2
            && dialogoMapa.open
            && !tutorialLocalSelecionado;
        cursor.classList.toggle('is-visible', visivel);
        if (visivel) {
            var ponto = estado.mapa.latLngToContainerPoint([
                estado.localDemonstracao.latitude,
                estado.localDemonstracao.longitude
            ]);
            cursor.style.left = ponto.x + 'px';
            cursor.style.top = ponto.y + 'px';
        }
    }

    function sincronizarInteracoesMapaTutorial() {
        if (!estado.mapa) {
            return;
        }
        var mapaEstatico = tutorialAtivo && etapaTutorial === 2 && dialogoMapa.open;
        ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard'].forEach(function (interacao) {
            var controle = estado.mapa[interacao];
            if (controle && typeof controle[mapaEstatico ? 'disable' : 'enable'] === 'function') {
                controle[mapaEstatico ? 'disable' : 'enable']();
            }
        });
        mapaElement.classList.toggle('is-tutorial-static', mapaEstatico);
    }

    function atualizarSelecaoDemonstrativa(ponto) {
        var local = estado.localDemonstracao;
        tutorialLocalSelecionado = Boolean(local)
            && calcularDistancia(ponto, { lat: local.latitude, lng: local.longitude }) <= 150;
        if (tutorialLocalSelecionado) {
            setStatus(statusMapaDialogo, 'Localização correta selecionada. Prossiga para confirmar o palpite.');
            setStatus(statusMapa, 'Muito bem! Você marcou o local correto da demonstração.');
            etapaTutorial = 3;
            atualizarEtapaTutorial();
            atualizarBotaoConfirmar();
        } else {
            setStatus(statusMapaDialogo, 'Ajuste o marcador até a mãozinha indicar o ponto correto da fotografia.');
            setStatus(statusMapa, 'O ponto ainda não corresponde ao local indicado. Você pode tentar novamente.');
            atualizarCursorTutorialMapa();
            atualizarBotaoConfirmar();
        }
    }

    function destruirPanorama() {
        estado.tokenPanorama += 1;
        if (estado.panorama) {
            estado.panorama.destroy();
            estado.panorama = null;
        }
    }

    function mostrarFallbackPanorama(mensagem) {
        var aviso = document.createElement('div');
        aviso.className = 'panorama-fallback';
        var icone = document.createElement('i');
        icone.className = 'fas fa-panorama';
        icone.setAttribute('aria-hidden', 'true');
        var texto = document.createElement('p');
        texto.textContent = mensagem;
        aviso.append(icone, texto);
        document.getElementById('panorama').replaceChildren(aviso);
    }

    function atualizarBotaoNovaLocalizacao() {
        var rodadaRespondida = estado.resultados.length > estado.rodada;
        var falhaSemResposta = estado.panoramaComErro && estado.resultados.length === estado.rodada;
        var falhaComAlternativa = falhaSemResposta && candidatosDisponiveis().length > 0;
        botaoNovaLocalizacao.disabled = !(rodadaRespondida || falhaComAlternativa);
        if (estado.resultados.length >= estado.rodadasPlanejadas && rodadaRespondida) {
            botaoNovaLocalizacao.innerHTML = '<i class="fas fa-flag-checkered" aria-hidden="true"></i> Ver resultado final';
        } else {
            botaoNovaLocalizacao.innerHTML = '<i class="fas fa-random" aria-hidden="true"></i> Nova localização';
        }
        document.getElementById('new-location-hint').hidden = rodadaRespondida || falhaSemResposta;
    }

    function aoFalharPanorama(local, token) {
        if (token !== estado.tokenPanorama || !estado.localAtual || local.id !== estado.localAtual.id) {
            return;
        }
        estado.panoramaPronto = false;
        estado.panoramaComErro = true;
        estado.locaisIndisponiveis.add(local.id);
        atualizarBotaoConfirmar();
        mostrarFallbackPanorama('Não foi possível carregar esta fotografia 360°. Tente novamente ou sorteie outro cenário; esta rodada ainda não foi registrada.');
        setStatus(statusPanorama, 'Falha ao carregar ' + local.panoramaPath + '.', true);
        document.getElementById('retry-panorama-button').hidden = false;
        document.getElementById('error-new-location-button').hidden = candidatosDisponiveis().length === 0;
        acoesErroPanorama.hidden = false;
        atualizarBotaoNovaLocalizacao();
    }

    function carregarPanorama(local) {
        destruirPanorama();
        estado.panoramaPronto = false;
        estado.panoramaComErro = false;
        acoesErroPanorama.hidden = true;
        document.getElementById('panorama').replaceChildren();
        var token = estado.tokenPanorama;
        if (!window.pannellum) {
            aoFalharPanorama(local, token);
            return;
        }

        setStatus(statusPanorama, 'Carregando fotografia 360°…');
        try {
            estado.panorama = window.pannellum.viewer('panorama', {
                type: 'equirectangular',
                panorama: local.panoramaPath,
                autoLoad: true,
                showControls: true,
                showZoomCtrl: true,
                showFullscreenCtrl: true,
                mouseZoom: true,
                doubleClickZoom: true,
                draggable: true,
                hfov: 100,
                minHfov: 45,
                maxHfov: 120,
                yaw: Number.isFinite(local.panoramaYaw) ? local.panoramaYaw : 0,
                pitch: Number.isFinite(local.panoramaPitch) ? local.panoramaPitch : 0,
                minPitch: -90,
                maxPitch: 90
            });
            estado.panorama.on('load', function () {
                if (token !== estado.tokenPanorama) {
                    return;
                }
                estado.panoramaPronto = true;
                estado.panoramaComErro = false;
                estado.locaisIndisponiveis.delete(local.id);
                atualizarBotaoConfirmar();
                acoesErroPanorama.hidden = true;
                setStatus(statusPanorama, 'Panorama interativo pronto. Arraste para explorar a paisagem e use os controles de zoom.');
                atualizarBotaoNovaLocalizacao();
            });
            estado.panorama.on('error', function () {
                aoFalharPanorama(local, token);
            });
        } catch (erro) {
            aoFalharPanorama(local, token);
        }
    }

    function escolherLocal() {
        var localEscolhido = null;
        while (estado.proximoLocal < estado.sequenciaLocais.length && !localEscolhido) {
            var proximo = estado.sequenciaLocais[estado.proximoLocal];
            estado.proximoLocal += 1;
            if (!estado.locaisIndisponiveis.has(proximo.id)) {
                localEscolhido = proximo;
            }
        }
        if (!localEscolhido) {
            estado.localAtual = null;
            estado.panoramaPronto = false;
            mostrarFallbackPanorama('Não há outros locais únicos disponíveis nesta partida. Você pode iniciar uma nova partida para sortear novamente.');
            setStatus(statusPanorama, 'Todos os locais únicos desta partida foram utilizados.', true);
            botaoNovaLocalizacao.disabled = true;
            return false;
        }

        estado.localAtual = localEscolhido;
        registrarUltimoLocal(estado.localAtual.id);
        estado.rodada = estado.resultados.length;
        iniciarCenarioAtual();
        return true;
    }

    function iniciarCenarioAtual() {
        var local = estado.localAtual;
        if (!local) {
            return;
        }
        limparMapaResultado();
        estado.panoramaComErro = false;
        estado.panoramaPronto = false;
        limparMapaDePalpite();
        painelResultado.hidden = true;
        painelResultado.replaceChildren();
        palcoPanorama.classList.toggle('is-result', false);
        document.getElementById('panorama-title').textContent = 'Observe a paisagem';
        botaoConfirmar.hidden = false;
        atualizarBotaoConfirmar();
        setStatus(statusMapaDialogo, 'Ainda não há um ponto selecionado. Escolha um ponto no mapa para habilitar seu palpite.');
        document.getElementById('round-title').textContent = tutorialAtivo
            ? 'Demonstração guiada'
            : 'Desafio ' + (estado.rodada + 1) + ' de ' + estado.rodadasPlanejadas;
        document.getElementById('round-progress').replaceChildren.apply(
            document.getElementById('round-progress'),
            Array.from({ length: tutorialAtivo ? 0 : estado.rodadasPlanejadas }).map(function (_, indice) {
                var item = document.createElement('span');
                item.className = indice < estado.rodada ? 'is-complete' : (indice === estado.rodada ? 'is-current' : '');
                item.setAttribute('aria-hidden', 'true');
                return item;
            })
        );
        if (estado.mapa) {
            setStatus(statusMapa, 'Marque no mapa o local onde acredita que a paisagem está.');
        } else {
            setStatus(statusMapa, 'Mapa indisponível. Tente carregar o mapa novamente para marcar o palpite.', true);
            botaoTentarMapa.hidden = false;
        }
        if (estado.mapa) {
            estado.mapa.invalidateSize();
        }
        carregarPanorama(local);
        atualizarBotaoNovaLocalizacao();
    }

    function inicializarMapa() {
        if (estado.mapa) {
            return true;
        }
        if (!window.L) {
            setStatus(statusMapa, 'A biblioteca Leaflet ainda não está disponível.', true);
            botaoConfirmar.disabled = true;
            return false;
        }
        try {
            var mapa = window.L.map(mapaElement, {
                scrollWheelZoom: true,
                zoomControl: false
            }).setView([-28.235, -48.668], 10);
            window.L.control.zoom({ position: 'topright' }).addTo(mapa);
            var camada = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            });
            estado.tilesCarregados = false;
            estado.tilesComErro = false;
            camada.on('tileload', function () {
                estado.tilesCarregados = true;
                botaoTentarMapa.hidden = true;
                if (estado.tilesComErro) {
                    setStatus(statusMapa, 'O mapa está funcionando; alguns blocos cartográficos não carregaram.');
                }
            });
            camada.on('tileerror', function () {
                estado.tilesComErro = true;
                if (!estado.tilesCarregados) {
                    setStatus(statusMapa, 'O mapa foi criado, mas os blocos cartográficos não responderam. Você ainda pode tentar marcar o local.', true);
                    botaoTentarMapa.hidden = false;
                }
            });
            estado.mapa = mapa;
            estado.camadaBaseMapa = camada.addTo(mapa);
            estado.cursorTutorialMapa = document.createElement('span');
            estado.cursorTutorialMapa.className = 'tutorial-map-pointer';
            estado.cursorTutorialMapa.setAttribute('aria-hidden', 'true');
            estado.cursorTutorialMapa.innerHTML = '<i class="fas fa-hand-pointer" aria-hidden="true"></i>';
            mapaElement.appendChild(estado.cursorTutorialMapa);
            mapa.on('moveend zoomend resize', atualizarCursorTutorialMapa);
        } catch (erro) {
            console.error('[Desafio 360] Não foi possível inicializar o mapa Leaflet.', erro);
            if (typeof mapa !== 'undefined') {
                mapa.remove();
            }
            estado.mapa = null;
            estado.camadaBaseMapa = null;
            botaoTentarMapa.hidden = false;
            setStatus(statusMapa, 'Não foi possível criar o mapa. Tente carregar novamente; o panorama continua disponível.', true);
            return false;
        }
        try {
            estado.mapa.on('click', function (evento) {
                if (estado.resultados.length > estado.rodada || estado.panoramaComErro) {
                    return;
                }
                estado.palpite = { lat: evento.latlng.lat, lng: evento.latlng.lng };
                if (!estado.marcadorPalpite) {
                    var iconePalpite = window.L.divIcon({
                        className: 'guess-marker-icon',
                        html: '<span class="guess-marker"><i class="fas fa-location-dot" aria-hidden="true"></i></span>',
                        iconSize: [34, 40],
                        iconAnchor: [17, 40]
                    });
                    estado.marcadorPalpite = window.L.marker(evento.latlng, {
                        draggable: true,
                        riseOnHover: true,
                        icon: iconePalpite
                    }).addTo(estado.mapa);
                    estado.marcadorPalpite.on('dragend', function (dragEvento) {
                        var ponto = dragEvento.target.getLatLng();
                        estado.palpite = { lat: ponto.lat, lng: ponto.lng };
                        if (tutorialAtivo && etapaTutorial === 2) {
                            atualizarSelecaoDemonstrativa(estado.palpite);
                        } else {
                            setStatus(statusMapaDialogo, 'Ponto ajustado. Confirme para registrar seu palpite.');
                            setStatus(statusMapa, 'Palpite marcado. Clique novamente ou arraste o marcador para ajustar.');
                            atualizarBotaoConfirmar();
                        }
                    });
                } else {
                    estado.marcadorPalpite.setLatLng(evento.latlng);
                }
                if (tutorialAtivo && etapaTutorial === 2) {
                    atualizarSelecaoDemonstrativa(estado.palpite);
                } else {
                    atualizarBotaoConfirmar();
                    setStatus(statusMapaDialogo, 'Ponto selecionado. Confirme para registrar seu palpite.');
                    setStatus(statusMapa, 'Palpite marcado. Clique novamente ou arraste o marcador para ajustar.');
                    atualizarBotaoConfirmar();
                }
            });
        } catch (erro) {
            console.error('[Desafio 360] Não foi possível conectar os controles ao mapa Leaflet.', erro);
            estado.mapa.remove();
            estado.mapa = null;
            estado.camadaBaseMapa = null;
            botaoTentarMapa.hidden = false;
            setStatus(statusMapa, 'Não foi possível preparar os controles do mapa. Tente carregar novamente.', true);
            return false;
        }
        atualizarBotaoConfirmar();
        return true;
    }

    function tentarCarregarMapa() {
        botaoTentarMapa.disabled = true;
        setStatus(statusMapa, 'Carregando biblioteca e mapa…');
        carregarLeaflet().then(function () {
            if (!estado.mapa && !inicializarMapa()) {
                botaoTentarMapa.disabled = false;
                return;
            }
            botaoTentarMapa.disabled = false;
            if (estado.camadaBaseMapa) {
                estado.camadaBaseMapa.redraw();
            }
            estado.mapa.invalidateSize();
            if (!estado.tilesCarregados) {
                botaoTentarMapa.hidden = false;
                setStatus(statusMapa, 'Mapa criado. A camada cartográfica está sendo atualizada; se os blocos não aparecerem, você pode tentar novamente.');
            }
        }).catch(function (erro) {
            console.error('[Desafio 360] Não foi possível carregar a biblioteca Leaflet.', erro);
            botaoTentarMapa.hidden = false;
            botaoTentarMapa.disabled = false;
            setStatus(statusMapa, 'A biblioteca do mapa não carregou. Tente novamente; o panorama continua disponível.', true);
        });
    }

    function criarMarcadorResultado(coordenadas, cor, rotulo, mapa) {
        var tipo = cor === '#d97706' ? 'guess' : 'correct';
        var icone = window.L.divIcon({
            className: 'result-marker-icon',
            html: '<span class="result-marker result-marker-' + tipo + '"><i class="fas '
                + (tipo === 'guess' ? 'fa-location-dot' : 'fa-flag-checkered')
                + '" aria-hidden="true"></i></span>',
            iconSize: [32, 38],
            iconAnchor: [16, 38]
        });
        return window.L.marker(coordenadas, { icon: icone }).bindTooltip(rotulo).addTo(mapa);
    }

    function adicionarReferencia(lista, fonte) {
        if (!fonte || !fonte.url || !fonte.nome) {
            return;
        }
        var item = document.createElement('li');
        var link = document.createElement('a');
        link.href = fonte.url;
        link.textContent = fonte.nome;
        if (/^https?:/i.test(fonte.url)) {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        }
        item.appendChild(link);
        lista.appendChild(item);
    }

    function limparMapaResultado() {
        if (estado.mapaResultado) {
            estado.mapaResultado.remove();
            estado.mapaResultado = null;
        }
    }

    function montarResultado(resultado, demonstracao) {
        limparMapaResultado();
        painelResultado.replaceChildren();
        painelResultado.hidden = false;
        painelResultado.classList.toggle('is-expanded', false);
        palcoPanorama.classList.toggle('is-result', true);
        document.getElementById('panorama-title').textContent = 'Resultado da rodada';
        botaoConfirmar.hidden = true;
        botaoConfirmar.disabled = true;
        acoesErroPanorama.hidden = true;
        botaoNovaLocalizacao.disabled = false;

        var local = resultado.local;
        var alternadorPainel = document.createElement('button');
        alternadorPainel.className = 'result-sheet-toggle';
        alternadorPainel.type = 'button';
        alternadorPainel.setAttribute('aria-expanded', 'false');
        alternadorPainel.setAttribute('aria-label', 'Expandir painel de resultado');
        alternadorPainel.innerHTML = '<span aria-hidden="true"></span>';
        var gestoPainel = false;
        alternadorPainel.addEventListener('click', function () {
            if (gestoPainel) {
                gestoPainel = false;
                return;
            }
            var expandido = painelResultado.classList.toggle('is-expanded');
            alternadorPainel.setAttribute('aria-expanded', String(expandido));
            alternadorPainel.setAttribute('aria-label', expandido ? 'Recolher painel de resultado' : 'Expandir painel de resultado');
        });
        alternadorPainel.addEventListener('pointerdown', function (evento) {
            alternadorPainel.dataset.startY = String(evento.clientY);
        });
        alternadorPainel.addEventListener('pointerup', function (evento) {
            var startY = Number(alternadorPainel.dataset.startY);
            if (!Number.isFinite(startY) || Math.abs(evento.clientY - startY) < 18) {
                return;
            }
            gestoPainel = true;
            var expandido = evento.clientY < startY;
            painelResultado.classList.toggle('is-expanded', expandido);
            alternadorPainel.setAttribute('aria-expanded', String(expandido));
            alternadorPainel.setAttribute('aria-label', expandido ? 'Recolher painel de resultado' : 'Expandir painel de resultado');
        });
        painelResultado.appendChild(alternadorPainel);
        var layout = document.createElement('div');
        layout.className = 'result-layout';
        var mapaColuna = document.createElement('section');
        mapaColuna.className = 'result-map-column';
        mapaColuna.setAttribute('aria-label', 'Mapa da sua resposta');
        var mapaResultadoElement = document.createElement('div');
        mapaResultadoElement.className = 'result-map';
        mapaResultadoElement.setAttribute('role', 'region');
        mapaResultadoElement.setAttribute('aria-label', 'Mapa comparando o palpite e o local correto');
        mapaColuna.appendChild(mapaResultadoElement);
        var legenda = document.createElement('div');
        legenda.className = 'result-map-legend';
        legenda.innerHTML = '<span><i class="fas fa-location-dot result-legend-guess" aria-hidden="true"></i> Seu palpite</span>'
            + '<span><i class="fas fa-flag-checkered result-legend-correct" aria-hidden="true"></i> Local correto</span>';
        mapaColuna.appendChild(legenda);

        var informacoes = document.createElement('section');
        informacoes.className = 'result-info';
        informacoes.setAttribute('aria-label', 'Informações do resultado');
        var cabecalho = document.createElement('div');
        cabecalho.className = 'result-info-heading';
        var titulo = document.createElement('div');
        var eyebrow = document.createElement('span');
        eyebrow.className = 'eyebrow';
        eyebrow.textContent = 'Resposta revelada';
        var nome = document.createElement('h2');
        nome.textContent = local.nome;
        nome.setAttribute('tabindex', '-1');
        titulo.append(eyebrow, nome);
        cabecalho.appendChild(titulo);
        informacoes.appendChild(cabecalho);

        var metricas = document.createElement('div');
        metricas.className = 'result-metrics';
        var selo = document.createElement('span');
        selo.className = 'score-badge';
        selo.textContent = '0 / ' + maxPontos.toLocaleString('pt-BR') + ' pontos';
        var pontuacao = document.createElement('div');
        pontuacao.className = 'result-metric result-score';
        var rotuloPontos = document.createElement('span');
        rotuloPontos.textContent = 'Pontuação da rodada';
        pontuacao.append(rotuloPontos, selo);
        var distancia = document.createElement('div');
        distancia.className = 'result-metric';
        var rotuloDistancia = document.createElement('span');
        rotuloDistancia.textContent = 'Distância do palpite';
        var valorDistancia = document.createElement('strong');
        valorDistancia.textContent = formatarDistancia(resultado.distancia);
        distancia.append(rotuloDistancia, valorDistancia);
        metricas.append(pontuacao, distancia);
        informacoes.appendChild(metricas);

        var mensagemDesempenho = document.createElement('p');
        mensagemDesempenho.className = 'result-note result-performance';
        mensagemDesempenho.textContent = resultado.pontos >= 4000
            ? 'Excelente! Você chegou muito perto!'
            : resultado.pontos >= 2500
                ? 'Muito bem! Você conseguiu identificar a região!'
                : resultado.pontos >= 1000
                    ? 'Quase lá! Continue explorando!'
                    : 'Continue tentando! A próxima rodada pode render mais pontos!';
        animarPontuacao(selo, resultado.pontos);

        var resumo = document.createElement('p');
        resumo.className = 'result-location-coordinates';
        resumo.textContent = 'Localização correta: ' + local.latitude + ', ' + local.longitude;
        informacoes.appendChild(resumo);

        estado.mapaResultado = window.L.map(mapaResultadoElement, { scrollWheelZoom: true, zoomControl: true });
        window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(estado.mapaResultado);
        var correto = [local.latitude, local.longitude];
        var palpite = [resultado.palpite.lat, resultado.palpite.lng];
        criarMarcadorResultado(palpite, '#d97706', 'Seu palpite', estado.mapaResultado);
        criarMarcadorResultado(correto, '#125f5f', 'Local correto', estado.mapaResultado);
        window.L.polyline([palpite, correto], { color: '#092f3b', weight: 3, dashArray: '7 7' }).addTo(estado.mapaResultado);
        estado.mapaResultado.fitBounds([palpite, correto], { padding: [35, 35], maxZoom: 14 });

        var detalhes = document.createElement('div');
        detalhes.className = 'result-education';
        var informacao = document.createElement('div');
        var tituloInformacao = document.createElement('h3');
        tituloInformacao.textContent = 'Conheça o local';
        informacao.appendChild(tituloInformacao);
        if (local.descricao) {
            var descricao = document.createElement('p');
            descricao.textContent = local.descricao;
            informacao.appendChild(descricao);
        }
        if (local.importancia) {
            var importancia = document.createElement('p');
            importancia.innerHTML = '<strong>Importância e relação com a APABF:</strong> ';
            importancia.appendChild(document.createTextNode(local.importancia));
            informacao.appendChild(importancia);
        }
        if (local.curiosidade) {
            var curiosidade = document.createElement('p');
            curiosidade.innerHTML = '<strong>Curiosidade:</strong> ';
            curiosidade.appendChild(document.createTextNode(local.curiosidade));
            informacao.appendChild(curiosidade);
        }
        if (!local.descricao && !local.importancia && !local.curiosidade) {
            var pendente = document.createElement('p');
            pendente.className = 'result-note';
            pendente.textContent = 'As informações educativas específicas deste cenário aguardam validação e cadastro de fontes. Nenhum dado histórico, cultural ou ambiental foi inferido.';
            informacao.appendChild(pendente);
        }
        var autoria = document.createElement('p');
        autoria.textContent = 'Autoria da fotografia: ' + (local.autoriaFotografia || 'não informada no cadastro.');
        informacao.appendChild(autoria);

        var referencias = document.createElement('div');
        var tituloReferencias = document.createElement('h3');
        tituloReferencias.textContent = 'Fontes e referências';
        referencias.appendChild(tituloReferencias);
        var lista = document.createElement('ul');
        (Array.isArray(local.fontes) ? local.fontes : []).forEach(function (fonte) {
            adicionarReferencia(lista, fonte);
        });
        if (local.fonteFotografia) {
            adicionarReferencia(lista, local.fonteFotografia);
        }
        if (local.panoramaUrl) {
            adicionarReferencia(lista, { nome: 'Abrir localização de referência no Google Maps', url: local.panoramaUrl });
        }
        if (!lista.children.length) {
            var fontePendente = document.createElement('li');
            fontePendente.textContent = 'Fontes locais específicas pendentes de validação.';
            lista.appendChild(fontePendente);
        }
        referencias.appendChild(lista);
        detalhes.append(informacao, referencias, mensagemDesempenho);
        if (demonstracao) {
            var explicacaoPontuacao = document.createElement('p');
            explicacaoPontuacao.className = 'result-note tutorial-score-explanation';
            explicacaoPontuacao.textContent =
                'A pontuação diminui conforme aumenta a distância entre o palpite e o local correto.';
            detalhes.appendChild(explicacaoPontuacao);
        }
        informacoes.appendChild(detalhes);
        var acoesResultado = document.createElement('div');
        acoesResultado.className = 'result-actions';
        var avancar = document.createElement('button');
        avancar.className = 'primary-button';
        avancar.type = 'button';
        if (demonstracao) {
            avancar.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i> Começar partida oficial';
            avancar.addEventListener('click', iniciarSessaoOficial);
        } else {
            avancar.innerHTML = estado.resultados.length >= estado.rodadasPlanejadas
                ? '<i class="fas fa-flag-checkered" aria-hidden="true"></i> Ver resultado final'
                : '<i class="fas fa-arrow-right" aria-hidden="true"></i> Próxima localização';
            avancar.addEventListener('click', selecionarNovaLocalizacao);
        }
        acoesResultado.appendChild(avancar);
        informacoes.append(acoesResultado);
        layout.append(mapaColuna, informacoes);
        painelResultado.appendChild(layout);
        window.setTimeout(function () {
            if (estado.mapaResultado) {
                estado.mapaResultado.invalidateSize();
            }
        }, 0);
    }

    function confirmarResposta() {
        if (!estado.palpite) {
            setStatus(statusMapa, 'Marque um ponto no mapa antes de confirmar.', true);
            setStatus(statusMapaDialogo, 'Ainda não há um ponto selecionado. Toque ou clique no mapa para escolher seu palpite.', true);
            return;
        }
        if (!estado.localAtual || !estado.panoramaPronto || estado.resultados.length > estado.rodada) {
            return;
        }
        if (tutorialAtivo && (etapaTutorial !== 3 || !tutorialLocalSelecionado)) {
            return;
        }
        var local = estado.localAtual;
        var distancia = calcularDistancia(estado.palpite, { lat: local.latitude, lng: local.longitude });
        var resultado = {
            local: local,
            palpite: { lat: estado.palpite.lat, lng: estado.palpite.lng },
            distancia: distancia,
            pontos: calcularPontos(distancia)
        };
        if (!tutorialAtivo) {
            estado.resultados.push(resultado);
        }
        var demonstracao = tutorialAtivo;
        montarResultado(resultado, demonstracao);
        if (dialogoMapa.open) dialogoMapa.close();
        if (demonstracao) {
            etapaTutorial = 4;
            atualizarEtapaTutorial();
        }
        painelResultado.setAttribute('tabindex', '-1');
        painelResultado.focus();
        atualizarBotaoNovaLocalizacao();
    }

    function animarPontuacao(elemento, pontuacao) {
        var movimentoReduzido = window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        var quadros = movimentoReduzido ? 1 : 20;
        var quadro = 0;
        function atualizar() {
            quadro += 1;
            var valor = Math.round(pontuacao * quadro / quadros);
            elemento.textContent = valor.toLocaleString('pt-BR')
                + ' / ' + maxPontos.toLocaleString('pt-BR') + ' pontos';
            if (quadro < quadros) {
                window.setTimeout(atualizar, 45);
            }
        }
        window.setTimeout(atualizar, movimentoReduzido ? 0 : 70);
    }

    function atualizarDimensoesMapa() {
        window.setTimeout(function () {
            if (estado.mapa) {
                estado.mapa.invalidateSize();
                atualizarCursorTutorialMapa();
            }
        }, 30);
    }

    function abrirMapaAmpliado() {
        if (!estado.mapa || dialogoMapa.open) {
            return;
        }
        slotMapaDialogo.appendChild(mapaElement);
        slotConfirmacaoDialogo.appendChild(botaoConfirmar);
        jogo.classList.toggle('is-map-expanded', true);
        dialogoMapa.showModal();
        botaoAmpliarMapa.setAttribute('aria-expanded', 'true');
        if (tutorialAtivo && etapaTutorial === 1) {
            etapaTutorial = 2;
            estado.mapa.setView([
                estado.localDemonstracao.latitude,
                estado.localDemonstracao.longitude
            ], 14);
            atualizarEtapaTutorial();
        }
        sincronizarInteracoesMapaTutorial();
        atualizarDimensoesMapa();
    }

    function fecharMapaAmpliado() {
        if (dialogoMapa.open) {
            dialogoMapa.close();
        }
    }

    function aoFecharMapaAmpliado() {
        sincronizarInteracoesMapaTutorial();
        slotMapaEmLinha.appendChild(mapaElement);
        slotConfirmacaoEmLinha.appendChild(botaoConfirmar);
        jogo.classList.toggle('is-map-expanded', false);
        botaoAmpliarMapa.setAttribute('aria-expanded', 'false');
        if (estado.mapa) {
            atualizarDimensoesMapa();
        }
        if (painelResultado.hidden) {
            botaoAmpliarMapa.focus();
        }
    }

    function limparDestaquesTutorial() {
        ['panorama', 'map-card', 'expand-map-button', 'guess-map', 'confirm-button', 'result-panel'].forEach(function (id) {
            document.getElementById(id).classList.toggle('tutorial-target', false);
        });
        palcoPanorama.classList.toggle('tutorial-panorama-drag', false);
        document.getElementById('expand-map-button').classList.toggle('tutorial-expand-cursor', false);
        mapaElement.classList.toggle('tutorial-map-pick', false);
        atualizarCursorTutorialMapa();
    }

    function atualizarEtapaTutorial() {
        limparDestaquesTutorial();
        dialogoTutorial.hidden = false;
        if (dialogoTutorial.open) {
            dialogoTutorial.close();
        }
        dialogoTutorial.show();
        var etapa = etapasTutorial[etapaTutorial];
        var alvo = document.getElementById(etapa.alvo);
        if (alvo) {
            alvo.classList.toggle('tutorial-target', true);
        }
        if (etapaTutorial === 1) {
            document.getElementById('map-card').classList.toggle('tutorial-target', true);
            document.getElementById('expand-map-button').classList.toggle('tutorial-expand-cursor', true);
        }
        if (etapaTutorial === 0) {
            palcoPanorama.classList.toggle('tutorial-panorama-drag', true);
        }
        if (etapaTutorial === 2) {
            mapaElement.classList.toggle('tutorial-target', true);
            window.setTimeout(function () {
                if (estado.mapa) {
                    estado.mapa.invalidateSize();
                    atualizarCursorTutorialMapa();
                }
            }, 30);
        }
        sincronizarInteracoesMapaTutorial();
        document.getElementById('tutorial-step-label').textContent = 'Etapa ' + (etapaTutorial + 1) + ' de ' + etapasTutorial.length;
        document.getElementById('tutorial-title').textContent = etapa.titulo;
        document.getElementById('tutorial-copy').textContent = etapa.texto;
        document.getElementById('tutorial-previous').disabled = etapaTutorial === 0 || etapaTutorial > 1;
        document.getElementById('tutorial-next').hidden = etapaTutorial >= 3;
        document.getElementById('tutorial-skip').hidden = etapaTutorial === 4;
        document.getElementById('tutorial-next').disabled = etapaTutorial !== 0;
        document.getElementById('tutorial-next').textContent = etapaTutorial === 0
            ? 'Prosseguir'
            : etapaTutorial === 1
                ? 'Abra o mapa para prosseguir'
                : 'Selecione o ponto indicado';
        document.getElementById('tutorial-progress').replaceChildren.apply(
            document.getElementById('tutorial-progress'),
            etapasTutorial.map(function (_, indice) {
                var item = document.createElement('span');
                item.className = indice < etapaTutorial ? 'is-complete' : (indice === etapaTutorial ? 'is-current' : '');
                return item;
            })
        );
    }

    function marcarTutorialApresentado() {
        try {
            window.localStorage.setItem(chaveTutorialApresentado, 'true');
        } catch (erro) {
            // O tutorial continua acessível pelo botão de ajuda se o armazenamento estiver bloqueado.
        }
    }

    function prepararDemonstracao() {
        var local = estado.localDemonstracao;
        if (!local) {
            setStatus(statusPanorama, 'Não há um cenário válido disponível para demonstrar o tutorial.', true);
            return;
        }
        tutorialAtivo = true;
        tutorialLocalSelecionado = false;
        etapaTutorial = 0;
        estado.localAtual = local;
        estado.rodada = 0;
        estado.resultados = [];
        jogo.hidden = false;
        final.hidden = true;
        if (dialogoEscolhaTutorial.open) {
            dialogoEscolhaTutorial.close();
        }
        if (dialogoMapa.open) {
            dialogoMapa.close();
        }
        if (!estado.mapa && !inicializarMapa()) {
            document.getElementById('retry-map-button').hidden = false;
            return;
        }
        iniciarCenarioAtual();
        atualizarEtapaTutorial();
    }

    function iniciarDemonstracao() {
        marcarTutorialApresentado();
        if (!estado.localDemonstracao) {
            estado.localDemonstracao = estado.candidatos[0] || null;
        }
        if (window.L) {
            prepararDemonstracao();
            return;
        }
        setStatus(statusMapa, 'Preparando mapa para a demonstração guiada…');
        carregarLeaflet().then(function () {
            if (!estado.mapa && !inicializarMapa()) {
                document.getElementById('retry-map-button').hidden = false;
                return;
            }
            prepararDemonstracao();
        }).catch(function (erro) {
            console.error('[Desafio 360] Não foi possível carregar o mapa do tutorial.', erro);
            setStatus(statusMapa, 'Não foi possível carregar o mapa para a demonstração. Tente novamente.', true);
            document.getElementById('retry-map-button').hidden = false;
        });
    }

    function iniciarSessaoOficial() {
        tutorialAtivo = false;
        tutorialLocalSelecionado = false;
        sincronizarInteracoesMapaTutorial();
        limparDestaquesTutorial();
        if (dialogoTutorial.open) {
            dialogoTutorial.close();
        }
        dialogoTutorial.hidden = true;
        if (dialogoEscolhaTutorial.open) {
            dialogoEscolhaTutorial.close();
        }
        if (dialogoMapa.open) {
            dialogoMapa.close();
        }
        jogo.classList.toggle('is-map-expanded', false);
        iniciarSessao();
    }

    function pularTutorial() {
        marcarTutorialApresentado();
        iniciarSessaoOficial();
    }

    function apresentarTutorialSeNovo() {
        var apresentado = false;
        try {
            apresentado = window.localStorage.getItem(chaveTutorialApresentado) === 'true';
        } catch (erro) {
            // Sem armazenamento disponível, a escolha é oferecida nesta visita.
        }
        if (apresentado) {
            iniciarSessaoOficial();
        } else {
            dialogoEscolhaTutorial.showModal();
        }
    }

    function mostrarFinal() {
        limparMapaResultado();
        jogo.hidden = true;
        final.hidden = false;
        var totalPontos = estado.resultados.reduce(function (soma, resultado) {
            return soma + resultado.pontos;
        }, 0);
        var totalDistancia = estado.resultados.reduce(function (soma, resultado) {
            return soma + resultado.distancia;
        }, 0);
        document.getElementById('final-score').textContent =
            totalPontos.toLocaleString('pt-BR') + ' / ' + (maxPontos * estado.rodadasPlanejadas).toLocaleString('pt-BR') + ' pontos';
        document.getElementById('final-distance').textContent =
            'Distância acumulada: ' + formatarDistancia(totalDistancia);
        var resumo = document.getElementById('round-summary');
        resumo.replaceChildren();
        estado.resultados.forEach(function (resultado, indice) {
            var linha = document.createElement('div');
            linha.className = 'summary-row';
            var local = document.createElement('strong');
            local.textContent = 'Desafio ' + (indice + 1) + ': ' + resultado.local.nome;
            var desempenho = document.createElement('span');
            desempenho.textContent = formatarDistancia(resultado.distancia)
                + ' · ' + resultado.pontos.toLocaleString('pt-BR') + ' pontos';
            linha.append(local, desempenho);
            resumo.appendChild(linha);
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function selecionarNovaLocalizacao() {
        if (estado.panoramaComErro && estado.resultados.length === estado.rodada) {
            escolherLocal();
            return;
        }
        if (estado.resultados.length <= estado.rodada) {
            setStatus(statusMapa, 'Confirme seu palpite antes de trocar de cenário; a rodada atual não será perdida.', true);
            return;
        }
        if (estado.resultados.length >= estado.rodadasPlanejadas) {
            mostrarFinal();
            return;
        }
        estado.rodada = estado.resultados.length;
        escolherLocal();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function tentarNovamente() {
        if (!estado.localAtual || estado.resultados.length > estado.rodada) {
            return;
        }
        estado.locaisIndisponiveis.delete(estado.localAtual.id);
        estado.panoramaComErro = false;
        estado.panoramaPronto = false;
        botaoConfirmar.disabled = true;
        document.getElementById('retry-panorama-button').hidden = false;
        document.getElementById('error-new-location-button').hidden = candidatosDisponiveis().length === 0;
        carregarPanorama(estado.localAtual);
        atualizarBotaoNovaLocalizacao();
    }

    function iniciarSessao() {
        destruirPanorama();
        limparMapaResultado();
        estado.rodada = 0;
        estado.palpite = null;
        estado.resultados = [];
        estado.sequenciaLocais = [];
        estado.proximoLocal = 0;
        estado.rodadasPlanejadas = 0;
        estado.locaisIndisponiveis.clear();
        estado.panoramaComErro = false;
        estado.panoramaPronto = false;
        estado.ultimoLocalId = lerUltimoLocal();
        estado.localAtual = null;
        prepararSequenciaDaPartida();
        jogo.hidden = false;
        final.hidden = true;
        botaoConfirmar.hidden = false;
        botaoNovaLocalizacao.disabled = true;
        if (window.L) {
            if (!estado.mapa && !inicializarMapa()) {
                escolherLocal();
                return;
            }
            botaoTentarMapa.hidden = true;
            escolherLocal();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        setStatus(statusMapa, 'Carregando biblioteca do mapa…');
        carregarLeaflet().then(function () {
            if (!estado.mapa && !inicializarMapa()) {
                escolherLocal();
                return;
            }
            botaoTentarMapa.hidden = true;
            escolherLocal();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }).catch(function (erro) {
            console.error('[Desafio 360] Falha ao carregar a biblioteca Leaflet.', erro);
            botaoTentarMapa.hidden = false;
            setStatus(statusMapa, 'A biblioteca do mapa não carregou. Tente novamente; o panorama continua disponível.', true);
            escolherLocal();
        });
    }

    var identificadoresGeograficos = new Set();
    estado.candidatos = lugares.filter(function (local) {
        if (!eCenarioValido(local)) {
            return false;
        }
        var chave = chaveGeografica(local);
        if (identificadoresGeograficos.has(chave)) {
            return false;
        }
        identificadoresGeograficos.add(chave);
        return true;
    });
    document.getElementById('new-location-button').addEventListener('click', selecionarNovaLocalizacao);
    document.getElementById('error-new-location-button').addEventListener('click', function () {
        escolherLocal();
    });
    document.getElementById('retry-panorama-button').addEventListener('click', tentarNovamente);
    botaoConfirmar.addEventListener('click', function (evento) {
        evento.stopPropagation();
        confirmarResposta();
    });
    document.getElementById('tutorial-button').addEventListener('click', iniciarDemonstracao);
    document.getElementById('learn-to-play-button').addEventListener('click', iniciarDemonstracao);
    document.getElementById('skip-tutorial-button').addEventListener('click', pularTutorial);
    document.getElementById('tutorial-skip').addEventListener('click', pularTutorial);
    document.getElementById('tutorial-next').addEventListener('click', function () {
        if (etapaTutorial === 0) {
            etapaTutorial = 1;
            atualizarEtapaTutorial();
            return;
        }
    });
    document.getElementById('tutorial-previous').addEventListener('click', function () {
        if (etapaTutorial === 1) {
            etapaTutorial = 0;
            atualizarEtapaTutorial();
        }
    });
    botaoAmpliarMapa.addEventListener('click', function (evento) {
        evento.stopPropagation();
        abrirMapaAmpliado();
    });
    document.getElementById('close-map-button').addEventListener('click', function (evento) {
        evento.stopPropagation();
        fecharMapaAmpliado();
    });
    dialogoMapa.addEventListener('close', aoFecharMapaAmpliado);
    document.getElementById('restart-button').addEventListener('click', iniciarSessao);
    botaoTentarMapa.addEventListener('click', tentarCarregarMapa);

    document.getElementById('round-progress').replaceChildren.apply(
        document.getElementById('round-progress'),
        Array.from({ length: maxRodadas }, function () {
            var item = document.createElement('span');
            item.setAttribute('aria-hidden', 'true');
            return item;
        })
    );
    if (!estado.candidatos.length) {
        mostrarFallbackPanorama('Nenhum cenário com fotografia local válida foi encontrado.');
        setStatus(statusPanorama, 'Verifique o cadastro de cenários e os arquivos em fotos_360/.', true);
        botaoNovaLocalizacao.disabled = true;
    } else {
        estado.localDemonstracao = estado.candidatos[0];
        apresentarTutorialSeNovo();
    }
}());
