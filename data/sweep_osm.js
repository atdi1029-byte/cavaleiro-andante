#!/usr/bin/env node
// Step 1 of the data pipeline: pull every outdoor feature in the region from
// OpenStreetMap (Overpass API) into data/raw/, one small file per query.
//
//   node data/sweep_osm.js            fetch whatever is missing in data/raw/
//   node data/sweep_osm.js --force    re-fetch everything
//   node data/sweep_osm.js parks      only the groups whose name starts with "parks"
//
// Results are cached (data/raw/ is git-ignored). build.js turns them into
// places.json. Nothing is capped: the old sweep asked for "out center 200" per
// zone, which silently dropped most waterfalls, overlooks and parks.

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'raw');
const { REGION } = require('./region');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'CavaleiroAndante/2.0 (personal outdoor app; data sweep)';

// One query per group and tile. Overpass admits small queries even when it is
// busy and refuses big ones, so each group is a single cheap statement (or a
// few related ones). "@" is replaced by the bounding box.
//   grid 1 = the whole region in one query, grid 6 = six tiles
const GROUPS = [
  // Natural features and the "cool stuff" a nature app is for
  { name: 'waterfall',  grid: 1, q: ['nwr["waterway"="waterfall"]@', 'node["natural"="waterfall"]@'] },
  { name: 'viewpoint',  grid: 1, q: ['node["tourism"="viewpoint"]@'] },
  { name: 'peak',       grid: 6, q: ['node["natural"="peak"]["name"]@'] },
  { name: 'cave',       grid: 1, q: ['nwr["natural"="cave_entrance"]@', 'nwr["natural"="arch"]@'] },
  { name: 'rock',       grid: 6, q: ['node["natural"="rock"]["name"]["wikidata"]@', 'nwr["natural"="gorge"]["name"]@'] },
  { name: 'beach',      grid: 6, q: ['nwr["natural"="beach"]@'] },
  { name: 'swim',       grid: 1, q: ['nwr["leisure"="swimming_area"]@', 'nwr["leisure"="bathing_place"]@', 'nwr["leisure"="beach_resort"]@'] },
  { name: 'lighthouse', grid: 1, q: ['nwr["man_made"="lighthouse"]@'] },
  { name: 'tower',      grid: 1, q: ['nwr["man_made"="tower"]["tower:type"="observation"]@'] },
  { name: 'attraction', grid: 6, q: ['nwr["tourism"="attraction"]["name"]@'] },
  { name: 'covered',    grid: 1, q: ['way["bridge"="covered"]@', 'way["bridge"]["covered"="yes"]["name"]@'] },
  { name: 'dam',        grid: 1, q: ['nwr["waterway"="dam"]["name"]["wikidata"]@'] },

  // Protected land: state/national parks, refuges, preserves, forests, gardens
  { name: 'reserve',    grid: 6, q: ['nwr["leisure"="nature_reserve"]["name"]@'] },
  { name: 'protected',  grid: 6, q: ['nwr["boundary"="protected_area"]["name"]@'] },
  { name: 'natpark',    grid: 1, q: ['relation["boundary"="national_park"]["name"]@'] },
  { name: 'garden',     grid: 1, q: ['nwr["leisure"="garden"]["name"]["garden:type"]@', 'nwr["leisure"="garden"]["name"]["wikidata"]@'] },

  // Ordinary parks (most are filtered out later; the good ones are kept)
  { name: 'parks',      grid: 6, q: ['nwr["leisure"="park"]["name"]@'] },

  // Abandoned and historic things worth walking to
  { name: 'ruins',      grid: 6, q: ['nwr["historic"="ruins"]@', 'nwr["ruins"="yes"]["name"]@'] },
  { name: 'abandoned',  grid: 6, q: ['nwr["abandoned"="yes"]["name"]@', 'nwr["abandoned:building"]["name"]@', 'nwr["abandoned:man_made"]["name"]@',
                                     'nwr["railway"="abandoned"]["tunnel"]@', 'nwr["railway"="abandoned"]["bridge"]["name"]@'] },
  { name: 'fort',       grid: 1, q: ['nwr["historic"="fort"]@', 'nwr["historic"="castle"]@', 'nwr["historic"="fortification"]@',
                                     'nwr["military"="bunker"]["name"]@'] },
  { name: 'industrial', grid: 1, q: ['nwr["historic"="mine"]@', 'nwr["historic"="mine_shaft"]@', 'nwr["historic"="kiln"]@', 'nwr["historic"="lime_kiln"]@',
                                     'nwr["historic"="furnace"]@', 'nwr["historic"="industrial"]@', 'nwr["man_made"="kiln"]["name"]@',
                                     'nwr["historic"="mill"]["name"]@', 'nwr["historic"="watermill"]["name"]@', 'nwr["man_made"="watermill"]["name"]@',
                                     'nwr["historic"="quarry"]@'] },
  { name: 'transport',  grid: 1, q: ['nwr["historic"="aqueduct"]@', 'nwr["historic"="tunnel"]@', 'nwr["historic"="wreck"]@'] },
  { name: 'locks',      grid: 1, q: ['nwr["historic"="lock"]["name"]@', 'nwr["historic"="bridge"]["name"]["wikipedia"]@'] },
  { name: 'oldsites',   grid: 1, q: ['nwr["historic"="archaeological_site"]["name"]@', 'nwr["historic"="ghost_town"]@',
                                     'nwr["historic"="battlefield"]["name"]@'] },

  // Named hiking routes and rail trails
  { name: 'hiking',     grid: 6, q: ['relation["route"="hiking"]["name"]@', 'relation["route"="foot"]["name"]@'] },
  { name: 'railtrail',  grid: 6, q: ['relation["route"="bicycle"]["name"~"Trail|Greenway|Towpath"]@'] },
  { name: 'trailhead',  grid: 1, q: ['nwr["highway"="trailhead"]["name"]@'] },

  { name: 'camping',    grid: 6, q: ['nwr["tourism"="camp_site"]["name"]@'] },

  // Towns, used to say where a place is ("near Thurmont")
  { name: 'towns',      grid: 6, q: ['node["place"="city"]@', 'node["place"="town"]@', 'node["place"="village"]["name"]@', 'node["place"="hamlet"]["name"]@'] },
];

