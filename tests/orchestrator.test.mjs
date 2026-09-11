import test from 'node:test';
import assert from 'node:assert/strict';
import { whitelistParameters, selectToolChain } from '../server/registry.ts';
import { resolveBandRoles, computeIndices, changeAnalysis } from '../server/specialists.ts';
import { orchestrate } from '../server/orchestrator.ts';
import { classifyTask, assessCoRegistration } from '../src/services/fusionPlan.ts';

// --- registry: permitted-parameter whitelisting --------------------------
test('the registry forwards only permitted parameters and reports the rest', () => {
  const { accepted, rejected } = whitelistParameters('bitemporal-change-analyzer', { changeThreshold: 0.1, registration_method: 'SIFT', temperature: 0.9 });
  assert.equal(accepted.changeThreshold, 0.1);
  assert.equal('registration_method' in accepted, false);
  assert.deepEqual(rejected.sort(), ['registration_method', 'temperature']);
});

test('the tool chain always starts with the compatibility checker and adds a pair assessor', () => {
  const measurement = selectToolChain('change_vqa', 2, ['multispectral', 'sar'], false).chain.map(t => t.id);
  assert.equal(measurement[0], 'input-compatibility-checker');
  assert.ok(measurement.includes('co-registration-assessor'));
  assert.ok(measurement.includes('bitemporal-change-analyzer'));
  assert.equal(measurement.includes('rs-vlm-adapter'), false);

  const withProvider = selectToolChain('captioning', 1, ['optical'], true).chain.map(t => t.id);
  assert.ok(withProvider.includes('rs-vlm-adapter'));
  assert.equal(withProvider.includes('bigearthnet-scene-descriptor'), false);
});

// --- measurement specialists: real computation from band statistics -----
const s2 = (id, means) => ({
  id, name: id, sensor: 'multispectral', date: '2024-01-01', bands: 8, width: 768, height: 768,
  crs: 'EPSG:4326', bounds: [72, 18, 73, 19], collection: 'sentinel-2-l2a',
  stats: means.map((mean, i) => ({ band: i + 1, min: 0, max: 1, mean, validPixels: 1000 })),
});

test('band roles resolve for a Sentinel-2 L2A raster', () => {
  const roles = resolveBandRoles(s2('a', [0.1, 0.1, 0.1, 0.4, 0.2, 0.15, 5, 1]));
  assert.equal(roles.known, true);
  assert.equal(roles.red, 2); assert.equal(roles.nir, 3); assert.equal(roles.dataMask, 7);
});

test('NDVI / NDWI are computed from measured scene-mean band values, not invented', () => {
  // Blue,Green,Red,NIR,SWIR1,SWIR2,SCL,dataMask
  const obs = s2('a', [0.08, 0.10, 0.10, 0.40, 0.20, 0.15, 5, 1]);
  const idx = computeIndices(obs, resolveBandRoles(obs));
  assert.equal(idx.ndvi, 0.6);            // (0.40-0.10)/(0.40+0.10)
  assert.equal(idx.ndwi, -0.6);           // (0.10-0.40)/(0.10+0.40)
  assert.equal(idx.validFraction, 1);
});

test('bi-temporal change reports measured index deltas and direction', () => {
  const a = s2('t1', [0.08, 0.10, 0.10, 0.40, 0.20, 0.15, 5, 1]); // NDVI 0.6
  const b = s2('t2', [0.08, 0.10, 0.25, 0.25, 0.20, 0.15, 5, 1]); // NDVI 0.0
  const out = changeAnalysis(a, b, 'What changed?', 0.02);
  assert.equal(out.metrics.delta_ndvi, -0.6);
  assert.match(out.findings.join(' '), /NDVI 0\.6 → 0 .*decreased/);
  assert.match(out.warnings.join(' '), /not a per-pixel change map/);
  assert.deepEqual(out.evidence, []); // no fabricated boxes
});

// --- co-registration assessment ----------------------------------------
test('co-registration assessment grades CRS / grid / footprint agreement', () => {
  const base = { crs: 'EPSG:4326', bounds: [72, 18, 73, 19], width: 768, height: 768, resolution: 10 };
  assert.equal(assessCoRegistration(base, { ...base }).status, 'co-registered');
  assert.equal(assessCoRegistration(base, { ...base, crs: 'EPSG:32643' }).status, 'incompatible');
  assert.equal(assessCoRegistration(base, { ...base, bounds: [72.5, 18.5, 73.5, 19.5], width: 512, height: 512 }).status, 'overlap-only');
});

// --- query classification --------------------------------------------
test('classifyTask exposes the signals behind a routing decision', () => {
  const c = classifyTask('What changed between 2021 and 2024, and where?', 2);
  assert.equal(c.task, 'change_vqa');
  assert.ok(c.signals.includes('temporal-change'));
  assert.ok(c.confidence > 0.5);
});

// --- orchestrator end to end (measurement path, no network) -----------
test('orchestrate runs the measurement path and returns an auditable execution summary', async () => {
  const payload = {
    query: 'Describe the land-cover in this image.',
    task: 'captioning',
    observations: [s2('scene', [0.08, 0.10, 0.10, 0.40, 0.20, 0.15, 5, 1])],
  };
  const res = await orchestrate(payload, false);
  assert.ok(res.answer.length > 0);
  assert.equal(res.executionSummary.task, 'captioning');
  assert.ok(res.executionSummary.tools.some(t => t.id === 'bigearthnet-scene-descriptor'));
  assert.ok(res.trace.some(t => t.tool === 'Execution Summary'));
  assert.ok(res.trace.some(t => /Tool Registry Selector/.test(t.tool)));
  assert.ok(res.confidence === null || (res.confidence >= 0 && res.confidence <= 0.6));
});

test('orchestrate change request assesses the pair and labels the task', async () => {
  const payload = {
    query: 'Has the built-up area increased, decreased, or remained unchanged?',
    task: 'change_vqa',
    observations: [
      s2('t1', [0.08, 0.10, 0.10, 0.40, 0.20, 0.15, 5, 1]),
      { ...s2('t2', [0.08, 0.10, 0.20, 0.20, 0.30, 0.20, 5, 1]), date: '2025-01-01' },
    ],
  };
  const res = await orchestrate(payload, false);
  assert.equal(res.executionSummary.task, 'change_vqa');
  assert.equal(res.spatialMetrics.coRegistration, 'co-registered');
  assert.ok(res.executionSummary.tools.some(t => t.id === 'co-registration-assessor'));
});
