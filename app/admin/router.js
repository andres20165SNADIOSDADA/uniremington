import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, audit } from '../lib/db.js';
import {
  verifyPassword, hashPassword, passwordPolicyError,
  generateTotpEnrollment, verifyTotpToken,
  SESSION_COOKIE, createSession, getSession, touchSession, upgradeSessionAfter2fa,
  destroySession, destroyAllSessionsForUser, destroyOtherSessionsForUser, verifyCsrf,
  isLoginLocked, recordLoginAttempt, isTwofaLocked, recordTwofaAttempt, clearTwofaAttempts,
  getUserByUsername, getUserById,
} from '../lib/auth.js';
import { reloadPostsAndEvents } from '../lib/contentStore.js';
import { sanitizeArticleHtml } from '../lib/sanitizeHtml.js';
import { uploadCoverImage, uploadInlineImage, processAndSaveImage } from '../lib/uploads.js';

export const adminRouter = express.Router();

// Nunca se indexa el panel, sin importar la respuesta (login, 404 internos, lo que sea).
adminRouter.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

// ---------- Cookies ----------
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const isHttps = (req) => req.secure || req.get('x-forwarded-proto') === 'https';

function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, secure: isHttps(req), sameSite: 'strict', path: '/admin',
    maxAge: 12 * 60 * 60 * 1000,
  });
}
function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE, { path: '/admin' });
}

// CSRF previo al login (todavía no existe una sesión de la que colgar el token): patrón
// de doble envío — cookie de corta vida + campo oculto del formulario, deben coincidir.
const GUEST_CSRF_COOKIE = 'cms_guest_csrf';
function issueGuestCsrf(req, res) {
  const token = crypto.randomBytes(24).toString('base64url');
  res.cookie(GUEST_CSRF_COOKIE, token, {
    httpOnly: true, secure: isHttps(req), sameSite: 'strict', path: '/admin', maxAge: 10 * 60 * 1000,
  });
  return token;
}
function checkGuestCsrf(req, res, next) {
  const cookieVal = getCookie(req, GUEST_CSRF_COOKIE);
  const formVal = req.body && req.body._csrf;
  if (!cookieVal || !formVal || cookieVal !== formVal) {
    return res.status(403).type('text/plain').send('Solicitud inválida o expirada. Recarga la página e intenta de nuevo.');
  }
  next();
}
function checkSessionCsrf(req, res, next) {
  if (!verifyCsrf(req.cmsSession, req.body && req.body._csrf)) {
    return res.status(403).type('text/plain').send('Solicitud inválida o expirada. Recarga la página e intenta de nuevo.');
  }
  next();
}

// ---------- Carga de sesión ----------
adminRouter.use((req, res, next) => {
  const token = getCookie(req, SESSION_COOKIE);
  const session = token ? getSession(token) : null;
  if (session) touchSession(session.token);
  req.cmsSession = session;
  req.cmsUser = session ? getUserById(session.user_id) : null;
  if (req.cmsUser && req.cmsUser.disabled) { req.cmsSession = null; req.cmsUser = null; }
  next();
});

function requireGuest(req, res, next) {
  if (req.cmsSession && req.cmsUser && !req.cmsSession.pending_2fa) return res.redirect('/admin');
  next();
}
// Cualquier ruta del flujo de autenticación (2FA incluido) necesita al menos una sesión
// creada tras validar usuario+contraseña, aunque todavía esté "pendiente".
function requireAnySession(req, res, next) {
  if (!req.cmsSession || !req.cmsUser) return res.redirect('/admin/login');
  next();
}
// Rutas ya autenticadas del todo: sesión completa (2FA superado) y usuario habilitado.
function requireFullAuth(req, res, next) {
  if (!req.cmsSession || !req.cmsUser) return res.redirect('/admin/login');
  if (!req.cmsUser.totp_enabled) return res.redirect('/admin/2fa/setup');
  if (req.cmsSession.pending_2fa) return res.redirect('/admin/2fa/verify');
  next();
}
export function requireRole(role) {
  return (req, res, next) => {
    if (req.cmsUser.role !== role) {
      return res.status(403).type('text/plain').send('No tienes permiso para ver esa sección.');
    }
    next();
  };
}

