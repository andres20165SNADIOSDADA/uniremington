(function(){
  document.querySelectorAll('.prog-carousel').forEach(function(carousel){
    var grid = carousel.querySelector('.prog-grid');
    var pager = carousel.querySelector('.prog-pager');
    if (!grid || !pager) return;
    var prev = pager.querySelector('.prog-arrow--prev');
    var next = pager.querySelector('.prog-arrow--next');
    var dotsWrap = pager.querySelector('.prog-dots');
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.pcard'));
    if (!cards.length) { pager.hidden = true; return; }

    var perPage = cards.length, pages = 1, page = 0;

    function columns(){
      cards.forEach(function(c){ c.style.display = ''; });
      var top0 = cards[0].offsetTop, n = 0;
      for (var i = 0; i < cards.length; i++){
        if (Math.abs(cards[i].offsetTop - top0) < 2) n++; else break;
      }
      return Math.max(n, 1);
    }

    function renderDots(){
      dotsWrap.innerHTML = '';
      if (pages > 6){
        dotsWrap.classList.add('prog-dots--count');
        var span = document.createElement('span');
        span.className = 'prog-count';
        dotsWrap.appendChild(span);
        return;
      }
      dotsWrap.classList.remove('prog-dots--count');
      for (var i = 0; i < pages; i++){
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'prog-dot';
        b.setAttribute('aria-label', 'Página ' + (i + 1) + ' de ' + pages);
        b.addEventListener('click', (function(idx){ return function(){ page = idx; show(); }; })(i));
        dotsWrap.appendChild(b);
      }
    }

    function show(){
      cards.forEach(function(c, i){
        c.style.display = (i >= page * perPage && i < (page + 1) * perPage) ? '' : 'none';
      });
      prev.disabled = page === 0;
      next.disabled = page >= pages - 1;
      if (dotsWrap.classList.contains('prog-dots--count')){
        var span = dotsWrap.querySelector('.prog-count');
        if (span) span.textContent = (page + 1) + ' / ' + pages;
      } else {
        Array.prototype.forEach.call(dotsWrap.children, function(d, i){
          d.classList.toggle('is-active', i === page);
          d.setAttribute('aria-current', i === page ? 'true' : 'false');
        });
      }
    }

    function layout(){
      var rows = columns() === 1 ? 4 : 2;
      perPage = columns() * rows;
      pages = Math.max(Math.ceil(cards.length / perPage), 1);
      pager.hidden = pages <= 1;
      if (page >= pages) page = pages - 1;
      renderDots();
      show();
    }

    prev.addEventListener('click', function(){ if (page > 0){ page--; show(); } });
    next.addEventListener('click', function(){ if (page < pages - 1){ page++; show(); } });

    var resizeTimer;
    window.addEventListener('resize', function(){
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 200);
    });
    layout();
  });
})();
