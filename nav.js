(function () {
    'use strict';

    var script = document.currentScript;
    var base = script && script.dataset.base ? script.dataset.base + '/' : '';
    var existingBar = document.querySelector('.nav-bar');

    if (!existingBar) {
        return;
    }

    var items = [
        { href: base + 'index.html', icon: 'fa-home', label: 'Início' },
        { href: base + 'Zoneamento APABF/index.html', icon: 'fa-map', label: 'Mapa' },
        { href: base + 'Fiscalização/index.html', icon: 'fa-shield-alt', label: 'Fiscalização' },
        { href: base + 'PMP-na-APABF-main2/index.html', icon: 'fa-camera', label: 'Ocorrências' },
        { href: base + 'Instrumentos Legais/index.html', icon: 'fa-gavel', label: 'Instrumentos Legais' }
    ];

    existingBar.innerHTML = '';
    existingBar.setAttribute('aria-label', 'Navegação principal');

    items.forEach(function (item) {
        var link = document.createElement('a');
        link.href = item.href;
        link.className = 'nav-btn';
        link.title = item.label;
        link.setAttribute('aria-label', item.label);

        if (new URL(link.href, window.location.href).pathname === window.location.pathname) {
            link.classList.add('is-active');
        }

        var icon = document.createElement('span');
        icon.className = 'nav-btn-icon';
        icon.innerHTML = '<i class="fas ' + item.icon + '" aria-hidden="true"></i>';

        var label = document.createElement('span');
        label.className = 'nav-btn-label';
        label.textContent = item.label;

        link.appendChild(icon);
        link.appendChild(label);
        existingBar.appendChild(link);
    });
}());
