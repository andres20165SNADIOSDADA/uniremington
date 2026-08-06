// Subida de imágenes de portada (noticias/eventos). No se confía en la extensión ni en
// el Content-Type que manda el navegador: multer guarda el archivo en memoria y sharp
// intenta decodificarlo de verdad — si no es una imagen válida, se rechaza. La imagen
// se reprocesa siempre (redimensiona + reconvierte a webp), lo que de paso elimina
// cualquier metadato EXIF o payload escondido en el archivo original. El nombre final es
// aleatorio (nunca el nombre que trae el usuario) para evitar path traversal o choques.
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_ROOT = join(__dirname, '..', 'public', 'uploads');

const MAX_BYTES = 8 * 1024 * 1024; // 8MB de entrada; la salida siempre queda mucho más liviana
const MAX_WIDTH = 1600;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});
export const uploadCoverImage = upload.single('cover_image');
export const uploadInlineImage = upload.single('image');

// Lanza si el buffer no es una imagen real y decodificable (protege contra archivos
// renombrados con extensión de imagen que en realidad son otra cosa).
export async function processAndSaveImage(buffer) {
  let img = sharp(buffer, { failOn: 'error' });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('El archivo no es una imagen válida.');
  if (meta.width > MAX_WIDTH) img = img.resize({ width: MAX_WIDTH, withoutEnlargement: true });

  const out = await img.rotate().webp({ quality: 82 }).toBuffer(); // .rotate() sin args = auto-orienta según EXIF y LUEGO lo descarta

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dir = join(UPLOADS_ROOT, yyyy, mm);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filename = crypto.randomBytes(16).toString('hex') + '.webp';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, filename), out);

  return `/uploads/${yyyy}/${mm}/${filename}`;
}
