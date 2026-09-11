// Measurement-grounded remote-sensing specialists.
//
// These functions do NOT invent numbers. Every figure they report is derived
// from the per-band statistics (min/max/mean/valid-pixel count) that the browser
// measured from the original raster, or from the acquisition metadata. Where a
// value cannot be computed from the available evidence, the output says so.
//
// A domain-adapted VLM (server/aiService.ts) is used instead when a model
// provider is configured; this module is the deterministic fallback that keeps
// the "no model" path evidence-grounded rather than templated.

export interface BandStat { band: number; min: number; max: number; mean: number; validPixels: number }

export interface SpecialistObservation {
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
  stats?: BandStat[];
}

export interface SpecialistOutput {
  answer: string;
  findings: string[];
  warnings: string[];
  metrics: Record<string, number | string>;
  evidence: Array<{ observationId: string; label: string; box: [number, number, number, number] }>;
}

const round = (v: number, dp = 3) => Number.isFinite(v) ? Number(v.toFixed(dp)) : NaN;
const ratioIndex = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) && a + b !== 0) ? (a - b) / (a + b) : NaN;

// ---------------------------------------------------------------------------
// Band-role resolution
// ---------------------------------------------------------------------------

export interface BandRoles {
  known: boolean;
  source: string;
  blue?: number; green?: number; red?: number; nir?: number; swir1?: number; swir2?: number; scl?: number; dataMask?: number;
  vv?: number; vh?: number;
}

export function resolveBandRoles(obs: SpecialistObservation): BandRoles {
  const n = obs.stats?.length ?? obs.bands;
  if (obs.collection === 'sentinel-2-l2a' || (obs.sensor === 'multispectral' && n === 8)) {
    // Process API evalscript order: B02,B03,B04,B08,B11,B12,SCL,dataMask
    return { known: true, source: 'Sentinel-2 L2A evalscript order (B02,B03,B04,B08,B11,B12,SCL,dataMask)', blue: 0, green: 1, red: 2, nir: 3, swir1: 4, swir2: 5, scl: 6, dataMask: 7 };
  }
  if (obs.collection === 'sentinel-1-grd' || (obs.sensor === 'sar' && n === 3)) {
    return { known: true, source: 'Sentinel-1 GRD evalscript order (VV,VH,dataMask)', vv: 0, vh: 1, dataMask: 2 };
  }
  return { known: false, source: 'Band roles not established for this input; only measured band values are reported.' };
}

const meanOf = (obs: SpecialistObservation, i?: number) =>
  i === undefined ? NaN : (obs.stats?.[i]?.mean ?? NaN);

export function validDataFraction(obs: SpecialistObservation, roles: BandRoles): number {
  const mask = roles.dataMask;
  if (mask !== undefined && obs.stats?.[mask]) {
    // dataMask is 0/1; its mean is the valid-pixel fraction of the sampled raster.
    return clamp01(obs.stats[mask].mean);
  }
  return NaN;
}

const clamp01 = (v: number) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN;

// ---------------------------------------------------------------------------
// Spectral indices (scene-mean approximation from sampled band statistics)
// ---------------------------------------------------------------------------

export interface SceneIndices {
  ndvi?: number; ndwi?: number; ndbi?: number;
  vvMeanDb?: number; vhMeanDb?: number; vvVhRatioDb?: number;
  validFraction?: number;
  note: string;
}

export function computeIndices(obs: SpecialistObservation, roles: BandRoles): SceneIndices {
  const out: SceneIndices = { note: '' };
  if (!obs.stats?.length) { out.note = 'No band statistics supplied; indices could not be computed.'; return out; }
  if (roles.red !== undefined && roles.nir !== undefined) {
    out.ndvi = round(ratioIndex(meanOf(obs, roles.nir), meanOf(obs, roles.red)));
    out.ndwi = round(ratioIndex(meanOf(obs, roles.green), meanOf(obs, roles.nir)));
    if (roles.swir1 !== undefined) out.ndbi = round(ratioIndex(meanOf(obs, roles.swir1), meanOf(obs, roles.nir)));
    out.note = 'NDVI=(NIR-Red)/(NIR+Red), NDWI=(Green-NIR)/(Green+NIR), NDBI=(SWIR1-NIR)/(SWIR1+NIR), each from sampled scene-mean band reflectance. Not a per-pixel index map.';
  } else if (roles.vv !== undefined && roles.vh !== undefined) {
    const vv = meanOf(obs, roles.vv), vh = meanOf(obs, roles.vh);
    out.vvMeanDb = round(vv, 2); out.vhMeanDb = round(vh, 2);
    out.vvVhRatioDb = round(vv - vh, 2);
    out.note = 'Sentinel-1 GRD linear-power means; VV/VH ratio reported as VV(dB-like)-VH(dB-like) difference of sampled means. Apply product calibration before physical interpretation.';
  } else {
    out.note = roles.source;
  }
  const vf = validDataFraction(obs, roles);
  if (Number.isFinite(vf)) out.validFraction = round(vf, 3);
  return out;
}

