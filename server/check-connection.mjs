import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const c = parseEnv(readFileSync('.env','utf8'));
try {
  const auth = await fetch('https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:c.SENTINEL_CLIENT_ID,client_secret:c.SENTINEL_CLIENT_SECRET}),signal:AbortSignal.timeout(30000)});
  console.log('OAuth HTTP status:',auth.status);
  const authData=await auth.json();
  if(!auth.ok) { console.log('OAuth error code:',authData.error || 'unknown'); process.exit(1); }
  const end = new Date(); const start = new Date(end.getTime()-30*86400000);
  const response=await fetch('https://sh.dataspace.copernicus.eu/catalog/v1/search',{method:'POST',headers:{Authorization:'Bearer '+authData.access_token,'Content-Type':'application/json'},body:JSON.stringify({bbox:[72.79,18.90,72.88,18.98],collections:['sentinel-2-l2a'],datetime:start.toISOString()+'/'+end.toISOString(),distinct:'date',limit:100}),signal:AbortSignal.timeout(60000)});
  console.log('Catalogue HTTP status:',response.status);
  const data=await response.json();
  console.log(JSON.stringify(response.ok?{featureType:typeof data.features?.[0],dates:data.features?.slice(0,3),next:data.context?.next}:{error:data.error},null,2));
} catch (error) { console.log('Connection error:',error.message, error.cause?.code || ''); process.exit(1); }
