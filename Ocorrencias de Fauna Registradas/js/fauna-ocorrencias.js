(function (global) {
    'use strict';

    var cachePrefix = 'apabf.fauna.photo.v3:';
    var cacheDuration = 30 * 24 * 60 * 60 * 1000;
    var emptyCacheDuration = 6 * 60 * 60 * 1000;
    var lifeStatusTermId = 17;
    var aliveTermValueId = 18;
    var photoLicenses = {
        cc0: {
            label: 'CC0',
            priority: 3
        },
        'cc-by': {
            label: 'CC BY',
            priority: 2
        },
        'cc-by-sa': {
            label: 'CC BY-SA',
            priority: 1
        }
    };
    var memoryCache = Object.create(null);
    var pendingRequests = Object.create(null);
    var requestQueue = Promise.resolve();
    var lastRequestAt = 0;
    var activeModal = null;

    function createElement(tagName, className, text) {
        var element = document.createElement(tagName);
        if (className) {
            element.className = className;
        }
        if (text !== undefined) {
            element.textContent = text;
        }
        return element;
    }

    function isEmpty(value) {
        return value === null || value === undefined || String(value).trim() === '';
    }

    function getValue(properties, keys) {
        for (var index = 0; index < keys.length; index += 1) {
            var value = properties[keys[index]];
            if (!isEmpty(value)) {
                return String(value).trim();
            }
        }
        return '';
    }

    function getSpecies(properties) {
        return getValue(properties, [
            'Espécies - Espécie',
            'OFAI - Espécie do indivíduo',
            'Necropsia - Espécie do indivíduo'
        ]);
    }

    function getCommonName(properties) {
        return getValue(properties, ['Nome Popular']);
    }

    function makeCacheKey(species) {
        return species.trim().toLocaleLowerCase();
    }

    function readCache(key) {
        var cached = memoryCache[key];
        if (!cached) {
            try {
                cached = JSON.parse(global.localStorage.getItem(cachePrefix + key) || 'null');
            } catch (error) {
                console.warn('Não foi possível ler o cache local de fotografias do iNaturalist.', error);
                return null;
            }
        }

        if (!cached || Date.now() - cached.savedAt >= cached.duration) {
            delete memoryCache[key];
            try {
                global.localStorage.removeItem(cachePrefix + key);
            } catch (error) {
                console.warn('Não foi possível remover um item expirado do cache de fotografias.', error);
            }
            return null;
        }

        memoryCache[key] = cached;
        return { value: cached.value };
    }

    function writeCache(key, value, duration) {
        var cached = {
            savedAt: Date.now(),
            duration: duration,
            value: value
        };
        memoryCache[key] = cached;
        try {
            global.localStorage.setItem(cachePrefix + key, JSON.stringify(cached));
        } catch (error) {
            console.warn('Não foi possível persistir o cache local de fotografias.', error);
        }
    }

    function buildPhotoUrl(url) {
        var photoUrl;
        try {
            photoUrl = new URL(url);
        } catch (error) {
            return null;
        }

        if (photoUrl.protocol !== 'https:' || photoUrl.hostname !== 'inaturalist-open-data.s3.amazonaws.com') {
            return null;
        }

        photoUrl.pathname = photoUrl.pathname.replace(
            /\/(?:square|small|medium|thumb|original)\./i,
            '/large.'
        );
        return photoUrl.href;
    }

    function isEligibleObservation(observation, species) {
        var taxon = observation.taxon || {};
        var statusAnnotations = (observation.annotations || []).filter(function (annotation) {
            return Number(annotation.controlled_attribute_id) === lifeStatusTermId;
        });

        return observation.quality_grade === 'research' &&
            observation.identifications_most_agree === true &&
            Number(observation.community_taxon_id) === Number(taxon.id) &&
            String(taxon.name || '').trim().toLowerCase() === species.trim().toLowerCase() &&
            observation.captive === false &&
            statusAnnotations.length > 0 &&
            statusAnnotations.every(function (annotation) {
                return Number(annotation.controlled_value_id) === aliveTermValueId &&
                    !(Number(annotation.vote_score) < 0);
            });
    }

    function comparePhotos(left, right) {
        return right.license.priority - left.license.priority ||
            right.area - left.area ||
            right.observationVotes - left.observationVotes;
    }

    function photoCandidates(observation) {
        return (observation.photos || []).reduce(function (candidates, photo) {
            var license = photoLicenses[String(photo.license_code || '').toLowerCase()];
            var imageUrl = buildPhotoUrl(photo.url);
            if (!license || !imageUrl) {
                return candidates;
            }

            var dimensions = photo.original_dimensions || {};
            candidates.push({
                photoId: String(photo.id || photo.url),
                observationId: String(observation.id),
                area: (Number(dimensions.width) || 0) * (Number(dimensions.height) || 0),
                observationVotes: Number(observation.cached_votes_total) || 0,
                imageUrl: imageUrl,
                license: license,
                attribution: (observation.user && (observation.user.name || observation.user.login)) ||
                    'Autoria não informada',
                observationUrl: 'https://www.inaturalist.org/observations/' + observation.id
            });
            return candidates;
        }, []);
    }

    function findRepresentativePhotos(data, species) {
        var distinctObservations = [];
        var additionalPhotos = [];
        (data.results || []).forEach(function (observation) {
            if (!isEligibleObservation(observation, species)) {
                return;
            }

            var candidates = photoCandidates(observation).sort(comparePhotos);
            if (candidates.length) {
                distinctObservations.push(candidates[0]);
                additionalPhotos = additionalPhotos.concat(candidates.slice(1));
            }
        });

        distinctObservations.sort(comparePhotos);
        var selected = distinctObservations.slice(0, 5);
        if (selected.length < 5) {
            var selectedObservationIds = Object.create(null);
            var selectedPhotoIds = Object.create(null);
            selected.forEach(function (photo) {
                selectedObservationIds[photo.observationId] = true;
                selectedPhotoIds[photo.photoId] = true;
            });

            additionalPhotos.sort(comparePhotos).forEach(function (photo) {
                if (selected.length < 5 &&
                    selectedObservationIds[photo.observationId] &&
                    !selectedPhotoIds[photo.photoId]) {
                    selected.push(photo);
                    selectedPhotoIds[photo.photoId] = true;
                }
            });
        }
        return selected;
    }

    function requestGallery(species) {
        var url = new URL('https://api.inaturalist.org/v1/observations');
        url.search = new URLSearchParams({
            taxon_name: species,
            photos: 'true',
            photo_license: 'cc0,cc-by,cc-by-sa',
            quality_grade: 'research',
            identifications: 'most_agree',
            term_id: String(lifeStatusTermId),
            term_value_id: String(aliveTermValueId),
            captive: 'false',
            order_by: 'votes',
            order: 'desc',
            per_page: '30'
        }).toString();

        return fetch(url.href, { headers: { Accept: 'application/json' } }).then(function (response) {
            if (!response.ok) {
                throw new Error('A API do iNaturalist respondeu com HTTP ' + response.status + '.');
            }
            return response.json();
        }).then(function (data) {
            return findRepresentativePhotos(data, species);
        });
    }

    function getGallery(species) {
        if (isEmpty(species)) {
            return Promise.resolve(null);
        }

        var key = makeCacheKey(species);
        var cached = readCache(key);
        if (cached) {
            return Promise.resolve(cached.value);
        }
        if (Object.prototype.hasOwnProperty.call(pendingRequests, key)) {
            return pendingRequests[key];
        }

        var request = requestQueue.then(function () {
            var wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
            return new Promise(function (resolve) {
                global.setTimeout(resolve, wait);
            });
        }).then(function () {
            lastRequestAt = Date.now();
            return requestGallery(species);
        }).then(function (gallery) {
            writeCache(key, gallery, gallery.length ? cacheDuration : emptyCacheDuration);
            return gallery;
        }).catch(function (error) {
            console.warn('Falha ao consultar fotografias para ' + species + ' no iNaturalist.', error);
            return { unavailable: true };
        }).then(function (photo) {
            delete pendingRequests[key];
            return photo;
        });

        pendingRequests[key] = request;
        requestQueue = request.then(function () {}, function () {});
        return request;
    }

    function addSummaryRow(table, label, value) {
        if (isEmpty(value)) {
            return;
        }
        var row = createElement('tr');
        row.appendChild(createElement('th', '', label));
        row.appendChild(createElement('td', '', value));
        table.appendChild(row);
    }

    function showPhotoFallback(container, message) {
        container.textContent = '';
        container.appendChild(createElement('div', 'fauna-photo__placeholder', message));
    }

    function renderGallerySlide(container, gallery, species, index, selectIndex) {
        container.textContent = '';
        var photo = gallery[index];
        var galleryElement = createElement('div', 'fauna-gallery');
        var frame = createElement('div', 'fauna-gallery__frame');
        var image = createElement('img', 'fauna-gallery__image');
        image.alt = 'Fotografia ' + (index + 1) + ' de ' + gallery.length + ' de ' + species;
        image.loading = 'eager';
        image.decoding = 'async';
        image.addEventListener('error', function () {
            frame.textContent = '';
            frame.appendChild(createElement('div', 'fauna-photo__placeholder', 'Esta fotografia não pôde ser carregada.'));
        }, { once: true });
        frame.appendChild(image);

        if (gallery.length > 1) {
            var previous = createElement('button', 'fauna-gallery__arrow fauna-gallery__arrow--previous', '‹');
            previous.type = 'button';
            previous.setAttribute('aria-label', 'Fotografia anterior');
            previous.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                selectIndex(index - 1);
            });
            frame.appendChild(previous);

            var next = createElement('button', 'fauna-gallery__arrow fauna-gallery__arrow--next', '›');
            next.type = 'button';
            next.setAttribute('aria-label', 'Próxima fotografia');
            next.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                selectIndex(index + 1);
            });
            frame.appendChild(next);
        }

        galleryElement.appendChild(frame);
        galleryElement.appendChild(createElement('div', 'fauna-gallery__position', (index + 1) + ' de ' + gallery.length));

        var credits = createElement('div', 'fauna-photo__credits');
        credits.appendChild(createElement('span', '', 'Crédito do fotógrafo/observador: ' + photo.attribution + '. '));

        var source = createElement('a', '', 'Observação original no iNaturalist');
        source.href = photo.observationUrl;
        source.target = '_blank';
        source.rel = 'noopener noreferrer';
        credits.appendChild(source);
        credits.appendChild(document.createTextNode(' · '));

        credits.appendChild(createElement('span', '', 'Licença: ' + photo.license.label));

        container.appendChild(galleryElement);
        container.appendChild(credits);
        image.src = photo.imageUrl;
    }

    function renderGallery(container, species) {
        showPhotoFallback(container, species
            ? 'Buscando fotografias verificadas...'
            : 'Fotografia ilustrativa indisponível para esta espécie.');
        if (isEmpty(species)) {
            return;
        }

        getGallery(species).then(function (gallery) {
            if (!container.isConnected) {
                return;
            }
            if (!gallery || gallery.unavailable || !gallery.length) {
                showPhotoFallback(container, 'Fotografia ilustrativa indisponível para esta espécie.');
                return;
            }

            function selectIndex(index) {
                var selectedIndex = (index + gallery.length) % gallery.length;
                renderGallerySlide(container, gallery, species, selectedIndex, selectIndex);
            }
            selectIndex(0);
        });
    }

    function makePhotoContainer(species, className) {
        var container = createElement('div', 'fauna-photo ' + className);
        container.setAttribute('aria-live', 'polite');
        showPhotoFallback(container, species ? 'A fotografia será carregada ao abrir o registro.' : 'Espécie sem nome científico disponível.');
        return container;
    }

    function openDetails(feature, returnFocus) {
        if (activeModal) {
            activeModal.close();
        }

        var properties = feature.properties || {};
        var species = getSpecies(properties);
        var commonName = getCommonName(properties);
        var overlay = createElement('div', 'map-popup-overlay fauna-record-overlay');
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) {
                close();
            }
        });

        var dialog = createElement('section', 'map-popup map-popup--modal fauna-record-modal');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'fauna-record-title');
        var header = createElement('header', 'map-popup__header');
        var heading = createElement('h2', 'map-popup__header-title', 'Informações da ocorrência');
        heading.id = 'fauna-record-title';
        header.appendChild(heading);

        var closeButton = createElement('button', 'map-popup__close', '×');
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', 'Fechar informações da ocorrência');
        header.appendChild(closeButton);
        dialog.appendChild(header);

        if (commonName || species) {
            dialog.appendChild(createElement('h3', 'map-popup__subtitle', commonName || species));
        }
        if (species && commonName !== species) {
            var scientificName = createElement('p', 'fauna-record-modal__scientific-name', species);
            scientificName.setAttribute('lang', 'la');
            dialog.appendChild(scientificName);
        }
        var modalContent = createElement('div', 'fauna-record-modal__content');
        var mediaColumn = createElement('div', 'fauna-record-modal__media');
        var photoContainer = makePhotoContainer(species, 'fauna-photo--details');
        mediaColumn.appendChild(photoContainer);
        renderGallery(photoContainer, species);
        modalContent.appendChild(mediaColumn);

        var attributesColumn = createElement('div', 'fauna-record-modal__attributes');
        var tableWrapper = createElement('div', 'map-popup__table-wrapper fauna-record-table-wrapper');
        var table = createElement('table', 'map-popup__table');
        var tableHead = createElement('thead');
        var headerRow = createElement('tr');
        headerRow.appendChild(createElement('th', '', 'Atributo'));
        headerRow.appendChild(createElement('th', '', 'Informação'));
        tableHead.appendChild(headerRow);
        table.appendChild(tableHead);
        var tableBody = createElement('tbody');

        Object.keys(properties).forEach(function (key) {
            if (key === 'fid') {
                return;
            }
            var row = createElement('tr');
            row.appendChild(createElement('th', '', key));
            row.appendChild(createElement('td', '', isEmpty(properties[key]) ? 'Não informado' : String(properties[key])));
            tableBody.appendChild(row);
        });

        table.appendChild(tableBody);
        tableWrapper.appendChild(table);
        attributesColumn.appendChild(tableWrapper);
        modalContent.appendChild(attributesColumn);
        dialog.appendChild(modalContent);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        function close() {
            if (!overlay.isConnected) {
                return;
            }
            document.removeEventListener('keydown', onKeyDown);
            overlay.remove();
            activeModal = null;
            if (returnFocus && returnFocus.isConnected) {
                returnFocus.focus();
            }
        }

        function onKeyDown(event) {
            if (event.key === 'Escape') {
                close();
            }
        }

        closeButton.addEventListener('click', close);
        document.addEventListener('keydown', onKeyDown);
        activeModal = { close: close };
        closeButton.focus();
    }

    function bindPopup(feature, layer) {
        var properties = feature.properties || {};
        var species = getSpecies(properties);
        var commonName = getCommonName(properties);
        var popup = createElement('div', 'fauna-occurrence-popup');
        var title = createElement('h3', 'map-popup__title', commonName || species || 'Ocorrência de fauna');
        popup.appendChild(title);

        if (species && commonName !== species) {
            var scientificName = createElement('p', 'fauna-occurrence-popup__scientific-name', species);
            scientificName.setAttribute('lang', 'la');
            popup.appendChild(scientificName);
        }

        popup.appendChild(makePhotoContainer(species, 'fauna-photo--popup'));
        var table = createElement('table', 'map-popup__table');
        addSummaryRow(table, 'Município', getValue(properties, ['Cidade', 'Município']));
        addSummaryRow(table, 'Data da ocorrência', getValue(properties, ['Data/Hora', 'Data']));
        addSummaryRow(table, 'Condição do animal', getValue(properties, ['Condição', 'Condição final', 'Condição na finalização']));
        if (table.rows.length) {
            popup.appendChild(table);
        }

        var actions = createElement('div', 'map-popup__actions');
        var detailsButton = createElement('button', 'map-ui-button map-ui-button--primary', 'Ver mais informações');
        detailsButton.type = 'button';
        detailsButton.addEventListener('click', function () {
            openDetails(feature, detailsButton);
        });
        actions.appendChild(detailsButton);
        popup.appendChild(actions);

        layer.bindPopup(popup, { maxWidth: 360, maxHeight: 450, autoPan: true });
        layer.on('popupopen', function (event) {
            var popupElement = event.popup.getElement();
            var photoContainer = popupElement && popupElement.querySelector('.fauna-photo--popup');
            if (photoContainer) {
                renderGallery(photoContainer, species);
            }
        });
    }

    global.FaunaOccurrences = {
        bindPopup: bindPopup
    };
}(window));
