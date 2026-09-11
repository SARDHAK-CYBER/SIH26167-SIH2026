import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from './config.ts';
const execFileAsync = promisify(execFile);
export const python = join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

/**
 * True only when the pinned interpreter exists AND its Rasterio import works.
 * A `.venv` created on another machine leaves a launcher whose base Python is
 * gone; `existsSync(python)` alone would wrongly report it as usable.
 */
export function pythonUsable(): boolean {
  if (!existsSync(python)) return false;
  try {
    return spawnSync(python, ['-c', 'import rasterio'], { windowsHide: true, timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
}
export function isJP2(data: Buffer) { return data.length >= 12 && (data.subarray(0, 12).equals(Buffer.from([0,0,0,12,106,80,32,32,13,10,135,10])) || (data[0] === 0xff && data[1] === 0x4f && data[2] === 0xff && data[3] === 0x51)); }
export async function decodeJP2(data: Buffer) {
  if (!isJP2(data)) throw new Error('The file is not a valid JP2/JPEG2000 image. Unzip the Sentinel product and choose a .jp2 image.');
  if (!existsSync(python)) throw new Error('JP2 decoder is not installed. Run npm run setup:jp2 from the project folder.');
  const dir = await mkdtemp(join(tmpdir(), 'satquery-jp2-'));
  const input = join(dir, 'input.jp2'), output = join(dir, 'preview.tif');
  try {
    await writeFile(input, data);
    const { stdout } = await execFileAsync(python, [join(projectRoot, 'server/jp2_preview.py'), input, output], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    return { tiff: await readFile(output), metadata: JSON.parse(stdout.trim()) as { width: number; height: number; bands: number; sampled: boolean } };
  } catch { throw new Error('JP2 decoding failed. Check that the file is a valid JPEG2000 image and run npm run setup:jp2 if the decoder is missing.'); }
  finally { await unlink(input).catch(() => {}); await unlink(output).catch(() => {}); await unlink(input + '.aux.xml').catch(() => {}); await rmdir(dir).catch(() => {}); }
}
