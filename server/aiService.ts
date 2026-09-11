import { getConfig } from './config.ts';

export interface AnalysisPayload {
  query: string;
  task: string;
  targetDate?: string;
  toleranceDays?: number;
  parameters?: Record<string, unknown>;
  sessionMemory?: Array<{ query: string; answer: string; observationNames: string[] }>;
  observations: Array<{
    id: string;
    name: string;
    sensor: string;
    date: string;
    bands: number;
    width: number;
    height: number;
    crs?: string;
    bounds?: [number, number, number, number];
    collection?: string;
    cloudCover?: number;
    resolution?: number;
    sarProduct?: string;
    stats?: Array<{ band: number; min: number; max: number; mean: number; validPixels: number }>;
    previewBase64?: string;
  }>;
}

export interface AnalysisResponse {
  answer: string;
  findings: string[];
  warnings?: string[];
  confidence: number | null;
  trace: Array<{
    tool: string;
    status: string;
    detail: string;
  }>;
  evidence?: Array<{
    observationId: string;
    label: string;
    box: [number, number, number, number]; // normalized [xmin, ymin, xmax, ymax], 0-1
  }>;
  spatialMetrics?: Record<string, number | string>;
}

const RS_SYSTEM_PROMPT = `You are SatQuery AI, an agentic Remote Sensing Vision-Language Assistant for ISRO/SAC Problem Statement 26167.
You handle single-image VQA, land-cover description (BigEarthNet-style Corine Land Cover), spatial reasoning / object counting (RSVQA / VRSBench), bi-temporal change VQA (CDVQA), and optical-SAR cross-modal fusion (Cartosat/Sentinel-2 + RISAT/Sentinel-1).

RULES:
1. Ground every statement in remote-sensing evidence visible in the supplied imagery and the provided band statistics:
   - Multispectral: RGB, NIR (B08) for vegetation, SWIR (B11/B12) for moisture/built-up.
   - SAR: C-band VV/VH, surface roughness, urban double-bounce, specular water.
   - Bi-temporal: built-up expansion, vegetation loss/gain, water-body change.
2. Do not invent quantities. If a number is not derivable from the imagery or the supplied statistics, say it is an estimate or omit it.
3. For spatial regions, return normalized bounding boxes in "evidence". Each box is [xmin, ymin, xmax, ymax] with floats in [0,1] relative to the referenced image.
4. Respond with ONLY a raw JSON object (no markdown fences) of this exact shape:
{
  "answer": "grounded natural-language answer",
  "findings": ["finding 1", "finding 2", "finding 3"],
  "confidence": 0.0,
  "trace": [
    { "tool": "Task Classifier & Ingest", "status": "completed", "detail": "..." },
    { "tool": "Specialist Reasoner", "status": "completed", "detail": "..." }
  ],
  "evidence": [
    { "observationId": "<id from the request>", "label": "Water body (NDWI > 0)", "box": [0.3, 0.2, 0.85, 0.7] }
  ],
  "warnings": []
}
Set "confidence" to a number in [0,1] only if you can calibrate it; otherwise use null.`;

const OPENROUTER_FALLBACK_MODEL = 'google/gemma-4-26b-a4b-it:free';

/**
 * Multimodal VLM path. Returns a normalised AnalysisResponse, or throws so the
 * agentic controller can fall back to the measurement specialists.
 */
export async function executeAIAnalysis(payload: AnalysisPayload): Promise<AnalysisResponse> {
  const config = getConfig();

  if (config.openRouterKey) {
    try {
      return await callOpenRouter(payload, config.openRouterKey, config.openRouterModel);
    } catch (err) {
      if (shouldTryOpenRouterFallback(err, config.openRouterModel)) {
        return await callOpenRouter(payload, config.openRouterKey, OPENROUTER_FALLBACK_MODEL);
      }
      throw new Error(`OpenRouter analysis failed: ${err instanceof Error ? err.message : 'unknown provider error'}`);
    }
  }

  if (config.geminiKey) {
    try {
      return await callGemini(payload, config.geminiKey);
    } catch (err) {
      throw new Error(`Gemini analysis failed: ${err instanceof Error ? err.message : 'unknown provider error'}`);
    }
  }

  throw new Error('No multimodal model provider is configured.');
}

function shouldTryOpenRouterFallback(error: unknown, configuredModel: string): boolean {
  if (configuredModel === OPENROUTER_FALLBACK_MODEL) return false;
  return error instanceof Error && /OpenRouter error \(429\)/.test(error.message);
}

