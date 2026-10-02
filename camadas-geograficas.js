(function (global) {
    'use strict';

    global.CAMADAS_GEOGRAFICAS = {
        // Adicione aqui cada GeoJSON publicado na pasta dados/.
        definitions: {
            'dados/limites_apabf_linha.geojson': {
                name: 'Limite da APABF',
                color: '#12647a',
                initiallyVisible: true,
                downloads: {
                    geojson: 'https://raw.githubusercontent.com/geoboyjpg/Base-de-Dados/main/limites_apabf/limites_apabf_linha.geojson',
                    kml: null,
                    shapefile: null,
                    geopackage: null
                }
            },
            'dados/ilhas_apabf_poligono.geojson': {
                name: 'Ilhas da APABF (polígonos)',
                color: '#2e8b57',
                downloads: {
                    geojson: 'https://raw.githubusercontent.com/geoboyjpg/Base-de-Dados/main/ilhas/ilhas_apabf_poligono.geojson',
                    kml: null,
                    shapefile: null,
                    geopackage: null
                }
            },
            'dados/ilhas_apabf_ponto.geojson': {
                name: 'Ilhas da APABF (pontos)',
                color: '#e28b32',
                downloads: {
                    geojson: 'https://raw.githubusercontent.com/geoboyjpg/Base-de-Dados/main/ilhas/ilhas_apabf_ponto.geojson',
                    kml: null,
                    shapefile: null,
                    geopackage: null
                }
            },
            'dados/lagoas_apabf.geojson': {
                name: 'Lagoas da APABF',
                color: '#168a9b',
                downloads: {
                    geojson: 'https://raw.githubusercontent.com/geoboyjpg/Base-de-Dados/main/lagoas/lagoas_apabf.geojson',
                    kml: null,
                    shapefile: null,
                    geopackage: null
                }
            },
            'dados/sitios_arqueologicos.geojson': {
                name: 'Sítios arqueológicos',
                color: '#8059a7',
                downloads: {
                    geojson: 'https://raw.githubusercontent.com/geoboyjpg/Base-de-Dados/main/sitios_arqueologicos/sitios_arqueologicos.geojson',
                    kml: null,
                    shapefile: null,
                    geopackage: null
                }
            }
        }
    };
}(window));
