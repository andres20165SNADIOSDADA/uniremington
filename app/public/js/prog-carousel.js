(function(){
  document.querySelectorAll('.prog-carousel').forEach(function(carousel){
    var track = carousel.querySelector('.prog-grid--scroll');
    var prev = carousel.querySelector('.prog-arrow--prev');
    var next = carousel.querySelector('.prog-arrow--next');
    if (!track || !prev || !next) return;

    function step(){
      var card = track.querySelector('.pcard');
      var gap = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap || '20') || 20;
      var w = card ? card.getBoundingClientRect().width : 260;
      return Math.round((w + gap) * 2);
    }

    function refresh(){
      var max = track.scrollWidth - track.clientWidth;
      if (max <= 4){
        prev.hidden = true; next.hidden = true;
        return;
      }
      prev.hidden = false; next.hidden = false;
      prev.disabled = track.scrollLeft <= 4;
      next.disabled = track.scrollLeft >= max - 4;
    }

    prev.addEventListener('click', function(){ track.scrollBy({ left: -step(), behavior: 'smooth' }); });
    next.addEventListener('click', function(){ track.scrollBy({ left: step(), behavior: 'smooth' }); });
    track.addEventListener('scroll', refresh, { passive: true });
    window.addEventListener('resize', refresh);
    refresh();
  });
})();
