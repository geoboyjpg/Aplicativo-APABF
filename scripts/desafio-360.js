(function () {
    'use strict';

    var lugares = window.APABF_DESAFIO_360_LOCAIS || [];
    var maxPontos = 5000;
    var distanciaSemPontos = 20000;
    var maxRodadas = 3;
    var chaveUltimoLocal = 'apabf-desafio-360-ultimo-local';
    var estado = {
        rodada: 0,
        palpite: null,
        resultados: [],
        candidatos: [],
        locaisIndisponiveis: new Set(),
        ultimoLocalId: '',
        localAtual: null,
        mapa: null,
        camadaBaseMapa: null,
        marcadorPalpite: null,
        panorama: null,
        panoramaPronto: false,
        panoramaComErro: false,
        tokenPanorama: 0,
        mapaResultado: null
    };

    var jogo = document.getElementById('game-panel');
    var final = document.getElementById('final-panel');
    var mapaElement = document.getElementById('guess-map');
    var slotMapaEmLinha = document.getElementById('map-inline-slot');
    var slotMapaDialogo = document.getElementById('map-dialog-slot');
    var dialogoMapa = document.getElementById('map-dialog');
    var botaoAmpliarMapa = document.getElementById('expand-map-button');
    var botaoNovaLocalizacao = document.getElementById('new-location-button');
    var botaoConfirmar = document.getElementById('confirm-button');
    var statusMapa = document.getElementById('map-status');
    var statusPanorama = document.getElementById('panorama-status');
    var acoesErroPanorama = document.getElementById('panorama-error-actions');
    var painelResultado = document.getElementById('result-panel');

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
        return estado.candidatos.filter(function (local) {
            return !estado.locaisIndisponiveis.has(local.id);
        });
    }

    function limparMarcadorDoPalpite() {
        if (estado.marcadorPalpite && estado.mapa) {
            estado.mapa.removeLayer(estado.marcadorPalpite);
        }
        estado.marcadorPalpite = null;
        estado.palpite = null;
        botaoConfirmar.disabled = true;
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
        if (estado.resultados.length >= maxRodadas && rodadaRespondida) {
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

    function escolherLocal(proibirUltimo) {
        var disponiveis = candidatosDisponiveis();
        if (proibirUltimo && disponiveis.length > 1) {
            var alternativas = disponiveis.filter(function (local) {
                return local.id !== estado.ultimoLocalId;
            });
            if (alternativas.length) {
                disponiveis = alternativas;
            }
        }
        if (!disponiveis.length) {
            estado.localAtual = null;
            estado.panoramaPronto = false;
            mostrarFallbackPanorama('Nenhuma fotografia 360° disponível para iniciar uma rodada. Verifique os arquivos cadastrados.');
            setStatus(statusPanorama, 'Não há cenários com imagens disponíveis.', true);
            botaoNovaLocalizacao.disabled = true;
            return false;
        }

        var indice = Math.min(disponiveis.length - 1, Math.floor(Math.random() * disponiveis.length));
        estado.localAtual = disponiveis[indice];
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
        estado.panoramaComErro = false;
        estado.panoramaPronto = false;
        limparMapaDePalpite();
        painelResultado.hidden = true;
        painelResultado.replaceChildren();
        botaoConfirmar.hidden = false;
        botaoConfirmar.disabled = true;
        document.getElementById('round-title').textContent =
            'Desafio ' + (estado.rodada + 1) + ' de ' + maxRodadas;
        document.getElementById('round-progress').replaceChildren.apply(
            document.getElementById('round-progress'),
            lugares.filter(eCenarioValido).slice(0, maxRodadas).map(function (_, indice) {
                var item = document.createElement('span');
                item.className = indice < estado.rodada ? 'is-complete' : (indice === estado.rodada ? 'is-current' : '');
                item.setAttribute('aria-hidden', 'true');
                return item;
            })
        );
        setStatus(statusMapa, 'Marque no mapa o local onde acredita que a paisagem está.');
        if (estado.mapa) {
            estado.mapa.invalidateSize();
        }
        carregarPanorama(local);
        atualizarBotaoNovaLocalizacao();
    }

    function inicializarMapa() {
        if (!window.L) {
            setStatus(statusMapa, 'Não foi possível carregar o mapa. Verifique a conexão e recarregue a página.', true);
            botaoConfirmar.disabled = true;
            return false;
        }
        estado.mapa = L.map(mapaElement, { scrollWheelZoom: true }).setView([-28.235, -48.668], 10);
        estado.camadaBaseMapa = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(estado.mapa);
        estado.mapa.on('click', function (evento) {
            if (estado.resultados.length > estado.rodada || estado.panoramaComErro) {
                return;
            }
            estado.palpite = { lat: evento.latlng.lat, lng: evento.latlng.lng };
            if (!estado.marcadorPalpite) {
                estado.marcadorPalpite = L.marker(evento.latlng, { draggable: true }).addTo(estado.mapa);
                estado.marcadorPalpite.on('dragend', function (dragEvento) {
                    var ponto = dragEvento.target.getLatLng();
                    estado.palpite = { lat: ponto.lat, lng: ponto.lng };
                });
            } else {
                estado.marcadorPalpite.setLatLng(evento.latlng);
            }
            botaoConfirmar.disabled = false;
            setStatus(statusMapa, 'Palpite marcado. Clique novamente ou arraste o marcador para ajustar.');
        });
        setStatus(statusMapa, 'Marque no mapa o local onde acredita que a paisagem está.');
        return true;
    }

    function criarMarcadorResultado(coordenadas, cor, rotulo, mapa) {
        return L.circleMarker(coordenadas, {
            radius: 9,
            color: '#ffffff',
            weight: 3,
            fillColor: cor,
            fillOpacity: 1
        }).bindTooltip(rotulo).addTo(mapa);
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

    function montarResultado(resultado) {
        limparMapaResultado();
        painelResultado.replaceChildren();
        painelResultado.hidden = false;
        botaoConfirmar.hidden = true;
        acoesErroPanorama.hidden = true;
        botaoNovaLocalizacao.disabled = false;

        var local = resultado.local;
        var cabecalho = document.createElement('div');
        cabecalho.className = 'result-heading';
        var titulo = document.createElement('div');
        var eyebrow = document.createElement('span');
        eyebrow.className = 'eyebrow';
        eyebrow.textContent = 'Resposta revelada';
        var nome = document.createElement('h2');
        nome.textContent = local.nome;
        titulo.append(eyebrow, nome);
        var selo = document.createElement('span');
        selo.className = 'score-badge';
        selo.textContent = resultado.pontos.toLocaleString('pt-BR')
            + ' / ' + maxPontos.toLocaleString('pt-BR') + ' pontos';
        cabecalho.append(titulo, selo);
        painelResultado.appendChild(cabecalho);

        var resumo = document.createElement('p');
        resumo.textContent = 'Distância do palpite: ' + formatarDistancia(resultado.distancia)
            + ' · Localização correta: ' + local.latitude + ', ' + local.longitude;
        painelResultado.appendChild(resumo);

        var mapaResultadoElement = document.createElement('div');
        mapaResultadoElement.className = 'result-map';
        mapaResultadoElement.setAttribute('role', 'region');
        mapaResultadoElement.setAttribute('aria-label', 'Mapa comparando o palpite e o local correto');
        painelResultado.appendChild(mapaResultadoElement);

        estado.mapaResultado = L.map(mapaResultadoElement, { scrollWheelZoom: true, zoomControl: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(estado.mapaResultado);
        var correto = [local.latitude, local.longitude];
        var palpite = [resultado.palpite.lat, resultado.palpite.lng];
        criarMarcadorResultado(palpite, '#d97706', 'Seu palpite', estado.mapaResultado);
        criarMarcadorResultado(correto, '#125f5f', 'Local correto', estado.mapaResultado);
        L.polyline([palpite, correto], { color: '#092f3b', weight: 3, dashArray: '7 7' }).addTo(estado.mapaResultado);
        estado.mapaResultado.fitBounds([palpite, correto], { padding: [35, 35], maxZoom: 14 });

        var detalhes = document.createElement('div');
        detalhes.className = 'result-details';
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
        detalhes.append(informacao, referencias);
        painelResultado.appendChild(detalhes);
        window.setTimeout(function () {
            if (estado.mapaResultado) {
                estado.mapaResultado.invalidateSize();
            }
        }, 0);
    }

    function confirmarResposta() {
        if (!estado.palpite) {
            setStatus(statusMapa, 'Marque um ponto no mapa antes de confirmar.', true);
            return;
        }
        if (!estado.localAtual || !estado.panoramaPronto || estado.resultados.length > estado.rodada) {
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
        estado.resultados.push(resultado);
        montarResultado(resultado);
        atualizarBotaoNovaLocalizacao();
    }

    function abrirMapaAmpliado() {
        if (!estado.mapa || dialogoMapa.open) {
            return;
        }
        slotMapaDialogo.appendChild(mapaElement);
        dialogoMapa.showModal();
        botaoAmpliarMapa.setAttribute('aria-expanded', 'true');
        window.setTimeout(function () {
            estado.mapa.invalidateSize();
        }, 30);
    }

    function fecharMapaAmpliado() {
        if (dialogoMapa.open) {
            dialogoMapa.close();
        }
    }

    function aoFecharMapaAmpliado() {
        slotMapaEmLinha.appendChild(mapaElement);
        botaoAmpliarMapa.setAttribute('aria-expanded', 'false');
        if (estado.mapa) {
            estado.mapa.invalidateSize();
        }
        botaoAmpliarMapa.focus();
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
            totalPontos.toLocaleString('pt-BR') + ' / ' + (maxPontos * maxRodadas).toLocaleString('pt-BR') + ' pontos';
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
            escolherLocal(true);
            return;
        }
        if (estado.resultados.length <= estado.rodada) {
            setStatus(statusMapa, 'Confirme seu palpite antes de trocar de cenário; a rodada atual não será perdida.', true);
            return;
        }
        if (estado.resultados.length >= maxRodadas) {
            mostrarFinal();
            return;
        }
        estado.rodada = estado.resultados.length;
        escolherLocal(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function tentarNovamente() {
        if (!estado.localAtual || estado.resultados.length > estado.rodada) {
            return;
        }
        estado.locaisIndisponiveis.delete(estado.localAtual.id);
        estado.panoramaComErro = false;
        estado.panoramaPronto = false;
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
        estado.locaisIndisponiveis.clear();
        estado.panoramaComErro = false;
        estado.panoramaPronto = false;
        estado.ultimoLocalId = lerUltimoLocal();
        estado.localAtual = null;
        jogo.hidden = false;
        final.hidden = true;
        botaoConfirmar.hidden = false;
        botaoNovaLocalizacao.disabled = true;
        if (!estado.mapa && !inicializarMapa()) {
            mostrarFallbackPanorama('O mapa não está disponível. Confira a conexão e tente recarregar a página.');
            setStatus(statusPanorama, 'Não foi possível iniciar o desafio sem o mapa.', true);
            return;
        }
        escolherLocal(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    estado.candidatos = lugares.filter(eCenarioValido);
    document.getElementById('new-location-button').addEventListener('click', selecionarNovaLocalizacao);
    document.getElementById('error-new-location-button').addEventListener('click', function () {
        escolherLocal(true);
    });
    document.getElementById('retry-panorama-button').addEventListener('click', tentarNovamente);
    botaoConfirmar.addEventListener('click', confirmarResposta);
    botaoAmpliarMapa.addEventListener('click', abrirMapaAmpliado);
    document.getElementById('close-map-button').addEventListener('click', fecharMapaAmpliado);
    dialogoMapa.addEventListener('close', aoFecharMapaAmpliado);
    document.getElementById('restart-button').addEventListener('click', iniciarSessao);

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
        iniciarSessao();
    }
}());
