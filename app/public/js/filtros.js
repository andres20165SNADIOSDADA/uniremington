// Filtro de programas: facultad · tipo · modalidad · sede + búsqueda (cliente).
// Preselecciona desde los data-* de #filtros (que el servidor rellena con el preset de la
// ruta: /especializaciones, /maestrias…) y desde la query string (?tipo=&facultad=&sede=&q=).
(function () {
  const grid = document.getElementById('prog-grid');
  if (!grid) return;
  const cards = Array.prototype.slice.call(grid.querySelectorAll('.pcard'));
  const fFac = document.getElementById('f-fac');
  const fMod = document.getElementById('f-mod');
  const fTipo = document.getElementById('f-tipo');
  const fSede = document.getElementById('f-sede');
  const fQ = document.getElementById('f-q');
  const count = document.getElementById('f-count');
  const empty = document.getElementById('f-empty');
  const clear = document.getElementById('f-clear');
  const box = document.getElementById('filtros');

  function apply() {
    const fac = fFac.value, mod = fMod.value, tipo = fTipo.value, sede = fSede.value;
    const q = (fQ.value || '').trim().toLowerCase();
    let n = 0;
    cards.forEach(function (c) {
      const ok =
        (!fac || c.dataset.fac === fac) &&
        (!mod || c.dataset.mod === mod) &&
        (!tipo || c.dataset.tipo === tipo) &&
        (!sede || c.dataset.sedes.split('|').indexOf(sede) !== -1) &&
        (!q || c.dataset.search.indexOf(q) !== -1);
      c.style.display = ok ? '' : 'none';
      if (ok) n++;
    });
    count.textContent = n;
    empty.style.display = n ? 'none' : 'block';
    grid.style.display = n ? '' : 'none';
  }

  // valor por defecto: query string tiene prioridad sobre el preset del servidor (data-*)
  function setSelect(el, val) {
    if (!el || !val) return;
    const opt = Array.prototype.some.call(el.options, function (o) { return o.value === val; });
    if (opt) el.value = val;
  }
  const qs = new URLSearchParams(location.search);
  const d = (box && box.dataset) || {};
  setSelect(fTipo, qs.get('tipo') || d.tipo);
  setSelect(fFac, qs.get('facultad') || qs.get('fac') || d.fac);
  setSelect(fMod, qs.get('modalidad') || qs.get('mod') || d.mod);
  setSelect(fSede, qs.get('sede') || d.sede);
  if (fQ) fQ.value = qs.get('q') || d.q || '';

  [fFac, fMod, fTipo, fSede].forEach(function (el) { if (el) el.addEventListener('change', apply); });
  if (fQ) fQ.addEventListener('input', apply);
  clear.addEventListener('click', function () {
    [fFac, fMod, fTipo, fSede].forEach(function (el) { if (el) el.value = ''; });
    if (fQ) fQ.value = '';
    apply();
  });
  apply();
})();