// ---------------------------------------------------------------------------
// Single-image: scene description / land-cover characterisation
// ---------------------------------------------------------------------------

export function describeScene(obs: SpecialistObservation, query: string): SpecialistOutput {
  const roles = resolveBandRoles(obs);
  const idx = computeIndices(obs, roles);
  const findings: string[] = [];
  const warnings: string[] = [roles.source];
  const metrics: Record<string, number | string> = { bandsMeasured: obs.stats?.length ?? obs.bands };

  const lines: string[] = [
    `Measured characterisation of ${obs.name} (${obs.sensor}, ${obs.width}\u00d7${obs.height} px, ${obs.crs || 'CRS unknown'}${obs.date ? ', acquired ' + obs.date.slice(0, 10) : ''}).`
  ];

  if (idx.ndvi !== undefined && Number.isFinite(idx.ndvi)) {
    metrics.sceneMeanNDVI = idx.ndvi; metrics.sceneMeanNDWI = idx.ndwi ?? NaN;
    const veg = idx.ndvi > 0.3 ? 'vegetation-dominated' : idx.ndvi > 0.15 ? 'mixed / sparsely vegetated' : 'low-vegetation or non-vegetated';
    findings.push(`Scene-mean NDVI ${idx.ndvi} indicates a ${veg} scene (typical vegetation threshold NDVI > 0.3).`);
    if (idx.ndwi !== undefined && Number.isFinite(idx.ndwi)) {
      findings.push(`Scene-mean NDWI ${idx.ndwi}: ${idx.ndwi > 0 ? 'open-water presence is likely' : 'no dominant open-water signal'} (McFeeters NDWI > 0).`);
    }
    if (idx.ndbi !== undefined && Number.isFinite(idx.ndbi)) {
      metrics.sceneMeanNDBI = idx.ndbi;
      findings.push(`Scene-mean NDBI ${idx.ndbi}: ${idx.ndbi > 0 ? 'built-up / bare-surface fraction is non-trivial' : 'built-up signal is not dominant'}.`);
    }
    lines.push(`Spectral summary \u2014 NDVI ${idx.ndvi}, NDWI ${idx.ndwi}${idx.ndbi !== undefined ? ', NDBI ' + idx.ndbi : ''} (scene means). ${idx.note}`);
  } else if (idx.vvMeanDb !== undefined) {
    metrics.vvMean = idx.vvMeanDb; metrics.vhMean = idx.vhMeanDb ?? NaN; metrics.vvVhRatio = idx.vvVhRatioDb ?? NaN;
    findings.push(`Mean SAR backscatter VV ${idx.vvMeanDb}, VH ${idx.vhMeanDb}, VV\u2212VH ${idx.vvVhRatioDb}. Low values suggest smooth surfaces (open water / roads); high VV\u2212VH separation suggests volume or double-bounce scattering (vegetation / built-up).`);
    lines.push(`SAR summary \u2014 ${idx.note}`);
  } else {
    for (const s of obs.stats ?? []) findings.push(`Band ${s.band}: min ${round(s.min, 2)}, max ${round(s.max, 2)}, mean ${round(s.mean, 2)} over ${s.validPixels} valid sampled pixels.`);
    lines.push('Band roles are not known for this input, so only raw per-band statistics are reported. Supply a calibrated Sentinel-2/Sentinel-1 product or a band manifest for index-based characterisation.');
  }

  if (Number.isFinite(idx.validFraction as number)) {
    metrics.validDataFraction = idx.validFraction as number;
    if ((idx.validFraction as number) < 0.98) warnings.push(`Valid-data fraction ${idx.validFraction} (< 1.0): no-data or masked pixels are present in the AOI.`);
  }
  if (obs.cloudCover != null) { metrics.reportedCloudCoverPct = obs.cloudCover; if (obs.cloudCover > 10) warnings.push(`Catalogue cloud cover for this scene is ${obs.cloudCover.toFixed(0)}%.`); }
  warnings.push('Scene-mean indices summarise the whole AOI; they are not a substitute for a per-pixel classification or a segmentation mask.');
  if (/highlight|locate|where is|ground/i.test(query)) warnings.push('This query asks for a located region. The measurement fallback cannot localise sub-scene regions \u2014 connect a grounding specialist for bounding boxes.');

  return { answer: lines.join('\n\n'), findings, warnings, metrics, evidence: [] };
}

// ---------------------------------------------------------------------------
// Single-image: explicit spectral-index report
// ---------------------------------------------------------------------------