function dashboardStats() {
  return {
    posts: db.prepare("SELECT COUNT(*) n FROM content_items WHERE kind='post' AND status='publish'").get().n,
    events: db.prepare("SELECT COUNT(*) n FROM content_items WHERE kind='event' AND status='publish'").get().n,
    drafts: db.prepare("SELECT COUNT(*) n FROM content_items WHERE status='draft'").get().n,
    users: db.prepare('SELECT COUNT(*) n FROM admin_users WHERE disabled = 0').get().n,
  };
}

const LOGIN_ERR = 'Usuario o contraseña incorrectos.';
const LOCK_ERR = 'Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.';
const TWOFA_ERR = { '1': 'Código incorrecto. Intenta de nuevo.', lock: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' };

// ---------- Login ----------
adminRouter.get('/login', requireGuest, (req, res) => {
  res.render('admin/login', { csrfToken: issueGuestCsrf(req, res) });
});

adminRouter.post('/login', requireGuest, checkGuestCsrf, (req, res) => {
  const ip = req.ip;
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (isLoginLocked(username, ip)) {
    return res.status(429).render('admin/login', { error: LOCK_ERR, username, csrfToken: issueGuestCsrf(req, res) });
  }
  const user = getUserByUsername(username);
  const ok = !!(user && !user.disabled && verifyPassword(password, user.password_hash));
  recordLoginAttempt(username, ip, ok);
  if (!ok) {
    audit({ username, action: 'login_failed', ip });
    return res.status(401).render('admin/login', { error: LOGIN_ERR, username, csrfToken: issueGuestCsrf(req, res) });
  }
  const token = createSession(user.id, { ip, userAgent: req.get('user-agent'), pending2fa: true });
  setSessionCookie(req, res, token);
  audit({ userId: user.id, username: user.username, action: 'login_password_ok', ip });
  res.redirect(user.totp_enabled ? '/admin/2fa/verify' : '/admin/2fa/setup');
});

adminRouter.post('/logout', requireAnySession, checkSessionCsrf, (req, res) => {
  destroySession(req.cmsSession.token);
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'logout', ip: req.ip });
  clearSessionCookie(req, res);
  res.redirect('/admin/login');
});

// ---------- 2FA: alta obligatoria (primer login) ----------
adminRouter.get('/2fa/setup', requireAnySession, async (req, res) => {
  const user = req.cmsUser;
  if (user.totp_enabled) return res.redirect(req.cmsSession.pending_2fa ? '/admin/2fa/verify' : '/admin');
  const enrollment = generateTotpEnrollment(user.username);
  db.prepare('UPDATE admin_users SET totp_secret = ? WHERE id = ?').run(enrollment.encrypted, user.id);
  const qrDataUrl = await QRCode.toDataURL(enrollment.uri);
  const errMap = { '1': 'Código incorrecto — este QR es nuevo, escanéalo de nuevo.', lock: LOCK_ERR };
  res.render('admin/setup-2fa', {
    qrDataUrl, manualKey: enrollment.secret,
    error: errMap[req.query.error] || null,
    csrfToken: req.cmsSession.csrf_token,
  });
});

