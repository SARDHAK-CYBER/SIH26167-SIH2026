import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decryptEnv } from './envcrypto.ts';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// Committed, encrypted secrets. Loaded only when SATQUERY_MASTER_KEY is set.
// scrypt is deliberately slow, so the decrypted result is memoised per
// (key, file-mtime); getConfig() runs on every request.
let encCache: { sig: string; values: Record<string, string> } | null = null;
function encryptedEnvValues(): Record<string, string> {
  const key = process.env.SATQUERY_MASTER_KEY;
  const encPath = new URL('../.env.enc', import.meta.url);
  if (!key || !existsSync(encPath)) return {};
  const sig = createHash('sha256').update(key).update(String(statSync(encPath).mtimeMs)).digest('base64');
  if (encCache?.sig === sig) return encCache.values;
  try {
    const values = parseEnv(decryptEnv(readFileSync(encPath, 'utf8'), key)) as Record<string, string>;
    encCache = { sig, values };
    return values;
  } catch (e) {
    console.error(`config: ignoring .env.enc — ${e instanceof Error ? e.message : String(e)}`);
    encCache = { sig, values: {} };
    return {};
  }
}

let runtimeOverrides: {
  aiProvider?: 'openrouter' | 'gemini' | 'custom' | 'local';
  openRouterKey?: string;
  openRouterModel?: string;
  geminiKey?: string;
  modelURL?: string;
  modelKey?: string;
} = {};

export function updateRuntimeConfig(overrides: typeof runtimeOverrides) {
  runtimeOverrides = { ...runtimeOverrides, ...overrides };
}

export function getConfig() {
  const envPath = new URL('../.env', import.meta.url);
  // Precedence: process env  <  committed .env.enc  <  local plaintext .env
  const values = {
    ...process.env,
    ...encryptedEnvValues(),
    ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}),
  };
  const provider = values.SENTINEL_PROVIDER || 'cdse';
  if (!['cdse', 'sentinelhub'].includes(provider)) throw new Error('SENTINEL_PROVIDER must be cdse or sentinelhub.');
  
  const modelURL = runtimeOverrides.modelURL ?? (values.MODEL_API_URL?.trim() || '');
  let modelError = '';
  if (modelURL) {
    try {
      const url = new URL(modelURL);
      if (!['http:', 'https:'].includes(url.protocol)) modelError = 'MODEL_API_URL must be an HTTP(S) model endpoint.';
      else if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['8787', '5173'].includes(url.port)) {
        modelError = 'MODEL_API_URL points to this dashboard/API. Leave it empty until you have a separate AI inference service.';
      }
    } catch {
      modelError = 'MODEL_API_URL is not a valid URL.';
    }
  }

  const openRouterKey = runtimeOverrides.openRouterKey ?? (values.OPENROUTER_API_KEY?.trim() || '');
  const openRouterModel = runtimeOverrides.openRouterModel ?? (values.OPENROUTER_MODEL?.trim() || 'google/gemma-4-31b-it:free');
  const geminiKey = runtimeOverrides.geminiKey ?? (values.GEMINI_API_KEY?.trim() || '');

  const aiProvider = runtimeOverrides.aiProvider ?? (
    openRouterKey ? 'openrouter' :
    geminiKey ? 'gemini' :
    modelURL ? 'custom' :
    'local'
  );

  const modelConnected = Boolean(openRouterKey || geminiKey || (modelURL && !modelError));

  return {
    provider,
    clientId: values.SENTINEL_CLIENT_ID?.trim() || '',
    clientSecret: values.SENTINEL_CLIENT_SECRET?.trim() || '',
    modelURL: modelError ? '' : modelURL,
    modelError,
    modelKey: runtimeOverrides.modelKey ?? (values.MODEL_API_KEY || ''),
    openRouterKey,
    openRouterModel,
    geminiKey,
    aiProvider,
    modelConnected,
    root: provider === 'cdse' ? 'https://sh.dataspace.copernicus.eu' : 'https://services.sentinel-hub.com',
    tokenURL: provider === 'cdse' ? 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token' : 'https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token',
    catalogPath: provider === 'cdse' ? '/catalog/v1/search' : '/api/v1/catalog/1.0.0/search',
    processPath: provider === 'cdse' ? '/process/v1' : '/api/v1/process'
  };
}

