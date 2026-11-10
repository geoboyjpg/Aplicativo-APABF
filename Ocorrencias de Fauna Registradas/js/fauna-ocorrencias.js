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
                kind: 'illustrative',
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

    function safeAuthorizedUrl(value) {
        if (isEmpty(value)) {
            return null;
        }
        try {
            var url = new URL(String(value).trim(), document.baseURI);
            if (url.protocol === 'https:' ||
                (url.protocol === global.location.protocol &&
                    url.origin === global.location.origin &&
                    url.protocol !== 'data:' &&
                    url.protocol !== 'javascript:')) {
                return url.href;
            }
        } catch (error) {
            return null;
        }
        return null;
    }

    function getAuthorizedIndividualPhotos(properties) {
        var occurrenceId = getValue(properties, ['Identificador da ocorrência']);
        var individualId = getValue(properties, ['Identificador do indivíduo']);
        var manifest = global.FaunaOccurrencePhotos;
        if (!occurrenceId || !individualId || !manifest ||
            !Object.prototype.hasOwnProperty.call(manifest, occurrenceId)) {
            return null;
        }

        var entries = Array.isArray(manifest[occurrenceId]) ? manifest[occurrenceId] : [];
        var authorizedEntries = entries.filter(function (entry) {
            return entry && entry.authorized === true &&
                String(entry.occurrenceId || '') === occurrenceId &&
                String(entry.individualId || '') === individualId;
        });
        if (!authorizedEntries.length) {
            return null;
        }

        return {
            occurrenceId: occurrenceId,
            individualId: individualId,
            photos: authorizedEntries.map(function (entry, index) {
                return {
                    photoId: String(entry.photoId || index),
                    kind: 'individual',
                    occurrenceId: occurrenceId,
                    individualId: individualId,
                    imageUrl: safeAuthorizedUrl(entry.url),
                    attribution: String(entry.credit || '').trim(),
                    source: String(entry.source || '').trim(),
                    sourceUrl: safeAuthorizedUrl(entry.sourceUrl),
                    license: String(entry.license || '').trim()
                };
            }).filter(function (photo) {
                return photo.imageUrl;
            })
        };
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
        image.alt = photo.kind === 'individual'
            ? 'Registro fotográfico do indivíduo ' + photo.individualId
            : 'Imagem ilustrativa ' + (index + 1) + ' de ' + gallery.length + ' da espécie ' + species;
        image.loading = 'eager';
        image.decoding = 'async';
        var imageLink = createElement('a', 'fauna-gallery__image-link');
        image.addEventListener('error', function () {
            imageLink.hidden = true;
            var unavailable = createElement(
                'div',
                'fauna-photo__placeholder fauna-gallery__error',
                photo.kind === 'individual'
                    ? 'Não foi possível carregar a fotografia do SIMBA. O arquivo pode não existir ou o servidor pode ter negado o acesso.'
                    : 'Esta imagem ilustrativa não pôde ser carregada.'
            );
            if (photo.kind === 'individual') {
                var retryButton = createElement(
                    'button',
                    'map-ui-button map-ui-button--secondary',
                    'Tentar novamente'
                );
                retryButton.type = 'button';
                retryButton.addEventListener('click', function () {
                    selectIndex(index);
                });
                unavailable.appendChild(retryButton);
            }
            frame.appendChild(unavailable);
        }, { once: true });
        imageLink.href = photo.imageUrl;
        imageLink.target = '_blank';
        imageLink.rel = 'noopener noreferrer';
        imageLink.setAttribute('aria-label', 'Ampliar fotografia em uma nova guia');
        imageLink.appendChild(image);
        frame.appendChild(imageLink);

        var position = createElement(
            'div',
            'fauna-gallery__position',
            (index + 1) + ' de ' + gallery.length
        );
        position.setAttribute('aria-live', 'polite');
        frame.appendChild(position);

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
        galleryElement.appendChild(createElement(
            'p',
            'fauna-gallery__caption',
            photo.kind === 'individual'
                ? 'Fotografia do indivíduo – SIMBA/PMP · Ocorrência: ' + photo.occurrenceId +
                    ' · Indivíduo: ' + photo.individualId
                : 'Imagem ilustrativa da espécie – não corresponde necessariamente ao indivíduo registrado.'
        ));

        var credits = createElement('div', 'fauna-photo__credits');
        if (photo.kind === 'individual') {
            var details = ['Fonte: ' + (photo.source || 'SIMBA/PMP')];
            if (photo.attribution) {
                details.push('Crédito: ' + photo.attribution);
            }
            if (photo.license) {
                details.push('Licença: ' + photo.license);
            }
            if (details.length) {
                credits.appendChild(createElement('span', '', details.join(' · ')));
            }
            credits.appendChild(document.createTextNode(' · '));
            var source = createElement('a', '', 'Origem da fotografia');
            source.href = photo.sourceUrl || photo.imageUrl;
            source.target = '_blank';
            source.rel = 'noopener noreferrer';
            credits.appendChild(source);
            if (photo.sourceUrl) {
                credits.appendChild(document.createTextNode(' · '));
                var imageFile = createElement('a', '', 'Arquivo da imagem');
                imageFile.href = photo.imageUrl;
                imageFile.target = '_blank';
                imageFile.rel = 'noopener noreferrer';
                credits.appendChild(imageFile);
            }
        } else {
            credits.appendChild(createElement('span', '', 'Crédito do fotógrafo/observador: ' + photo.attribution + '. '));

            var observation = createElement('a', '', 'Observação original no iNaturalist');
            observation.href = photo.observationUrl;
            observation.target = '_blank';
            observation.rel = 'noopener noreferrer';
            credits.appendChild(observation);
            credits.appendChild(document.createTextNode(' · '));

            credits.appendChild(createElement('span', '', 'Licença: ' + photo.license.label));
        }

        container.appendChild(galleryElement);
        container.appendChild(credits);
        image.src = photo.imageUrl;
    }

    function renderGallery(container, species) {
        showPhotoFallback(container, species
            ? 'Buscando imagens ilustrativas verificadas...'
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

    function renderIndividualPhotoSection(properties) {
        var individualGallery = getAuthorizedIndividualPhotos(properties);
        if (!individualGallery || !individualGallery.photos.length) {
            return null;
        }

        var section = createElement('section', 'fauna-individual-photos');
        var heading = createElement(
            'h3',
            'fauna-media-section-title',
            'Registro fotográfico do indivíduo – SIMBA'
        );
        section.appendChild(heading);
        section.appendChild(createElement(
            'p',
            'fauna-individual-photos__identity',
            'Ocorrência: ' + individualGallery.occurrenceId +
                ' · Indivíduo: ' + individualGallery.individualId
        ));

        var viewButton = createElement('button', 'map-ui-button map-ui-button--primary', 'Ver fotografia');
        viewButton.type = 'button';
        section.appendChild(viewButton);

        var confirmation = createElement('div', 'fauna-individual-photos__confirmation');
        confirmation.hidden = true;
        confirmation.setAttribute('role', 'group');
        confirmation.setAttribute('aria-label', 'Confirmação para visualizar fotografia do SIMBA');
        confirmation.appendChild(createElement(
            'p',
            'fauna-individual-photos__warning',
            'Algumas fotografias podem apresentar animais mortos, feridos, em decomposição ou submetidos a procedimentos de atendimento e análise. Deseja visualizar a imagem?'
        ));
        var confirmationActions = createElement('div', 'fauna-individual-photos__actions');
        var confirmButton = createElement(
            'button',
            'map-ui-button map-ui-button--primary',
            'Visualizar fotografia'
        );
        confirmButton.type = 'button';
        var cancelButton = createElement(
            'button',
            'map-ui-button map-ui-button--secondary',
            'Cancelar'
        );
        cancelButton.type = 'button';
        confirmationActions.appendChild(confirmButton);
        confirmationActions.appendChild(cancelButton);
        confirmation.appendChild(confirmationActions);
        section.appendChild(confirmation);

        var viewer = createElement('div', 'fauna-individual-photos__viewer');
        viewer.hidden = true;
        var hideButton = createElement(
            'button',
            'map-ui-button map-ui-button--secondary fauna-individual-photos__hide',
            'Ocultar fotografia'
        );
        hideButton.type = 'button';
        viewer.appendChild(hideButton);
        var galleryContainer = createElement('div', 'fauna-photo fauna-photo--individual-details');
        galleryContainer.setAttribute('aria-live', 'polite');
        viewer.appendChild(galleryContainer);
        section.appendChild(viewer);

        viewButton.addEventListener('click', function () {
            viewButton.hidden = true;
            confirmation.hidden = false;
            confirmButton.focus();
        });
        cancelButton.addEventListener('click', function () {
            confirmation.hidden = true;
            viewButton.hidden = false;
            viewButton.focus();
        });
        confirmButton.addEventListener('click', function () {
            confirmation.hidden = true;
            viewer.hidden = false;

            function selectIndividualIndex(index) {
                var selectedIndex = (index + individualGallery.photos.length) % individualGallery.photos.length;
                renderGallerySlide(
                    galleryContainer,
                    individualGallery.photos,
                    '',
                    selectedIndex,
                    selectIndividualIndex
                );
            }
            selectIndividualIndex(0);
            hideButton.focus();
        });
        hideButton.addEventListener('click', function () {
            galleryContainer.textContent = '';
            viewer.hidden = true;
            viewButton.hidden = false;
            viewButton.focus();
        });

        return section;
    }

    function makePhotoContainer(species, className) {
        var container = createElement('div', 'fauna-photo ' + className);
        container.setAttribute('aria-live', 'polite');
        showPhotoFallback(container, species ? 'A fotografia será carregada ao abrir o registro.' : 'Espécie sem nome científico disponível.');
        return container;
    }

    var pendingDetailRequests = Object.create(null);

    function loadOccurrenceDetails(properties) {
        var year = String(properties.__detailsYear || '');
        var occurrenceId = getValue(properties, ['Identificador da ocorrência']);
        if (!/^(?:20\d{2}|sem-data)$/.test(year) || !occurrenceId) {
            return Promise.reject(new Error('O registro não possui uma referência válida para os detalhes.'));
        }

        function readDetails() {
            var data = global.FaunaOccurrenceDetailsData || {};
            var yearData = data[year];
            if (!yearData || !Array.isArray(yearData.fields) || !yearData.records) {
                throw new Error('Os detalhes completos do ano ' + year + ' não foram carregados.');
            }
            var values = yearData.records[occurrenceId];
            if (!Array.isArray(values) || values.length !== yearData.fields.length) {
                throw new Error('Os detalhes da ocorrência ' + occurrenceId + ' não foram encontrados.');
            }
            var fullProperties = {};
            yearData.fields.forEach(function (field, index) {
                fullProperties[field] = values[index];
            });
            return fullProperties;
        }

        if (global.FaunaOccurrenceDetailsData && global.FaunaOccurrenceDetailsData[year]) {
            return Promise.resolve().then(readDetails);
        }
        if (!pendingDetailRequests[year]) {
            pendingDetailRequests[year] = new Promise(function (resolve, reject) {
                var script = document.createElement('script');
                script.src = 'data/fauna-detalhes-' + year + '.js';
                script.async = true;
                script.onload = function () {
                    script.remove();
                    resolve();
                };
                script.onerror = function () {
                    script.remove();
                    reject(new Error('Não foi possível carregar os detalhes das ocorrências de ' + year + '.'));
                };
                document.head.appendChild(script);
            }).then(function () {
                delete pendingDetailRequests[year];
            }, function (error) {
                delete pendingDetailRequests[year];
                throw error;
            });
        }
        return pendingDetailRequests[year].then(readDetails);
    }

    function openDetails(feature, returnFocus) {
        if (returnFocus) {
            returnFocus.disabled = true;
            returnFocus.textContent = 'Carregando detalhes…';
        }
        loadOccurrenceDetails(feature.properties || {}).then(function (properties) {
            if (returnFocus) {
                returnFocus.disabled = false;
                returnFocus.textContent = 'Ver mais informações';
            }
            renderDetails(properties, returnFocus);
        }).catch(function (error) {
            console.error('Falha ao carregar os detalhes da ocorrência.', error);
            if (returnFocus) {
                returnFocus.disabled = false;
                returnFocus.textContent = 'Ver mais informações';
                var status = returnFocus.parentNode.querySelector('.fauna-occurrence-popup__details-status');
                if (status) {
                    status.textContent = 'Não foi possível carregar os detalhes. Tente novamente.';
                }
            }
        });
    }

    function renderDetails(properties, returnFocus) {
        if (activeModal) {
            activeModal.close();
        }

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
        var individualPhotoSection = renderIndividualPhotoSection(properties);
        if (individualPhotoSection) {
            mediaColumn.appendChild(individualPhotoSection);
        }
        mediaColumn.appendChild(createElement(
            'h3',
            'fauna-media-section-title',
            'Fotografias ilustrativas da espécie – iNaturalist'
        ));
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

        var photoContainer = makePhotoContainer(species, 'fauna-photo--popup');
        popup.appendChild(photoContainer);
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
        var detailsStatus = createElement('p', 'fauna-occurrence-popup__details-status');
        detailsStatus.setAttribute('role', 'status');
        actions.appendChild(detailsStatus);
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
