// Envío AJAX de formularios de captación (sin recargar) + validación + feedback.
(function () {
  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(function () {
    var forms = document.querySelectorAll('form.js-lead');
    Array.prototype.forEach.call(forms, function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!form.checkValidity()) { form.reportValidity(); return; }

        var btn = form.querySelector('button[type="submit"]');
        var orig = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Enviando…'; }

        fetch(form.action, {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'X-Requested-With': 'fetch' },
          body: new URLSearchParams(new FormData(form)),
        })
          .then(function (r) { return r.json().catch(function () { return { ok: true }; }); })
          .then(function (data) {
            var ok = document.createElement('div');
            ok.className = 'lead-ok';
            ok.setAttribute('role', 'status');
            ok.innerHTML =
              '<span class="msi">check_circle</span>' +
              '<div><strong>¡Solicitud enviada!</strong><p>' +
              ((data && data.message) || 'Un asesor académico te contactará muy pronto.') +
              '</p></div>';
            form.replaceWith(ok);
          })
          .catch(function () {
            if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.innerHTML = orig; }
            var err = form.querySelector('.lead-err') || document.createElement('p');
            err.className = 'lead-err';
            err.textContent = 'No pudimos enviar el formulario. Revisa tu conexión e inténtalo de nuevo.';
            if (!err.parentNode) form.appendChild(err);
          });
      });
    });
  });
})();