adminRouter.post('/2fa/setup', requireAnySession, checkSessionCsrf, async (req, res) => {
  const user = req.cmsUser;
  if (user.totp_enabled) return res.redirect('/admin');
  if (isTwofaLocked(req.cmsSession.token)) return res.redirect('/admin/2fa/setup?error=lock');
  const ok = await verifyTotpToken(user.totp_secret, req.body.token);
  if (!ok) {
    recordTwofaAttempt(req.cmsSession.token);
    return res.redirect('/admin/2fa/setup?error=1');
  }
  clearTwofaAttempts(req.cmsSession.token);
  db.prepare('UPDATE admin_users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  upgradeSessionAfter2fa(req.cmsSession.token);
  audit({ userId: user.id, username: user.username, action: 'totp_enroll', ip: req.ip });
  res.redirect('/admin');
});

// ---------- 2FA: verificación en cada login ----------
adminRouter.get('/2fa/verify', requireAnySession, (req, res) => {
  const user = req.cmsUser;
  if (!user.totp_enabled) return res.redirect('/admin/2fa/setup');
  if (!req.cmsSession.pending_2fa) return res.redirect('/admin');
  res.render('admin/verify-2fa', { error: TWOFA_ERR[req.query.error] || null, csrfToken: req.cmsSession.csrf_token });
});

adminRouter.post('/2fa/verify', requireAnySession, checkSessionCsrf, async (req, res) => {
  const user = req.cmsUser;
  if (!user.totp_enabled) return res.redirect('/admin/2fa/setup');
  if (!req.cmsSession.pending_2fa) return res.redirect('/admin');
  if (isTwofaLocked(req.cmsSession.token)) return res.redirect('/admin/2fa/verify?error=lock');
  const ok = await verifyTotpToken(user.totp_secret, req.body.token);
  if (!ok) {
    recordTwofaAttempt(req.cmsSession.token);
    return res.redirect('/admin/2fa/verify?error=1');
  }
  clearTwofaAttempts(req.cmsSession.token);
  upgradeSessionAfter2fa(req.cmsSession.token);
  audit({ userId: user.id, username: user.username, action: 'login', ip: req.ip });
  res.redirect('/admin');
});

// ---------- Dashboard ----------
adminRouter.get('/', requireFullAuth, (req, res) => {
  res.render('admin/dashboard', { user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, stats: dashboardStats() });
});

// ---------- Noticias / Eventos (CRUD) ----------
const KINDS = {
  noticias: { kind: 'post', label: 'Noticia', labelPlural: 'Noticias' },
  eventos: { kind: 'event', label: 'Evento', labelPlural: 'Eventos' },
};
function kindMw(req, res, next) {
  const cfg = KINDS[req.params.section];
  if (!cfg) return next('route');
  req.contentKind = cfg;
  next();
}
// Si el archivo falla la validación de multer (tamaño, etc.), responde con un error
// legible en vez de dejar que Express lo trate como un 500 genérico.
function safeUpload(req, res, next) {
  uploadCoverImage(req, res, (err) => {
    if (err) return res.status(400).type('text/plain').send('No se pudo subir la imagen: ' + (err.message || 'archivo inválido o demasiado grande (máx. 8MB).'));
    next();
  });
}

// Subida de imágenes DENTRO del cuerpo del artículo (botón de imagen del editor Quill) —
// misma validación/reprocesado que la portada, solo que responde con JSON en vez de
// redirigir, porque la llama el editor por fetch() sin recargar la página.
adminRouter.post('/subir-imagen', requireFullAuth, (req, res) => {
  uploadInlineImage(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Archivo inválido o demasiado grande (máx. 8MB).' });
    if (!verifyCsrf(req.cmsSession, req.body && req.body._csrf)) return res.status(403).json({ error: 'Solicitud inválida o expirada. Recarga la página.' });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    try {
      const url = await processAndSaveImage(req.file.buffer);
      audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'upload_image', ip: req.ip });
      res.json({ url });
    } catch (e) {
      res.status(400).json({ error: e.message || 'El archivo no es una imagen válida.' });
    }
  });
});

