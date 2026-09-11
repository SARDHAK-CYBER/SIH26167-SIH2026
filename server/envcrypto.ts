// AES-256-GCM encryption for the .env file, so real API keys are never stored
// in the repository as plaintext. The ciphertext (.env.enc) is safe to commit;
// the master key is supplied at runtime (SATQUERY_MASTER_KEY) and never written
// anywhere. Pure functions only — no filesystem, no process side effects.
//
// Serialized form (JSON): { v, kdf, params, salt, iv, tag, data } — all base64.

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const MAXMEM = 128 * 1024 * 1024;

function deriveKey(passphrase: string, salt: Buffer, params = SCRYPT_PARAMS): Buffer {
  return scryptSync(Buffer.from(passphrase, 'utf8'), salt, 32, { ...params, maxmem: MAXMEM });
}

export function encryptEnv(plaintext: string, passphrase: string): string {
  if (!passphrase) throw new Error('A non-empty master key is required.');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return JSON.stringify({
    v: 1, kdf: 'scrypt', params: SCRYPT_PARAMS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }, null, 2) + '\n';
}

export function decryptEnv(encJson: string, passphrase: string): string {
  if (!passphrase) throw new Error('A non-empty master key is required.');
  let obj: { v?: number; params?: typeof SCRYPT_PARAMS; salt?: string; iv?: string; tag?: string; data?: string };
  try { obj = JSON.parse(encJson); } catch { throw new Error('.env.enc is not valid JSON.'); }
  if (obj.v !== 1 || !obj.salt || !obj.iv || !obj.tag || !obj.data) throw new Error('.env.enc is missing fields or has an unsupported version.');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(obj.salt, 'base64'), obj.params), Buffer.from(obj.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(obj.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(obj.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Decryption failed — wrong master key or corrupted .env.enc.');
  }
}
