import crypto from 'node:crypto';
import { generate as totpGenerate, verify as totpVerify, generateSecret as totpGenerateSecret, generateURI as totpGenerateURI } from 'otplib';
import { db } from './db.js';

// ---------- Contraseñas (scrypt nativo de Node, sin dependencia externa) ----------
// Formato almacenado: "scrypt:N:r:p:saltHex:hashHex" — versionado por si algún día
// cambian los parámetros de costo, sin invalidar los hashes ya guardados.
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = (stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function passwordPolicyError(password, username) {
  if (!password || password.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
  if (username && password.toLowerCase().includes(String(username).toLowerCase())) return 'La contraseña no puede contener el nombre de usuario.';
  if (!/[a-z]/i.test(password) || !/[0-9]/.test(password)) return 'La contraseña debe combinar letras y números.';
  return null;
}

// ---------- Cifrado en reposo del secreto TOTP (AES-256-GCM) ----------
function secretKey() {
  const hex = process.env.CMS_SECRET_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('CMS_SECRET_KEY no está configurada (debe ser un hex de 32 bytes). Revisa .env.example.');
  }
  return Buffer.from(hex, 'hex');
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

function decryptSecret(stored) {
  const [ivHex, tagHex, dataHex] = (stored || '').split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Secreto TOTP corrupto o ilegible.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// ---------- TOTP (2FA) ----------
const TOTP_ISSUER = 'Uniremington CMS';

export function generateTotpEnrollment(username) {
  const secret = totpGenerateSecret();
  const uri = totpGenerateURI({ secret, label: username, issuer: TOTP_ISSUER });
  return { secret, uri, encrypted: encryptSecret(secret) };
}

export async function verifyTotpToken(encryptedSecret, token) {
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  const secret = decryptSecret(encryptedSecret);
  const res = await totpVerify({ secret, token: String(token), epochTolerance: 30 });
  return !!(res && res.valid);
}

// ---------- Sesiones ----------
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;   // 8h de inactividad
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000; // 12h máximo desde el login
const PENDING_2FA_MS = 5 * 60 * 1000;          // 5 min para completar el 2FA

export const SESSION_COOKIE = 'cms_session';

function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function isoIn(ms) { return new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19); }

export function createSession(userId, { ip, userAgent, pending2fa }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = isoIn(pending2fa ? PENDING_2FA_MS : SESSION_IDLE_MS);
  db.prepare(`INSERT INTO admin_sessions (token, user_id, csrf_token, pending_2fa, expires_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(token, userId, csrfToken, pending2fa ? 1 : 0, expiresAt, ip || null, userAgent || null);
  return token;
}

export function upgradeSessionAfter2fa(token) {
  db.prepare(`UPDATE admin_sessions SET pending_2fa = 0, expires_at = ?, last_seen_at = ? WHERE token = ?`)
    .run(isoIn(SESSION_IDLE_MS), nowIso(), token);
}

export function getSession(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM admin_sessions WHERE token = ?`).get(token);
  if (!row) return null;
  if (new Date(row.expires_at + 'Z').getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return row;
}

// Renueva la expiración deslizante (idle) sin superar el tope absoluto desde created_at.
export function touchSession(token) {
  const row = db.prepare(`SELECT created_at FROM admin_sessions WHERE token = ?`).get(token);
  if (!row) return;
  const absoluteLimit = new Date(row.created_at + 'Z').getTime() + SESSION_ABSOLUTE_MS;
  const idleLimit = Date.now() + SESSION_IDLE_MS;
  const newExpiry = new Date(Math.min(absoluteLimit, idleLimit)).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?`)
    .run(nowIso(), newExpiry, token);
}

export function destroySession(token) {
  db.prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
}

export function destroyAllSessionsForUser(userId) {
  db.prepare(`DELETE FROM admin_sessions WHERE user_id = ?`).run(userId);
}

// Cierra las demás sesiones del usuario (otros dispositivos/navegadores) manteniendo
// viva la sesión actual — se usa al cambiar la contraseña o resetear el 2FA propio.
export function destroyOtherSessionsForUser(userId, exceptToken) {
  db.prepare(`DELETE FROM admin_sessions WHERE user_id = ? AND token != ?`).run(userId, exceptToken);
}

export function cleanupExpiredSessions() {
  db.prepare(`DELETE FROM admin_sessions WHERE expires_at < datetime('now')`).run();
}

// ---------- CSRF ----------
export function verifyCsrf(session, tokenFromForm) {
  if (!session || !tokenFromForm) return false;
  const a = Buffer.from(String(session.csrf_token));
  const b = Buffer.from(String(tokenFromForm));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Fuerza bruta: login y verificación 2FA ----------
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_USER = 8;
const LOGIN_MAX_PER_IP = 20;

export function recordLoginAttempt(username, ip, success) {
  db.prepare(`INSERT INTO login_attempts (username, ip, success) VALUES (?, ?, ?)`).run(username, ip, success ? 1 : 0);
}

export function isLoginLocked(username, ip) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString().replace('T', ' ').slice(0, 19);
  const byUser = db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND success = 0 AND created_at > ?`)
    .get(username, since).n;
  const byIp = db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > ?`)
    .get(ip, since).n;
  return byUser >= LOGIN_MAX_PER_USER || byIp >= LOGIN_MAX_PER_IP;
}

// Intentos de 2FA: en memoria por sesión pendiente (ventanas cortas, no necesita persistir).
const twofaAttempts = new Map();
const TWOFA_MAX = 6;
const TWOFA_WINDOW_MS = 10 * 60 * 1000;

export function isTwofaLocked(sessionToken) {
  const hits = (twofaAttempts.get(sessionToken) || []).filter((t) => Date.now() - t < TWOFA_WINDOW_MS);
  twofaAttempts.set(sessionToken, hits);
  return hits.length >= TWOFA_MAX;
}

export function recordTwofaAttempt(sessionToken) {
  const hits = twofaAttempts.get(sessionToken) || [];
  hits.push(Date.now());
  twofaAttempts.set(sessionToken, hits);
}

export function clearTwofaAttempts(sessionToken) {
  twofaAttempts.delete(sessionToken);
}

// ---------- Usuarios ----------
export function getUserByUsername(username) {
  return db.prepare(`SELECT * FROM admin_users WHERE username = ?`).get(username);
}

export function getUserById(id) {
  return db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(id);
}
