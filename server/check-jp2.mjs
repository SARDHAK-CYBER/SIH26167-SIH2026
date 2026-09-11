
import { readObservation } from '../src/services/observationReader.ts';
import { readFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { python } from './jp2.ts';
const dir = await mkdtemp(join(tmpdir(),'satquery-upload-check-')); const input=join(dir,'sample.jp2');
try {
await promisify(execFile)(python,['-c',`import sys, numpy as np, rasterio
from rasterio.transform import from_origin
with rasterio.open(sys.argv[1],'w',driver='JP2OpenJPEG',width=16,height=16,count=1,dtype='uint16',crs='EPSG:32643',transform=from_origin(500000,2100000,10,10),REVERSIBLE='YES',QUALITY=100) as dst:
 dst.write(np.full((1,16,16),12000,dtype=np.uint16))`,input],{windowsHide:true});
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>nativeFetch(typeof url==='string'&&url.startsWith('/')?'http://127.0.0.1:5173'+url:url,options);
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}}),toDataURL:()=> 'canvas-preview'})};
const observation=await readObservation(new File([await readFile(input)],'sentinel-band.jp2'),'multispectral','2026-09-08','');
console.log('JP2 upload through Vite proxy verified:',{width:observation.width,height:observation.height,crs:observation.crs,resolution:observation.resolution,mean:observation.stats[0].mean,originalFilename:observation.file.name});
if(observation.crs!=='EPSG:32643'||observation.stats[0].mean!==12000||observation.resolution!==10) throw new Error('JP2 metadata mismatch');
} finally {await unlink(input).catch(()=>{});await unlink(input+'.aux.xml').catch(()=>{});await rmdir(dir).catch(()=>{});}

