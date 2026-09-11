import type { Bounds, CatalogScene, SearchRequest, SearchResult } from '../src/types/workspace.ts';
export const COLLECTIONS = ['sentinel-2-l2a', 'sentinel-1-grd'];
export function validateSearch(input: SearchRequest) {
  if (!Array.isArray(input.bounds) || input.bounds.length !== 4 || !input.bounds.every(Number.isFinite)) throw new Error('Enter four valid AOI coordinates.');
  const [w, s, e, n] = input.bounds;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) throw new Error('AOI must be west, south, east, north, without crossing the antimeridian.');
  if (e - w > 2 || n - s > 2) throw new Error('Select an AOI smaller than 2° on each side.');
  if (!Array.isArray(input.collections) || !input.collections.length || input.collections.length > 2 || input.collections.some(c => !COLLECTIONS.includes(c))) throw new Error('Select Sentinel-1 SAR or Sentinel-2 multispectral.');
  if (!['latest', 'range'].includes(input.mode)) throw new Error('Invalid date mode.');
  if (input.mode === 'range' && (!validDate(input.start) || !validDate(input.end) || input.start! > input.end!)) throw new Error('Choose a valid date range, with start on or before end.');
}
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function selectDates(dates: string[], mode: 'latest' | 'range', start?: string, end?: string) {
  const sorted = [...new Set(dates.filter(validDate))].sort();
  if (mode === 'latest') return { dates: sorted.slice(-1), fallback: false };
  const inRange = sorted.filter(d => d >= start! && d <= end!);
  if (inRange.length) return { dates: inRange.reverse(), fallback: false };
  const before = sorted.filter(d => d < start!).at(-1);
  const after = sorted.find(d => d > end!);
  return { dates: [before, after].filter((d): d is string => !!d).sort((a, b) => Math.min(Math.abs(Date.parse(a) - Date.parse(start!)), Math.abs(Date.parse(a) - Date.parse(end!))) - Math.min(Math.abs(Date.parse(b) - Date.parse(start!)), Math.abs(Date.parse(b) - Date.parse(end!)))), fallback: true };
}

type CatalogPost = (payload: Record<string, unknown>) => Promise<{ features: unknown[]; context?: { next?: number } }>;
export async function searchCatalog(input: SearchRequest, post: CatalogPost): Promise<SearchResult> {
  validateSearch(input);
  const scenes: CatalogScene[] = []; let fallback = false; let truncated = false;
  const perCollection = await Promise.all(input.collections.map(async collection => {
    // Search the requested interval first, not the entire archive on every click.
    const now = new Date();
    async function availableDates(from: string, to: string) {
    const dates: string[] = []; let next: number | undefined;
    for (let page = 0; page < 100; page++) {
      const data = await post({ bbox: input.bounds, collections: [collection], datetime: `${from}/${to}`, distinct: 'date', limit: 100, ...(next !== undefined ? { next } : {}) });
      if (!Array.isArray(data.features) || data.features.some(v => !validDate(v))) throw new Error('Unexpected catalogue date response. Availability could not be verified.');
      dates.push(...data.features as string[]);
      const cursor = data.context?.next;
      if (cursor === undefined || cursor === null) break;
      if (cursor === next || page === 99) throw new Error('Catalogue pagination did not complete. Narrow the AOI and retry; nearest/latest dates have not been verified.');
      next = cursor;
    }
    return dates;
    }
    let dates = await availableDates(input.mode === 'latest' ? new Date(now.getTime() - 30 * 86400000).toISOString() : `${input.start}T00:00:00Z`, input.mode === 'latest' ? now.toISOString() : `${input.end}T23:59:59.999Z`);
    if (!dates.length) dates = await availableDates('2014-01-01T00:00:00Z', now.toISOString());
    const selected = selectDates(dates, input.mode, input.start, input.end);
    return { collection, ...selected };
  }));
  for (const group of perCollection) {
    fallback ||= group.fallback;
    if (group.dates.length > 12) truncated = true;
    for (const date of group.dates.slice(0, 12)) {
      const data = await post({ bbox: input.bounds, collections: [group.collection], datetime: `${date}T00:00:00Z/${date}T23:59:59.999Z`, limit: 100 });
      if (data.context?.next != null) truncated = true;
      for (const feature of data.features) {
        const f = feature as { id: string; bbox: Bounds; properties: { datetime: string; 'eo:cloud_cover'?: number } };
        if (!f.id || !f.properties?.datetime) continue;
        scenes.push({ id: f.id, collection: group.collection, date: f.properties.datetime, bounds: f.bbox, cloudCover: f.properties['eo:cloud_cover'] });
      }
    }
  }
  scenes.sort((a, b) => b.date.localeCompare(a.date));
  return { scenes, fallback, truncated, message: !scenes.length ? 'No acquisitions found for this AOI in the catalogue since 2014.' : fallback ? 'One or more sensors have no acquisitions in this range. The closest available date before and after the range is shown for those sensors; choose explicitly to load.' : input.mode === 'latest' ? 'Latest available acquisition date for each selected sensor.' : 'Available acquisitions inside your requested dates.' };
}