function tiles(grid) {
  const cols = grid === 6 ? 3 : 1, rows = grid === 6 ? 2 : 1;
  const out = [];
  const w = (REGION.east - REGION.west) / cols, h = (REGION.north - REGION.south) / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    out.push({
      name: grid === 1 ? 'all' : `r${r}c${c}`,
      box: [REGION.south + r * h, REGION.west + c * w, REGION.south + (r + 1) * h, REGION.west + (c + 1) * w]
        .map(n => n.toFixed(4)).join(','),
    });
  }
  return out;
}

function query(group, tile) {
  const body = group.q.map(s => s.replace('@', `(${tile.box})`) + ';').join('\n  ');
  return `[out:json][timeout:120][maxsize:268435456];
(
  ${body}
);
out tags bb;`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOverpass(q, label) {
  let lastErr;
  for (let attempt = 0; attempt < 7; attempt++) {
    // The main server is the reliable one; the mirrors are a fallback after
    // it has refused a few times in a row.
    const url = attempt % 4 === 3 ? ENDPOINTS[1 + (attempt >> 2) % 2] : ENDPOINTS[0];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(150000),
      });
      const text = await res.text();
      if (text[0] !== '{') {
        // Overpass answers "server too busy" as an HTML page
        const m = text.match(/<strong[^>]*>Error<\/strong>:([^<]*)/);
        throw new Error(m ? m[1].trim().slice(-70) : `HTTP ${res.status}`);
      }
      const data = JSON.parse(text);
      if (data.remark && /timed out|out of memory/i.test(data.remark)) throw new Error(data.remark.slice(0, 80));
      return data;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(60, 8 * (attempt + 1));
      console.log(`  ${label}: ${e.message} (retrying in ${wait}s)`);
      await sleep(wait * 1000);
    }
  }
  throw lastErr;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const want = args.filter(a => !a.startsWith('--'));
  const groups = GROUPS.filter(g => !want.length || want.some(w => g.name.startsWith(w)));

  fs.mkdirSync(RAW, { recursive: true });
  let failed = 0;
  for (const group of groups) for (const tile of tiles(group.grid)) {
    const file = path.join(RAW, `${group.name}_${tile.name}.json`);
    if (!force && fs.existsSync(file)) continue;
    const t0 = Date.now();
    try {
      const data = await fetchOverpass(query(group, tile), `${group.name} ${tile.name}`);
      // Write each chunk to disk before starting the next one
      fs.writeFileSync(file, JSON.stringify({ fetched: new Date().toISOString(), elements: data.elements }));
      console.log(`${group.name} ${tile.name}: ${data.elements.length} elements in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      failed++;
      console.log(`${group.name} ${tile.name}: GAVE UP (${e.message}). Run the sweep again to retry.`);
    }
    await sleep(1500);
  }
  console.log(failed ? `Done with ${failed} queries missing.` : 'Done. All queries are cached.');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { GROUPS, tiles, query };