export function spectralReport(obs: SpecialistObservation, requested: string[]): SpecialistOutput {
  const roles = resolveBandRoles(obs);
  const idx = computeIndices(obs, roles);
  const want = requested.length ? requested.map(s => s.toLowerCase()) : ['ndvi', 'ndwi', 'ndbi'];
  const findings: string[] = [];
  const metrics: Record<string, number | string> = {};
  const warnings: string[] = [roles.source, idx.note];

  const push = (key: string, val: number | undefined, formula: string, inputs: string) => {
    if (val === undefined || !Number.isFinite(val)) { findings.push(`${key.toUpperCase()}: not computable (${inputs} unavailable for this input).`); return; }
    metrics[key] = val;
    findings.push(`${key.toUpperCase()} = ${val}  \u2014  ${formula}; ${inputs}.`);
  };
  if (want.includes('ndvi')) push('ndvi', idx.ndvi, '(NIR\u2212Red)/(NIR+Red)', `scene-mean NIR=${round(meanOf(obs, roles.nir), 2)}, Red=${round(meanOf(obs, roles.red), 2)}`);
  if (want.includes('ndwi')) push('ndwi', idx.ndwi, '(Green\u2212NIR)/(Green+NIR)', `scene-mean Green=${round(meanOf(obs, roles.green), 2)}, NIR=${round(meanOf(obs, roles.nir), 2)}`);
  if (want.includes('ndbi')) push('ndbi', idx.ndbi, '(SWIR1\u2212NIR)/(SWIR1+NIR)', `scene-mean SWIR1=${round(meanOf(obs, roles.swir1), 2)}, NIR=${round(meanOf(obs, roles.nir), 2)}`);
  if (idx.vvMeanDb !== undefined) { push('vv_vh_ratio', idx.vvVhRatioDb, 'VV\u2212VH of sampled means', `VV=${idx.vvMeanDb}, VH=${idx.vhMeanDb}`); }

  return {
    answer: `Spectral indices for ${obs.name}, computed from sampled scene-mean band values:\n\n${findings.join('\n')}\n\nThese are AOI-wide means, not per-pixel index rasters. Physical calibration (BOA reflectance, SAR sigma-nought) is assumed to have been applied by the product.`,
    findings, warnings, metrics, evidence: []
  };
}

// ---------------------------------------------------------------------------
// Bi-temporal: change analysis from measured band deltas
// ---------------------------------------------------------------------------

export function changeAnalysis(a: SpecialistObservation, b: SpecialistObservation, query: string, changeThreshold: number): SpecialistOutput {
  // a, b are pre-sorted oldest -> newest by the caller.
  const rolesA = resolveBandRoles(a), rolesB = resolveBandRoles(b);
  const idxA = computeIndices(a, rolesA), idxB = computeIndices(b, rolesB);
  const findings: string[] = [];
  const warnings: string[] = [];
  const metrics: Record<string, number | string> = { fromDate: a.date?.slice(0, 10) || 'unknown', toDate: b.date?.slice(0, 10) || 'unknown' };
  const vfA = validDataFraction(a, rolesA), vfB = validDataFraction(b, rolesB);
  if (Number.isFinite(vfA) && Number.isFinite(vfB)) {
    metrics.validDataFraction = round(Math.min(vfA, vfB), 3);
    if (metrics.validDataFraction < 0.98) warnings.push(`Lowest valid-data fraction across the pair is ${metrics.validDataFraction}; masked/no-data pixels affect the comparison.`);
  }

  const delta = (name: string, va?: number, vb?: number) => {
    if (va === undefined || vb === undefined || !Number.isFinite(va) || !Number.isFinite(vb)) return;
    const d = round(vb - va);
    metrics[`delta_${name}`] = d;
    const dir = Math.abs(d) < changeThreshold ? 'unchanged' : d > 0 ? 'increased' : 'decreased';
    findings.push(`${name.toUpperCase()} ${va} \u2192 ${vb} (\u0394 ${d >= 0 ? '+' : ''}${d}): ${dir} (|\u0394| threshold ${changeThreshold}).`);
    return { d, dir };
  };

  const ndvi = delta('ndvi', idxA.ndvi, idxB.ndvi);
  delta('ndwi', idxA.ndwi, idxB.ndwi);
  const ndbi = delta('ndbi', idxA.ndbi, idxB.ndbi);
  delta('vv_backscatter', idxA.vvMeanDb, idxB.vvMeanDb);

  // Per-band mean magnitude of change, if the two rasters have matching band counts.
  if (a.stats?.length && b.stats?.length && a.stats.length === b.stats.length) {
    let acc = 0, cnt = 0;
    for (let i = 0; i < a.stats.length; i++) {
      const va = a.stats[i].mean, vb = b.stats[i].mean;
      const denom = Math.abs(va) + Math.abs(vb);
      if (denom > 0) { acc += Math.abs(vb - va) / denom; cnt++; }
    }
    if (cnt) { metrics.meanRelativeBandChange = round(acc / cnt); findings.push(`Mean relative change across ${cnt} bands: ${metrics.meanRelativeBandChange} (0 = identical means, 1 = fully divergent).`); }
  } else {
    warnings.push('The two acquisitions have different band counts; only shared derived indices were differenced.');
  }

  let verdict = 'Change magnitude is within the reporting threshold on the available indices.';
  if (/built[- ]?up|urban|construction/i.test(query) && ndbi) {
    verdict = `Built-up proxy (NDBI) ${ndbi.dir} by ${ndbi.d >= 0 ? '+' : ''}${ndbi.d} between ${metrics.fromDate} and ${metrics.toDate}.`;
  } else if (ndvi) {
    verdict = `Vegetation proxy (NDVI) ${ndvi.dir} by ${ndvi.d >= 0 ? '+' : ''}${ndvi.d} between ${metrics.fromDate} and ${metrics.toDate}.`;
  }

  warnings.push('Change is quantified from AOI scene-mean band statistics, not a per-pixel change map. Spatial extent and location of change require a co-registered pixel-level change model with reference masks.');

  return {
    answer: `Bi-temporal comparison of ${a.name} (${metrics.fromDate}) and ${b.name} (${metrics.toDate}):\n\n${findings.join('\n')}\n\n${verdict}`,
    findings, warnings, metrics, evidence: []
  };
}

