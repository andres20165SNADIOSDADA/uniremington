(function () {
  var editorEl = document.getElementById('editor');
  if (!editorEl || typeof Quill === 'undefined') return;

  var form = editorEl.closest('form');
  var csrfToken = form.querySelector('input[name="_csrf"]').value;

  // Barra de herramientas deliberadamente limitada: cada botón produce exactamente el
  // subconjunto de HTML que app/lib/sanitizeHtml.js acepta en el servidor — así lo que
  // el editor permite y lo que el servidor guarda siempre coinciden.
  var quill = new Quill('#editor', {
    theme: 'snow',
    modules: {
      toolbar: {
        container: [
          [{ header: [2, 3, false] }],
          ['bold', 'italic', 'underline'],
          [{ color: ['#00457c', '#0a5aa8', '#e30613', '#0f9d58', '#2c3945', false] }],
          [{ align: [] }],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['blockquote', 'link', 'image', 'video'],
          ['clean'],
        ],
        handlers: { image: handleImageButton, video: handleVideoButton },
      },
    },
  });

  // Sube la imagen elegida (misma validación/optimización que la portada) y la inserta
  // en el punto del cursor — nunca se guarda como base64 dentro del HTML.
  function handleImageButton() {
    var range = quill.getSelection(true);
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var fd = new FormData();
      fd.append('image', file);
      fd.append('_csrf', csrfToken);
      quill.insertText(range.index, 'Subiendo imagen…', 'italic', true);
      fetch('/admin/subir-imagen', { method: 'POST', body: fd })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          quill.deleteText(range.index, 'Subiendo imagen…'.length);
          if (data.url) {
            quill.insertEmbed(range.index, 'image', data.url, 'user');
            quill.setSelection(range.index + 1);
          } else {
            alert(data.error || 'No se pudo subir la imagen.');
          }
        })
        .catch(function () {
          quill.deleteText(range.index, 'Subiendo imagen…'.length);
          alert('No se pudo subir la imagen (error de conexión).');
        });
    };
    input.click();
  }

  // Solo admite enlaces de YouTube — nunca cualquier iframe arbitrario (el servidor
  // igual lo revalida al guardar, esto es solo para no dejar pegar un enlace que no sirve).
  function handleVideoButton() {
    var url = window.prompt('Pega el enlace del video de YouTube:');
    if (!url) return;
    var m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{6,20})/);
    if (!m) { alert('Solo se admiten enlaces de YouTube (youtube.com o youtu.be).'); return; }
    var range = quill.getSelection(true);
    quill.insertEmbed(range.index, 'video', 'https://www.youtube.com/embed/' + m[1], 'user');
    quill.setSelection(range.index + 1);
  }

  form.addEventListener('submit', function () {
    document.getElementById('content_body_input').value = quill.root.innerHTML;
  });

  // Vista previa inmediata de la imagen de portada elegida (antes de subirla).
  var coverInput = document.getElementById('cover_image');
  var coverPreview = document.getElementById('coverPreview');
  var coverEmpty = document.getElementById('coverEmpty');
  if (coverInput && coverPreview && coverEmpty) {
    coverInput.addEventListener('change', function () {
      var file = coverInput.files && coverInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        coverPreview.src = e.target.result;
        coverPreview.hidden = false;
        coverEmpty.hidden = true;
      };
      reader.readAsDataURL(file);
    });
  }

  // Vista previa de la noticia/evento tal como se vería publicada, sin guardar nada.
  var previewBtn = document.getElementById('previewBtn');
  if (previewBtn) {
    previewBtn.addEventListener('click', function () {
      var win = window.open('', '_blank');
      var fd = new FormData(form);
      fd.set('content_body', quill.root.innerHTML);
      fetch(form.getAttribute('data-preview-url'), { method: 'POST', body: fd })
        .then(function (res) { return res.text(); })
        .then(function (html) { win.document.write(html); win.document.close(); })
        .catch(function () { win.close(); alert('No se pudo generar la vista previa.'); });
    });
  }
})();
