// Location resolution for the Sentinel AOI picker.
//
// Two inputs are supported:
//   1. A free-text place name  -> OpenStreetMap Nominatim forward search.
//   2. A single "latitude, longitude" pair -> a square AOI of `radiusKm`
//      (default 3 km) built around that point, with an optional reverse-geocoded
//      label. No coordinates are hard-coded; everything comes from the query or
//      a free, key-less API.

export interface LocationMatch {
  name: string;
  latitude: number;
  longitude: number;
  bounds: [number, number, number, number]; // [west, south, east, north] in EPSG:4326
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const UA = 'SatQueryAI/1.0 (open-source remote-sensing workspace)';
const KM_PER_DEG_LAT = 111.32;
const round6 = (v: number) => Number(v.toFixed(6));

/** Parse "lat, lon" / "lat lon" / "lat;lon". Returns null if it is not a coordinate pair. */
export function parseLatLon(query: string): { lat: number; lon: number } | null {
  const m = query.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[ ,;]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  let lat = Number(m[1]);
  let lon = Number(m[2]);
  // Tolerate "lon, lat" when it is the only interpretation that is in range.
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) { const t = lat; lat = lon; lon = t; }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Square-ish AOI of `radiusKm` half-extent around a point, clamped to valid lat/lon. */
export function boxFromCenter(lat: number, lon: number, radiusKm: number): [number, number, number, number] {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const dLon = radiusKm / (KM_PER_DEG_LAT * cosLat);
  return [
    round6(Math.max(-180, lon - dLon)),
    round6(Math.max(-90, lat - dLat)),
    round6(Math.min(180, lon + dLon)),
    round6(Math.min(90, lat + dLat)),
  ];
}

/** Shrink a box around its centre so neither side exceeds `maxDeg` (keeps AOI under the catalogue's 2° limit). */
export function clampBoxSpan(box: [number, number, number, number], maxDeg: number): [number, number, number, number] {
  const [w, s, e, n] = box;
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const halfW = Math.min((e - w) / 2, maxDeg / 2);
  const halfH = Math.min((n - s) / 2, maxDeg / 2);
  return [round6(cx - halfW), round6(cy - halfH), round6(cx + halfW), round6(cy + halfH)];
}

async function reverseName(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=12&lat=${lat}&lon=${lon}`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json() as { display_name?: string };
      if (data.display_name) return data.display_name;
    }
  } catch { /* offline / rate-limited: fall through to the plain coordinate label */ }
  return `${round6(lat)}, ${round6(lon)}`;
}

async function forwardSearch(query: string, radiusKm: number): Promise<LocationMatch[]> {
  const res = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Location service did not respond. Try a more specific place name, or enter "latitude, longitude".');
  const items = await res.json() as Array<{ display_name?: string; boundingbox?: string[]; lat?: string; lon?: string }>;
  return items.flatMap(item => {
    const lat = Number(item.lat), lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const bb = item.boundingbox?.map(Number); // Nominatim order: south, north, west, east
    const radiusBox = boxFromCenter(lat, lon, radiusKm);
    let bounds = radiusBox;
    if (bb && bb.length === 4 && bb.every(Number.isFinite)) {
      const [south, north, west, east] = bb;
      const osmBox: [number, number, number, number] = [west, south, east, north];
      // Use the OSM extent only when it is larger than the radius AOI (a city / region);
      // otherwise a point-like result gets the fixed radiusKm box.
      const wider = (east - west) > (radiusBox[2] - radiusBox[0]) || (north - south) > (radiusBox[3] - radiusBox[1]);
      if (wider) bounds = clampBoxSpan(osmBox, 1.8);
    }
    return [{ name: item.display_name || query, latitude: lat, longitude: lon, bounds }];
  });
}

export async function resolveLocation(query: string, radiusKm = 3): Promise<LocationMatch[]> {
  const coord = parseLatLon(query);
  if (coord) {
    return [{
      name: await reverseName(coord.lat, coord.lon),
      latitude: coord.lat,
      longitude: coord.lon,
      bounds: boxFromCenter(coord.lat, coord.lon, radiusKm),
    }];
  }
  const matches = await forwardSearch(query, radiusKm);
  if (!matches.length) throw new Error('No matching location was found. Try adding a state and country, or enter "latitude, longitude".');
  return matches;
}