function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sin-titulo';
}
function uniqueSlug(base, excludeId) {
  let slug = base, n = 2;
  const exists = (s) => !!(excludeId
    ? db.prepare('SELECT 1 FROM content_items WHERE slug = ? AND id != ?').get(s, excludeId)
    : db.prepare('SELECT 1 FROM content_items WHERE slug = ?').get(s));
  while (exists(slug)) slug = `${base}-${n++}`;
  return slug;
}
function stripTags(html) { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
// Antepone la imagen de portada como la PRIMERA figura del contenido: leadAndBody()/realImg()
// (server.js) buscan justo ahí la imagen destacada del artículo — así una noticia creada
// desde el panel se ve igual de bien que una migrada de WordPress, sin tocar esas funciones.
function stripCoverImage(html) {
  return String(html || '')
    .replace(/^\s*<figure[^>]*>\s*<img[^>]+>\s*<\/figure>\s*/i, '')
    .replace(/^\s*<img[^>]+>\s*/i, '');
}
function withCoverImage(contentHtml, imageUrl, altText) {
  const alt = String(altText || '').replace(/"/g, '&quot;');
  return `<figure><img src="${imageUrl}" alt="${alt}" loading="lazy"></figure>` + stripCoverImage(contentHtml);
}
function toDbDate(datetimeLocal) {
  const v = String(datetimeLocal || '').trim();
  if (!v) return new Date().toISOString().replace('T', ' ').slice(0, 19);
  const [d, t = ''] = v.split('T');
  const withSeconds = /^\d{2}:\d{2}:\d{2}$/.test(t) ? t : (t + ':00');
  return `${d} ${withSeconds}`;
}
function toFormDate(dbDate) { return String(dbDate || '').replace(' ', 'T').slice(0, 16); }

adminRouter.get('/:section(noticias|eventos)', requireFullAuth, kindMw, (req, res) => {
  const { kind, labelPlural } = req.contentKind;
  const q = String(req.query.q || '').trim();
  const status = ['publish', 'draft', 'trash'].includes(req.query.status) ? req.query.status : '';
  const page = Math.max(1, parseInt(req.query.p) || 1);
  const perPage = 20;
  let where = 'kind = ?'; const params = [kind];
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (q) { where += ' AND title LIKE ?'; params.push('%' + q + '%'); }
  const total = db.prepare(`SELECT COUNT(*) n FROM content_items WHERE ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM content_items WHERE ${where} ORDER BY date DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage);
  res.render('admin/content-list', {
    user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: req.params.section,
    section: req.params.section, labelPlural, items: rows, q, status,
    page, pages: Math.max(1, Math.ceil(total / perPage)), total,
  });
});

// Vista previa: renderiza el HTML tal como quedaría publicado, sin guardar nada en la
// base de datos — se usa desde el botón "Vista previa" del formulario. El formulario
// viaja como multipart/form-data (por el input de imagen), aunque aquí no se suba ningún
// archivo — `multer().none()` es quien parsea esos campos de texto a req.body.
const parseMultipartFields = multer().none();
adminRouter.post('/:section(noticias|eventos)/vista-previa', requireFullAuth, kindMw, parseMultipartFields, checkSessionCsrf, (req, res) => {
  const title = String(req.body.title || '(sin título)').trim();
  const dateRaw = toDbDate(req.body.date);
  const dateLabel = new Date(dateRaw.replace(' ', 'T')).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  let contentHtml = sanitizeArticleHtml(req.body.content_body || '');
  const coverPreviewSrc = String(req.body.cover_preview_src || '');
  if (coverPreviewSrc) contentHtml = withCoverImage(contentHtml, coverPreviewSrc, title);
  res.render('admin/preview', { title, dateLabel, contentHtml, label: req.contentKind.label });
});

adminRouter.get('/:section(noticias|eventos)/nueva', requireFullAuth, kindMw, (req, res) => {
  res.render('admin/content-form', {
    user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: req.params.section,
    section: req.params.section, label: req.contentKind.label, item: null, error: null,
  });
});

adminRouter.post('/:section(noticias|eventos)/nueva', requireFullAuth, kindMw, safeUpload, checkSessionCsrf, async (req, res) => {
  const { kind, label } = req.contentKind;
  const title = String(req.body.title || '').trim();
  if (!title) {
    return res.status(400).render('admin/content-form', {
      user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: req.params.section,
      section: req.params.section, label, item: null, error: 'El título es obligatorio.',
    });
  }
  const slug = uniqueSlug(slugify(title));
  const categories = String(req.body.categories || '').split(',').map((s) => s.trim()).filter(Boolean);
  const status = ['draft', 'publish'].includes(req.body.status) ? req.body.status : 'draft';
  const date = toDbDate(req.body.date);
  let contentHtml = sanitizeArticleHtml(req.body.content_body || '');
  let coverImage = null;
  if (req.file) {
    coverImage = await processAndSaveImage(req.file.buffer);
    contentHtml = withCoverImage(contentHtml, coverImage, title);
  }
  const excerpt = String(req.body.excerpt || '').trim() || stripTags(contentHtml).slice(0, 160);

  db.prepare(`INSERT INTO content_items
      (kind, slug, title, date, status, categories, content_html, excerpt, cover_image, legacy_source, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(kind, slug, title, date, status, JSON.stringify(categories), contentHtml, excerpt, coverImage, req.cmsUser.id, req.cmsUser.id);

  reloadPostsAndEvents();
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'create', entityKind: kind, entityId: slug, detail: title, ip: req.ip });
  res.redirect(`/admin/${req.params.section}`);
});

// El editor solo muestra/edita el cuerpo del artículo — la imagen de portada (si hay)
// vive como la primera figura de content_html (ver withCoverImage/stripCoverImage más
// arriba) y se administra aparte, con su propio campo de archivo.
adminRouter.get('/:section(noticias|eventos)/:id/editar', requireFullAuth, kindMw, (req, res) => {
  const row = db.prepare('SELECT * FROM content_items WHERE id = ? AND kind = ?').get(req.params.id, req.contentKind.kind);
  if (!row) return res.status(404).type('text/plain').send('No encontrado.');
  res.render('admin/content-form', {
    user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: req.params.section,
    section: req.params.section, label: req.contentKind.label,
    item: {
      ...row,
      categories: JSON.parse(row.categories || '[]'),
      dateForm: toFormDate(row.date),
      bodyForEditor: stripCoverImage(row.content_html),
      // El contenido migrado de WordPress trae el extracto con etiquetas HTML crudas
      // (<p>…</p>); aquí solo se muestra como texto plano — al guardar, se regenera o
      // se reemplaza por lo que el usuario escriba, así que no hace falta tocar la fila.
      excerpt: stripTags(row.excerpt),
    },
    error: null,
  });
});

adminRouter.post('/:section(noticias|eventos)/:id/editar', requireFullAuth, kindMw, safeUpload, checkSessionCsrf, async (req, res) => {
  const row = db.prepare('SELECT * FROM content_items WHERE id = ? AND kind = ?').get(req.params.id, req.contentKind.kind);
  if (!row) return res.status(404).type('text/plain').send('No encontrado.');
  const title = String(req.body.title || '').trim() || row.title;
  const categories = String(req.body.categories || '').split(',').map((s) => s.trim()).filter(Boolean);
  const status = ['draft', 'publish', 'trash'].includes(req.body.status) ? req.body.status : row.status;
  const date = toDbDate(req.body.date) || row.date;
  let contentHtml = sanitizeArticleHtml(req.body.content_body ?? row.content_html);
  let coverImage = row.cover_image;
  if (req.file) {
    coverImage = await processAndSaveImage(req.file.buffer);
    contentHtml = withCoverImage(contentHtml, coverImage, title);
  }
  const excerpt = String(req.body.excerpt || '').trim() || stripTags(contentHtml).slice(0, 160);

  // El slug nunca se toca desde el formulario de edición (protege el SEO de la URL ya
  // publicada/indexada) — solo cambia, si hace falta, cuando se crea el ítem.
  db.prepare(`UPDATE content_items SET title=?, date=?, status=?, categories=?, content_html=?, excerpt=?, cover_image=?, updated_by=?, updated_at=datetime('now') WHERE id=?`)
    .run(title, date, status, JSON.stringify(categories), contentHtml, excerpt, coverImage, req.cmsUser.id, row.id);

  reloadPostsAndEvents();
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'update', entityKind: req.contentKind.kind, entityId: row.slug, detail: title, ip: req.ip });
  res.redirect(`/admin/${req.params.section}`);
});

