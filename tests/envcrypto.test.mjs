import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptEnv, decryptEnv } from '../server/envcrypto.ts';

const SAMPLE = 'SENTINEL_CLIENT_ID=sh-abc\nOPENROUTER_API_KEY=sk-or-v1-secret\n';

test('encrypt -> decrypt round-trips the .env contents', () => {
  const enc = encryptEnv(SAMPLE, 'correct horse battery staple');
  assert.equal(decryptEnv(enc, 'correct horse battery staple'), SAMPLE);
});

test('the ciphertext contains no plaintext secret and is fresh each call', () => {
  const a = encryptEnv(SAMPLE, 'k');
  const b = encryptEnv(SAMPLE, 'k');
  assert.doesNotMatch(a, /sk-or-v1-secret|sh-abc/);
  assert.notEqual(a, b, 'random salt + IV per call');
});

test('a wrong master key fails loudly instead of returning garbage', () => {
  const enc = encryptEnv(SAMPLE, 'right-key');
  assert.throws(() => decryptEnv(enc, 'wrong-key'), /Decryption failed/);
});

test('tampered ciphertext is rejected by the GCM auth tag', () => {
  const obj = JSON.parse(encryptEnv(SAMPLE, 'k'));
  const raw = Buffer.from(obj.data, 'base64');
  raw[0] ^= 0xff;
  obj.data = raw.toString('base64');
  assert.throws(() => decryptEnv(JSON.stringify(obj), 'k'), /Decryption failed/);
});

test('malformed or empty inputs are rejected', () => {
  assert.throws(() => decryptEnv('not json', 'k'), /not valid JSON/);
  assert.throws(() => decryptEnv(JSON.stringify({ v: 2 }), 'k'), /unsupported version|missing fields/);
  assert.throws(() => encryptEnv(SAMPLE, ''), /master key/);
});
