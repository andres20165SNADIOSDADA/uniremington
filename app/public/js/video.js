// Mejora progresiva de los videos de YouTube: en vez de cargar el iframe (y los scripts de
// YouTube) de entrada, se muestra una fachada ligera —miniatura + botón de play de marca— y el
// iframe real se inserta solo al hacer clic. Mejora el diseño y acelera la carga de la página.
(function () {
  var boxes = document.querySelectorAll('.video-embed');
  if (!boxes.length) return;

  Array.prototype.forEach.call(boxes, function (box) {
    var ifr = box.querySelector('iframe');
    if (!ifr) return;
    var src = ifr.getAttribute('src') || '';
    var m = src.match(/(?:embed\/|[?&]v=|youtu\.be\/)([\w-]{6,})/);
    if (!m) return;
    var id = m[1];

    box.classList.add('yt-facade');
    box.innerHTML =
      '<img class="yt-thumb" src="https://i.ytimg.com/vi/' + id + '/hqdefault.jpg" ' +
      'alt="Reproducir video de la Corporación Universitaria Remington" loading="lazy" decoding="async">' +
      '<button class="yt-play" type="button" aria-label="Reproducir video">' +
      '<span class="yt-tri"></span></button>';

    box.addEventListener('click', function () {
      var f = document.createElement('iframe');
      f.src = src + (src.indexOf('?') > -1 ? '&' : '?') + 'autoplay=1';
      f.title = 'Video Uniremington';
      f.setAttribute('allowfullscreen', '');
      f.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
      box.classList.remove('yt-facade');
      box.innerHTML = '';
      box.appendChild(f);
    }, { once: true });
  });
})();