function statusAction(newStatus, actionName) {
  return (req, res) => {
    const row = db.prepare('SELECT * FROM content_items WHERE id = ? AND kind = ?').get(req.params.id, req.contentKind.kind);
    if (!row) return res.status(404).type('text/plain').send('No encontrado.');
    db.prepare(`UPDATE content_items SET status=?, updated_by=?, updated_at=datetime('now') WHERE id=?`).run(newStatus, req.cmsUser.id, row.id);
    reloadPostsAndEvents();
    audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: actionName, entityKind: req.contentKind.kind, entityId: row.slug, detail: row.title, ip: req.ip });
    res.redirect(`/admin/${req.params.section}`);
  };
}
adminRouter.post('/:section(noticias|eventos)/:id/publicar', requireFullAuth, kindMw, checkSessionCsrf, statusAction('publish', 'publish'));
adminRouter.post('/:section(noticias|eventos)/:id/despublicar', requireFullAuth, kindMw, checkSessionCsrf, statusAction('draft', 'unpublish'));
adminRouter.post('/:section(noticias|eventos)/:id/papelera', requireFullAuth, kindMw, checkSessionCsrf, statusAction('trash', 'trash'));
adminRouter.post('/:section(noticias|eventos)/:id/restaurar', requireFullAuth, kindMw, checkSessionCsrf, statusAction('draft', 'restore'));

adminRouter.post('/:section(noticias|eventos)/:id/eliminar', requireFullAuth, kindMw, checkSessionCsrf, (req, res) => {
  const row = db.prepare('SELECT * FROM content_items WHERE id = ? AND kind = ?').get(req.params.id, req.contentKind.kind);
  if (!row) return res.status(404).type('text/plain').send('No encontrado.');
  if (row.status !== 'trash') return res.status(400).type('text/plain').send('Solo se puede eliminar definitivamente desde la papelera.');
  db.prepare('DELETE FROM content_items WHERE id = ?').run(row.id);
  reloadPostsAndEvents();
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'delete', entityKind: req.contentKind.kind, entityId: row.slug, detail: row.title, ip: req.ip });
  res.redirect(`/admin/${req.params.section}?status=trash`);
});

