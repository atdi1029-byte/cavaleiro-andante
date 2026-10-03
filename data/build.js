#!/usr/bin/env node
// Step 2 of the data pipeline: build places.json (what the app shows) from
//
//   data/raw/        OpenStreetMap sweep            (node data/sweep_osm.js)
//   data/curated/    hand-checked lists; these win over OpenStreetMap
//   data/legacy/     the pre-2026-10 place list, only so old ids keep working
//
//   node data/build.js            build
//   node data/build.js --offline  skip Wikipedia (use what is cached)
//
// Writes places.json, archive.json (old places that were dropped, so a saved
// one can still be shown) and prints a report. Nothing here is random: the
// same inputs give the same file.

const fs = require('fs');
const path = require('path');
const { HOME, inRegion, miles } = require('./region');
const geo = require('./lib/geo');
const osm = require('./lib/osm');
const wiki = require('./lib/wiki');

const ROOT = path.join(__dirname, '..');
const RAW = path.join(__dirname, 'raw');
const CURATED = path.join(__dirname, 'curated');
const offline = process.argv.includes('--offline');
const log = (...a) => console.log(...a);

const COVERED_STATES = new Set(['MD', 'DC', 'VA', 'WV', 'PA', 'DE']);
const TIER_Q = { 1: 92, 2: 76, 3: 60 };
const SEED_Q = 84;   // Alex's own list

// Families decide when two entries with similar names are the same place:
// "Cunningham Falls" (waterfall) must not swallow "Cunningham Falls State Park".
const FAMILY = {
  park: 'land', garden: 'land', camp: 'land',
  hike: 'trail', trail: 'trail', run: 'trail',
  waterfall: 'waterfall', viewpoint: 'view',
  beach: 'water', water: 'water', swim: 'water',
  gems: 'gem', caves: 'gem', historic: 'gem',
};

// ── Curated lists ───────────────────────────────────────────
const TYPE_MAP = { gem: 'gems', cave: 'caves' };
const TYPE_TAGS = {
  hike: ['hiking'], trail: ['hiking', 'trail'], park: ['park', 'nature'], garden: ['garden', 'nature'],
  waterfall: ['waterfall', 'water'], beach: ['beach', 'water', 'waterfront'], water: ['water', 'waterfront'],
  swim: ['swimming', 'water'], viewpoint: ['viewpoint', 'scenic'], gems: ['gems'], caves: ['cave', 'gems', 'geology'],
  run: ['running', 'trail'], camp: ['camping', 'nature'], historic: ['historic'],
};
// The rainy-day list says what kind of indoor or sheltered place each entry
// is; that decides its type in the app and the chips it appears under.
const RAINY_KIND = {
  cave:             ['caves',  ['cave', 'geology']],
  conservatory:     ['garden', ['conservatory', 'garden']],
  museum:           ['indoor', ['museum']],
  aquarium:         ['indoor', ['aquarium', 'museum']],
  interior:         ['indoor', ['interior']],
  market:           ['indoor', ['market']],
  'nature-center':  ['indoor', ['nature-center', 'nature']],
  fort:             ['gems',   ['fort', 'military', 'historic']],
  tunnel:           ['gems',   ['tunnel', 'historic']],
  'covered-bridge': ['gems',   ['bridge', 'covered', 'historic']],
  mill:             ['gems',   ['mill', 'historic']],
};
// Places from the other lists that are just as good in the rain
const RAINY_NAME = /conservatory|caverns\b|grottoes|aquarium|\bmuseum\b/i;

const ACCESS_NOTE = {
  view: 'You can only look at this one from outside (road, trail or water). The site itself is closed or fenced.',
  tour: 'Open by guided tour or by arrangement only. Check before you go.',
};

