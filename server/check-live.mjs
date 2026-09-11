import {fromArrayBuffer} from 'geotiff';
const base='http://127.0.0.1:5173';
const bounds=[72.79,18.90,72.88,18.98];
console.log('Local status:',await (await fetch(base+'/api/status')).json());
const search=await fetch(base+'/api/sentinel/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bounds,collections:['sentinel-2-l2a','sentinel-1-grd'],mode:'latest'}),signal:AbortSignal.timeout(180000)});
const result=await search.json(); if(!search.ok) throw new Error(result.error);
console.log('Latest catalogue:',result.scenes.map(s=>({collection:s.collection,date:s.date})),result.message);
for(const collection of ['sentinel-2-l2a','sentinel-1-grd']) {
  const scene=result.scenes.find(s=>s.collection===collection); if(!scene) throw new Error('No scene for '+collection);
  const response=await fetch(base+'/api/sentinel/raster',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scene,bounds}),signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw new Error(JSON.stringify(await response.json()));
  const image=await (await fromArrayBuffer(await response.arrayBuffer())).getImage();
  const mask=await image.readRasters({samples:[image.getSamplesPerPixel()-1],width:32,height:32});
  console.log('Raster verified:',collection,image.getWidth(),image.getHeight(),'bands',image.getSamplesPerPixel(),'valid mask samples',Array.from(mask[0]).filter(x=>Number(x)>0).length);
}