// ---------- Usuarios (solo rol admin) ----------
function countOtherActiveAdmins(excludeId) {
  return db.prepare("SELECT COUNT(*) n FROM admin_users WHERE role='admin' AND disabled=0 AND id != ?").get(excludeId).n;
}

adminRouter.get('/usuarios', requireFullAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT * FROM admin_users ORDER BY created_at').all();
  res.render('admin/users', { user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'usuarios', users });
});

adminRouter.get('/usuarios/nuevo', requireFullAuth, requireRole('admin'), (req, res) => {
  res.render('admin/user-form', { user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'usuarios', target: null, error: null });
});

adminRouter.post('/usuarios/nuevo', requireFullAuth, requireRole('admin'), checkSessionCsrf, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim() || username;
  const role = req.body.role === 'admin' ? 'admin' : 'editor';
  const password = String(req.body.password || '');
  const fail = (error) => res.status(400).render('admin/user-form', {
    user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'usuarios', target: null, error,
  });

  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return fail('Usuario inválido (3-40 caracteres: letras, números, punto, guion o guion bajo).');
  if (getUserByUsername(username)) return fail('Ese usuario ya existe.');
  const pwErr = passwordPolicyError(password, username);
  if (pwErr) return fail(pwErr);

  db.prepare('INSERT INTO admin_users (username, name, password_hash, role, totp_enabled) VALUES (?, ?, ?, ?, 0)')
    .run(username, name, hashPassword(password), role);
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'user_create', entityKind: 'user', entityId: username, detail: `rol ${role}`, ip: req.ip });
  res.redirect('/admin/usuarios');
});

adminRouter.get('/usuarios/:id/editar', requireFullAuth, requireRole('admin'), (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).type('text/plain').send('No encontrado.');
  res.render('admin/user-form', { user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'usuarios', target, error: null });
});

adminRouter.post('/usuarios/:id/editar', requireFullAuth, requireRole('admin'), checkSessionCsrf, (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).type('text/plain').send('No encontrado.');
  const name = String(req.body.name || '').trim() || target.name;
  const role = req.body.role === 'admin' ? 'admin' : 'editor';
  const newPassword = String(req.body.password || '');
  const fail = (error) => res.status(400).render('admin/user-form', {
    user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'usuarios', target, error,
  });

  if (target.id === req.cmsUser.id && role !== 'admin') return fail('No puedes quitarte a ti mismo el rol de administrador.');
  if (target.role === 'admin' && role !== 'admin' && countOtherActiveAdmins(target.id) === 0) {
    return fail('Debe quedar al menos un administrador activo.');
  }
  if (newPassword) {
    const pwErr = passwordPolicyError(newPassword, target.username);
    if (pwErr) return fail(pwErr);
  }

  if (newPassword) {
    db.prepare('UPDATE admin_users SET name=?, role=?, password_hash=? WHERE id=?').run(name, role, hashPassword(newPassword), target.id);
    destroyAllSessionsForUser(target.id);
    audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'user_password_reset', entityKind: 'user', entityId: target.username, ip: req.ip });
  } else {
    db.prepare('UPDATE admin_users SET name=?, role=? WHERE id=?').run(name, role, target.id);
  }
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'user_update', entityKind: 'user', entityId: target.username, detail: `rol ${role}`, ip: req.ip });
  res.redirect('/admin/usuarios');
});

adminRouter.post('/usuarios/:id/deshabilitar', requireFullAuth, requireRole('admin'), checkSessionCsrf, (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).type('text/plain').send('No encontrado.');
  if (target.id === req.cmsUser.id) return res.status(400).type('text/plain').send('No puedes deshabilitar tu propia cuenta.');
  if (target.role === 'admin' && countOtherActiveAdmins(target.id) === 0) {
    return res.status(400).type('text/plain').send('Debe quedar al menos un administrador activo.');
  }
  db.prepare('UPDATE admin_users SET disabled = 1 WHERE id = ?').run(target.id);
  destroyAllSessionsForUser(target.id);
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'user_disable', entityKind: 'user', entityId: target.username, ip: req.ip });
  res.redirect('/admin/usuarios');
});