function loadCurated() {
  const out = [];
  if (!fs.existsSync(CURATED)) return out;
  for (const file of fs.readdirSync(CURATED).sort()) {
    if (!file.endsWith('.json')) continue;
    for (const c of JSON.parse(fs.readFileSync(path.join(CURATED, file), 'utf8'))) {
      const rainy = RAINY_KIND[c.kind];
      const type = rainy ? rainy[0] : TYPE_MAP[c.type] || c.type;
      const f = c.facts || {};
      const facts = {};
      if (f.length_mi || f.walk_mi) facts.len = f.length_mi || f.walk_mi;
      if (f.gain_ft) facts.gain = f.gain_ft;
      if (f.height_ft) facts.height = f.height_ft;
      if (f.fee) facts.fee = String(f.fee);
      if (f.dogs) facts.dogs = String(f.dogs);
      if (f.swim && f.swim !== 'yes') facts.swim = f.swim === 'no' ? 'Not allowed' : 'Unofficial';
      if (f.built) facts.built = f.built;
      if (f.abandoned) facts.abandoned = f.abandoned;
      if (ACCESS_NOTE[c.access]) facts.access = ACCESS_NOTE[c.access];
      if (f.hours) facts.hours = String(f.hours);
      if (f.reserve) facts.reserve = String(f.reserve);
      const tags = new Set([...(c.tags || []), ...(TYPE_TAGS[type] || [])]);
      if (rainy) {
        tags.add('rainy');
        rainy[1].forEach(t => tags.add(t));
        if (/^free/i.test(facts.fee || '')) tags.add('free');
      }
      if (f.swim === 'yes' || f.swim === 'unofficial') tags.add('swimming');
      out.push({
        id: c.id || null,
        name: String(c.name).trim(), type, tags: [...tags],
        lat: c.lat, lng: c.lng,
        town: c.town || null, st: c.state || null,
        q: c.id?.startsWith('seed:') ? SEED_Q : TIER_Q[c.tier] || 60,
        desc: (c.blurb || '').trim(), facts,
        url: c.url || null,
        curated: true, file,
      });
    }
  }
  return out;
}

// Two curated entries for the same place (Alex's list and a research list
// both have Calvert Cliffs): keep one, with the best of both.
//
// Alex's original list (ids "seed:…") was typed in with rough coordinates:
// 43 of its 73 places sat more than 0.7 miles from the real spot, Downs Park
// 2.9 miles, White Cliffs of Conoy 7.8. When a research list has the same
// place, its checked coordinates and write-up replace the rough ones, and
// the seed keeps its id so anything saved under it carries over.
const bare = name => name.replace(/\s*\([^)]*\)/g, '').trim();
// "Patapsco Valley State Park" must not be folded into "… - Hilton Area"
const subArea = (a, b) => [[a, b], [b, a]].some(([x, y]) => y.length > x.length && y.startsWith(x) && /^\s*[-–:]/.test(y.slice(x.length)));

function mergeCurated(list) {
  const kept = [];
  for (const c of list) {
    const twin = kept.find(k => {
      if (k.lat == null || c.lat == null) return geo.norm(bare(k.name)) === geo.norm(bare(c.name));
      const d = miles(k.lat, k.lng, c.lat, c.lng);
      const m = geo.nameMatch(bare(k.name), bare(c.name));
      const sameFamily = FAMILY[k.type] === FAMILY[c.type];
      const seed = k.id?.startsWith('seed:');
      if (m >= 0.97 && d < 12) return true;
      if (subArea(bare(k.name), bare(c.name))) return false;
      // Otherwise only when the names differ in nothing but generic words: a
      // more specific name ("… Choate Chrome Mine") is a different entry
      if (!geo.sameCore(bare(k.name), bare(c.name))) return false;
      return (d < 2 && sameFamily) || (seed && d < 8);
    });
    if (!twin) { kept.push(c); continue; }
    const seed = twin.id?.startsWith('seed:');
    twin.q = Math.max(twin.q, c.q);
    twin.tags = [...new Set([...twin.tags, ...c.tags])];
    twin.facts = { ...c.facts, ...twin.facts };
    // A researched write-up beats the older one-liner (the first one found)
    if (c.desc && (!twin.desc || (seed && !twin.rewritten))) { twin.desc = c.desc; twin.rewritten = true; }
    twin.url = twin.url || c.url;
    twin.town = twin.town || c.town; twin.st = twin.st || c.st;
    if (c.lat != null && (twin.lat == null || (seed && !twin.located))) { twin.lat = c.lat; twin.lng = c.lng; twin.located = true; }
  }
  return kept;
}

