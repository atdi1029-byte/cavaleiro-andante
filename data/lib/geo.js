// Geography helpers for the build: which state a point is in, the nearest
// town, and name matching.

const fs = require('fs');
const path = require('path');
const { miles } = require('../region');

// ── States (point in polygon) ───────────────────────────────
// states.json: { MD: [ polygon: [ ring: [lng, lat, lng, lat, …], … ], … ], … }
const STATES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'states.json'), 'utf8'));

function inRing(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function stateAt(lat, lng) {
  return stateExactly(lat, lng) || stateNearby(lat, lng);
}

// The outlines stop at the shoreline, so a lighthouse, a pier or a point on
// an island's beach can fall just outside. Look a little way around it.
function stateNearby(lat, lng) {
  for (const reach of [0.02, 0.05, 0.1]) {
    for (const [dy, dx] of [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [1, 1], [-1, -1], [-1, 1]]) {
      const hit = stateExactly(lat + dy * reach, lng + dx * reach);
      if (hit) return hit;
    }
  }
  return null;
}

function stateExactly(lat, lng) {
  for (const [code, polygons] of Object.entries(STATES)) {
    for (const rings of polygons) {
      // Even-odd over the outer ring and its holes
      let inside = false;
      for (const ring of rings) if (inRing(ring, lng, lat)) inside = !inside;
      if (inside) return code;
    }
  }
  return null;
}

// ── Towns ───────────────────────────────────────────────────
// A coarse grid keeps "nearest town" fast for thousands of places.
function townIndex(towns) {
  const CELL = 0.2;
  const grid = new Map();
  const key = (lat, lng) => Math.floor(lat / CELL) + ':' + Math.floor(lng / CELL);
  for (const t of towns) {
    const k = key(t.lat, t.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
  }
  // Real towns win over hamlets unless the hamlet is much closer
  const WEIGHT = { city: 0.6, town: 0.7, village: 1, hamlet: 1.6 };
  return function nearest(lat, lng) {
    let best = null, bestScore = Infinity;
    const cy = Math.floor(lat / CELL), cx = Math.floor(lng / CELL);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const t of grid.get((cy + dy) + ':' + (cx + dx)) || []) {
        const d = miles(lat, lng, t.lat, t.lng);
        const score = d * (WEIGHT[t.kind] || 1);
        if (score < bestScore) { bestScore = score; best = { ...t, miles: d }; }
      }
    }
    return best;
  };
}

// ── Names ───────────────────────────────────────────────────
const STOP = new Set(['the', 'of', 'at', 'and', 'in', 'on', 'a', 'to', 'for', 'by']);
// Words that describe the kind of place rather than name it
const GENERIC = new Set(['park', 'state', 'national', 'trail', 'trails', 'area', 'natural', 'nature', 'preserve',
  'recreation', 'county', 'regional', 'memorial', 'site', 'historic', 'historical', 'center', 'loop', 'overlook',
  'falls', 'mountain', 'lake', 'beach', 'point', 'island', 'river', 'creek', 'forest', 'wildlife', 'refuge',
  'sanctuary', 'management', 'resources', 'environmental', 'environment', 'ruins', 'old', 'hike', 'circuit', 'summit', 'scenic',
  'museum', 'house', 'visitor']);

function tokens(name) {
  return String(name).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/['’`.]/g, '')
    .replace(/\bmt\b/g, 'mount').replace(/\bst\b/g, 'saint').replace(/\bft\b/g, 'fort').replace(/\bpa\b/g, 'pennsylvania')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(w => w && !STOP.has(w));
}

function norm(name) { return tokens(name).join(' '); }
function slug(name) { return tokens(name).join('').slice(0, 40); }

// 0..1: how likely two names mean the same place. The distinctive words
// ("catoctin", "kilgore") must agree; shared generic words ("state park")
// are not enough on their own.
function nameMatch(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  const da = ta.filter(w => !GENERIC.has(w)), db = tb.filter(w => !GENERIC.has(w));
  if (!da.length || !db.length) return 0;
  const sb = new Set(db), sa = new Set(da);
  const shared = da.filter(w => sb.has(w)).length;
  if (!shared) return 0;
  const distinct = shared / Math.max(sa.size, sb.size);     // every distinctive word agrees → 1
  const contained = shared / Math.min(sa.size, sb.size);    // one name's words are all in the other → 1
  // Generic words still matter a little: "Cunningham Falls" vs "Cunningham Falls State Park"
  const ga = new Set(ta), gb = new Set(tb);
  const all = [...ga].filter(w => gb.has(w)).length / Math.max(ga.size, gb.size);
  return Math.max(distinct * 0.75 + all * 0.25, contained * 0.8);
}

// True when two names share exactly the same distinctive words:
// "Merkle Wildlife Sanctuary" and "Merkle Natural Resources Management Area"
// do; "Soldiers Delight" and "Soldiers Delight Choate Chrome Mine" do not.
function sameCore(a, b) {
  const core = n => [...new Set(tokens(n).filter(w => !GENERIC.has(w)))].sort().join(' ');
  return core(a) !== '' && core(a) === core(b);
}

// True when one name's distinctive words are all found in the other's:
// "Fort Miles" and "Fort Miles Museum (Battery 519)". One shared word is not
// enough ("National Aquarium" is not "Harbor Wetland at the National Aquarium").
function coreInside(a, b) {
  const core = n => new Set(tokens(n).filter(w => !GENERIC.has(w)));
  const x = core(a), y = core(b);
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return small.size >= 2 && [...small].every(w => big.has(w));
}

// Share of distinctive words two names have in common (0..1)
function coreOverlap(a, b) {
  const core = n => new Set(tokens(n).filter(w => !GENERIC.has(w)));
  const x = core(a), y = core(b);
  const both = [...x].filter(w => y.has(w)).length;
  return both / (x.size + y.size - both || 1);
}

module.exports = { stateAt, townIndex, tokens, norm, slug, nameMatch, sameCore, coreInside, coreOverlap, miles };
