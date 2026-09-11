// CLI to encrypt / decrypt the local .env so real API keys never sit in the
// repo as plaintext. The ciphertext (.env.enc) is safe to commit; the master
// key comes from SATQUERY_MASTER_KEY, --key=..., or an interactive prompt and
// is NEVER written to disk.
//
//   node scripts/secrets.mjs encrypt         # .env      -> .env.enc
//   node scripts/secrets.mjs decrypt          # .env.enc  -> stdout
//   node scripts/secrets.mjs decrypt --out    # .env.enc  -> .env   (add --force to overwrite)
//   node scripts/secrets.mjs check            # verify .env.enc decrypts

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { encryptEnv, decryptEnv } from '../server/envcrypto.ts';

const ENV = new URL('../.env', import.meta.url);
const ENC = new URL('../.env.enc', import.meta.url);
const rel = u => fileURLToPath(u).replace(fileURLToPath(new URL('../', import.meta.url)), '');

function fail(msg) { console.error(`secrets: ${msg}`); process.exit(1); }

async function readKey() {
  const fromArg = process.argv.find(a => a.startsWith('--key='))?.slice(6);
  const key = fromArg || process.env.SATQUERY_MASTER_KEY;
  if (key) return key;
  if (!process.stdin.isTTY) fail('set SATQUERY_MASTER_KEY (or pass --key=...) when running non-interactively.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Master key: ')).trim();
  rl.close();
  if (!answer) fail('empty master key.');
  return answer;
}

const cmd = process.argv[2];

if (cmd === 'encrypt') {
  if (!existsSync(ENV)) fail('no .env to encrypt. Create it from .env.example first.');
  writeFileSync(ENC, encryptEnv(readFileSync(ENV, 'utf8'), await readKey()));
  console.log(`secrets: wrote ${rel(ENC)} (AES-256-GCM). Commit ${rel(ENC)}; keep .env out of git.`);
} else if (cmd === 'decrypt' || cmd === 'check') {
  if (!existsSync(ENC)) fail(`no ${rel(ENC)} found.`);
  const plain = decryptEnv(readFileSync(ENC, 'utf8'), await readKey());
  if (cmd === 'check') {
    console.log(`secrets: ${rel(ENC)} decrypts cleanly (${plain.split('\n').filter(l => /^\s*[A-Z]/.test(l)).length} keys).`);
  } else if (process.argv.includes('--out')) {
    if (existsSync(ENV) && !process.argv.includes('--force')) fail('.env already exists. Re-run with --force to overwrite.');
    writeFileSync(ENV, plain);
    console.log('secrets: wrote .env from .env.enc.');
  } else {
    process.stdout.write(plain);
  }
} else {
  console.log(`Usage:
  node scripts/secrets.mjs encrypt           .env      -> .env.enc   (commit .env.enc, never .env)
  node scripts/secrets.mjs decrypt            .env.enc  -> stdout
  node scripts/secrets.mjs decrypt --out      .env.enc  -> .env       (add --force to overwrite)
  node scripts/secrets.mjs check              verify .env.enc decrypts

Master key: SATQUERY_MASTER_KEY env var, --key=..., or an interactive prompt.
Runtime: the server auto-loads .env.enc when SATQUERY_MASTER_KEY is set (a plaintext .env still wins for local dev).`);
  process.exit(cmd ? 1 : 0);
}
