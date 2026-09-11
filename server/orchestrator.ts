// Agentic controller for Problem Statement 26167.
//
// Given a query + routed task + selected observations, the controller:
//   1. interprets the query and re-checks the task classification;
//   2. validates image count, modality, metadata and pair compatibility;
//   3. selects an ordered tool chain from the predefined registry;
//   4. configures ONLY the parameters each tool permits;
//   5. executes the chain (VLM adapter or measurement specialists), with
//      automatic fallback from the VLM to a measurement specialist on failure;
//   6. fuses textual + spatial outputs and estimates a confidence;
//   7. returns an auditable execution summary (task, tool ids/versions, params).
//
// Only this observable execution trace is intended for evaluation; there is no
// hidden reasoning channel.

import { classifyTask, assessCoRegistration } from '../src/services/fusionPlan.ts';
import { selectToolChain, whitelistParameters, type TaskName } from './registry.ts';
import { executeAIAnalysis, type AnalysisPayload, type AnalysisResponse } from './aiService.ts';
import {
  describeScene, spectralReport, changeAnalysis, opticalSarFusion,
  type SpecialistObservation, type SpecialistOutput,
} from './specialists.ts';

interface TraceEntry { tool: string; status: string; detail: string }

const OPTICAL = new Set(['optical', 'multispectral']);

function toSpecialist(o: AnalysisPayload['observations'][number]): SpecialistObservation {
  return {
    id: o.id, name: o.name, sensor: o.sensor, date: o.date, bands: o.bands,
    width: o.width, height: o.height, crs: o.crs, bounds: o.bounds,
    collection: o.collection, cloudCover: o.cloudCover, resolution: o.resolution,
    sarProduct: o.sarProduct, stats: o.stats,
  };
}

function compatibilityReport(task: TaskName, obs: SpecialistObservation[]): { findings: string[]; warnings: string[]; ok: boolean } {
  const findings: string[] = [];
  const warnings: string[] = [];
  let ok = true;
  const sensors = obs.map(o => o.sensor);
  findings.push(`Inputs: ${obs.length} image(s) [${sensors.join(', ') || 'none'}]. Formats decoded upstream to raster + band statistics.`);

  const dated = obs.filter(o => o.date).length;
  const georef = obs.filter(o => o.crs && o.bounds).length;
  findings.push(`Metadata: ${dated}/${obs.length} dated, ${georef}/${obs.length} georeferenced, band counts [${obs.map(o => o.bands).join(', ')}].`);

  if (task === 'change_vqa') {
    if (obs.length !== 2) { ok = false; warnings.push('Change analysis expects exactly two acquisitions.'); }
    if (obs.some(o => !o.date)) { ok = false; warnings.push('Change analysis requires an acquisition date on both inputs.'); }
    if (obs.length === 2 && obs[0].date && obs[1].date && obs[0].date.slice(0, 10) === obs[1].date.slice(0, 10)) warnings.push('Both acquisitions carry the same date.');
  }
  if (task === 'multisensor_fusion') {
    const hasOptical = obs.some(o => OPTICAL.has(o.sensor));
    const hasSar = obs.some(o => o.sensor === 'sar');
    if (!(hasOptical && hasSar)) { ok = false; warnings.push('Cross-modal fusion expects one optical/multispectral image and one SAR image.'); }
  }
  if ((task === 'grounding' || task === 'spectral_analysis' || task === 'captioning') && obs.length < 1) { ok = false; warnings.push('This task needs at least one image.'); }
  if (obs.some(o => !o.stats || !o.stats.length)) warnings.push('One or more inputs arrived without band statistics; measurement specialists will report reduced detail.');
  return { findings, warnings, ok };
}

function measurementConfidence(primary: SpecialistOutput, coRegisteredFactor: number): number | null {
  const vf = Number(primary.metrics.validDataFraction ?? primary.metrics.opticalValidFraction ?? NaN);
  if (!Number.isFinite(vf)) return null;
  // Documented heuristic for the uncalibrated measurement path, capped low.
  const c = 0.2 + 0.35 * vf + 0.1 * coRegisteredFactor;
  return Number(Math.min(0.6, Math.max(0, c)).toFixed(2));
}

export interface OrchestratedResponse extends AnalysisResponse {
  executionSummary: {
    task: string;
    classification: { task: string; confidence: number; signals: string[] };
    tools: Array<{ id: string; version: string; parameters: Record<string, unknown> }>;
  };
}

