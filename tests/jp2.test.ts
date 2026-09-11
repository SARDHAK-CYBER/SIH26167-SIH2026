import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fromArrayBuffer } from 'geotiff';
import { decodeJP2, isJP2, python, pythonUsable } from '../server/jp2.ts';
test('JP2 signature validation rejects renamed text and ZIP archives', async () => {
  assert.equal(isJP2(Buffer.from('not-a-jp2-file')), false);
  await assert.rejects(decodeJP2(Buffer.from('PK-not-a-jp2')), /not a valid JP2/);
});
test('real 16-bit JP2 decoding preserves raw values and georeferencing', { skip: !pythonUsable() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'satquery-jp2-test-')); const input = join(dir, 'fixture.jp2');
  try {
    await promisify(execFile)(python, ['-c', `import sys, numpy as np, rasterio
from rasterio.transform import from_origin
with rasterio.open(sys.argv[1], 'w', driver='JP2OpenJPEG', width=4, height=4, count=1, dtype='uint16', crs='EPSG:32643', transform=from_origin(500000,2100000,10,10), REVERSIBLE='YES', QUALITY=100) as dst:
 dst.write(np.arange(1000,17000,1000,dtype=np.uint16).reshape(1,4,4))`, input], { windowsHide: true });
    const bytes = await readFile(input); assert.equal(isJP2(bytes), true);
    const { tiff, metadata } = await decodeJP2(bytes);
    assert.deepEqual(metadata, { width: 4, height: 4, bands: 1, sampled: false });
    const raster = await (await fromArrayBuffer(Uint8Array.from(tiff).buffer)).getImage();
    assert.equal(raster.getGeoKeys()?.ProjectedCSTypeGeoKey, 32643);
    assert.deepEqual(raster.getBoundingBox(), [500000,2099960,500040,2100000]);
    const values = await raster.readRasters(); assert.equal(Number(values[0][0]), 1000); assert.equal(Number(values[0][15]), 16000);
  } finally { await unlink(input).catch(() => {}); await unlink(input + '.aux.xml').catch(() => {}); await rmdir(dir).catch(() => {}); }
});
