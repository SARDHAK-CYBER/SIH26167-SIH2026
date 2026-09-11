import type { Observation, Bounds } from '../types/workspace.ts';
export function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const box: Bounds = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[0] < box[2] && box[1] < box[3] ? box : null;
}
export function planFusion(observations: Observation[], target: string, tolerance: number) {
  const targetTime = Date.parse(target + 'T12:00:00Z');
  const reasons: string[] = [];
  const candidates = observations.map(observation => {
    const time = Date.parse(observation.date.slice(0, 10) + 'T12:00:00Z');
    const offset = Number.isFinite(time) && Number.isFinite(targetTime) ? Math.round((time - targetTime) / 86400000) : null;
    return { observation, offset, eligible: offset !== null && Math.abs(offset) <= tolerance };
  });
  const eligible = candidates.filter(c => c.eligible).map(c => c.observation);
  if (!Number.isFinite(targetTime)) reasons.push('Choose a valid target date.');
  if (eligible.length < 2) reasons.push('At least two dated observations must fall within the temporal window.');
  if (new Set(eligible.map(o => o.sensor)).size < 2) reasons.push('Cross-sensor fusion needs at least two sensor types.');
  if (eligible.some(o => !o.crs || !o.bounds)) reasons.push('Some inputs have no georeferencing. Spatial compatibility cannot be verified.');
  const sameCRS = eligible.length > 0 && eligible.every(o => o.crs && o.crs === eligible[0].crs);
  if (eligible.length > 1 && !sameCRS) reasons.push('Inputs need a common CRS; the model service must reproject them.');
  let overlap: Bounds | null = eligible[0]?.bounds ?? null;
  if (sameCRS) for (const item of eligible.slice(1)) overlap = overlap && item.bounds ? intersectBounds(overlap, item.bounds) : null;
  else overlap = null;
  if (sameCRS && eligible.every(o => o.bounds) && !overlap) reasons.push('The selected observations do not share a common spatial overlap.');
  return { candidates, eligible, overlap, reasons, ready: eligible.length >= 2 && reasons.length === 0,
    alignment: 'Bounding-box overlap is a precheck. Pixel alignment, resampling, calibration and masks must be verified by the model service.' };
}
export function routeTask(query: string, count: number) {
  if (/chang|before|after|increas|decreas|between.*date/i.test(query)) return 'change_vqa';
  if (/fus|together|combin|cross.modal|complement/i.test(query)) return 'multisensor_fusion';
  if (/highlight|locate|ground|where is/i.test(query)) return 'grounding';
  if (/ndvi|ndwi|spectral index|indices/i.test(query)) return 'spectral_analysis';
  if (/describe|caption|land.cover/i.test(query)) return 'captioning';
  return count ? 'vqa_single' : 'input_validation';
}

// --------------------------------------------------------------------------
// Task classification with observable signals and a confidence estimate.
// routeTask() remains the routing authority; classifyTask() wraps it so the
// agentic controller can record *why* a task was chosen in the execution trace
// (Problem Statement 26167: "interpret the query and classify the requested task").
// --------------------------------------------------------------------------
const TASK_SIGNATURES: Array<{ signal: string; pattern: RegExp }> = [
  { signal: 'temporal-change', pattern: /chang|before|after|increas|decreas|between.*date|over time|since/i },
  { signal: 'cross-modal-fusion', pattern: /fus|together|combin|cross.?modal|complement|optical.*sar|sar.*optical/i },
  { signal: 'region-grounding', pattern: /highlight|locate|ground|where is|point to|bounding|delineate/i },
  { signal: 'spectral-index', pattern: /ndvi|ndwi|ndbi|spectral index|indices|backscatter|vegetation index/i },
  { signal: 'scene-caption', pattern: /describe|caption|land.?cover|what.*(visible|see|shown)|summar/i },
];

export interface TaskClassification {
  task: string;
  confidence: number;
  signals: string[];
  rationale: string;
}

