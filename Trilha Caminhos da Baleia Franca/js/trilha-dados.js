(function (root, factory) {
    'use strict';

    var trailData = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = trailData;
    } else {
        root.TrilhaDados = trailData;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function validateCollection(collection) {
        if (!collection || collection.type !== 'FeatureCollection'
            || !Array.isArray(collection.features) || collection.features.length === 0) {
            throw new Error('A resposta não contém uma FeatureCollection com trilhas.');
        }

        var identifiers = new Set();
        collection.features.forEach(function (feature) {
            var properties = feature && feature.properties;
            var geometry = feature && feature.geometry;
            var fid = properties && properties.fid;
            if (!feature || feature.type !== 'Feature' || !properties
                || fid === null || fid === undefined || !String(fid).trim()
                || !['Nome', 'Distância', 'Município'].every(function (key) {
                    return typeof properties[key] === 'string' && properties[key].trim().length > 0;
                })) {
                throw new Error('Foi encontrada uma trilha sem identificador ou atributos obrigatórios.');
            }

            var key = String(fid);
            if (identifiers.has(key)) {
                throw new Error('Identificador de trilha duplicado: ' + key);
            }
            identifiers.add(key);

            if (!geometry || geometry.type !== 'MultiLineString'
                || !Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
                throw new Error('Foi encontrada uma trilha sem geometria MultiLineString válida.');
            }
            geometry.coordinates.forEach(function (line) {
                if (!Array.isArray(line) || line.length === 0) {
                    throw new Error('A geometria contém uma linha vazia.');
                }
                line.forEach(function (position) {
                    if (!Array.isArray(position) || position.length !== 3
                        || !Number.isFinite(position[0]) || position[0] < -180 || position[0] > 180
                        || !Number.isFinite(position[1]) || position[1] < -90 || position[1] > 90
                        || !Number.isFinite(position[2])) {
                        throw new Error('A geometria contém uma coordenada XYZ inválida.');
                    }
                });
            });
        });

        return collection;
    }

    function fetchCollection(fetcher, url) {
        return Promise.resolve()
            .then(function () {
                return fetcher(url);
            })
            .then(function (response) {
                if (!response || !response.ok) {
                    throw new Error('Servidor respondeu com HTTP '
                        + (response ? response.status : 'inválido') + '.');
                }
                return response.json();
            })
            .then(validateCollection);
    }

    function load(options) {
        if (!options || typeof options.fetch !== 'function'
            || !options.apiUrl || !options.fallbackUrl) {
            return Promise.reject(new Error('A configuração de carregamento das trilhas está incompleta.'));
        }

        var logger = options.logger || (typeof console !== 'undefined' ? console : null);
        return fetchCollection(options.fetch, options.apiUrl).catch(function (error) {
            if (logger && typeof logger.warn === 'function') {
                logger.warn(
                    'A API de trilhas falhou ou retornou dados inválidos; utilizando o GeoJSON local.',
                    error
                );
            }
            return fetchCollection(options.fetch, options.fallbackUrl);
        });
    }

    return {
        load: load,
        validateCollection: validateCollection
    };
}));
