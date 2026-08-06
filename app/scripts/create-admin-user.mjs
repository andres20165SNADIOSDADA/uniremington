// Crea el primer usuario del panel de administración (/admin) por línea de comandos.
// Necesario solo una vez: los siguientes usuarios se crean ya desde el panel (Usuarios,
// rol admin). Uso: npm run admin:create-user
import readline from 'node:readline';
import { db } from '../lib/db.js';
import { hashPassword, passwordPolicyError, getUserByUsername } from '../lib/auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// Entrada enmascarada (asteriscos) para la contraseña; si stdin no es una terminal
// interactiva (ej. una tubería en pruebas automatizadas), cae a una pregunta normal.
function askHidden(query) {
  if (!process.stdin.isTTY) return ask(query);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const BACKSPACE = String.fromCharCode(127);
    const CTRL_C = String.fromCharCode(3);
    const onData = (char) => {
      if (char === '\n' || char === '\r') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === CTRL_C) {
        process.stdout.write('\n');
        process.exit(1);
      } else if (char === BACKSPACE) {
        if (input.length) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        input += char;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  console.log('--- Crear usuario del panel de administración Uniremington ---\n');

  let username = '';
  while (true) {
    username = (await ask('Usuario (solo letras/números/guiones, sin espacios): ')).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      console.log('  Usuario inválido. Usa 3-40 caracteres: letras, números, punto, guion o guion bajo.\n');
      continue;
    }
    if (getUserByUsername(username)) {
      console.log('  Ese usuario ya existe.\n');
      continue;
    }
    break;
  }

  const name = (await ask('Nombre completo: ')).trim() || username;

  let role = (await ask('Rol (admin/editor) [admin]: ')).trim().toLowerCase() || 'admin';
  if (role !== 'admin' && role !== 'editor') role = 'admin';

  let password = '';
  while (true) {
    password = await askHidden('Contraseña (12+ caracteres, letras y números): ');
    console.log('');
    const err = passwordPolicyError(password, username);
    if (err) { console.log('  ' + err + '\n'); continue; }
    const confirm = await askHidden('Confirma la contraseña: ');
    console.log('');
    if (confirm !== password) { console.log('  No coincide, intenta de nuevo.\n'); continue; }
    break;
  }

  const passwordHash = hashPassword(password);
  db.prepare(`INSERT INTO admin_users (username, name, password_hash, role, totp_enabled) VALUES (?, ?, ?, ?, 0)`)
    .run(username, name, passwordHash, role);

  console.log(`\nUsuario "${username}" (${role}) creado correctamente.`);
  console.log('Al iniciar sesión por primera vez se pedirá activar la verificación en dos pasos (2FA) — es obligatoria.');
  rl.close();
  process.exit(0);
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
