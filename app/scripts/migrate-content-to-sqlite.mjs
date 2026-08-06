// Migración única de las noticias/eventos ya publicados (heredados de WordPress) hacia
// SQLite (content_items), para que el panel de administración pueda editarlos. Los JSON
// originales (post.json/tribe_events.json) NO se tocan ni se borran — quedan como
// respaldo/referencia; desde que se corre esto, el servidor deja de leerlos para
// noticias/eventos y usa la base de datos. Uso: npm run admin:migrate
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from '../lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const load = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf-8'));

function migrate(kind, file) {
  const items = load(file).filter((p) => p.status === 'publish');
  const insert = db.prepare(`
    INSERT INTO content_items
      (kind, slug, title, date, status, categories, content_html, excerpt, legacy_source, legacy_id, orig_path)
    VALUES (?, ?, ?, ?, 'publish', ?, ?, ?, 1, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `);
  let inserted = 0, skipped = 0;
  for (const item of items) {
    const res = insert.run(
      kind, item.slug, item.title || '(sin título)', item.date || '',
      JSON.stringify(item.categories || []), item.content_html || '', item.excerpt || '',
      String(item.id || ''), item.orig_path || null,
    );
    if (res.changes > 0) inserted++; else skipped++;
  }
  return { total: items.length, inserted, skipped };
}

console.log('--- Migrando contenido heredado a content_items (SQLite) ---\n');
const postsRes = migrate('post', 'post.json');
console.log(`Noticias:  ${postsRes.total} publicadas en el JSON -> ${postsRes.inserted} insertadas, ${postsRes.skipped} ya existían (se dejaron igual).`);
const eventsRes = migrate('event', 'tribe_events.json');
console.log(`Eventos:   ${eventsRes.total} publicados en el JSON -> ${eventsRes.inserted} insertados, ${eventsRes.skipped} ya existían (se dejaron igual).`);

const totals = db.prepare("SELECT kind, COUNT(*) n FROM content_items WHERE status='publish' GROUP BY kind").all();
console.log('\nEstado actual de content_items (publicados):', totals);
console.log('\nListo. Reinicia el servidor (o espera al próximo arranque) para que sirva desde la base de datos.');
