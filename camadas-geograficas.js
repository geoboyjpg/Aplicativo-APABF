(function (global) {
    'use strict';

    global.CAMADAS_GEOGRAFICAS = {
        // Adicione aqui cada GeoJSON publicado na pasta dados/.
        definitions: {
            'dados/limites_apabf_linha.geojson': {
                name: 'Limite da APABF',
                color: '#12647a',
                initiallyVisible: true
            },
            'dados/ilhas_apabf_poligono.geojson': {
                name: 'Ilhas da APABF (polígonos)',
                color: '#2e8b57'
            },
            'dados/ilhas_apabf_ponto.geojson': {
                name: 'Ilhas da APABF (pontos)',
                color: '#e28b32'
            },
            'dados/lagoas_apabf.geojson': {
                name: 'Lagoas da APABF',
                color: '#2589b5'
            },
            'dados/sitios_arqueologicos.geojson': {
                name: 'Sítios arqueológicos',
                color: '#9b5b3c'
            }
        }
    };
}(window));