export async function orchestrate(
  payload: AnalysisPayload,
  providerConfigured: boolean
): Promise<OrchestratedResponse> {
  const task = (payload.task || 'vqa_single') as TaskName;
  const obs = (payload.observations || []).map(toSpecialist);
  const sensors = obs.map(o => o.sensor);
  const trace: TraceEntry[] = [];

  // 1. Query interpretation ------------------------------------------------
  const classification = classifyTask(payload.query || '', obs.length);
  trace.push({
    tool: 'Query Interpreter',
    status: 'completed',
    detail: `${classification.rationale} Routed task: ${task}${classification.task !== task ? ` (query classifier suggested ${classification.task}; using the routed task)` : ''}. Classifier confidence ${classification.confidence}.`,
  });

  // 2. Tool selection ----------------------------------------------------
  const { chain, notes } = selectToolChain(task, obs.length, sensors, providerConfigured);
  const configured = chain.map(t => {
    const { accepted, rejected } = whitelistParameters(t.id, (payload as Record<string, unknown>).parameters as Record<string, unknown> ?? {});
    if (rejected.length) trace.push({ tool: `Parameter Guard → ${t.id}`, status: 'completed', detail: `Dropped non-permitted parameter(s): ${rejected.join(', ')}. Permitted: [${t.permittedParameters.join(', ') || 'none'}].` });
    return { spec: t, parameters: accepted };
  });
  trace.push({
    tool: 'Tool Registry Selector',
    status: 'completed',
    detail: `Chain: ${chain.map(t => `${t.id}@${t.version}`).join(' → ')}. ${notes.join(' ')}`,
  });

  // 3. Execute the chain ------------------------------------------------
  const findings: string[] = [];
  const warnings: string[] = [];
  const evidence: AnalysisResponse['evidence'] = [];
  const spatialMetrics: Record<string, number | string> = {};
  let answer = '';
  let confidence: number | null = null;
  let coRegFactor = 0.4;
  let primaryOut: SpecialistOutput | null = null;
  let vlmSucceeded = false;

  const sortedPair = obs.length === 2 ? [...obs].sort((a, b) => (a.date || '').localeCompare(b.date || '')) : obs;

  for (const { spec, parameters } of configured) {
    if (spec.id === 'input-compatibility-checker') {
      const r = compatibilityReport(task, obs);
      findings.push(...r.findings);
      warnings.push(...r.warnings);
      trace.push({ tool: `${spec.displayName} v${spec.version}`, status: r.ok ? 'completed' : 'warning', detail: r.ok ? 'Inputs are consistent with the routed task.' : r.warnings.join(' ') });
      continue;
    }

    if (spec.id === 'co-registration-assessor' && sortedPair.length === 2) {
      const a = sortedPair[0], b = sortedPair[1];
      const asr = assessCoRegistration(a, b);
      coRegFactor = asr.status === 'co-registered' ? 1 : asr.status === 'overlap-only' ? 0.6 : 0.3;
      spatialMetrics.footprintIoU = asr.footprintIoU ?? 'n/a';
      spatialMetrics.coRegistration = asr.status;
      warnings.push(...asr.notes);
      trace.push({ tool: `${spec.displayName} v${spec.version}`, status: 'completed', detail: `status=${asr.status}, sameCRS=${asr.sameCrs}, sameGrid=${asr.sameGrid}, footprintIoU=${asr.footprintIoU ?? 'n/a'}.` });
      continue;
    }

    if (spec.id === 'rs-vlm-adapter') {
      try {
        const vlm = await executeAIAnalysis(payload);
        answer = vlm.answer;
        findings.push(...vlm.findings);
        if (vlm.warnings) warnings.push(...vlm.warnings);
        if (vlm.evidence) evidence.push(...vlm.evidence);
        confidence = typeof vlm.confidence === 'number' ? vlm.confidence : null;
        vlmSucceeded = true;
        trace.push(...vlm.trace.map(t => ({ tool: `${spec.displayName} v${spec.version} · ${t.tool}`, status: t.status, detail: `params ${JSON.stringify(parameters)} — ${t.detail}` })));
      } catch (err) {
        const full = err instanceof Error ? err.message : 'model provider error';
        const msg = full.split('\n')[0].slice(0, 160).replace(/\s*[{[].*$/, '').trim() || 'model provider error';
        trace.push({ tool: `${spec.displayName} v${spec.version}`, status: 'failed', detail: `${msg}. Falling back to the measurement specialist for [${task}].` });
        warnings.push(`Model provider unavailable (${msg}); answer is from the measurement fallback.`);
        // Fall back: append the measurement specialist for this task.
        const fb = runMeasurement(task, obs, sortedPair, payload.query || '', parameters);
        if (fb) { primaryOut = fb.out; trace.push({ tool: `${fb.name} (fallback)`, status: 'completed', detail: fb.detail }); }
      }
      continue;
    }

    // Measurement specialists
    const m = runMeasurement(spec.id, obs, sortedPair, payload.query || '', parameters);
    if (m) {
      if (spec.id === 'spectral-index-engine' && vlmSucceeded) {
        findings.push('Verified measurements (spectral-index-engine): ' + m.out.findings.join(' '));
        warnings.push(...m.out.warnings);
      } else {
        primaryOut = m.out;
      }
      Object.assign(spatialMetrics, m.out.metrics);
      trace.push({ tool: `${spec.displayName} v${spec.version}`, status: 'completed', detail: `params ${JSON.stringify(parameters)} — ${m.detail}` });
    }
  }

  if (!vlmSucceeded && primaryOut) {
    answer = primaryOut.answer;
    findings.push(...primaryOut.findings);
    warnings.push(...primaryOut.warnings);
    evidence.push(...primaryOut.evidence);
    Object.assign(spatialMetrics, primaryOut.metrics);
    confidence = measurementConfidence(primaryOut, coRegFactor);
    trace.push({ tool: 'Confidence Estimator', status: 'completed', detail: confidence === null ? 'No valid-data fraction available; confidence left unset (null).' : `Heuristic (uncalibrated, capped 0.6): 0.2 + 0.35·validFraction + 0.1·coRegFactor = ${confidence}.` });
  } else if (vlmSucceeded) {
    trace.push({ tool: 'Confidence Estimator', status: 'completed', detail: confidence === null ? 'Model returned no calibrated confidence; left null.' : `Model-reported confidence ${confidence}.` });
  }

  if (!answer) answer = `Compatibility checked for a ${task.replace(/_/g, ' ')} request over ${obs.length} image(s); no specialist produced an answer for this configuration.`;

  const executionSummary = {
    task,
    classification: { task: classification.task, confidence: classification.confidence, signals: classification.signals },
    tools: configured.map(c => ({ id: c.spec.id, version: c.spec.version, parameters: c.parameters })),
  };
  trace.push({
    tool: 'Execution Summary',
    status: 'completed',
    detail: `task=${task}; tools=[${executionSummary.tools.map(t => `${t.id}@${t.version}(${Object.keys(t.parameters).join(',') || 'no-params'})`).join('; ')}]`,
  });

  return {
    answer,
    findings: dedupe(findings),
    warnings: dedupe(warnings),
    confidence: confidence as number,
    trace,
    evidence,
    spatialMetrics,
    executionSummary,
  };
}

function runMeasurement(
  idOrTask: string,
  obs: SpecialistObservation[],
  sortedPair: SpecialistObservation[],
  query: string,
  parameters: Record<string, unknown>
): { name: string; detail: string; out: SpecialistOutput } | null {
  switch (idOrTask) {
    case 'bigearthnet-scene-descriptor':
    case 'captioning':
    case 'vqa_single': {
      const out = describeScene(obs[0], query);
      return { name: 'BigEarthNet-Style Scene Descriptor', detail: `Scene-mean characterisation of ${obs[0]?.name}.`, out };
    }
    case 'spectral-index-engine':
    case 'spectral_analysis': {
      const indices = Array.isArray(parameters.indices) ? (parameters.indices as string[]) : [];
      const out = spectralReport(obs[0], indices);
      return { name: 'Spectral Index Engine', detail: `Indices [${indices.join(', ') || 'NDVI, NDWI, NDBI'}] from sampled band means.`, out };
    }
    case 'bitemporal-change-analyzer':
    case 'change_vqa': {
      if (sortedPair.length !== 2) return null;
      const threshold = Number(parameters.changeThreshold ?? 0.02);
      const out = changeAnalysis(sortedPair[0], sortedPair[1], query, threshold);
      return { name: 'Bi-Temporal Change Analyzer', detail: `Δ between ${sortedPair[0].date?.slice(0, 10)} and ${sortedPair[1].date?.slice(0, 10)}, |Δ| threshold ${threshold}.`, out };
    }
    case 'optical-sar-fusion-analyzer':
    case 'multisensor_fusion': {
      const out = opticalSarFusion(obs, query);
      return { name: 'Optical-SAR Fusion Analyzer', detail: 'Side-by-side optical index + SAR backscatter evidence.', out };
    }
    case 'text-region-grounder':
    case 'grounding': {
      const out = describeScene(obs[0], query);
      out.warnings.unshift('Grounding requested: returning the referenced-feature description only. Bounding-box localisation requires a configured VLM or a trained grounding model.');
      return { name: 'Text-Guided Region Grounder', detail: 'Feature description only; no bounding boxes from the measurement path.', out };
    }
    default:
      return null;
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
