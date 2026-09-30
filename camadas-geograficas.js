(function (global) {
    'use strict';

    global.CAMADAS_GEOGRAFICAS = {
        repository: 'geoboyjpg/Base-de-Dados',
        branch: 'main',
        // Insira aqui uma chave Google Maps Platform restrita ao seu domínio e à Map Tiles API.
        googleMapsApiKey: '',
        definitions: {
            'limites_apabf/limites_apabf_linha.geojson': {
                name: 'Limite da APABF',
                color: '#12647a',
                initiallyVisible: true
            },
            'ilhas/ilhas_apabf_poligono.geojson': {
                name: 'Ilhas da APABF (polígonos)',
                color: '#2e8b57'
            },
            'ilhas/ilhas_apabf_ponto.geojson': {
                name: 'Ilhas da APABF (pontos)',
                color: '#e28b32'
            },
            'lagoas/lagoas_apabf.geojson': {
                name: 'Lagoas da APABF',
                color: '#2589b5'
            },
            'sitios_arqueologicos/sitios_arqueologicos.geojson': {
                name: 'Sítios arqueológicos',
                color: '#9b5b3c'
            }
        }
    };
}(window));