function observationText(payload: AnalysisPayload): string {
  return payload.observations.map(o => {
    const stats = o.stats?.length
      ? ' | band means ' + o.stats.map(s => `${s.band}:${Number(s.mean.toFixed(2))}`).join(',')
      : '';
    return `- id=${o.id} name="${o.name}" sensor=${o.sensor} date=${o.date || 'unknown'} ${o.width}x${o.height} bands=${o.bands} crs=${o.crs || 'unknown'}${o.collection ? ' collection=' + o.collection : ''}${o.cloudCover != null ? ' cloud%=' + o.cloudCover : ''}${stats}`;
  }).join('\n');
}

async function callOpenRouter(payload: AnalysisPayload, apiKey: string, modelName: string): Promise<AnalysisResponse> {
  const contentParts: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: `User query: "${payload.query}"\nRouted task: ${payload.task}\n` +
        `Permitted parameters: ${JSON.stringify(payload.parameters || {})}\n` +
        `Session memory (context only; correct it when current imagery disagrees):\n${JSON.stringify(payload.sessionMemory || [])}\n\n` +
        `Observations:\n${observationText(payload)}`,
    },
  ];
  for (const obs of payload.observations) {
    if (obs.previewBase64) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: obs.previewBase64.startsWith('data:') ? obs.previewBase64 : `data:image/jpeg;base64,${obs.previewBase64}` },
      });
    }
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://satquery.ai',
      'X-Title': 'SatQuery AI Remote Sensing Assistant',
    },
    body: JSON.stringify({
      model: modelName || 'google/gemini-2.0-flash-exp:free',
      messages: [
        { role: 'system', content: RS_SYSTEM_PROMPT },
        { role: 'user', content: contentParts },
      ],
      temperature: Number(payload.parameters?.temperature ?? 0.2),
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter error (${response.status}): ${errorText.slice(0, 300)}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return parseAIResponse(data.choices?.[0]?.message?.content || '{}', payload, `OpenRouter (${modelName})`);
}

async function callGemini(payload: AnalysisPayload, apiKey: string): Promise<AnalysisResponse> {
  const parts: Array<Record<string, unknown>> = [
    {
      text: `${RS_SYSTEM_PROMPT}\n\nRouted task: ${payload.task}\nUser query: "${payload.query}"\nObservations:\n${observationText(payload)}`,
    },
  ];
  for (const obs of payload.observations) {
    const match = obs.previewBase64?.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: Number(payload.parameters?.temperature ?? 0.2), responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60000),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText.slice(0, 300)}`);
  }
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return parseAIResponse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}', payload, 'Google Gemini 2.0 Flash');
}

function parseAIResponse(rawText: string, payload: AnalysisPayload, modelName: string): AnalysisResponse {
  let clean = rawText.trim();
  if (clean.startsWith('```json')) clean = clean.slice(7);
  if (clean.startsWith('```')) clean = clean.slice(3);
  if (clean.endsWith('```')) clean = clean.slice(0, -3);
  clean = clean.trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`${modelName} did not return valid JSON.`);
  }

  const observationIds = payload.observations.map(o => o.id);
  const clamp01 = (v: unknown, fallback: number) => Math.max(0, Math.min(1, Number(v) || fallback));

  const evidence = Array.isArray(parsed.evidence)
    ? (parsed.evidence as Array<Record<string, unknown>>).map(e => ({
        observationId: observationIds.includes(e.observationId as string) ? e.observationId as string : (observationIds[0] || 'obs-1'),
        label: String(e.label || 'Detected feature'),
        box: (Array.isArray(e.box) && e.box.length === 4
          ? [clamp01(e.box[0], 0), clamp01(e.box[1], 0), clamp01(e.box[2], 1), clamp01(e.box[3], 1)]
          : [0.1, 0.1, 0.9, 0.9]) as [number, number, number, number],
      }))
    : [];

  const trace = Array.isArray(parsed.trace) && parsed.trace.length
    ? parsed.trace as AnalysisResponse['trace']
    : [
        { tool: 'Query Ingest & Modality Verifier', status: 'completed', detail: `Parsed query for [${payload.task.toUpperCase()}] over ${payload.observations.length} image(s).` },
        { tool: `${modelName} multimodal reasoner`, status: 'completed', detail: 'Vision-language joint reasoning over image previews and band statistics.' },
        { tool: 'Spatial Evidence Grounder', status: 'completed', detail: `Returned ${evidence.length} bounding-box region(s).` },
      ];

  return {
    answer: String(parsed.answer || 'Remote-sensing analysis completed.'),
    findings: Array.isArray(parsed.findings) && parsed.findings.length ? (parsed.findings as string[]) : ['No discrete findings were returned by the model.'],
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
    trace,
    evidence,
    warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [],
  };
}
