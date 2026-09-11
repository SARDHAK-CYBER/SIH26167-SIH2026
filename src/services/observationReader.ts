import { fromArrayBuffer } from 'geotiff';
import type { Observation, Sensor, BandStats, Bounds, SarProduct } from '../types/workspace';

function inferSarProduct(name: string, directory?: Record<string, unknown>): SarProduct | undefined {
  const source = `${name} ${JSON.stringify(directory || {})}`.toLowerCase();
  if (/single[ _-]?look|\bslc\b|complex/.test(source)) return 'slc';
  if (/ground[ _-]?range|\bgrd\b|detected/.test(source)) return 'grd';
  return undefined;
}

export async function readObservation(file: File, sensor: Sensor, date: string, benchmark: string, displayBands?: [number, number, number]): Promise<Observation> {
  const extension = file.name.toLowerCase().split('.').pop() || '';
  const tiff = /^(tif|tiff)$/i.test(extension);
  const jp2 = /\.(jp2|j2k|jpx)$/i.test(file.name);
  const visual = /^(png|jpe?g)$/i.test(extension);
  const pointCloud = /^(las|laz|ply|pcd|e57)$/i.test(extension);
  const container = /^(hdf|h5|nc|img|bil|bsq|bip|safe|zip)$/i.test(extension);
  if (pointCloud) throw new Error('LiDAR point clouds are not raster images. Convert LAS/LAZ/PLY/PCD/E57 to a georeferenced GeoTIFF height/intensity raster, then upload the raster.');
  if (container) throw new Error(`.${extension} is a sensor container or raw raster format and cannot be decoded in the browser. Export its calibrated/georeferenced bands as GeoTIFF (preserving CRS, nodata and band metadata) before upload.`);
  if (!tiff && !jp2 && !visual) throw new Error('Unsupported image format. Use a calibrated GeoTIFF/TIFF or JP2/JPEG2000. PNG/JPEG are accepted only as unreferenced visual images.');
  if (file.size > 128 * 1024 * 1024) throw new Error('This browser workspace accepts files up to 128 MB. Crop a smaller AOI first.');
  if (jp2) {
    let response: Response;
    try { response = await fetch('/api/raster/jp2', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: AbortSignal.timeout(150000) }); }
    catch { throw new Error('JP2 decoding needs the local API. Start both services with npm start and retry.'); }
    if (!response.ok) { let error = 'JP2 decoding failed. Start both services with npm start and run npm run setup:jp2 if needed.'; try { const data = await response.json(); error = data.error || error; } catch { /* Offline proxy response. */ } throw new Error(error); }
    if (!response.headers.get('content-type')?.includes('image/tiff')) throw new Error('The JP2 decoder did not return a raster. Run npm start from the project folder.');
    const metadata = JSON.parse(response.headers.get('X-Raster-Metadata') || '{}') as { width: number; height: number; bands: number; sampled: boolean };
    if (![metadata.width, metadata.height, metadata.bands].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('Invalid JP2 decoder metadata.');
    const previewFile = new File([await response.blob()], 'jp2-preview.tif', { type: 'image/tiff' });
    const observation = await readObservation(previewFile, sensor, date, benchmark, displayBands);
    return { ...observation, file, name: file.name, width: metadata.width, height: metadata.height, bands: metadata.bands,
      sarProduct: sensor === 'sar' ? inferSarProduct(file.name) : undefined,
      resolution: observation.resolution === undefined ? undefined : observation.resolution * observation.width / metadata.width,
      warnings: [...observation.warnings, 'JPEG2000 decoded by the local API. Original JP2 file retained for analysis; preview statistics are sampled.'] };
  }
  const observation: Observation = { id: crypto.randomUUID(), name: file.name, sensor, date, source: 'upload', preview: '', file, width: 0, height: 0, bands: 0, stats: [], benchmark: benchmark || undefined, warnings: [] };
  const canvas = document.createElement('canvas');
  if (tiff) {
    const raster = await fromArrayBuffer(await file.arrayBuffer());
    const image = await raster.getImage();
    observation.width = image.getWidth(); observation.height = image.getHeight(); observation.bands = image.getSamplesPerPixel();
    if (observation.bands > 256) throw new Error('More than 256 bands: select a smaller band subset before upload.');
    const keys = image.getGeoKeys();
    const epsg = keys?.ProjectedCSTypeGeoKey || keys?.GeographicTypeGeoKey;
    if (epsg && epsg !== 32767) observation.crs = `EPSG:${epsg}`;
    try { observation.bounds = image.getBoundingBox() as Bounds; } catch { observation.warnings.push('No geospatial transform found.'); }
    // Coordinate units are not necessarily metres; do not infer metric resolution from an arbitrary CRS.
    const directory = image.getFileDirectory();
    if (sensor === 'sar') observation.sarProduct = inferSarProduct(file.name, directory as unknown as Record<string, unknown>);
    if (keys?.ProjLinearUnitsGeoKey === 9001 || (Number(epsg) >= 32601 && Number(epsg) <= 32760)) {
      const scale = directory.getValue('ModelPixelScale');
      if (scale) observation.resolution = Number(scale[0]);
    }
    const ratio = Math.min(1, 768 / Math.max(observation.width, observation.height));
    canvas.width = Math.max(1, Math.round(observation.width * ratio)); canvas.height = Math.max(1, Math.round(observation.height * ratio));
    const nodata = image.getGDALNoData();
    const ctx = canvas.getContext('2d')!;
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    const requested = displayBands ?? (observation.bands < 3 ? [0, 0, 0] : [0, 1, 2]);
    const channels: [number, number, number] = requested.map((band) => {
      if (!Number.isInteger(band) || band < 0 || band >= observation.bands) {
        observation.warnings.push(`Requested preview band ${band + 1} is unavailable; band 1 was used instead.`);
        return 0;
      }
      return band;
    }) as [number, number, number];
    // Decode one band at a time to bound memory for hyperspectral inputs.
    for (let band = 0; band < observation.bands; band++) {
      const result = await image.readRasters({ samples: [band], width: canvas.width, height: canvas.height });
      const values = result[0]; let min = Infinity, max = -Infinity, sum = 0, valid = 0;
      for (let i = 0; i < values.length; i++) { const v = Number(values[i]); if (Number.isFinite(v) && v !== nodata) { min = Math.min(min, v); max = Math.max(max, v); sum += v; valid++; } }
      const stat: BandStats = { band: band + 1, min: valid ? min : 0, max: valid ? max : 0, mean: valid ? sum / valid : 0, validPixels: valid };
      observation.stats.push(stat);
      if (channels.includes(band)) for (let i = 0; i < values.length; i++) {
        const v = Number(values[i]); const scaled = Number.isFinite(v) && v !== nodata ? (max > min ? Math.round((v - min) / (max - min) * 255) : 127) : 0;
        for (let c = 0; c < 3; c++) if (channels[c] === band) pixels.data[i * 4 + c] = scaled;
        pixels.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    observation.preview = canvas.toDataURL('image/png');
    observation.warnings.push(`Preview uses a min–max stretch of bands ${channels.map(c => c + 1).join(', ')}. Physical calibration is not inferred. Statistics use a preview-sized sample.`);
  } else {
    const bitmap = await createImageBitmap(file);
    observation.width = bitmap.width; observation.height = bitmap.height; observation.bands = 3;
    const ratio = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    observation.preview = canvas.toDataURL('image/png');
    observation.warnings.push('JPEG/PNG visual image has no verified CRS, footprint or spectral calibration. It can be inspected but cannot establish spatial fusion compatibility.');
  }
  if (tiff || jp2) {
    const minimumBands = sensor === 'multispectral' ? 3 : sensor === 'hyperspectral' ? 4 : 1;
    if (observation.bands < minimumBands) observation.warnings.push(`${sensor} data usually contains at least ${minimumBands} bands; this file has ${observation.bands}. It will be inspected as a single/low-band raster, not assumed to be a complete sensor product.`);
    if (sensor === 'sar') {
      if (observation.sarProduct === 'slc') observation.warnings.push('SAR product identified as SLC (Single Look Complex). Values may be complex I/Q samples; amplitude, phase and coherence require SLC-aware processing and orbit/calibration metadata.');
      else if (observation.sarProduct === 'grd') observation.warnings.push('SAR product identified as GRD (Ground Range Detected). Values are detected ground-range measurements; confirm sigma-nought/gamma-nought calibration and polarization metadata before analysis.');
      else observation.warnings.push('SAR product could not be identified as SLC or GRD from the filename/metadata. Select or export a product with explicit SLC/GRD provenance.');
      if (observation.bands > 1) observation.warnings.push('SAR channel meaning (VV, VH, amplitude, intensity or coherence) was not inferred from band position. Verify the product metadata before polarimetric analysis.');
    }
    if (sensor === 'thermal') observation.warnings.push('Thermal values are reported as raw raster values. Apply the product-specific scale/offset and confirm whether the band is radiance, brightness temperature or surface temperature.');
    if (sensor === 'lidar') observation.warnings.push('LiDAR raster values are not assumed to be elevation, intensity or canopy height. Confirm the exported layer meaning and vertical units.');
    if (sensor === 'hyperspectral') observation.warnings.push('Hyperspectral wavelength metadata is not present in the generic raster contract. Band numbers are reported, but wavelength-based indices require a sidecar/product manifest.');
  }
  if (!observation.crs) observation.warnings.push('CRS is unknown; spatial fusion is unavailable until georeferencing is supplied.');
  if (!date) observation.warnings.push('Acquisition date was not supplied.');
  return observation;
}
