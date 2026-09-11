import test from 'node:test';
import assert from 'node:assert/strict';
import { writeArrayBuffer } from 'geotiff';
import { readObservation } from '../src/services/observationReader.ts';
// Only the canvas renderer is stubbed. GeoTIFF encoding, decoding, tags and statistics are real.
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {}, drawImage: () => {} }), toDataURL: () => 'canvas-preview' }) };
test('decode a real GeoTIFF and preserve its measured values and EPSG', async () => {
  const buffer = writeArrayBuffer([10, 20, 30, 40], { width: 2, height: 2, GeographicTypeGeoKey: 4326, ModelPixelScale: [0.01, 0.01, 0], ModelTiepoint: [0, 0, 0, 72, 19, 0] });
  const result = await readObservation(new File([buffer], 'fixture.tif'), 'thermal', '2026-09-06', '');
  assert.equal(result.width, 2); assert.equal(result.height, 2); assert.equal(result.crs, 'EPSG:4326');
  assert.equal(result.stats[0].min, 10); assert.equal(result.stats[0].max, 40); assert.equal(result.stats[0].mean, 25);
  assert.equal(result.sensor, 'thermal'); assert.equal(result.resolution, undefined);
});
test('corrupt TIFF is rejected without a synthetic image or fabricated metadata', async () => {
  await assert.rejects(readObservation(new File(['not a raster'], 'broken.tiff'), 'optical', '', ''));
});
test('point clouds are rejected with conversion guidance', async () => {
  await assert.rejects(readObservation(new File(['bad'], 'test.laz'), 'lidar', '', ''), /point clouds/);
});

test('ordinary Sentinel JPEG/PNG inputs do not require a benchmark declaration', async () => {
  // Browser bitmap decode is stubbed; this verifies file admission and metadata handling.
  globalThis.createImageBitmap = async () => ({ width: 1024, height: 512, close() {} });
  for (const extension of ['jpg', 'jpeg', 'png']) {
    const result = await readObservation(new File(['browser-decoded fixture'], 'sentinel.' + extension), 'optical', '', '');
    assert.equal(result.width, 1024); assert.equal(result.height, 512); assert.equal(result.crs, undefined);
    assert.equal(result.benchmark, undefined); assert.match(result.warnings.join(' '), /no verified CRS/);
  }
});
