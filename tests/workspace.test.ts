import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDates, validateSearch, searchCatalog } from '../server/catalog.ts';
import { planFusion, routeTask } from '../src/services/fusionPlan.ts';
import type { Observation, SearchRequest } from '../src/types/workspace.ts';
const dates = ['2026-09-09', '2026-09-01', '2026-09-06', '2026-09-06'];
test('latest is chronological, independent of provider order and duplicates', () => assert.deepEqual(selectDates(dates, 'latest'), { dates: ['2026-09-09'], fallback: false }));
test('date ranges include both boundaries and do not substitute nearest dates', () => assert.deepEqual(selectDates(dates, 'range', '2026-09-01', '2026-09-06'), { dates: ['2026-09-06', '2026-09-01'], fallback: false }));
test('empty ranges return nearest dates on both sides, closest first', () => assert.deepEqual(selectDates(dates, 'range', '2026-09-04', '2026-09-04'), { dates: ['2026-09-06', '2026-09-01'], fallback: true }));
test('empty and one-sided catalogues are handled', () => { assert.deepEqual(selectDates([], 'latest').dates, []); assert.deepEqual(selectDates(dates, 'range', '2027-01-01', '2027-02-01').dates, ['2026-09-09']); });
const request: SearchRequest = { bounds: [72.79, 18.90, 72.88, 18.98], mode: 'latest', collections: ['sentinel-2-l2a'] };
test('reject invalid dates, coordinates, unbounded AOIs and unsupported providers', () => {
  assert.throws(() => validateSearch({ ...request, mode: 'range', start: '2026-02-30', end: '2026-03-03' }));
  assert.throws(() => validateSearch({ ...request, mode: 'range', start: '2026-09-10', end: '2026-09-01' }));
  assert.throws(() => validateSearch({ ...request, bounds: [73, 18, 72, 19] }));
  assert.throws(() => validateSearch({ ...request, bounds: [0, 0, 180, 90] }));
  assert.throws(() => validateSearch({ ...request, collections: ['lidar'] }));
});
test('catalogue follows pagination before deciding latest', async () => {
  const result = await searchCatalog(request, async payload => {
    if (payload.distinct && payload.next === undefined) return { features: ['2026-09-01'], context: { next: 1 } };
    if (payload.distinct) return { features: ['2026-09-09'] };
    assert.equal(payload.datetime, '2026-09-09T00:00:00Z/2026-09-09T23:59:59.999Z');
    return { features: [{ id: 'real-catalogue-id', bbox: request.bounds, properties: { datetime: '2026-09-09T09:00:00Z' } }] };
  });
  assert.equal(result.scenes[0].id, 'real-catalogue-id'); assert.equal(result.fallback, false);
});
test('repeating pagination fails rather than claiming latest is verified', async () => {
  await assert.rejects(searchCatalog(request, async () => ({ features: dates, context: { next: 1 } })), /pagination/);
});
function observation(id: string, sensor: Observation['sensor'], date: string): Observation { return { id, sensor, date, name: id, source: 'upload', preview: '', width: 2, height: 2, bands: 1, stats: [], warnings: [], crs: 'EPSG:4326', bounds: [72, 18, 73, 19] }; }
test('optical, SAR, thermal and LiDAR share fusion eligibility rules', () => {
  const inputs = [observation('a', 'optical', '2026-09-06'), observation('b', 'sar', '2026-09-09'), observation('c', 'thermal', '2026-09-03'), observation('d', 'lidar', '2026-08-01')];
  const plan = planFusion(inputs, '2026-09-06', 3); assert.equal(plan.ready, true); assert.equal(plan.eligible.length, 3); assert.equal(plan.candidates[3].eligible, false);
});
test('missing dates, unknown georeferencing, differing CRS and no common overlap block fusion', () => {
  const a = observation('a', 'optical', '2026-09-06'); const b = observation('b', 'sar', '2026-09-06');
  for (const bad of [{ ...b, date: '' }, { ...b, crs: undefined }, { ...b, crs: 'EPSG:32643' }, { ...b, bounds: [1, 1, 2, 2] as [number, number, number, number] }]) assert.equal(planFusion([a, bad], '2026-09-06', 3).ready, false);
});
test('same-day fusion accepts timestamps but never claims pixel registration', () => {
  const plan = planFusion([observation('a', 'optical', '2026-09-06T00:01:00Z'), observation('b', 'sar', '2026-09-06T23:59:00Z')], '2026-09-06', 0);
  assert.equal(plan.ready, true); assert.match(plan.alignment, /Pixel alignment/);
});
test('query routing does not force every paired scene into change analysis', () => { assert.equal(routeTask('Describe this scene', 2), 'captioning'); assert.equal(routeTask('Fuse thermal and LiDAR', 2), 'multisensor_fusion'); assert.equal(routeTask('What changed?', 1), 'change_vqa'); });
test('an empty requested interval falls back to archive dates on both sides', async () => {
  let dateRequests = 0;
  const result = await searchCatalog({ ...request, mode: 'range', start: '2026-09-04', end: '2026-09-04' }, async payload => {
    if (payload.distinct) {
      dateRequests++;
      if (dateRequests === 1) { assert.equal(payload.datetime, '2026-09-04T00:00:00Z/2026-09-04T23:59:59.999Z'); return { features: [] }; }
      assert.match(String(payload.datetime), /^2014-01-01/); return { features: ['2026-09-03', '2026-09-05'] };
    }
    const date = String(payload.datetime).slice(0, 10);
    return { features: [{ id: date, bbox: request.bounds, properties: { datetime: date + 'T12:00:00Z' } }] };
  });
  assert.equal(result.fallback, true); assert.equal(result.scenes.length, 2); assert.equal(dateRequests, 2);
});
