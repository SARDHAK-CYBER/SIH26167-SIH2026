import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWorkspace } from '../src/services/workspaceAnalysis.ts';
const image = id => ({ id, name: id, sensor: 'optical', date: '', source: 'upload', preview: '', width: 2, height: 2, bands: 1, stats: [], warnings: [] });
test('single-image questions use the selected image and report no invented model confidence', async () => {
  const result = await analyzeWorkspace('Describe this image', [image('first'), image('selected')], '2026-09-09', 3, false, new AbortController().signal, 'selected');
  assert.deepEqual(result.observationIds, ['selected']);
  assert.equal(result.confidence, null); assert.equal(result.mode, 'inspection'); assert.equal(result.findings.length, 1);
});
test('change queries never synthesize a missing temporal observation', async () => {
  await assert.rejects(analyzeWorkspace('What changed?', [image('single')], '2026-09-09', 3, false, new AbortController().signal), /exactly two/);
});
test('fusion questions block undated images rather than treating upload time as acquisition time', async () => {
  await assert.rejects(analyzeWorkspace('Fuse observations', [image('a'), { ...image('b'), sensor: 'sar' }], '2026-09-09', 3, false, new AbortController().signal), /dated observations/);
});
