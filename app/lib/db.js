import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'cms.sqlite');

// En un entorno sin disco persistente (ej. Vercel, filesystem de solo lectura) abrir o
// crear el archivo falla. Eso NUNCA debe tumbar el sitio público entero — server.js
// importa este módulo de forma incondicional — así que el error se contiene aquí: se
// exporta un `db` que solo falla en el momento en que alguien intenta USARLO (es decir,
// dentro de una ruta de /admin), no al arrancar. contentStore.js ya sabe recurrir al
// JSON estático de respaldo si `reloadPostsAndEvents()` no puede leer de esta base.
let db;
try {
  if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
} catch (e) {
  console.error('[cms] No se pudo abrir la base de datos del panel (¿filesystem de solo lectura?):', e.message);
  const unavailable = () => { throw new Error('El panel de administración no está disponible en este entorno (falta disco persistente).'); };
  db = { prepare: unavailable, exec() {} };
}
export { db };

// Esquema del panel de administración. `IF NOT EXISTS` hace que sea seguro correr esto
// en cada arranque del servidor sin necesidad de un sistema de migraciones aparte.
db.exec(`
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'editor',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,
  pending_2fa   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ip            TEXT,
  user_agent    TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  ip          TEXT NOT NULL,
  success     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('post','event')),
  slug          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  date          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','publish','trash')),
  categories    TEXT NOT NULL DEFAULT '[]',
  content_html  TEXT NOT NULL DEFAULT '',
  excerpt       TEXT NOT NULL DEFAULT '',
  cover_image   TEXT,
  legacy_source INTEGER NOT NULL DEFAULT 0,
  legacy_id     TEXT,
  orig_path     TEXT,
  created_by    INTEGER REFERENCES admin_users(id),
  updated_by    INTEGER REFERENCES admin_users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES admin_users(id),
  username     TEXT,
  action       TEXT NOT NULL,
  entity_kind  TEXT,
  entity_id    TEXT,
  detail       TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON admin_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_content_kind_status ON content_items(kind, status);
CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(username, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

export function audit({ userId = null, username = null, action, entityKind = null, entityId = null, detail = null, ip = null }) {
  db.prepare(`INSERT INTO audit_log (user_id, username, action, entity_kind, entity_id, detail, ip)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, username, action, entityKind, entityId, detail, ip);
}