// ── OpenStreetMap candidates ────────────────────────────────
function dedupeOsm(list) {
  // The same park is often mapped twice (boundary + park area). Keep the
  // better one per name within a few km.
  const byName = new Map();
  for (const c of list) {
    const k = geo.norm(c.name) + '|' + (FAMILY[c.type] || c.type);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  const out = [];
  for (const group of byName.values()) {
    group.sort((a, b) => b.q - a.q || b.km - a.km);
    const kept = [];
    for (const c of group) {
      const reach = FAMILY[c.type] === 'land' ? 8 : FAMILY[c.type] === 'trail' ? 5 : 1.2;
      const twin = kept.find(k => miles(k.lat, k.lng, c.lat, c.lng) < reach);
      if (twin) {
        twin.tags = [...new Set([...twin.tags, ...c.tags])];
        twin.wikidata = twin.wikidata || c.wikidata;
        twin.wikipedia = twin.wikipedia || c.wikipedia;
        twin.website = twin.website || c.website;
        twin.facts = { ...c.facts, ...twin.facts };
        (twin.osmAlso = twin.osmAlso || []).push(c.osm);
      } else kept.push(c);
    }
    // "Chesapeake Forest" is forty scattered tracts with one name: keep the
    // two biggest rather than forty identical entries
    if (kept.length > 3 && FAMILY[kept[0].type] === 'land') {
      kept.sort((a, b) => b.km - a.km);
      kept.length = 2;
    }
    out.push(...kept);
  }
  return out;
}

// A grid so "what is near this point" does not scan every place
function spatialIndex(list) {
  const CELL = 0.1;
  const grid = new Map();
  const key = (lat, lng) => Math.floor(lat / CELL) + ':' + Math.floor(lng / CELL);
  for (const p of list) {
    const k = key(p.lat, p.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  return (lat, lng, reachMiles) => {
    const span = Math.ceil(reachMiles / 5.5);
    const cy = Math.floor(lat / CELL), cx = Math.floor(lng / CELL);
    const out = [];
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
      for (const p of grid.get((cy + dy) + ':' + (cx + dx)) || []) {
        if (miles(lat, lng, p.lat, p.lng) <= reachMiles) out.push(p);
      }
    }
    return out;
  };
}

// ── Build ───────────────────────────────────────────────────
async function main() {
  // 1. OpenStreetMap
  const elements = osm.loadElements(RAW);
  const towns = osm.loadTowns(RAW);
  const nearestTown = geo.townIndex(towns);
  log(`OpenStreetMap: ${elements.length.toLocaleString()} elements, ${towns.length.toLocaleString()} towns`);

  let candidates = [];
  for (const el of elements) {
    if (el.groups.size === 1 && (el.groups.has('towns') || el.groups.has('trailhead'))) continue;
    if (!inRegion(el.lat, el.lng)) continue;
    const c = osm.classify(el);
    if (c) candidates.push(c);
  }
  log(`  worth keeping: ${candidates.length.toLocaleString()}`);
  candidates = dedupeOsm(candidates);
  log(`  after merging doubles: ${candidates.length.toLocaleString()}`);

  // 2. Curated places take over the OpenStreetMap entry for the same place
  const curatedAll = loadCurated();
  const curated = mergeCurated(curatedAll);
  log(`Curated: ${curatedAll.length} entries, ${curated.length} distinct places`);

  const near = spatialIndex(candidates);
  const taken = new Set();
  const noCoords = [];
  for (const c of curated) {
    let best = null, bestScore = 0;
    // A refuge or national park's mapped middle can be 20 miles from its entrance
    const reach = FAMILY[c.type] === 'land' ? 25 : 15;
    const pool = c.lat != null ? near(c.lat, c.lng, reach) : candidates.filter(o => geo.norm(o.name) === geo.norm(c.name));
    const exactWorthy = geo.tokens(bare(c.name)).length >= 2;   // not just "Overlook"
    for (const o of pool) {
      if (taken.has(o)) continue;
      const m = geo.nameMatch(bare(c.name), o.name);
      const d = c.lat != null ? miles(c.lat, c.lng, o.lat, o.lng) : 0;
      const sameFamily = FAMILY[c.type] === FAMILY[o.type];
      // Close by with a similar name, or the very same name within a few miles
      // (a big park's mapped middle can be far from its entrance)
      const ok = (d < 2 && m >= (sameFamily ? 0.7 : 0.97)) || (m >= 0.97 && exactWorthy && d < reach);
      if (ok && m - d / 100 > bestScore) { bestScore = m - d / 100; best = o; }
    }
    if (best) {
      taken.add(best);
      c.osm = best.osm; c.osmAlso = [...(best.osmAlso || [])];
      // The same thing is often mapped more than once under one name (the
      // B&A Trail is a route and a strip of park). The curated entry stands
      // for all of them.
      for (const o of pool) {
        if (taken.has(o) || !exactWorthy || geo.nameMatch(bare(c.name), o.name) < 0.97) continue;
        taken.add(o);
        c.osmAlso.push(o.osm, ...(o.osmAlso || []));
        c.wikidata = c.wikidata || o.wikidata; c.wikipedia = c.wikipedia || o.wikipedia;
      }
      c.wikidata = best.wikidata || c.wikidata; c.wikipedia = best.wikipedia || c.wikipedia; c.website = best.website;
      c.facts = { ...best.facts, ...c.facts };
      c.osmDesc = best.osmDesc;
      c.km = best.km;
      const rough = c.id?.startsWith('seed:') && !c.located && FAMILY[c.type] !== 'land';
      if (c.lat == null || (rough && miles(c.lat, c.lng, best.lat, best.lng) > 0.3)) { c.lat = best.lat; c.lng = best.lng; }
    }
    if (c.lat == null) noCoords.push(c.name);
  }
  let places = [...curated.filter(c => c.lat != null), ...candidates.filter(o => !taken.has(o))];

  // 3. Where each place is. Outside the covered states, or too far: out.
  const dropped = { outside: [] };
  places = places.filter(p => {
    p.state = geo.stateAt(p.lat, p.lng);
    const town = nearestTown(p.lat, p.lng);
    if (!p.state && town) p.state = geo.stateAt(town.lat, town.lng);   // lighthouses and beaches just offshore
    if (!p.state && p.st) p.state = p.st;
    if (!COVERED_STATES.has(p.state) || !inRegion(p.lat, p.lng)) {
      if (p.curated) dropped.outside.push(`${p.name} (${p.state || '?'}, ${Math.round(miles(HOME.lat, HOME.lng, p.lat, p.lng))} mi)`);
      return false;
    }
    const townName = p.town || (town && town.miles < 12 ? town.name : null);
    p.where = townName ? `${townName}, ${p.state}` : p.state;
    return true;
  });

  // Which big park a spot sits in (only compact parks: a bounding box is a
  // fair stand-in for their outline, which it is not for a 180-mile canal)
  const hosts = places.filter(p => FAMILY[p.type] === 'land' && p.q >= 55 && p.km >= 0.8 && p.km <= 8 && p.osm);
  const boxes = new Map();
  for (const el of elements) if (el.bounds) boxes.set(el.key, el.bounds);
  for (const p of places) {
    if (FAMILY[p.type] === 'land') continue;
    let host = null;
    for (const h of hosts) {
      const b = boxes.get(h.osm);
      if (!b || p.lat < b.minlat || p.lat > b.maxlat || p.lng < b.minlon || p.lng > b.maxlon) continue;
      if (!host || h.km < host.km) host = h;
    }
    if (host && geo.nameMatch(host.name, p.name) < 0.6) p.in = host.name;
  }

  // 4. Ids. A place that existed before keeps its old id so saved places
  //    and "been there" marks carry over.
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, 'legacy', 'old_places.json'), 'utf8'));
  const legacyByOsm = new Map(), legacyNear = spatialIndex(legacy.map(r => ({ id: r[0], name: r[1], lat: r[3], lng: r[4] })));
  for (const r of legacy) if (r[5] && !legacyByOsm.has(r[5])) legacyByOsm.set(r[5], r[0]);
  const used = new Set();
  const claim = id => { if (!id || used.has(id)) return false; used.add(id); return true; };

  for (const p of places) if (p.id && !claim(p.id)) p.id = null;   // Alex's seed ids first
  for (const p of places) {
    if (p.id) continue;
    const viaOsm = [p.osm, ...(p.osmAlso || [])].map(k => legacyByOsm.get(k)).find(id => id && !used.has(id));
    if (viaOsm && claim(viaOsm)) { p.id = viaOsm; continue; }
    const old = legacyNear(p.lat, p.lng, 1.5).find(o => !used.has(o.id) && geo.norm(o.name) === geo.norm(p.name));
    if (old && claim(old.id)) { p.id = old.id; continue; }
  }
  // Second pass, looser: the same place under a slightly different name
  // ("Bolivar Heights Battlefield" then, "Bolivar Heights" now)
  for (const p of places) {
    if (p.id) continue;
    const old = legacyNear(p.lat, p.lng, 1.5)
      .filter(o => !used.has(o.id))
      .map(o => ({ o, m: geo.nameMatch(o.name, p.name) }))
      .filter(x => x.m >= 0.8)
      .sort((a, b) => b.m - a.m)[0];
    if (old && claim(old.o.id)) p.id = old.o.id;
  }
  for (const p of places) {
    if (p.id) continue;
    if (p.curated) {
      const base = 'c:' + geo.slug(p.name);
      let id = base, n = 2;
      while (!claim(id)) id = base + n++;
      p.id = id;
    } else {
      p.id = 'osm:' + p.osm;
      claim(p.id);
    }
  }

  // 5. Photos and descriptions
  log(offline ? 'Wikipedia (cached answers only)…' : 'Wikipedia…');
  await wiki.enrich(places, log, offline);

  // An OpenStreetMap-only place earns its notability bonus once an English
  // Wikipedia article is confirmed; some kinds are only kept if they have one.
  places = places.filter(p => {
    if (p.curated) return true;
    if (p.wikiUrl) p.q = Math.min(osm.OSM_CAP, p.q + (p.bonus || 0));
    else if (p.needsArticle) return false;
    // A beach with no sign of being public stays only if it is inside a park
    if (p.needsHost && !p.in && !p.wikiUrl) return false;
    return p.q >= osm.KEEP;
  });

  // 6. Final shape
  const out = places.map(p => {
    const facts = { ...p.facts };
    // Good in the rain even though they came from another list: show caves,
    // walk-through tunnels, covered bridges, anything called a museum
    if (!p.tags.includes('rainy') && (
      (p.type === 'caves' && (p.curated || facts.fee)) ||
      (p.curated && p.tags.includes('tunnel') && !facts.access) ||
      p.tags.includes('covered') || RAINY_NAME.test(p.name))) p.tags = [...p.tags, 'rainy'];
    const desc = p.curated && p.desc ? p.desc : p.wikiExtract || p.osmDesc || p.desc || '';
    const q = Math.round(Math.min(99, p.q + (!p.curated && p.img ? 3 : 0)));
    const o = { id: p.id, name: p.name, type: p.type, tags: p.tags, lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5), where: p.where, q };
    if (p.in) o.in = p.in;
    if (desc) o.desc = desc;
    if (p.img) o.img = p.img;
    const url = p.wikiUrl || p.url || p.website;
    if (url && /^https?:\/\//.test(url)) o.url = url;
    if (Object.keys(facts).length) o.facts = facts;
    return o;
  });
  out.sort((a, b) => b.q - a.q || a.name.localeCompare(b.name));

  fs.writeFileSync(path.join(ROOT, 'places.json'), '[\n' + out.map(p => JSON.stringify(p)).join(',\n') + '\n]\n');

  // Old places that did not make it, in case one was saved
  const keptIds = new Set(out.map(p => p.id));
  const seen = new Set();
  const archive = legacy.filter(r => !keptIds.has(r[0]) && !seen.has(r[0]) && seen.add(r[0]))
    .map(r => [r[0], r[1], r[2], r[3], r[4]]);
  fs.writeFileSync(path.join(ROOT, 'archive.json'), '[\n' + archive.map(r => JSON.stringify(r)).join(',\n') + '\n]\n');

  // ── Report ──
  const count = (list, f) => list.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  log(`\nplaces.json: ${out.length.toLocaleString()} places (${(fs.statSync(path.join(ROOT, 'places.json')).size / 1e6).toFixed(2)} MB)`);
  log('  by type:', count(out, p => p.type));
  log('  by state:', count(out, p => p.where.slice(-2)));
  log('  curated:', out.filter(p => p.q >= 60).length, ' top picks (q≥80):', out.filter(p => p.q >= 80).length,
    ' with photo:', out.filter(p => p.img).length, ' with description:', out.filter(p => p.desc).length);
  const far = out.map(p => miles(HOME.lat, HOME.lng, p.lat, p.lng));
  log(`  farthest from home: ${Math.round(Math.max(...far))} mi;  within 30 mi: ${far.filter(d => d <= 30).length},  30-80: ${far.filter(d => d > 30 && d <= 80).length},  80+: ${far.filter(d => d > 80).length}`);
  log(`  kept old ids: ${out.filter(p => /^(seed|sw|pk|wp):/.test(p.id)).length};  archive.json: ${archive.length.toLocaleString()} old places left out`);
  if (noCoords.length) log(`  curated without coordinates (left out): ${noCoords.join('; ')}`);
  if (dropped.outside.length) log(`  curated outside the covered area (left out): ${dropped.outside.join('; ')}`);
  const ids = count(out, p => p.id);
  const dup = Object.keys(ids).filter(k => ids[k] > 1);
  if (dup.length) { log('  DUPLICATE IDS:', dup); process.exitCode = 1; }
}

main().catch(e => { console.error(e); process.exit(1); });
