(function (global) {
    'use strict';

    var sessionWelcomeKey = 'apabf.fauna.welcome.dismissed';
    var filterFields = {
        species: [
            'Espécies - Espécie',
            'OFAI - Espécie do indivíduo',
            'Necropsia - Espécie do indivíduo'
        ],
        common: ['Nome Popular'],
        taxonomicClass: ['Espécies - Classe'],
        city: ['Cidade'],
        segment: ['Trecho'],
        institution: ['Instituição executora'],
        condition: ['Condição'],
        sex: ['OFAI - Sexo', 'Necropsia - Sexo'],
        developmentStage: ['Estágio de desenvolvimento', 'OFAI - Estágio de desenvolvimento'],
        threatened: ['Espécie ameaçada'],
        date: ['Data/Hora', 'Data']
    };

    function element(id) {
        var target = document.getElementById(id);
        if (!target) {
            throw new Error('Elemento necessário não encontrado: #' + id);
        }
        return target;
    }

    function valuesFor(properties, fields) {
        return fields.map(function (field) {
            var value = properties[field];
            return value === null || value === undefined ? '' : String(value).trim();
        }).filter(Boolean);
    }

    function dateKey(value) {
        var text = String(value || '').trim();
        var brazilian = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        var iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        var year;
        var month;
        var day;
        if (brazilian) {
            day = Number(brazilian[1]);
            month = Number(brazilian[2]);
            year = Number(brazilian[3]);
        } else if (iso) {
            year = Number(iso[1]);
            month = Number(iso[2]);
            day = Number(iso[3]);
        } else {
            return null;
        }
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
            || date.getUTCDate() !== day) {
            return null;
        }
        return year * 10000 + month * 100 + day;
    }

    function recordDate(properties) {
        var values = valuesFor(properties, filterFields.date);
        for (var index = 0; index < values.length; index += 1) {
            var parsed = dateKey(values[index]);
            if (parsed !== null) {
                return parsed;
            }
        }
        return null;
    }

    function initialize() {
        var map = global.map;
        var sourceLayer = global.layer_OcorrnciasdeFaunaindividual_1;
        var cluster = global.cluster_OcorrnciasdeFaunaindividual_1;
        var collection = global.json_OcorrnciasdeFaunaindividual_1;
        var faunaSearch = global.FaunaSearch;
        var sidebar = element('sidebar');
        var sidebarToggle = element('sidebarToggle');
        var sidebarClose = element('sidebarClose');
        var sidebarOverlay = element('sidebarOverlay');
        var welcome = element('popupInicial');
        var welcomeClose = element('popupInicialClose');
        var welcomeContinue = element('btnExplorarMapa');
        var welcomePreference = element('fauna-welcome-session');
        var filterForm = element('fauna-filter-form');
        var filterStatus = element('fauna-filter-status');
        var clearFiltersButton = element('fauna-filter-clear');

        if (!map || !sourceLayer || !cluster || !collection || !Array.isArray(collection.features)
            || !faunaSearch) {
            throw new Error('O mapa ou a base de ocorrências não foi inicializado corretamente.');
        }

        var renderedRecords = [];
        sourceLayer.eachLayer(function (featureLayer) {
            var feature = featureLayer.feature;
            if (!feature || !feature.properties) {
                throw new Error('Uma ocorrência não possui seus atributos originais.');
            }
            renderedRecords.push({
                layer: featureLayer,
                properties: feature.properties
            });
        });
        if (renderedRecords.length !== collection.features.length) {
            throw new Error('A quantidade de pontos do mapa diverge da base de ocorrências.');
        }

        function populateSelect(id, fields) {
            var select = element(id);
            var options = Object.create(null);
            renderedRecords.forEach(function (record) {
                valuesFor(record.properties, fields).forEach(function (value) {
                    options[value] = true;
                });
            });
            Object.keys(options).sort(function (left, right) {
                return left.localeCompare(right, 'pt-BR', { sensitivity: 'base' });
            }).forEach(function (value) {
                var option = document.createElement('option');
                option.value = value;
                option.textContent = value;
                select.appendChild(option);
            });
        }

        populateSelect('fauna-filter-class', filterFields.taxonomicClass);
        populateSelect('fauna-filter-city', filterFields.city);
        populateSelect('fauna-filter-segment', filterFields.segment);
        populateSelect('fauna-filter-institution', filterFields.institution);
        populateSelect('fauna-filter-condition', filterFields.condition);
        populateSelect('fauna-filter-sex', filterFields.sex);
        populateSelect('fauna-filter-stage', filterFields.developmentStage);
        populateSelect('fauna-filter-threatened', filterFields.threatened);

        var speciesSearch = faunaSearch.createAutocomplete({
            input: element('fauna-filter-species'),
            clearButton: element('fauna-filter-species-clear'),
            list: element('fauna-species-suggestions'),
            records: renderedRecords,
            fields: filterFields.species,
            emptyMessage: 'Nenhum nome científico encontrado.',
            idPrefix: 'fauna-species',
            onChange: applyFilters
        });
        var commonNameSearch = faunaSearch.createAutocomplete({
            input: element('fauna-filter-common-name'),
            clearButton: element('fauna-filter-common-name-clear'),
            list: element('fauna-common-name-suggestions'),
            records: renderedRecords,
            fields: filterFields.common,
            emptyMessage: 'Nenhum nome popular encontrado.',
            idPrefix: 'fauna-common-name',
            onChange: applyFilters
        });

        function readFilters() {
            return {
                species: speciesSearch.getFilter(),
                commonName: commonNameSearch.getFilter(),
                taxonomicClass: element('fauna-filter-class').value,
                dateFrom: dateKey(element('fauna-filter-date-from').value),
                dateTo: dateKey(element('fauna-filter-date-to').value),
                city: element('fauna-filter-city').value,
                segment: element('fauna-filter-segment').value,
                institution: element('fauna-filter-institution').value,
                condition: element('fauna-filter-condition').value,
                sex: element('fauna-filter-sex').value,
                developmentStage: element('fauna-filter-stage').value,
                threatened: element('fauna-filter-threatened').value
            };
        }

        function matchesAny(properties, fields, selected) {
            if (!selected) {
                return true;
            }
            return valuesFor(properties, fields).some(function (value) {
                return normalize(value) === normalize(selected);
            });
        }

        function matchesRecord(properties, filters) {
            if (!faunaSearch.matches(properties, filterFields.species, filters.species)
                || !faunaSearch.matches(properties, filterFields.common, filters.commonName)) {
                return false;
            }
            if (!matchesAny(properties, filterFields.taxonomicClass, filters.taxonomicClass)
                || !matchesAny(properties, filterFields.city, filters.city)
                || !matchesAny(properties, filterFields.segment, filters.segment)
                || !matchesAny(properties, filterFields.institution, filters.institution)
                || !matchesAny(properties, filterFields.condition, filters.condition)
                || !matchesAny(properties, filterFields.sex, filters.sex)
                || !matchesAny(properties, filterFields.developmentStage, filters.developmentStage)
                || !matchesAny(properties, filterFields.threatened, filters.threatened)) {
                return false;
            }

            if (filters.dateFrom !== null || filters.dateTo !== null) {
                var occurrenceDate = recordDate(properties);
                if (occurrenceDate === null
                    || (filters.dateFrom !== null && occurrenceDate < filters.dateFrom)
                    || (filters.dateTo !== null && occurrenceDate > filters.dateTo)) {
                    return false;
                }
            }
            return true;
        }

        function formatCount(count) {
            return new Intl.NumberFormat('pt-BR').format(count);
        }

        function updateStatus(count) {
            filterStatus.classList.toggle('is-empty', count === 0);
            if (count === 0) {
                filterStatus.textContent = 'Nenhuma ocorrência corresponde à pesquisa (0 de '
                    + formatCount(renderedRecords.length) + ' pontos/ocorrências).';
                return;
            }
            filterStatus.textContent = formatCount(count)
                + (count === 1 ? ' ocorrência encontrada' : ' ocorrências encontradas')
                + ' — exibindo ' + formatCount(count) + ' pontos de '
                + formatCount(renderedRecords.length) + ' ocorrências.';
        }

        function updateMap(matchingRecords) {
            cluster.clearLayers();
            cluster.addLayers(matchingRecords.map(function (record) {
                return record.layer;
            }));
            updateStatus(matchingRecords.length);
        }

        function applyFilters() {
            var filters = readFilters();
            if (filters.dateFrom !== null && filters.dateTo !== null
                && filters.dateFrom > filters.dateTo) {
                filterStatus.classList.add('is-empty');
                filterStatus.textContent = 'A data inicial deve ser anterior ou igual à data final.';
                return false;
            }
            updateMap(renderedRecords.filter(function (record) {
                return matchesRecord(record.properties, filters);
            }));
            return true;
        }

        function updateNavigationClearance() {
            var navigation = document.querySelector('.nav-bar');
            var viewportHeight = global.visualViewport
                ? global.visualViewport.height
                : global.innerHeight;
            var clearance = navigation
                ? Math.max(0, viewportHeight - navigation.getBoundingClientRect().top + 10)
                : 110;
            document.documentElement.style.setProperty('--fauna-nav-clearance', clearance + 'px');
            return clearance;
        }

        var overviewBounds = sourceLayer.getBounds();
        function fitOverview() {
            if (overviewBounds.isValid()) {
                map.fitBounds(overviewBounds, {
                    paddingTopLeft: [36, 36],
                    paddingBottomRight: [36, updateNavigationClearance() + 24]
                });
            }
            map.invalidateSize();
        }

        function closeSidebar(restoreFocus) {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            sidebarOverlay.setAttribute('aria-hidden', 'true');
            sidebar.setAttribute('aria-hidden', 'true');
            sidebar.setAttribute('inert', '');
            sidebarToggle.setAttribute('aria-expanded', 'false');
            document.getElementById('map').style.filter = 'none';
            map.invalidateSize();
            if (restoreFocus) {
                sidebarToggle.focus();
            }
        }

        function openSidebar() {
            sidebar.classList.add('open');
            sidebar.removeAttribute('inert');
            sidebar.setAttribute('aria-hidden', 'false');
            sidebarOverlay.classList.add('active');
            sidebarOverlay.setAttribute('aria-hidden', 'false');
            sidebarToggle.setAttribute('aria-expanded', 'true');
            document.getElementById('map').style.filter = 'grayscale(25%) brightness(0.95)';
            map.invalidateSize();
            var activeTab = sidebar.querySelector('.tab-button.active');
            if (activeTab) {
                activeTab.focus();
            }
        }

        function closeWelcome() {
            if (welcomePreference.checked) {
                try {
                    global.sessionStorage.setItem(sessionWelcomeKey, 'true');
                } catch (error) {
                    console.warn('Não foi possível salvar a preferência de apresentação da janela inicial.', error);
                }
            }
            welcome.hidden = true;
            map.invalidateSize();
            sidebarToggle.focus();
        }

        sidebarToggle.addEventListener('click', function () {
            if (sidebar.classList.contains('open')) {
                closeSidebar(true);
            } else {
                openSidebar();
            }
        });
        sidebarClose.addEventListener('click', function () {
            closeSidebar(true);
        });
        sidebarOverlay.addEventListener('click', function () {
            closeSidebar(true);
        });

        sidebar.querySelectorAll('.tab-button').forEach(function (button) {
            button.addEventListener('click', function () {
                sidebar.querySelectorAll('.tab-button').forEach(function (tab) {
                    var active = tab === button;
                    tab.classList.toggle('active', active);
                    tab.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                sidebar.querySelectorAll('.tab-content').forEach(function (content) {
                    var active = content.id === 'tab-' + button.dataset.tab;
                    content.classList.toggle('active', active);
                    content.hidden = !active;
                });
            });
        });

        filterForm.addEventListener('submit', function (event) {
            event.preventDefault();
            speciesSearch.hide();
            commonNameSearch.hide();
            applyFilters();
        });
        clearFiltersButton.addEventListener('click', function () {
            filterForm.reset();
            speciesSearch.clear();
            commonNameSearch.clear();
            updateMap(renderedRecords);
            fitOverview();
        });

        welcomeClose.addEventListener('click', closeWelcome);
        welcomeContinue.addEventListener('click', closeWelcome);
        welcome.addEventListener('click', function (event) {
            if (event.target === welcome) {
                closeWelcome();
            }
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                if (sidebar.classList.contains('open')) {
                    closeSidebar(true);
                }
                if (!welcome.hidden) {
                    closeWelcome();
                }
            }
        });
        global.addEventListener('resize', updateNavigationClearance);
        if (global.visualViewport) {
            global.visualViewport.addEventListener('resize', updateNavigationClearance);
        }

        updateNavigationClearance();
        updateStatus(renderedRecords.length);
        fitOverview();
        try {
            if (global.sessionStorage.getItem(sessionWelcomeKey) === 'true') {
                welcome.hidden = true;
            }
        } catch (error) {
            console.warn('Não foi possível ler a preferência de apresentação da janela inicial.', error);
        }
        if (!welcome.hidden) {
            welcomeContinue.focus();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
}(window));