export function classifyTask(query: string, count: number): TaskClassification {
  const task = routeTask(query, count);
  const signals = TASK_SIGNATURES.filter(s => s.pattern.test(query)).map(s => s.signal);
  let confidence: number;
  if (task === 'input_validation') confidence = 1;
  else if (task === 'vqa_single' && signals.length === 0) confidence = 0.45; // generic question, no strong cue
  else confidence = Math.min(0.95, 0.55 + 0.15 * signals.length);
  const rationale = signals.length
    ? `Query cues [${signals.join(', ')}] with ${count} image(s) in context routed to ${task}.`
    : `No strong task cue; ${count} image(s) in context routed to ${task}.`;
  return { task, confidence: Number(confidence.toFixed(2)), signals, rationale };
}

// --------------------------------------------------------------------------
// Co-registration assessment for a candidate image pair (cross-modal or
// bi-temporal). Bounding-box + grid checks only; this reports how aligned the
// inputs appear, it does NOT perform or guarantee pixel co-registration.
// --------------------------------------------------------------------------
export interface CoRegistrationAssessment {
  status: 'co-registered' | 'overlap-only' | 'incompatible';
  sameCrs: boolean;
  sameGrid: boolean;
  footprintIoU: number | null;
  resolutionRatio: number | null;
  notes: string[];
}

type GeoLike = Pick<Observation, 'crs' | 'bounds' | 'width' | 'height' | 'resolution'>;

export function assessCoRegistration(a: GeoLike, b: GeoLike): CoRegistrationAssessment {
  const notes: string[] = [];
  const sameCrs = !!a.crs && a.crs === b.crs;
  if (!a.crs || !b.crs) notes.push('One or both inputs have no CRS; spatial alignment cannot be verified.');
  else if (!sameCrs) notes.push(`Different CRS (${a.crs} vs ${b.crs}); reprojection to a common grid is required before analysis.`);

  let footprintIoU: number | null = null;
  if (a.bounds && b.bounds) {
    const inter = intersectBounds(a.bounds as Bounds, b.bounds as Bounds);
    const area = (x: Bounds) => Math.max(0, x[2] - x[0]) * Math.max(0, x[3] - x[1]);
    const interArea = inter ? area(inter) : 0;
    const unionArea = area(a.bounds as Bounds) + area(b.bounds as Bounds) - interArea;
    footprintIoU = unionArea > 0 ? Number((interArea / unionArea).toFixed(4)) : 0;
    if (footprintIoU === 0) notes.push('Footprints do not intersect.');
    else if (footprintIoU < 0.9) notes.push(`Footprint IoU ${footprintIoU}: the two AOIs are not the same extent.`);
  } else {
    notes.push('Footprint comparison skipped (missing bounds).');
  }

  const sameGrid = a.width > 0 && a.width === b.width && a.height === b.height;
  if (!sameGrid) notes.push(`Pixel grids differ (${a.width}×${a.height} vs ${b.width}×${b.height}); resampling to a shared grid is required.`);

  let resolutionRatio: number | null = null;
  if (a.resolution && b.resolution) {
    resolutionRatio = Number((Math.max(a.resolution, b.resolution) / Math.min(a.resolution, b.resolution)).toFixed(3));
    if (resolutionRatio > 1.5) notes.push(`Native resolutions differ by ${resolutionRatio}×.`);
  }

  const status: CoRegistrationAssessment['status'] =
    sameCrs && sameGrid && footprintIoU !== null && footprintIoU > 0.98 ? 'co-registered'
    : sameCrs && footprintIoU !== null && footprintIoU > 0 ? 'overlap-only'
    : 'incompatible';

  if (status === 'co-registered') notes.push('Inputs share CRS, extent and pixel grid — consistent with co-registration. Sub-pixel alignment still must be confirmed by the analysis model.');
  return { status, sameCrs, sameGrid, footprintIoU, resolutionRatio, notes };
}
