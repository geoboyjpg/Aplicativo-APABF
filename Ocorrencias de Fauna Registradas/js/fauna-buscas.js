(function (global) {
    'use strict';

    function normalize(value) {
        return String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase('pt-BR');
    }

    function valuesFor(properties, fields) {
        return fields.map(function (field) {
            var value = properties[field];
            return value === null || value === undefined ? '' : String(value).trim();
        }).filter(Boolean);
    }

    function buildSuggestions(records, fields) {
        var suggestions = Object.create(null);
        records.forEach(function (record) {
            valuesFor(record.properties, fields).forEach(function (label) {
                var value = normalize(label);
                if (value && !suggestions[value]) {
                    suggestions[value] = { label: label, value: value };
                }
            });
        });
        return Object.keys(suggestions).map(function (value) {
            return suggestions[value];
        }).sort(function (left, right) {
            return left.label.localeCompare(right.label, 'pt-BR', { sensitivity: 'base' });
        });
    }

    function matches(properties, fields, search) {
        if (!search.query) {
            return true;
        }
        return valuesFor(properties, fields).some(function (value) {
            var normalized = normalize(value);
            return search.selected
                ? normalized === search.selected
                : normalized.includes(search.query);
        });
    }

    function createAutocomplete(options) {
        var input = options.input;
        var clearButton = options.clearButton;
        var list = options.list;
        var suggestions = buildSuggestions(options.records, options.fields);
        var selectedValue = null;
        var activeIndex = -1;

        function hideSuggestions() {
            list.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            activeIndex = -1;
        }

        function setActiveSuggestion(index) {
            var items = list.querySelectorAll('[role="option"]:not([aria-disabled="true"])');
            if (!items.length) {
                activeIndex = -1;
                input.removeAttribute('aria-activedescendant');
                return;
            }
            activeIndex = (index + items.length) % items.length;
            items.forEach(function (item, itemIndex) {
                var active = itemIndex === activeIndex;
                item.classList.toggle('is-active', active);
                item.setAttribute('aria-selected', active ? 'true' : 'false');
                if (active) {
                    input.setAttribute('aria-activedescendant', item.id);
                    item.scrollIntoView({ block: 'nearest' });
                }
            });
        }

        function chooseSuggestion(suggestion) {
            selectedValue = suggestion.value;
            input.value = suggestion.label;
            clearButton.hidden = false;
            hideSuggestions();
            options.onChange();
        }

        function updateSuggestions() {
            var query = normalize(input.value);
            selectedValue = null;
            activeIndex = -1;
            clearButton.hidden = !input.value;
            list.textContent = '';
            input.removeAttribute('aria-activedescendant');
            if (!query) {
                hideSuggestions();
                return;
            }

            var matchesForQuery = suggestions.filter(function (suggestion) {
                return suggestion.value.includes(query);
            }).slice(0, 8);
            if (!matchesForQuery.length) {
                var emptyOption = document.createElement('li');
                emptyOption.className = 'fauna-species-suggestion fauna-species-suggestion--empty';
                emptyOption.setAttribute('role', 'option');
                emptyOption.setAttribute('aria-disabled', 'true');
                emptyOption.textContent = options.emptyMessage;
                list.appendChild(emptyOption);
            } else {
                matchesForQuery.forEach(function (suggestion, index) {
                    var item = document.createElement('li');
                    item.className = 'fauna-species-suggestion';
                    item.id = options.idPrefix + '-option-' + index;
                    item.setAttribute('role', 'option');
                    item.setAttribute('aria-selected', 'false');
                    item.textContent = suggestion.label;
                    item.addEventListener('mousedown', function (event) {
                        event.preventDefault();
                    });
                    item.addEventListener('click', function () {
                        chooseSuggestion(suggestion);
                    });
                    list.appendChild(item);
                });
            }
            list.hidden = false;
            input.setAttribute('aria-expanded', 'true');
        }

        input.addEventListener('input', updateSuggestions);
        input.addEventListener('blur', hideSuggestions);
        input.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (list.hidden) {
                    updateSuggestions();
                }
                setActiveSuggestion(activeIndex + 1);
            } else if (event.key === 'ArrowUp' && !list.hidden) {
                event.preventDefault();
                var optionCount = list.querySelectorAll(
                    '[role="option"]:not([aria-disabled="true"])'
                ).length;
                setActiveSuggestion(activeIndex <= 0 ? optionCount - 1 : activeIndex - 1);
            } else if (event.key === 'Enter' && activeIndex >= 0) {
                var items = list.querySelectorAll('[role="option"]:not([aria-disabled="true"])');
                if (items[activeIndex]) {
                    event.preventDefault();
                    items[activeIndex].click();
                }
            } else if (event.key === 'Escape') {
                hideSuggestions();
            }
        });
        clearButton.addEventListener('click', function () {
            input.value = '';
            selectedValue = null;
            clearButton.hidden = true;
            hideSuggestions();
            options.onChange();
            input.focus();
        });

        return {
            getFilter: function () {
                return {
                    query: normalize(input.value),
                    selected: selectedValue
                };
            },
            clear: function () {
                input.value = '';
                selectedValue = null;
                clearButton.hidden = true;
                hideSuggestions();
            },
            hide: hideSuggestions
        };
    }

    var api = {
        normalize: normalize,
        buildSuggestions: buildSuggestions,
        matches: matches,
        createAutocomplete: createAutocomplete
    };
    global.FaunaSearch = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
}(typeof window === 'undefined' ? globalThis : window));
