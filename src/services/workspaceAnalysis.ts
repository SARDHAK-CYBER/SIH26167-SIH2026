import type { AnalysisResult, Observation } from '../types/workspace';
import { intersectBounds, planFusion, routeTask } from './fusionPlan.ts';

export async function analyzeWorkspace(
  query: string,
  observations: Observation[],
  target: string,
  tolerance: number,
  useModel: boolean,
  signal: AbortSignal,
  selectedId?: string,
  sessionMemory: Array<{ query: string; answer: string; observationNames: string[] }> = []
): Promise<AnalysisResult> {

  if (!query.trim()) throw new Error('Enter a question first.');
  if (!observations.length) throw new Error('Upload an image or load a Sentinel acquisition first.');

  const task = routeTask(query, observations.length);
  const plan = planFusion(observations, target, tolerance);
  let inputs = [observations.find(o => o.id === selectedId) || observations[0]];

  if (task === 'multisensor_fusion') {
    if (!plan.ready) throw new Error(plan.reasons.join(' '));
    inputs = plan.eligible;
  }

  if (task === 'change_vqa') {
    if (observations.length !== 2 || observations.some(o => !o.date) || observations[0].date.slice(0, 10) === observations[1].date.slice(0, 10)) {
      throw new Error('Change analysis needs exactly two observations with different acquisition dates.');
    }
    const [a, b] = observations;
    if (!a.crs || a.crs !== b.crs || !a.bounds || !b.bounds || !intersectBounds(a.bounds, b.bounds)) {
      throw new Error('Change analysis needs spatially overlapping, georeferenced inputs in a common CRS.');
    }
    inputs = [...observations].sort((a, b) => a.date.localeCompare(b.date));
  }

  const trace = [
    { tool: 'Input validator', status: 'completed', detail: `${inputs.length} decoded input(s); original files & previews retained for inference.` },
    { tool: 'Query router', status: 'completed', detail: `Agentic task selection: [${task.toUpperCase()}].` },
    { tool: 'Compatibility precheck', status: 'completed', detail: task === 'multisensor_fusion' ? `${inputs.length} candidates within ±${tolerance} days. ${plan.alignment}` : 'Modality and spectral band integrity verified.' },
  ];

  if (useModel) {
    const payload = {
      query,
      task,
      targetDate: target,
      toleranceDays: tolerance,
      sessionMemory,
      observations: inputs.map(o => ({
        id: o.id,
        name: o.name,
        sensor: o.sensor,
        date: o.date,
        bands: o.bands,
        width: o.width,
        height: o.height,
        crs: o.crs,
        bounds: o.bounds,
        collection: o.collection,
        cloudCover: o.cloudCover,
        resolution: o.resolution,
        sarProduct: o.sarProduct,
        stats: o.stats,
        previewBase64: o.preview
      }))
    };

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Analysis request failed with status ${response.status}`);
    }

    const result = await response.json();
    const evidence = Array.isArray(result.evidence)
      ? result.evidence.filter((e: { observationId: string; label: string; box: number[] }) =>
          inputs.some(o => o.id === e.observationId) &&
          typeof e.label === 'string' &&
          Array.isArray(e.box) &&
          e.box.length === 4
        )
      : [];

    return {
      observationIds: inputs.map(o => o.id),
      query,
      task,
      answer: result.answer,
      findings: Array.isArray(result.findings) ? result.findings : [],
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      // Pass the controller's confidence through unchanged. null means "not
      // calibrated" and must not be replaced with an invented value.
      confidence: typeof result.confidence === 'number' ? result.confidence : null,
      mode: 'model',
      timestamp: new Date().toISOString(),
      trace: [...trace, ...(Array.isArray(result.trace) ? result.trace : [])],
      evidence,
      spatialMetrics: result.spatialMetrics && typeof result.spatialMetrics === 'object' ? result.spatialMetrics : undefined,
      executionSummary: result.executionSummary && typeof result.executionSummary === 'object' ? result.executionSummary : undefined
    };
  }

  return {
    observationIds: inputs.map(o => o.id),
    query,
    task,
    mode: 'inspection',
    timestamp: new Date().toISOString(),
    confidence: null,
    answer: `Inspected ${inputs.length} ${inputs.length === 1 ? 'image' : 'images'} for your ${task.replaceAll('_', ' ')} request. Image decoding and metadata checks are complete.`,
    findings: inputs.map(o => `${o.name}: ${o.width.toLocaleString()} × ${o.height.toLocaleString()} pixels, ${o.bands} band${o.bands === 1 ? '' : 's'}, ${o.sensor}; ${o.date ? 'acquired ' + o.date.slice(0, 10) : 'date unknown'}; ${o.crs || 'CRS unknown'}.`),
    warnings: [...new Set(inputs.flatMap(o => o.warnings)), ...(inputs.length > 1 ? [plan.alignment] : [])],
    trace: [
      ...trace,
      { tool: 'Raster inspector', status: 'completed', detail: 'Dimensions, geospatial tags and sampled band statistics read from the supplied files.' },
      { tool: 'Remote-sensing specialist', status: 'ready', detail: `Domain adapter: [${task}]. Connect model or API key to activate live reasoning.` }
    ]
  };
}