// ---------------------------------------------------------------------------
// Cross-modal: optical + SAR joint information extraction
// ---------------------------------------------------------------------------

export function opticalSarFusion(inputs: SpecialistObservation[], query: string): SpecialistOutput {
  const optical = inputs.find(o => o.sensor === 'optical' || o.sensor === 'multispectral');
  const sar = inputs.find(o => o.sensor === 'sar');
  const findings: string[] = [];
  const warnings: string[] = [];
  const metrics: Record<string, number | string> = {};

  if (!optical || !sar) {
    return {
      answer: 'Cross-modal fusion needs one optical/multispectral image and one SAR image. The current selection does not contain both modalities.',
      findings: [`Selected modalities: ${inputs.map(o => o.sensor).join(', ') || 'none'}.`],
      warnings: ['Load a co-registered optical + SAR pair for cross-modal analysis.'],
      metrics, evidence: []
    };
  }

  const oRoles = resolveBandRoles(optical), sRoles = resolveBandRoles(sar);
  const oIdx = computeIndices(optical, oRoles), sIdx = computeIndices(sar, sRoles);

  if (Number.isFinite(oIdx.validFraction as number)) { metrics.opticalValidFraction = oIdx.validFraction as number; findings.push(`Optical valid-data fraction ${oIdx.validFraction}. ${(oIdx.validFraction as number) < 0.95 ? 'SAR fills the missing/occluded optical coverage.' : 'Optical coverage is near-complete for this AOI.'}`); }
  if (optical.cloudCover != null) { metrics.opticalCloudCoverPct = optical.cloudCover; if (optical.cloudCover > 10) findings.push(`Optical scene cloud cover ${optical.cloudCover.toFixed(0)}% \u2014 SAR backscatter is the reliable structural source over cloud.`); }
  if (oIdx.ndwi !== undefined && Number.isFinite(oIdx.ndwi)) findings.push(`Optical NDWI ${oIdx.ndwi} (${oIdx.ndwi > 0 ? 'water likely' : 'no dominant water'}).`);
  if (sIdx.vvMeanDb !== undefined) {
    metrics.sarVvMean = sIdx.vvMeanDb; metrics.sarVhMean = sIdx.vhMeanDb ?? NaN; metrics.sarVvVh = sIdx.vvVhRatioDb ?? NaN;
    findings.push(`SAR VV ${sIdx.vvMeanDb}, VH ${sIdx.vhMeanDb}, VV\u2212VH ${sIdx.vvVhRatioDb}. Smooth open water gives low VV and VH; built-up gives high VV from double-bounce; vegetation gives elevated VH from volume scattering.`);
  }
  findings.push('Joint reading: optical spectral indices delineate land cover and water where cloud-free; SAR backscatter confirms structure and water boundaries independently of illumination and cloud.');

  warnings.push('This fusion reads each modality\u2019s sampled statistics side by side. It does not perform pixel-level co-registration, resampling to a common grid, or learned feature fusion \u2014 those require a dedicated optical\u2013SAR model.');

  return { answer: `Optical\u2013SAR joint analysis for the query \u201c${query}\u201d:\n\n${findings.join('\n')}`, findings, warnings, metrics, evidence: [] };
}
