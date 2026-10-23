(function () {
    'use strict';

    var password = 'baleialivre';
    var form = document.getElementById('generator-access-form');
    var input = document.getElementById('generator-password');
    var gate = document.getElementById('generator-access');
    var error = document.getElementById('generator-access-error');

    window.GeradorMapasAcesso = {
        requirePassword: function (onAuthorized) {
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                if (input.value !== password) {
                    input.value = '';
                    error.textContent = 'Senha incorreta. Tente novamente.';
                    error.hidden = false;
                    input.focus();
                    return;
                }
                input.value = '';
                error.textContent = '';
                error.hidden = true;
                gate.hidden = true;
                document.body.classList.add('generator-unlocked');
                onAuthorized();
            });
        }
    };
}());
