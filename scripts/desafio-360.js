(function () {
    'use strict';

    var lugares = window.APABF_DESAFIO_360_LOCAIS;
    var maxPontos = 5000;
    // Escala linear: 5.000 pontos no local exato, decrescendo até zero a 20 km.
    var distanciaSemPontos = 20000;
    var estado = {
        rodada: 0,
        palpite: null,
        resultados: [],
        mapa: null,
        marcadorPalpite: null,
        marcadorPanorama: null,
        linha: null,
        panorama: null,
        camadaBaseMapa: null,
        erroPanorama: ''
    };

    var intro = document.getElementById('intro-panel');
    var jogo = document.getElementById('game-panel');
    var final = document.getElementById('final-panel');
    var mapaElement = document.getElementById('guess-map');
    var panoramaElement = document.getElementById('panorama');
    var confirmar = document.getElementById('confirm-button');
    var statusMapa = document.getElementById('map-status');
    var statusPanorama = document.getElementById('panorama-status');
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

    function atualizarEstadoPanorama() {
        panoramaElement.innerHTML = '';
        var mensagem = estado.erroPanorama || 'Panorama local não cadastrado para este cenário. Abra o link externo para consultar a paisagem.';
        var aviso = document.createElement('div');
        aviso.className = 'panorama-fallback';
        aviso.innerHTML = '<i class="fas fa-panorama" aria-hidden="true"></i>';
        var texto = document.createElement('p');
        texto.textContent = mensagem;
        aviso.appendChild(texto);
        panoramaElement.appendChild(aviso);
        setStatus(statusPanorama, mensagem, Boolean(estado.erroPanorama));
    }

    function destruirPanorama() {
        if (estado.panorama) {
            estado.panorama.destroy();
            estado.panorama = null;
        }
    }

    function carregarPanorama(lugar) {
        destruirPanorama();
        if (!lugar.panoramaPath) {
            estado.erroPanorama = '';
            atualizarEstadoPanorama();
            return;
        }
        if (!window.pannellum) {
            estado.erroPanorama = 'Não foi possível carregar o visualizador Pannellum. Confira a conexão e abra o mapa externo como alternativa.';
            atualizarEstadoPanorama();
            return;
        }
        setStatus(statusPanorama, 'Carregando panorama local…');
        panoramaElement.innerHTML = '';
        try {
            estado.panorama = window.pannellum.viewer('panorama', {
                type: 'equirectangular',
                panorama: lugar.panoramaPath,
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
                yaw: lugar.panoramaYaw || 0,
                pitch: lugar.panoramaPitch || 0,
                minPitch: -90,
                maxPitch: 90
            });
            estado.panorama.on('load', function () {
                estado.erroPanorama = '';
                setStatus(statusPanorama, 'Panorama local interativo carregado. Arraste para explorar e use os controles para aproximar.');
            });
            estado.panorama.on('error', function () {
                estado.erroPanorama = 'Não foi possível carregar esta imagem panorâmica. Verifique o arquivo e o caminho configurado; o link externo continua disponível.';
                atualizarEstadoPanorama();
            });
        } catch (erro) {
            estado.erroPanorama = 'Não foi possível inicializar o visualizador panorâmico. Confira a imagem e tente novamente.';
            atualizarEstadoPanorama();
        }
    }

    function inicializarMapa() {
        if (!window.L) {
            setStatus(statusMapa, 'Não foi possível carregar o mapa. Verifique a conexão e recarregue a página.', true);
            return;
        }
        estado.mapa = L.map(mapaElement, { scrollWheelZoom: true }).setView([-28.235, -48.668], 11);
        estado.camadaBaseMapa = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(estado.mapa);
        estado.mapa.on('click', function (evento) {
            if (estado.resultados.length > estado.rodada) {
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
            confirmar.disabled = false;
            setStatus(statusMapa, 'Palpite marcado. Você pode clicar novamente ou arrastar o marcador para ajustar.');
        });
        setStatus(statusMapa, 'Mapa pronto. Nenhuma resposta correta aparece antes da confirmação.');
    }

    function prepararRodada() {
        var lugar = lugares[estado.rodada];
        estado.palpite = null;
        estado.marcadorPalpite = null;
        estado.marcadorPanorama = null;
        estado.linha = null;
        estado.erroPanorama = '';
        confirmar.disabled = true;
        confirmar.hidden = false;
        painelResultado.hidden = true;
        painelResultado.innerHTML = '';
        document.getElementById('round-title').textContent = 'Desafio ' + (estado.rodada + 1) + ' de ' + lugares.length;
        document.getElementById('round-progress').innerHTML = lugares.map(function (_, indice) {
            var classe = indice < estado.rodada ? 'is-complete' : (indice === estado.rodada ? 'is-current' : '');
            return '<span class="' + classe + '" aria-hidden="true"></span>';
        }).join('');
        document.getElementById('open-panorama-link').href = lugar.panoramaUrl;
        document.getElementById('open-panorama-link').hidden = !lugar.panoramaUrl;

        if (estado.mapa) {
            estado.mapa.eachLayer(function (layer) {
                if (layer !== estado.camadaBaseMapa) {
                    estado.mapa.removeLayer(layer);
                }
            });
            estado.mapa.setView([-28.235, -48.668], 11);
            estado.mapa.invalidateSize();
        }

        carregarPanorama(lugar);
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

    function montarResultado(resultado) {
        var lugar = resultado.lugar;
        painelResultado.innerHTML = '';
        painelResultado.hidden = false;
        confirmar.hidden = true;

        var cabecalho = document.createElement('div');
        cabecalho.className = 'result-heading';
        var titulo = document.createElement('div');
        titulo.innerHTML = '<span class="eyebrow">Resposta revelada</span><h2></h2>';
        titulo.querySelector('h2').textContent = lugar.nome;
        var selo = document.createElement('span');
        selo.className = 'score-badge';
        selo.textContent = resultado.pontos.toLocaleString('pt-BR') + ' / ' + maxPontos.toLocaleString('pt-BR') + ' pontos';
        cabecalho.append(titulo, selo);
        painelResultado.appendChild(cabecalho);

        var resumo = document.createElement('p');
        resumo.innerHTML = '<strong>Distância do palpite:</strong> ' + formatarDistancia(resultado.distancia);
        painelResultado.appendChild(resumo);

        var mapaResultadoElement = document.createElement('div');
        mapaResultadoElement.className = 'result-map';
        mapaResultadoElement.setAttribute('role', 'region');
        mapaResultadoElement.setAttribute('aria-label', 'Mapa com seu palpite e a localização correta');
        painelResultado.appendChild(mapaResultadoElement);

        var mapaResultado = L.map(mapaResultadoElement, { scrollWheelZoom: true, zoomControl: true })
            .setView([lugar.latitude, lugar.longitude], 12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(mapaResultado);
        var correto = [lugar.latitude, lugar.longitude];
        var palpite = [resultado.palpite.lat, resultado.palpite.lng];
        criarMarcadorResultado(palpite, '#d97706', 'Seu palpite', mapaResultado);
        criarMarcadorResultado(correto, '#125f5f', 'Local de referência', mapaResultado);
        L.polyline([palpite, correto], { color: '#092f3b', weight: 3, dashArray: '7 7' }).addTo(mapaResultado);
        mapaResultado.fitBounds([palpite, correto], { padding: [35, 35], maxZoom: 13 });

        var detalhes = document.createElement('div');
        detalhes.className = 'result-details';
        var informacao = document.createElement('div');
        informacao.innerHTML = '<h3>Sobre o local</h3>';
        var descricao = document.createElement('p');
        descricao.textContent = lugar.descricao;
        var importancia = document.createElement('p');
        importancia.innerHTML = '<strong>Importância e relação com a APABF:</strong> ';
        importancia.appendChild(document.createTextNode(lugar.importancia));
        var curiosidade = document.createElement('p');
        curiosidade.innerHTML = '<strong>Curiosidade:</strong> ';
        curiosidade.appendChild(document.createTextNode(lugar.curiosidade));
        var nota = document.createElement('p');
        nota.className = 'result-note';
        nota.textContent = 'As coordenadas exibidas são as referências fornecidas para o protótipo. A posição exata da câmera e a correspondência com o local a identificar ainda precisam de validação.';
        informacao.append(descricao, importancia, curiosidade, nota);

        var referencias = document.createElement('div');
        referencias.innerHTML = '<h3>Referências</h3>';
        var lista = document.createElement('ul');
        lugar.fontes.forEach(function (fonte) {
            var item = document.createElement('li');
            var link = document.createElement('a');
            link.href = fonte.url;
            link.textContent = fonte.nome;
            if (/^https?:/.test(fonte.url)) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            item.appendChild(link);
            lista.appendChild(item);
        });
        referencias.appendChild(lista);
        detalhes.append(informacao, referencias);
        painelResultado.appendChild(detalhes);

        var proximo = document.createElement('button');
        proximo.className = 'primary-button next-button';
        proximo.type = 'button';
        proximo.innerHTML = estado.rodada === lugares.length - 1
            ? 'Ver resultado final <i class="fas fa-flag-checkered" aria-hidden="true"></i>'
            : 'Próximo desafio <i class="fas fa-arrow-right" aria-hidden="true"></i>';
        proximo.addEventListener('click', avancar);
        painelResultado.appendChild(proximo);
        window.setTimeout(function () {
            mapaResultado.invalidateSize();
        }, 0);
    }

    function confirmarResposta() {
        if (!estado.palpite || estado.resultados.length > estado.rodada) {
            if (!estado.palpite) {
                setStatus(statusMapa, 'Marque um ponto no mapa antes de confirmar.', true);
            }
            return;
        }
        var lugar = lugares[estado.rodada];
        var resposta = { lat: lugar.latitude, lng: lugar.longitude };
        var distancia = calcularDistancia(estado.palpite, resposta);
        var resultado = {
            lugar: lugar,
            palpite: { lat: estado.palpite.lat, lng: estado.palpite.lng },
            distancia: distancia,
            pontos: calcularPontos(distancia)
        };
        estado.resultados.push(resultado);
        montarResultado(resultado);
    }

    function avancar() {
        if (estado.rodada === lugares.length - 1) {
            mostrarFinal();
            return;
        }
        estado.rodada += 1;
        prepararRodada();
        estado.mapa.invalidateSize();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function mostrarFinal() {
        jogo.hidden = true;
        final.hidden = false;
        var totalPontos = estado.resultados.reduce(function (soma, resultado) {
            return soma + resultado.pontos;
        }, 0);
        var totalDistancia = estado.resultados.reduce(function (soma, resultado) {
            return soma + resultado.distancia;
        }, 0);
        document.getElementById('final-score').textContent =
            totalPontos.toLocaleString('pt-BR') + ' / ' + (maxPontos * lugares.length).toLocaleString('pt-BR') + ' pontos';
        document.getElementById('final-distance').textContent =
            'Distância acumulada: ' + formatarDistancia(totalDistancia);
        document.getElementById('round-summary').innerHTML = '';
        estado.resultados.forEach(function (resultado, indice) {
            var linha = document.createElement('div');
            linha.className = 'summary-row';
            var local = document.createElement('strong');
            local.textContent = 'Desafio ' + (indice + 1) + ': ' + resultado.lugar.nome;
            var desempenho = document.createElement('span');
            desempenho.textContent = formatarDistancia(resultado.distancia) + ' · ' + resultado.pontos.toLocaleString('pt-BR') + ' pontos';
            linha.append(local, desempenho);
            document.getElementById('round-summary').appendChild(linha);
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function iniciar() {
        if (!Array.isArray(lugares) || lugares.length !== 3) {
            setStatus(statusPanorama, 'A lista de desafios não foi carregada corretamente. Recarregue a página.', true);
            return;
        }
        intro.hidden = true;
        final.hidden = true;
        jogo.hidden = false;
        estado.rodada = 0;
        estado.resultados = [];
        if (!estado.mapa) {
            inicializarMapa();
        }
        prepararRodada();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    document.getElementById('start-button').addEventListener('click', iniciar);
    document.getElementById('restart-button').addEventListener('click', function () {
        estado.rodada = 0;
        estado.palpite = null;
        estado.resultados = [];
        estado.erroPanorama = '';
        destruirPanorama();
        final.hidden = true;
        intro.hidden = false;
        jogo.hidden = true;
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    confirmar.addEventListener('click', confirmarResposta);
    setStatus(statusMapa, 'O mapa será preparado quando você iniciar o desafio.');
}());
