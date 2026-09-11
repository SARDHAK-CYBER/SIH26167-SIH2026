import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, updateRuntimeConfig } from './config.ts';
import { sentinelRequest, accessToken } from './sentinel.ts';
import { decodeJP2 } from './jp2.ts';
import { COLLECTIONS, searchCatalog, validateSearch } from './catalog.ts';
import { resolveLocation } from './geocode.ts';
import { orchestrate } from './orchestrator.ts';
import type { AnalysisPayload } from './aiService.ts';
import type { SearchRequest } from '../src/types/workspace.ts';

const distDirectory = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2'
};

async function serveDashboard(pathname: string, res: import('node:http').ServerResponse) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = resolve(distDirectory, requested);
  if (!file.startsWith(distDirectory + sep) && file !== resolve(distDirectory, 'index.html')) return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    if (extname(requested)) return false;
    try {
      const data = await readFile(resolve(distDirectory, 'index.html'));
      res.writeHead(200, { 'Content-Type': mimeTypes['.html'] });
      res.end(data);
      return true;
    } catch { return false; }
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return json(403, { error: 'Only local workspace requests are allowed.' });
  }

  try {
    const config = getConfig();
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && !pathname.startsWith('/api/') && await serveDashboard(pathname, res)) return;

    if (req.method === 'GET' && req.url === '/api/status') {
      return json(200, {
        sentinel: !!(config.clientId && config.clientSecret),
        provider: config.provider,
        model: config.modelConnected,
        aiProvider: config.aiProvider,
        openRouterModel: config.openRouterModel,
        modelError: config.modelError
      });
    }

    if (req.method === 'GET' && pathname === '/api/location/search') {
      const params = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
      const query = params.get('q')?.trim() || '';
      if (query.length < 2 || query.length > 160) return json(400, { error: 'Enter a location name, or a single "latitude, longitude", 2–160 characters.' });
      const radiusKm = Math.min(100, Math.max(0.5, Number(params.get('radiusKm')) || 3));
      const matches = await resolveLocation(query, radiusKm);
      return json(200, { matches, radiusKm });
    }

    if (req.method === 'GET' && req.url === '/api/config/model') {
      return json(200, {
        aiProvider: config.aiProvider,
        openRouterModel: config.openRouterModel,
        hasOpenRouterKey: !!config.openRouterKey,
        hasGeminiKey: !!config.geminiKey,
        hasCustomUrl: !!config.modelURL,
        modelURL: config.modelURL
      });
    }

    if (req.method === 'POST' && req.url === '/api/sentinel/check') {
      await accessToken();
      return json(200, { connected: true, provider: config.provider });
    }

    if (req.method !== 'POST') return json(404, { error: 'Endpoint not found.' });

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 160 * 1024 * 1024) return json(413, { error: 'Request exceeds 160 MB. Use smaller AOI crops.' });
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);

    if (req.url === '/api/config/model') {
      const body = JSON.parse(raw.toString('utf8'));
      updateRuntimeConfig({
        aiProvider: body.aiProvider,
        openRouterKey: body.openRouterKey !== undefined ? body.openRouterKey : undefined,
        openRouterModel: body.openRouterModel || undefined,
        geminiKey: body.geminiKey !== undefined ? body.geminiKey : undefined,
        modelURL: body.modelURL !== undefined ? body.modelURL : undefined,
        modelKey: body.modelKey !== undefined ? body.modelKey : undefined
      });
      const updated = getConfig();
      return json(200, {
        success: true,
        aiProvider: updated.aiProvider,
        openRouterModel: updated.openRouterModel,
        modelConnected: updated.modelConnected
      });
    }

    if (req.url === '/api/raster/jp2') {
      const result = await decodeJP2(raw);
      res.writeHead(200, { 'Content-Type': 'image/tiff', 'X-Raster-Metadata': JSON.stringify(result.metadata) });
      return res.end(result.tiff);
    }

    if (req.url === '/api/analyze') {
      const contentType = req.headers['content-type'] || '';
      let payload: AnalysisPayload;

      if (contentType.includes('application/json')) {
        payload = JSON.parse(raw.toString('utf8'));
      } else {
        // Parse multipart or raw json string inside form data
        const text = raw.toString('utf8');
        const match = text.match(/name="request"\r?\n\r?\n([\s\S]*?)\r?\n---/);
        if (match) {
          payload = JSON.parse(match[1]);
        } else {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = {
              query: 'Describe this satellite scene',
              task: 'vqa_single',
              observations: []
            };
          }
        }
      }

      // If a separate external model/orchestrator URL is configured, it owns the
      // whole request: forward the body unchanged and return its response.
      if (config.modelURL) {
        try {
          const customResponse = await fetch(config.modelURL, {
            method: 'POST',
            headers: {
              'Content-Type': contentType || 'application/octet-stream',
              ...(config.modelKey ? { Authorization: `Bearer ${config.modelKey}` } : {})
            },
            body: raw,
            signal: AbortSignal.timeout(120000)
          });
          if (customResponse.ok) {
            return json(200, await customResponse.json());
          }
          console.warn(`Custom model URL responded ${customResponse.status}; using the built-in agentic controller.`);
        } catch (e) {
          console.warn('Custom model URL unreachable, using the built-in agentic controller:', e);
        }
      }

      // Built-in agentic controller: registry-driven tool selection, permitted-
      // parameter whitelisting, VLM adapter (OpenRouter/Gemini) or measurement
      // specialists, output fusion, confidence estimate and execution summary.
      const providerConfigured = !!(config.openRouterKey || config.geminiKey);
      const analysisResult = await orchestrate(payload, providerConfigured);
      return json(200, analysisResult);
    }

    const input = JSON.parse(raw.toString('utf8'));
    if (req.url === '/api/sentinel/search') {
      return json(200, await searchCatalog(input as SearchRequest, async payload =>
        (await sentinelRequest('catalog', payload)).json() as Promise<{ features: unknown[]; context?: { next?: number } }>
      ));
    }

    if (req.url === '/api/sentinel/raster') {
      validateSearch({ bounds: input.bounds, collections: [input.collection], mode: 'latest' });
      if (!COLLECTIONS.includes(input.collection) || !Number.isFinite(Date.parse(input.date))) {
        return json(400, { error: 'Invalid acquisition.' });
      }
      const sar = input.collection === 'sentinel-1-grd';
      const bands = sar ? ['VV', 'VH', 'dataMask'] : ['B02', 'B03', 'B04', 'B08', 'B11', 'B12', 'SCL', 'dataMask'];
      const time = Date.parse(input.date);
      const response = await sentinelRequest('process', {
        input: {
          bounds: { bbox: input.bounds, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
          data: [{
            type: input.collection,
            dataFilter: {
              timeRange: { from: new Date(time - 60000).toISOString(), to: new Date(time + 60000).toISOString() },
              mosaickingOrder: 'mostRecent',
              ...(sar ? { polarization: 'DV' } : {})
            }
          }]
        },
        output: { width: 768, height: 768, responses: [{ identifier: 'default', format: { type: 'image/tiff' } }] },
        evalscript: `//VERSION=3\nfunction setup(){return {input:[${JSON.stringify({ bands })}],output:{bands:${bands.length},sampleType:"FLOAT32"}};}\nfunction evaluatePixel(s){return [${bands.map(b => `s.${b}`).join(',')}];}`
      });
      res.writeHead(200, { 'Content-Type': 'image/tiff' });
      return res.end(Buffer.from(await response.arrayBuffer()));
    }

    return json(404, { error: 'Endpoint not found.' });
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Request failed.' });
  }
});

server.listen(8787, '127.0.0.1', () => console.log('SatQuery API: http://127.0.0.1:8787'));

