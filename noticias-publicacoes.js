(function () {
    'use strict';

    var resultsElement = document.getElementById('news-results');
    var statusElement = document.getElementById('news-status');
    var countElement = document.getElementById('results-count');
    var updatedElement = document.getElementById('last-updated');
    var searchInput = document.getElementById('news-search');
    var categoryFilter = document.getElementById('category-filter');
    var dateFrom = document.getElementById('date-from');
    var dateTo = document.getElementById('date-to');
    var sortSelect = document.getElementById('sort-order');
    var items = [];
    var filtersWired = false;
    var collectionStatus = 'unknown';
    var collectionFreshness = 'unknown';
    var categoryLabels = {
        noticia: 'Notícias',
        academico: 'Acadêmico',
        institucional: 'Institucional',
        pesquisa: 'Pesquisa'
    };

    function formatDate(value) {
        if (!value) {
            return 'Data não informada';
        }
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return 'Data não informada';
        }
        return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
    }

    function normalize(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase('pt-BR');
    }

    function textElement(tag, className, text) {
        var element = document.createElement(tag);
        if (className) {
            element.className = className;
        }
        element.textContent = text;
        return element;
    }

    function createCard(item) {
        var card = document.createElement('article');
        card.className = 'news-card';

        var badges = document.createElement('div');
        badges.className = 'news-badges';
        badges.appendChild(textElement('span', 'news-badge', categoryLabels[item.category] || 'Publicação'));
        var isHigh = item.relevance && item.relevance.level === 'alta';
        var isComplementary = item.relevance && item.relevance.level === 'complementar';
        badges.appendChild(textElement(
            'span',
            'news-badge ' + (isHigh ? 'relevance-high' : isComplementary ? 'relevance-complementary' : 'relevance-medium'),
            'Relevância ' + (isHigh ? 'alta' : isComplementary ? 'complementar' : 'média') + ' · ' + item.relevance.score
        ));
        card.appendChild(badges);

        card.appendChild(textElement('h2', '', item.title || 'Conteúdo sem título'));
        if (item.summary) {
            card.appendChild(textElement('p', 'news-card-summary', item.summary));
        }
        var academicDetails = [];
        if (Array.isArray(item.authors) && item.authors.length) {
            academicDetails.push(item.authors.join('; '));
        }
        if (item.journal) {
            academicDetails.push(item.journal);
        }
        if (academicDetails.length) {
            card.appendChild(textElement('p', 'news-card-authors', academicDetails.join(' · ')));
        }

        var metadata = document.createElement('div');
        metadata.className = 'news-card-meta';
        var source = document.createElement('span');
        source.appendChild(textElement('i', 'fas fa-building', ''));
        source.lastChild.setAttribute('aria-hidden', 'true');
        source.appendChild(document.createTextNode(item.source && item.source.name ? item.source.name : 'Fonte não informada'));
        metadata.appendChild(source);
        var date = document.createElement('span');
        date.appendChild(textElement('i', 'far fa-calendar', ''));
        date.lastChild.setAttribute('aria-hidden', 'true');
        date.appendChild(document.createTextNode(formatDate(item.published_at)));
        metadata.appendChild(date);
        card.appendChild(metadata);

        var reason = item.relevance && Array.isArray(item.relevance.reason)
            ? item.relevance.reason.join('; ')
            : '';
        if (reason) {
            card.appendChild(textElement('p', 'news-reason', 'Por que apareceu: ' + reason));
        }

        var link = document.createElement('a');
        link.className = 'news-original-link';
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.appendChild(document.createTextNode('Ver conteúdo original'));
        var externalIcon = document.createElement('i');
        externalIcon.className = 'fas fa-arrow-up-right-from-square';
        externalIcon.setAttribute('aria-hidden', 'true');
        link.appendChild(externalIcon);
        card.appendChild(link);
        return card;
    }

    function itemDate(item) {
        var value = item.published_at || '';
        return value.slice(0, 10);
    }

    function render() {
        var query = normalize(searchInput.value.trim());
        var category = categoryFilter.value;
        var from = dateFrom.value;
        var to = dateTo.value;
        var filtered = items.filter(function (item) {
            if (category !== 'todos' && item.category !== category) {
                return false;
            }
            var date = itemDate(item);
            if (from && (!date || date < from)) {
                return false;
            }
            if (to && (!date || date > to)) {
                return false;
            }
            var searchable = normalize([
                item.title,
                item.summary,
                (item.authors || []).join(' '),
                item.journal,
                item.doi,
                item.source && item.source.name,
                (item.locations || []).join(' '),
                (item.keywords || []).join(' ')
            ].join(' '));
            return !query || searchable.includes(query);
        });

        filtered.sort(function (left, right) {
            var leftDate = left.published_at || '';
            var rightDate = right.published_at || '';
            if (sortSelect.value === 'recent') {
                return rightDate.localeCompare(leftDate)
                    || (right.relevance.score || 0) - (left.relevance.score || 0);
            }
            return (right.relevance.score || 0) - (left.relevance.score || 0)
                || rightDate.localeCompare(leftDate);
        });

        resultsElement.replaceChildren();
        filtered.forEach(function (item) {
            resultsElement.appendChild(createCard(item));
        });
        countElement.textContent = filtered.length + (filtered.length === 1 ? ' resultado' : ' resultados');

        if (!items.length && collectionStatus === 'failed') {
            statusElement.textContent = 'A última coleta falhou e não há resultados publicados para exibir. Consulte o estado da coleta ou tente novamente mais tarde.';
            statusElement.hidden = false;
        } else if (!items.length) {
            statusElement.textContent = 'Ainda não há resultados publicados. A coleta automática será executada pelo GitHub Actions.';
            statusElement.hidden = false;
        } else if (!filtered.length) {
            statusElement.textContent = 'Nenhum conteúdo corresponde aos filtros selecionados.';
            statusElement.hidden = false;
        } else if (collectionStatus === 'partial') {
            statusElement.textContent = 'Coleta parcial: os resultados de consultas concluídas estão disponíveis; os dados anteriores foram preservados.';
            statusElement.hidden = false;
        } else if (collectionStatus === 'failed') {
            statusElement.textContent = 'A última coleta falhou. Os resultados exibidos pertencem à base anterior preservada.';
            statusElement.hidden = false;
        } else if (collectionFreshness === 'stale') {
            statusElement.textContent = 'A data da última checagem está desatualizada. Os resultados publicados podem não incluir coletas recentes.';
            statusElement.hidden = false;
        } else {
            statusElement.hidden = true;
        }
    }

    function wireFilters() {
        if (filtersWired) {
            return;
        }
        [searchInput, categoryFilter, dateFrom, dateTo, sortSelect].forEach(function (input) {
            input.addEventListener('input', render);
            input.addEventListener('change', render);
        });
        filtersWired = true;
    }

    function loadNews() {
        statusElement.textContent = 'Carregando resultados…';
        statusElement.hidden = false;
        countElement.textContent = 'Carregando conteúdos…';

        fetch('dados/noticias-publicacoes.json', { cache: 'no-cache' })
        .then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.json();
        })
        .then(function (data) {
            if (!data || data.schema_version !== 1 || !Array.isArray(data.items)) {
                throw new Error('Formato de dados inválido');
            }
            items = data.items.filter(function (item) {
                return item.relevance
                    && ['alta', 'media', 'complementar'].includes(item.relevance.level);
            });
            collectionStatus = data.collection_status || 'unknown';
            var lastChecked = data.last_checked_at
                ? 'Última checagem: ' + formatDate(data.last_checked_at)
                : '';
            var lastPublished = data.generated_at
                ? 'Última publicação: ' + formatDate(data.generated_at)
                : 'Data da última publicação indisponível';
            var checkedAt = new Date(data.last_checked_at || data.generated_at || '');
            collectionFreshness = Number.isNaN(checkedAt.getTime())
                || Date.now() - checkedAt.getTime() > 7 * 24 * 60 * 60 * 1000
                ? 'stale'
                : 'fresh';
            updatedElement.textContent = collectionStatus === 'partial'
                ? 'Coleta parcial. ' + lastChecked + ' ' + lastPublished
                : collectionStatus === 'failed'
                    ? 'Última coleta falhou. ' + lastChecked + ' ' + lastPublished
                    : collectionFreshness === 'stale'
                        ? 'Checagem desatualizada. ' + lastChecked + ' ' + lastPublished
                    : lastChecked || lastPublished;
            wireFilters();
            render();
        })
        .catch(function (error) {
            updatedElement.textContent = 'Não foi possível carregar a data da atualização.';
            countElement.textContent = 'Resultados indisponíveis';
            statusElement.replaceChildren(document.createTextNode(
                'Não foi possível carregar os conteúdos. Verifique sua conexão e tente novamente. '
            ));
            var retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.className = 'news-retry';
            retryButton.textContent = 'Tentar novamente';
            retryButton.addEventListener('click', loadNews);
            statusElement.appendChild(retryButton);
            statusElement.hidden = false;
            console.error('Falha ao carregar notícias e publicações:', error);
        });
    }

    loadNews();
}());
