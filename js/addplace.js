// Adding a place of your own: from a Google Maps share, a pasted link, a
// pair of coordinates or just a name. No DOM in here.

import { REGION_BOX } from './config.js';

// Where Google Maps links keep coordinates, most exact first. "!3d…!4d…" is
// the pin itself; "@…" is only the middle of the screen that was showing.
const COORDS = [
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
  /[?&](?:q|ll|query|destination|center)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/,
  /\/place\/[^/]+\/(-?\d+\.\d+),(-?\d+\.\d+)/,
  /@(-?\d+\.\d+),(-?\d+\.\d+)/,
  /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/m,
];

const valid = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);

// Shared text looks like "Pot Rocks\nhttps://maps.app.goo.gl/abc". Returns
// { name, url, lat, lng, query } with whatever could be worked out.
export function parseShared(text) {
  const raw = String(text || '').trim();
  const url = (raw.match(/https?:\/\/\S+/g) || []).pop() || '';
  const lines = raw.split(/\n+/).map(l => l.trim()).filter(l => l && !/^https?:\/\//.test(l));
  let name = (lines[0] || '').replace(/https?:\/\/\S+/g, '').trim();
  let query = '';

  // …/maps/place/Kilgore+Falls,+Pylesville,+MD/… carries the name and often the address
  const segment = url.match(/\/maps\/place\/([^/@?]+)/);
  if (segment) {
    let decoded = segment[1].replace(/\+/g, ' ');
    try { decoded = decodeURIComponent(decoded); } catch { /* keep as is */ }
    if (!/^-?\d+\.\d+,/.test(decoded)) {
      query = decoded;
      if (!name) name = decoded.split(',')[0].trim();
    }
  }

  let lat, lng;
  for (const re of COORDS) {
    const m = (url + '\n' + raw).match(re);
    if (m && valid(+m[1], +m[2])) { lat = +m[1]; lng = +m[2]; break; }
  }
  if (lat !== undefined && /^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(name)) name = '';
  return { name, url, lat, lng, query: query || name };
}

async function geocode(q, bounded) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us' +
    (bounded ? `&bounded=1&viewbox=${REGION_BOX.join(',')}` : '') + `&q=${encodeURIComponent(q)}`;
  const hits = await (await fetch(url)).json();
  return hits[0] && valid(+hits[0].lat, +hits[0].lon) ? { lat: +hits[0].lat, lng: +hits[0].lon } : null;
}

// Finds coordinates for a draft that has none. Looks inside the covered
// region first, so "Cascade Falls" means the one in Maryland. Returns true
// when the draft now has a location. A place is never saved without one:
// that is how the old app ended up with pins "5,000 miles away" at 0°, 0°.
export async function locate(draft) {
  if (valid(draft.lat, draft.lng)) return true;
  const tries = [...new Set([draft.query, draft.name].filter(Boolean))];
  for (const bounded of [true, false]) {
    for (const q of tries) {
      try {
        const hit = await geocode(q, bounded);
        if (hit) { draft.lat = hit.lat; draft.lng = hit.lng; draft.guessed = true; return true; }
      } catch { return false; }
    }
  }
  return false;
}

export function placeFromDraft(draft, type, taken) {
  const base = 'user:' + (draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'place');
  let id = base, n = 2;
  while (taken(id)) id = base + '_' + n++;
  return {
    id, name: draft.name, type, tags: [type],
    lat: +draft.lat.toFixed(5), lng: +draft.lng.toFixed(5),
    url: draft.url || '',
  };
}

export { valid as validCoords };