adminRouter.post('/usuarios/:id/habilitar', requireFullAuth, requireRole('admin'), checkSessionCsrf, (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).type('text/plain').send('No encontrado.');
  db.prepare('UPDATE admin_users SET disabled = 0 WHERE id = ?').run(target.id);
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'user_enable', entityKind: 'user', entityId: target.username, ip: req.ip });
  res.redirect('/admin/usuarios');
});

adminRouter.post('/usuarios/:id/resetear-2fa', requireFullAuth, requireRole('admin'), checkSessionCsrf, (req, res) => {
  const target = getUserById(req.params.id);
  if (!target) return res.status(404).type('text/plain').send('No encontrado.');
  db.prepare('UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(target.id);
  destroyAllSessionsForUser(target.id);
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'user_reset_2fa', entityKind: 'user', entityId: target.username, ip: req.ip });
  res.redirect('/admin/usuarios');
});

// ---------- Mi perfil (cualquier usuario autenticado) ----------
adminRouter.get('/perfil', requireFullAuth, (req, res) => {
  res.render('admin/profile', { user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'perfil', error: null, ok: null });
});

adminRouter.post('/perfil/password', requireFullAuth, checkSessionCsrf, (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const confirm = String(req.body.confirm_password || '');
  const fail = (error) => res.status(400).render('admin/profile', {
    user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'perfil', error, ok: null,
  });

  if (!verifyPassword(current, req.cmsUser.password_hash)) return fail('La contraseña actual no es correcta.');
  const pwErr = passwordPolicyError(next, req.cmsUser.username);
  if (pwErr) return fail(pwErr);
  if (next !== confirm) return fail('Las contraseñas nuevas no coinciden.');

  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.cmsUser.id);
  destroyOtherSessionsForUser(req.cmsUser.id, req.cmsSession.token);
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'password_change', ip: req.ip });
  res.render('admin/profile', {
    user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'perfil', error: null,
    ok: 'Contraseña actualizada. Se cerraron tus demás sesiones activas (otros navegadores/dispositivos).',
  });
});

adminRouter.post('/perfil/resetear-2fa', requireFullAuth, checkSessionCsrf, (req, res) => {
  const current = String(req.body.current_password || '');
  if (!verifyPassword(current, req.cmsUser.password_hash)) {
    return res.status(400).render('admin/profile', {
      user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'perfil', error: 'La contraseña actual no es correcta.', ok: null,
    });
  }
  db.prepare('UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.cmsUser.id);
  audit({ userId: req.cmsUser.id, username: req.cmsUser.username, action: 'self_reset_2fa', ip: req.ip });
  res.redirect('/admin/2fa/setup');
});

// ---------- Auditoría (solo rol admin) ----------
const ACTION_LABELS = {
  login: 'Inicio de sesión', login_failed: 'Intento de acceso fallido', login_password_ok: 'Contraseña correcta (pendiente 2FA)',
  logout: 'Cierre de sesión', totp_enroll: 'Activó verificación en dos pasos', self_reset_2fa: 'Reseteó su propio 2FA',
  create: 'Creó contenido', update: 'Editó contenido', publish: 'Publicó', unpublish: 'Despublicó',
  trash: 'Envió a papelera', restore: 'Restauró de la papelera', delete: 'Eliminó definitivamente',
  user_create: 'Creó un usuario', user_update: 'Editó un usuario', user_password_reset: 'Restableció una contraseña',
  user_disable: 'Deshabilitó un usuario', user_enable: 'Habilitó un usuario', user_reset_2fa: 'Reseteó el 2FA de un usuario',
  password_change: 'Cambió su contraseña',
};
adminRouter.get('/auditoria', requireFullAuth, requireRole('admin'), (req, res) => {
  const page = Math.max(1, parseInt(req.query.p) || 1);
  const perPage = 40;
  const total = db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(perPage, (page - 1) * perPage)
    .map((r) => ({ ...r, actionLabel: ACTION_LABELS[r.action] || r.action }));
  res.render('admin/auditoria', {
    user: req.cmsUser, csrfToken: req.cmsSession.csrf_token, active: 'auditoria',
    rows, page, pages: Math.max(1, Math.ceil(total / perPage)), total,
  });
});

export { requireFullAuth, checkSessionCsrf };
