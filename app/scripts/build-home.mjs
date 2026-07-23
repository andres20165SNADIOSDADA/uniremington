// Genera app/views/home.ejs a partir de la maqueta del repositorio,
// cableando el menú a las rutas reales y repuntando "Actualidad" a la API local.
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'D:/u8/index.html';
const OUT = new URL('../views/home.ejs', import.meta.url);
let html = readFileSync(SRC, 'utf-8');

// 0) Fuente corporativa PT Sans (auto-alojada)
html = html.replace('<title>Maqueta - Uniremington (Responsive)</title>',
  '<title>Maqueta - Uniremington (Responsive)</title>\n  <link rel="stylesheet" href="/css/fonts.css">');

// 0a) Botón flotante de WhatsApp + flecha "volver arriba" antes de cerrar el body
html = html.replace('</body>', "<%- include('partials/whatsapp') %>\n<%- include('partials/totop') %>\n</body>");

// 0b) Footer: usar el logo local (texto blanco, ícono a color) y quitar el
//     filtro que blanqueaba todo el logo (dejaba un parche blanco).
html = html.replace(
  '<img src="https://www.uniremington.edu.co/wp-content/uploads/2025/05/logo-uniremington.svg" alt="Uniremington">\n          <p>Más de un siglo',
  '<img src="/img/logo-uniremington-blanco.svg" alt="Corporación Universitaria Remington">\n          <p>Más de un siglo');
html = html.replace('filter: brightness(0) invert(1);', '');

// 1) Imagen local del banner (estaba como ruta relativa con espacios)
html = html.split('imagen%20banner%201.jpeg').join('/media/imagen-banner-1.jpeg');
html = html.split('imagen banner 1.jpeg').join('/media/imagen-banner-1.jpeg');

// 2) Cablear los CTA y enlaces de programas a rutas reales
const links = [
  ['<a href="#" class="cta-hero">',                       '<a href="/programas" class="cta-hero">'],
  ['<a href="#" class="btn">VER OFERTA</a>',              '<a href="/programas" class="btn">VER OFERTA</a>'],
  ['<a href="#" class="mega-cta">Ver oferta completa &rarr;</a>', '<a href="/programas" class="mega-cta">Ver oferta completa &rarr;</a>'],
  ['<a class="m-cta" href="#">Explorar Programas &rarr;</a>',     '<a class="m-cta" href="/programas">Explorar Programas &rarr;</a>'],
  ['<a href="#" class="navbar-cta">Inscríbete Ahora</a>',        '<a href="https://class.uniremington.edu.co/academico/nuevoIngreso/Default.aspx" target="_blank" rel="noopener" class="navbar-cta">Inscríbete Ahora</a>'],
  ['<a class="m-cta" href="#" style="background: var(--blue); margin-top: 8px;">Inscríbete Ahora</a>', '<a class="m-cta" href="https://class.uniremington.edu.co/academico/nuevoIngreso/Default.aspx" target="_blank" rel="noopener" style="background: var(--blue); margin-top: 8px;">Inscríbete Ahora</a>'],
  // panel mega "Oferta Académica" (escritorio)
  ['<a href="#" role="menuitem"><i class="dot blue"></i>Pregrados</a>',        '<a href="/programas" role="menuitem"><i class="dot blue"></i>Pregrados</a>'],
  ['<a href="#" role="menuitem"><i class="dot blue"></i>Tecnologías</a>',      '<a href="/programas" role="menuitem"><i class="dot blue"></i>Tecnologías</a>'],
  ['<a href="#" role="menuitem"><i class="dot blue"></i>Posgrados</a>',        '<a href="/programas" role="menuitem"><i class="dot blue"></i>Posgrados</a>'],
  ['<a href="#" role="menuitem"><i class="dot blue"></i>Especializaciones</a>','<a href="/programas" role="menuitem"><i class="dot blue"></i>Especializaciones</a>'],
  // drawer móvil (programas)
  ['<a href="#">Pregrados</a>',        '<a href="/programas">Pregrados</a>'],
  ['<a href="#">Tecnologías</a>',      '<a href="/programas">Tecnologías</a>'],
  ['<a href="#">Posgrados</a>',        '<a href="/programas">Posgrados</a>'],
  ['<a href="#">Especializaciones</a>','<a href="/programas">Especializaciones</a>'],
  // grid de 4 tarjetas
  ['<a class="caption carreras" href="#">PREGRADOS</a>',            '<a class="caption carreras" href="/programas">PREGRADOS</a>'],
  ['<a class="caption tecnologias" href="#">TECNOLOGÍAS</a>',       '<a class="caption tecnologias" href="/programas">TECNOLOGÍAS</a>'],
  ['<a class="caption especializaciones" href="#">ESPECIALIZACIONES</a>', '<a class="caption especializaciones" href="/programas">ESPECIALIZACIONES</a>'],
];
for (const [a, b] of links) html = html.split(a).join(b);

// 3) Repuntar "Actualidad" (tabs) desde el WordPress en vivo a la API local
const START = 'const API = "https://www.uniremington.edu.co/wp-json/wp/v2";';
const END = 'sections.forEach(loadSection);';
const i = html.indexOf(START);
const j = html.indexOf(END);
if (i === -1 || j === -1) { console.error('No se encontró el bloque de Actualidad'); process.exit(1); }
const nuevo = `const ACT_TABS = ["noticias", "eventos", "blog"];
  async function loadTab(id) {
    try {
      const res = await fetch("/api/actualidad/" + id);
      const posts = await res.json();
      if (!posts.length) return;
      const container = document.getElementById(id);
      const principal = posts[0];
      const secundarios = posts.slice(1, 5);
      container.innerHTML =
        '<div class="act-grid">' +
          '<div class="act-principal">' +
            '<a href="' + principal.url + '"><img src="' + principal.img + '" alt=""></a>' +
            '<div class="contenido"><span class="act-tag">' + principal.tag + '</span><h3>' + principal.title + '</h3></div>' +
          '</div>' +
          '<div class="act-cards">' +
            secundarios.map(function(p){ return (
              '<div class="act-card">' +
                '<a href="' + p.url + '"><img src="' + p.img + '" alt=""></a>' +
                '<div class="info"><span class="act-tag">' + p.tag + '</span><h4>' + p.title + '</h4><p>' + p.date + '</p></div>' +
              '</div>'); }).join("") +
          '</div>' +
        '</div>';
    } catch (e) { console.error("actualidad", e); }
  }
  ACT_TABS.forEach(loadTab);`;
html = html.slice(0, i) + nuevo + html.slice(j + END.length);

writeFileSync(OUT, html, 'utf-8');
console.log('home.ejs generado (' + html.length + ' bytes)');
