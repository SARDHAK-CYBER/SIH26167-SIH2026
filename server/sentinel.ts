import { getConfig } from './config.ts';
let cached = { token: '', expires: 0, key: '' };
let pending: { key: string; promise: Promise<string> } | undefined;
export async function accessToken(): Promise<string> {
  const config = getConfig(); const key = `${config.provider}:${config.clientId}:${config.clientSecret}`;
  if (!config.clientId || !config.clientSecret) throw new Error('Add SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET to the project .env file.');
  if (cached.key === key && Date.now() < cached.expires) return cached.token;
  if (pending?.key === key) return pending.promise;
  const promise = (async () => {
    let response: Response;
    try { response = await fetch(config.tokenURL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }), signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error(`Cannot reach ${config.provider === 'cdse' ? 'Copernicus' : 'Sentinel Hub'} authentication. Check your internet connection and retry.`); }
    if (!response.ok) throw new Error(`Sentinel authentication failed (HTTP ${response.status}). Check the client credentials and SENTINEL_PROVIDER; use cdse for Copernicus Data Space.`);
    const data = await response.json() as { access_token: string; expires_in: number };
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('Unexpected authentication response.');
    cached = { token: data.access_token, expires: Date.now() + Math.max(0, data.expires_in - 60) * 1000, key }; return cached.token;
  })();
  pending = { key, promise };
  try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
}
export async function sentinelRequest(kind: 'catalog' | 'process', body: unknown, retry = true): Promise<Response> {
  const config = getConfig(); const token = await accessToken();
  let response: Response;
  try { response = await fetch(config.root + (kind === 'catalog' ? config.catalogPath : config.processPath), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) }); }
  catch { throw new Error(`Sentinel ${kind} request could not complete. Check the connection or try a smaller area.`); }
  if (response.status === 401 && retry) { cached.expires = 0; return sentinelRequest(kind, body, false); }
  if (!response.ok) {
    let detail = '';
    try { const data = await response.json() as { error?: { message?: string } }; detail = typeof data.error?.message === 'string' ? data.error.message : ''; } catch { /* Non-JSON provider failure. */ }
    for (const secret of [config.clientId, config.clientSecret, token]) if (secret) detail = detail.replaceAll(secret, '[redacted]');
    const hint = response.status === 403 ? ' Check account permissions and processing quota.' : response.status === 429 ? ' Rate limit reached; wait and retry.' : '';
    throw new Error(`Sentinel ${kind} failed (HTTP ${response.status}).${hint}${detail ? ' ' + detail.slice(0, 350) : ''}`);
  }
  return response;
}
