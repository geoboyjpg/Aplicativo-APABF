(function (global) {
    'use strict';

    global.CATALOGO_GERADOR_MAPAS = [
        {
            id: 'limite-apabf',
            name: 'Limite da APABF',
            source: 'ICMBio — dados geográficos da APABF',
            url: 'dados/limites_apabf_linha.geojson',
            format: 'geojson',
            geometry: 'line',
            color: '#e1c900',
            stroke: '#4e4a16',
            opacity: 1,
            visible: true
        },
        {
            id: 'zoneamento',
            name: 'Zoneamento do Plano de Manejo',
            source: 'ICMBio — Plano de Manejo da APABF',
            url: 'Zoneamento APABF/data/ZoneamentoAPAdaBaleiaFranca_2.js',
            format: 'script',
            globalName: 'json_ZoneamentoAPAdaBaleiaFranca_2',
            geometry: 'polygon',
            color: '#248c60',
            stroke: '#176341',
            opacity: 0.28,
            visible: true,
            legendField: 'Zonas',
            palette: ['#a4d65e', '#2a9d8f', '#e9c46a', '#f4a261', '#8ab17d', '#58a4b0', '#b5838d', '#9b5de5', '#d4a373']
        },
        {
            id: 'lagoas',
            name: 'Lagoas da APABF',
            source: 'Base de dados geográficos da APABF',
            url: 'dados/lagoas_apabf.geojson',
            format: 'geojson',
            geometry: 'polygon',
            color: '#36a6c8',
            stroke: '#176b86',
            opacity: 0.42,
            visible: false
        },
        {
            id: 'ilhas-poligonos',
            name: 'Ilhas da APABF (polígonos)',
            source: 'Base de dados geográficos da APABF',
            url: 'dados/ilhas_apabf_poligono.geojson',
            format: 'geojson',
            geometry: 'polygon',
            color: '#54a66b',
            stroke: '#27613a',
            opacity: 0.5,
            visible: false
        },
        {
            id: 'ilhas-pontos',
            name: 'Ilhas da APABF (pontos)',
            source: 'Base de dados geográficos da APABF',
            url: 'dados/ilhas_apabf_ponto.geojson',
            format: 'geojson',
            geometry: 'point',
            color: '#e28b32',
            stroke: '#774213',
            opacity: 1,
            visible: false
        },
        {
            id: 'sitios-arqueologicos',
            name: 'Sítios arqueológicos',
            source: 'Base de dados geográficos da APABF',
            url: 'dados/sitios_arqueologicos.geojson',
            format: 'geojson',
            geometry: 'point',
            color: '#8059a7',
            stroke: '#50356e',
            opacity: 1,
            visible: false
        },
        {
            id: 'trilhas',
            name: 'Trilhas Caminhos da Baleia Franca',
            source: 'Trilha Caminhos da Baleia Franca — dados publicados no aplicativo',
            url: 'Trilha Caminhos da Baleia Franca/data/TrilhaCaminhosdaBaleiaFranca_2.js',
            format: 'script',
            globalName: 'json_TrilhaCaminhosdaBaleiaFranca_2',
            geometry: 'line',
            color: '#d65a31',
            stroke: '#9c3215',
            opacity: 0.95,
            visible: false
        }
    ];
}(window));
