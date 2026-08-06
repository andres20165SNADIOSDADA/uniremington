// Limpieza anti-XSS del HTML que llega del editor del panel (Quill). Se aplica SIEMPRE
// al guardar, sin importar qué mande el navegador — el toolbar del editor ya está
// limitado a este mismo conjunto de elementos, así que en el caso normal esto no
// recorta nada; es la última línea de defensa si alguien manda HTML a mano al endpoint.
//
// Importante: esto NO se aplica al contenido migrado de WordPress (post.json/tribe_events.json),
// que trae iframes/tablas/SVGs legítimos de páginas ya publicadas — solo al HTML que entra
// por el formulario de crear/editar noticia o evento.
import { createRequire } from 'node:module';

// `sanitize-html` (y su dependencia `htmlparser2`) se cargan con `require` en vez de un
// `import` estático: en el bundler de Vercel, un `import` estático de este paquete
// revienta con `ERR_REQUIRE_ESM` (conflicto de empaquetado CJS/ESM de htmlparser2) y,
// como este módulo se importa sin condición desde server.js, tumbaba el sitio completo.
// Con `require` (vía createRequire) la falla sí es capturable — el sitio público sigue
// funcionando; solo se pierde la posibilidad de guardar contenido nuevo desde el panel
// en ese entorno, algo que de todas formas no funciona ahí por falta de disco persistente.
let sanitizeHtml;
try {
  const require = createRequire(import.meta.url);
  sanitizeHtml = require('sanitize-html');
} catch (e) {
  console.error('[cms] sanitize-html no se pudo cargar en este entorno:', e.message);
  sanitizeHtml = () => { throw new Error('El editor de contenido no está disponible en este entorno.'); };
}

// Un solo color válido: hex (#abc / #aabbcc) o rgb()/rgba() — es lo que produce el
// selector de color de Quill. No se acepta url()/expression()/nada ejecutable.
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\))$/;
// Solo videos embebidos de YouTube — nunca un iframe con cualquier otro origen.
const YOUTUBE_EMBED = /^https:\/\/www\.youtube\.com\/embed\/[\w-]{6,20}(\?[\w=&-]*)?$/;

const OPTIONS = {
  allowedTags: [
    'p', 'br', 'strong', 'em', 'u', 's', 'blockquote', 'span',
    'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'img', 'figure', 'figcaption', 'iframe',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    span: ['style'],
    p: ['class'], h2: ['class'], h3: ['class'], h4: ['class'], li: ['class'],
    iframe: ['src', 'class', 'frameborder', 'allowfullscreen'],
  },
  allowedClasses: {
    p: ['ql-align-center', 'ql-align-right', 'ql-align-justify'],
    h2: ['ql-align-center', 'ql-align-right', 'ql-align-justify'],
    h3: ['ql-align-center', 'ql-align-right', 'ql-align-justify'],
    h4: ['ql-align-center', 'ql-align-right', 'ql-align-justify'],
    li: ['ql-align-center', 'ql-align-right', 'ql-align-justify'],
    iframe: ['ql-video'],
  },
  allowedStyles: {
    span: { color: [SAFE_COLOR] },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  disallowedTagsMode: 'discard',
  // Cualquier iframe que no sea exactamente un embed de YouTube se descarta por completo
  // (no solo se le limpian atributos) — así no hay forma de colar un origen distinto.
  exclusiveFilter: (frame) => frame.tag === 'iframe' && !YOUTUBE_EMBED.test(frame.attribs.src || ''),
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        href: attribs.href || '#',
        // Cualquier link que meta el editor se abre en pestaña nueva y sin exponer
        // `window.opener` — evita "tabnabbing" sin que el usuario tenga que pensarlo.
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    }),
    iframe: (tagName, attribs) => ({
      tagName: 'iframe',
      attribs: { src: attribs.src, class: 'ql-video', frameborder: '0', allowfullscreen: 'true' },
    }),
  },
};

export function sanitizeArticleHtml(html) {
  return sanitizeHtml(String(html || ''), OPTIONS).trim();
}
