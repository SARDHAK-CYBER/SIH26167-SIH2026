import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLatLon, boxFromCenter, clampBoxSpan, resolveLocation } from '../server/geocode.ts';

test('parseLatLon accepts "lat, lon" / "lat lon" and rejects names & out-of-range', () => {
  assert.deepEqual(parseLatLon('19.076, 72.877'), { lat: 19.076, lon: 72.877 });
  assert.deepEqual(parseLatLon('-33.87  151.21'), { lat: -33.87, lon: 151.21 });
  assert.deepEqual(parseLatLon('48.8566;2.3522'), { lat: 48.8566, lon: 2.3522 });
  assert.equal(parseLatLon('Mumbai, India'), null);
  assert.equal(parseLatLon('500, 10'), null);
});

test('boxFromCenter builds a ~3 km-radius AOI and widens longitude with latitude', () => {
  const eq = boxFromCenter(0, 0, 3);
  assert.ok(Math.abs((eq[3] - eq[1]) - 0.0539) < 1e-3, 'lat span ~= 2 * 3/111.32 deg');
  assert.ok(Math.abs((eq[2] - eq[0]) - 0.0539) < 1e-3, 'lon span ~= lat span at the equator');

  const high = boxFromCenter(60, 10, 3);
  assert.ok(Math.abs((high[3] - high[1]) - 0.0539) < 1e-3, 'lat span is latitude-independent');
  assert.ok((high[2] - high[0]) > 0.10, 'lon span roughly doubles at 60° N');

  const radius10 = boxFromCenter(0, 0, 10);
  assert.ok((radius10[2] - radius10[0]) > (eq[2] - eq[0]), 'a larger radiusKm gives a larger box');
});

test('clampBoxSpan shrinks a large box around its centre', () => {
  assert.deepEqual(clampBoxSpan([0, 0, 3, 3], 1.8), [0.6, 0.6, 2.4, 2.4]);
  assert.deepEqual(clampBoxSpan([10, 10, 10.02, 10.02], 1.8), [10, 10, 10.02, 10.02]); // already small
});

test('resolveLocation turns a single coordinate into a 3 km AOI (no hard-coded places)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ display_name: 'Reverse-geocoded label' }) });
  try {
    const [match] = await resolveLocation('12.9716, 77.5946', 3);
    assert.equal(match.latitude, 12.9716);
    assert.equal(match.longitude, 77.5946);
    assert.equal(match.name, 'Reverse-geocoded label');
    assert.ok(Math.abs((match.bounds[3] - match.bounds[1]) - 0.0539) < 1e-3);
  } finally { globalThis.fetch = realFetch; }
});

test('resolveLocation uses the OSM extent for a city but the radius box for a point', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes('/search')
      ? [
          { lat: '19', lon: '72', display_name: 'Big City', boundingbox: ['18.2', '19.8', '71.2', '72.8'] },
          { lat: '1', lon: '1', display_name: 'Tiny POI', boundingbox: ['0.999', '1.001', '0.999', '1.001'] },
        ]
      : { display_name: 'unused' },
  });
  try {
    const [city, poi] = await resolveLocation('somewhere', 3);
    assert.ok((city.bounds[2] - city.bounds[0]) > 1 && (city.bounds[2] - city.bounds[0]) <= 1.8, 'city keeps (clamped) OSM extent');
    assert.ok(Math.abs((poi.bounds[3] - poi.bounds[1]) - 0.0539) < 1e-3, 'point-like result gets the 3 km box');
  } finally { globalThis.fetch = realFetch; }
});

test('resolveLocation rejects an unresolvable name', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    await assert.rejects(resolveLocation('asdkjhaskdjh', 3), /No matching location/);
  } finally { globalThis.fetch = realFetch; }
});
