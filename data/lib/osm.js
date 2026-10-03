// Turns raw OpenStreetMap elements into candidate places, or drops them.
//
// Every rule here answers one question: would somebody who likes hikes,
// beaches, waterfalls, views and odd corners be glad this showed up? The old
// data kept everything with a name (plaques, pocket parks, path segments,
// 43-metre "peaks"), which buried the good places.
//
// q is a rough 0-100 quality score. Hand-checked places from data/curated/
// score 60-92; OSM-only places top out below 80, and anything under KEEP
// is left out.

const fs = require('fs');
const path = require('path');
const { miles } = require('../region');

const KEEP = 30;
const OSM_CAP = 78;

function loadElements(rawDir) {
  const byKey = new Map();
  for (const file of fs.readdirSync(rawDir)) {
    if (!file.endsWith('.json')) continue;
    const group = file.split('_')[0];
    const { elements } = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
    for (const el of elements) {
      const key = el.type[0] + el.id;
      // Areas and routes come with a bounding box; its middle is the location
      const b = el.bounds;
      const lat = el.lat ?? el.center?.lat ?? (b && (b.minlat + b.maxlat) / 2);
      const lng = el.lon ?? el.center?.lon ?? (b && (b.minlon + b.maxlon) / 2);
      if (lat == null || lng == null) continue;
      if (!byKey.has(key)) byKey.set(key, { key, lat, lng, bounds: el.bounds, tags: el.tags || {}, groups: new Set() });
      byKey.get(key).groups.add(group);
    }
  }
  return [...byKey.values()];
}

// Size of an area in km (diagonal of its bounding box); 0 for a point
function diagKm(el) {
  const b = el.bounds;
  if (!b) return 0;
  return miles(b.minlat, b.minlon, b.maxlat, b.maxlon) * 1.609;
}

const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const feet = m => Math.round(m * 3.28084);

// Length tags are kilometres unless they say otherwise
function lengthMiles(v) {
  const n = num(v);
  if (n == null) return null;
  const mi = /mi/i.test(String(v)) ? n : n * 0.621371;
  return mi >= 0.2 && mi < 400 ? Math.round(mi * 10) / 10 : null;
}

const CLOSED = new Set(['private', 'no', 'customers', 'residents', 'members', 'military', 'agricultural', 'forestry']);

// Names that say "not for visitors"
const PRIVATE_NAME = /\b(private|community|association|hoa|homeowners|residents?|members?|club|estates?|condo|condominium|apartments?|subdivision|civic|improvement)\b/i;
const JUNK_NAME = /^(unnamed|unknown|no name|n\/a|\d+([\/\-]\d+)?|[a-z]|site \d+|lot \d+|area \d+)$/i;

// Land that is protected on paper but is not a place to go
const EASEMENT = /easement|conservation area parcel|\btract\b|\bparcel\b|buffer|agricultural|farmland|\bfarm preservation|open space|common area|stormwater|retention|detention|right[- ]of[- ]way|forest conservation|reforestation|mitigation|\bhoa\b|homeowners|rural legacy|scenic easement|development rights|\bfee simple\b|program open space|landfill/i;

const PARK_NATURE = /nature|natural|preserve|sanctuary|wildlife|refuge|arboretum|greenway|forest|woods|wetland|marsh|conservation|environmental|wilderness|reservation|battlefield|botanic|garden/i;
const PARK_WATER = /beach|waterfront|landing|\bpoint\b|cove|harbor|\bbay\b|shore|pier|wharf|river|creek|lake|reservoir|falls|pond|island|canal|run\b/i;
const PARK_DULL = /athletic|sports|recreation center|rec center|ballfields?|ball fields?|fields?$|playground|play area|tot lot|dog park|\bpool\b|tennis|golf|stadium|skate|community center|elementary|middle school|high school|\bschool\b|memorial garden|cemetery|\bsquare\b|plaza|circle|triangle|mini park|pocket park|commons?$|parklet|median|courtyard|clubhouse|swim club|basketball|soccer|baseball|softball|little league|boys (and|&) girls|ymca|fairgrounds|parking/i;

const PARK_LOCAL = /neighborhood|local park|community park|special park|urban park|village green|\bcivic\b|recreation(al)? (area|park)|\brec\b/i;
const GEM_DULL = /latrine|outhouse|privy|remnants?|\((former|ruins?|abandoned|closed|site)\)|brick pile|\bshed\b|cistern|\bpit\b|foundation|chimney$|\bwell\b|spring ?house|pump(ing)? (house|station)|\bgate(s)?\b|\bfence\b|\bwall\b|\bsteps\b|\bculvert\b|abutment|\bpier(s)?\b|\bpiling|farm field|driveway|parking|\bbarn\b|\bgarage\b|trailer|\bgrave\b/i;
const ATTRACTION_DULL = /district|arena|stadium|visitor center|welcome center|\bmall\b|hotel|\binn\b|casino|theat(er|re)|cinema|market|brewery|winery|vineyard|distillery|restaurant|farmhouse|house$|hall$|church|chapel|cathedral|school|college|university|library|museum|center$|centre$|store|shop|\bzoo\b|aquarium|carousel|playground/i;
const TRAIL_LONG = /\bseg(ment)? ?\d|\bsection \d|^adt\b|\busbr\b|bike route|bicycle route|\broute \d|east coast greenway|september 11|9\/11/i;
const TRAIL_PLAIN = /^(the )?(loop|wetlands?|farm|nature|lake|river|creek|ridge|forest|woods|woodland|meadow|orchard|pond|perimeter|main|boundary|upper|lower|north|south|east|west|inner|outer|fitness|exercise|interpretive|discovery|sensory|bridle|horse|equestrian|bike|mountain bike|hiker|multi-?use|service|old|new) (trail|loop|path|road)s?$/i;
const TRAIL_GENERIC = /^(the )?(red|blue|white|yellow|orange|green|purple|pink|black|silver|gold|brown|teal|grey|gray)([- ]blazed?)?( (trail|loop|blaze|path|connector))?$/i;
const TRAIL_MINOR = /connector|spur|access|cut-?off|\blink\b|bypass|sidewalk|shortcut|driveway|service road|fire road|alley/i;

// historic=* values worth walking to, with the tags the app files them under
const HISTORIC = {
  ruins:               { q: 40, tags: ['ruins', 'abandoned', 'historic'] },
  ghost_town:          { q: 50, tags: ['ghost-town', 'abandoned', 'historic'] },
  fort:                { q: 46, tags: ['fort', 'military', 'historic'] },
  fortification:       { q: 40, tags: ['fort', 'military', 'historic'] },
  castle:              { q: 34, tags: ['historic'], wikiOnly: true },
  mine:                { q: 42, tags: ['mine', 'abandoned', 'geology'] },
  mine_shaft:          { q: 40, tags: ['mine', 'abandoned', 'geology'] },
  kiln:                { q: 44, tags: ['furnace', 'ruins', 'industrial', 'historic'] },
  lime_kiln:           { q: 44, tags: ['furnace', 'ruins', 'industrial', 'historic'] },
  furnace:             { q: 44, tags: ['furnace', 'ruins', 'industrial', 'historic'] },
  industrial:          { q: 40, tags: ['industrial', 'abandoned', 'historic'] },
  quarry:              { q: 38, tags: ['quarry', 'geology', 'abandoned'] },
  mill:                { q: 32, tags: ['mill', 'historic'] },
  watermill:           { q: 32, tags: ['mill', 'historic'] },
  aqueduct:            { q: 46, tags: ['canal', 'bridge', 'historic'] },
  tunnel:              { q: 48, tags: ['tunnel', 'historic'] },
  bridge:              { q: 28, tags: ['bridge', 'historic'], wikiOnly: true },
  railway:             { q: 28, tags: ['railway', 'historic'], wikiOnly: true },
  lock:                { q: 30, tags: ['canal', 'historic'] },
  canal:               { q: 30, tags: ['canal', 'historic'], wikiOnly: true },
  wreck:               { q: 45, tags: ['shipwreck', 'abandoned', 'waterfront'] },
  ship:                { q: 30, tags: ['historic'], wikiOnly: true },
  aircraft:            { q: 30, tags: ['historic'], wikiOnly: true },
  archaeological_site: { q: 36, tags: ['ruins', 'historic'] },
  battlefield:         { q: 30, tags: ['historic'], wikiOnly: true, type: 'historic' },
  tower:               { q: 30, tags: ['historic'], wikiOnly: true },
  monastery:           { q: 30, tags: ['historic'], wikiOnly: true },
};

function facts(t) {
  const f = {};
  const ele = num(t.ele);
  if (ele != null && ele > 0 && ele < 2100) f.ele = feet(ele);
  const height = num(t.height);
  if (height != null && t.waterway === 'waterfall' && height > 1 && height < 200) f.height = feet(height);
  const len = lengthMiles(t.distance);
  if (len) f.len = len;
  if (t.fee === 'yes') f.fee = 'Yes';
  if (t.fee === 'no') f.fee = 'Free';
  if (t.dog === 'leashed') f.dogs = 'On leash';
  if (t.dog === 'no') f.dogs = 'Not allowed';
  if (t.dog === 'yes') f.dogs = 'Welcome';
  return f;
}

// Returns { name, type, tags, q, facts, … } or null
function classify(el) {
  const t = el.tags;
  const name = (t.name || t['name:en'] || '').trim();
  if (!name || name.length < 3 || JUNK_NAME.test(name)) return null;
  if (CLOSED.has(t.access)) return null;
  if (t.disused === 'yes' && !t.historic) return null;

  // A Wikidata id alone proves nothing (every hill in the federal names
  // database has one). An English Wikipedia article does, and build.js only
  // knows that after looking it up, so the bonus is handed back separately.
  const mayHaveArticle = !!(t.wikidata || t.wikipedia);
  let bonus = 0, needsArticle = false, needsHost = false;
  const wiki = n => { bonus = n; return 0; };
  const descriptive = name === name.toLowerCase();   // a mapper's note, not a name
  const km = diagKm(el);
  let type = null, tags = [], q = 0;

  const historic = HISTORIC[t.historic];
  const railwayAbandoned = t.railway === 'abandoned' || t.railway === 'disused';
  const abandoned = t.abandoned === 'yes' || t['abandoned:building'] || t['abandoned:man_made'] || t['abandoned:place'] || t.ruins === 'yes';

  if (t.waterway === 'waterfall' || t.natural === 'waterfall') {
    type = 'waterfall'; tags = ['waterfall', 'water', 'scenic', 'nature'];
    q = 50 + wiki(10) + (t.height ? 4 : 0);
  } else if (t.natural === 'cave_entrance') {
    // Show caves and well-known ones rank normally; an unnamed-to-the-public
    // hole on somebody's hillside ranks last
    type = 'caves'; tags = ['cave', 'geology', 'gems'];
    q = 34 + wiki(18) + (t.tourism === 'attraction' || t.fee === 'yes' ? 16 : 0);
    if (/^portal\b|#\d|\bentrance\b/i.test(name)) q -= 8;
  } else if (['arch', 'rock', 'stone', 'gorge', 'hot_spring', 'sinkhole', 'cliff'].includes(t.natural)) {
    type = 'gems'; tags = ['geology', 'gems', 'nature'];
    q = 40 + wiki(12);
  } else if (t.man_made === 'lighthouse') {
    type = 'gems'; tags = ['lighthouse', 'historic', 'waterfront', 'gems'];
    q = 46 + wiki(12);
  } else if (historic || t.man_made === 'kiln' || t.man_made === 'watermill') {
    const def = historic || HISTORIC[t.man_made === 'kiln' ? 'kiln' : 'watermill'];
    if (def.wikiOnly) needsArticle = true;
    if (t.building === 'house' || t.building === 'residential') return null;
    type = def.type || 'gems'; tags = [...def.tags, 'gems'];
    q = def.q + wiki(12);
    if (abandoned && !tags.includes('abandoned')) tags.push('abandoned');
    if (t.ruins === 'yes' && !tags.includes('ruins')) tags.push('ruins');
  } else if (railwayAbandoned && /trail|greenway|passage|towpath|path$/i.test(name) && !/tunnel|bridge|viaduct|trestle/i.test(name)) {
    return null;   // a rail trail, not a relic; rail trails come in as routes
  } else if (railwayAbandoned && (t.tunnel === 'yes' || t.tunnel === 'building_passage')) {
    type = 'gems'; tags = ['tunnel', 'railway', 'abandoned', 'gems']; q = 46 + wiki(10);
  } else if (railwayAbandoned && t.bridge) {
    // Usually named after the line, not the bridge; only documented ones stay
    needsArticle = true;
    type = 'gems'; tags = ['bridge', 'railway', 'abandoned', 'gems']; q = 34 + wiki(12);
  } else if (t.military === 'bunker') {
    type = 'gems'; tags = ['military', 'abandoned', 'gems']; q = 38 + wiki(10);
  } else if (abandoned) {
    // A shuttered shop is not a destination, nor is a retired pipeline or a numbered shed
    if (/transmission|pipeline|\bline \d|forest road|\broad \d|^[a-z]-?\d+$|^building \d+|mobile home|trailer park|substation/i.test(name)) return null;
    if (t.shop || t['abandoned:shop'] || t.amenity || t['abandoned:amenity'] || t.office || t.highway) return null;
    if (t.building === 'house' || t.building === 'residential' || t.building === 'apartments') return null;
    type = 'gems';
    if (t['abandoned:place'] || t.place === 'locality') { tags = ['ghost-town', 'abandoned', 'gems']; q = 44; }
    else if (t.ruins === 'yes') { tags = ['ruins', 'abandoned', 'gems']; q = 38; }
    else { tags = ['abandoned', 'gems']; q = 34; }
    if (/industrial|factory|warehouse|manufacture/.test(t.building || '') || t.man_made === 'works' || t['abandoned:man_made']) {
      tags.push('industrial'); q += 5;
    }
    q += wiki(12);
  } else if (t.tourism === 'viewpoint') {
    if (/^op \d|^observation (platform|deck|point)$|climbing tower|^view(point)?$|^overlook$|^vista$|^lookout$/i.test(name)) return null;
    type = 'viewpoint'; tags = ['viewpoint', 'scenic'];
    q = 36 + wiki(12) + (/overlook|vista|view|point|rocks?|lookout|summit|knob|tower|cliff|ledge|scenic|panorama/i.test(name) ? 10 : 0);
    const dir = num(t.direction);
    if ((dir != null && dir >= 225 && dir <= 315) || /^(W|WSW|WNW|SW|NW)$/i.test(t.direction || '')) tags.push('sunset');
  } else if (t.natural === 'peak') {
    const ele = num(t.ele) || 0;
    // A 90-metre rise in Arlington with a Civil War article is not a summit hike
    if (ele < 250) return null;
    type = 'hike'; tags = ['summit', 'hiking', 'nature'];
    q = 18 + wiki(24) + (ele >= 900 ? 6 : 0) + (ele >= 1100 ? 8 : 0);
    if (ele) tags.push('viewpoint');
  } else if (t.natural === 'beach' || t.leisure === 'beach_resort') {
    if (PRIVATE_NAME.test(name)) return null;
    type = 'beach'; tags = ['beach', 'waterfront', 'water', 'scenic'];
    // Named points imported from the federal names database are usually just a stretch of private shore
    const gnisPoint = el.key[0] === 'n' && Object.keys(t).some(k => k.startsWith('gnis:'));
    q = (gnisPoint ? 24 : 38) + wiki(12) + (t.supervised === 'yes' || t.lifeguard === 'yes' || t.fee ? 4 : 0);
    // Around the Bay most named beaches belong to a neighbourhood. Without a
    // sign that it is public, build.js keeps a beach only if it lies in a park.
    needsHost = !(t.supervised === 'yes' || t.lifeguard === 'yes' || t.fee || t.operator || t.access === 'yes');
  } else if (t.leisure === 'swimming_area' || t.leisure === 'bathing_place') {
    if (PRIVATE_NAME.test(name)) return null;
    if (/swimmer|beginner|lap pool|diving|wading|\bpool\b/i.test(name)) return null;
    type = 'swim'; tags = ['swimming', 'water', 'nature']; q = 44 + wiki(10);
    needsHost = !(t.supervised === 'yes' || t.lifeguard === 'yes' || t.fee || t.operator || t.access === 'yes');
  } else if (t.man_made === 'tower' && t['tower:type'] === 'observation') {
    type = 'viewpoint'; tags = ['viewpoint', 'scenic']; q = 40 + wiki(12);
  } else if ((t.bridge === 'covered' || (t.bridge && t.covered === 'yes')) &&
             (/covered bridge/i.test(name) || ((t.historic || t.wikidata || t.heritage) && /bridge/i.test(name)))) {
    // (the same tags are used for airport skywalks and roofed footbridges)
    type = 'gems'; tags = ['bridge', 'covered', 'historic', 'gems']; q = 44 + wiki(10);
  } else if (t.waterway === 'dam') {
    // Hundreds of farm-pond dams carry a Wikidata id; only the ones with an article are sights
    if (!t.wikipedia) return null;
    type = 'viewpoint'; tags = ['scenic', 'water', 'historic']; q = 36;
  } else if (t.tourism === 'camp_site') {
    // Public campgrounds only (state and national parks and forests, county
    // parks, canal hiker-biker sites). Commercial RV parks and scout camps are out.
    if (PRIVATE_NAME.test(name) || t.scout === 'yes' || t.group_only === 'yes') return null;
    if (/#\s?\d|\b(site|campsite|shelter|pad|loop) [a-z]?\d+\b|^\d/i.test(name)) return null;   // single numbered pitches
    const pub = /state|national|nps|usfs|forest service|dnr|dcnr|county|corps of engineers|department|park service|m-ncppc|city of|town of/i.test(t.operator || '') ||
      /state (park|forest)|national (park|forest)|county park|regional park|hiker[- ]biker|\bnra\b/i.test(name) || t.backcountry === 'yes';
    if (!pub) return null;
    type = 'camp'; tags = ['camping', 'nature'];
    q = 36 + wiki(8);
  } else if (t.leisure === 'garden') {
    if (/residential|private|community|allotment/i.test(t['garden:type'] || '') || PARK_DULL.test(name)) return null;
    // Campus rain gardens and community plots are tagged the same way as
    // Longwood; a botanical garden says so, or has an article
    const botanical = /botanic|arboretum|pinetum/i.test(name);
    if (!botanical) needsArticle = true;
    type = 'garden'; tags = ['garden', 'nature']; q = 42 + wiki(10);
  } else if (t.route) {
    if (km > 100 || TRAIL_GENERIC.test(name) || TRAIL_LONG.test(name) || TRAIL_PLAIN.test(name)) return null;
    const len = lengthMiles(t.distance);
    if (t.route === 'bicycle') {
      // Rail trails and greenways, not the path beside a six-lane road
      if (/boulevard|parkway|\bdrive\b|avenue|street|\broad\b|highway|\bpike\b|parallel|\broute\b|\bi-?\d|\bus ?\d|\bmd ?\d|\bva ?\d|extension|connector/i.test(name)) return null;
      type = 'run'; tags = ['running', 'trail', 'paved'];
      q = 38 + wiki(10);
    } else if ((len && len >= 3) || km >= 4) {
      type = 'hike'; tags = ['hiking', 'trail', 'nature'];
      q = 38 + wiki(12) + (/^(nwn|rwn)$/.test(t.network || '') ? 6 : 0) + (len && len >= 3 ? 3 : 0);
    } else {
      // A short named trail inside a park: the park is the destination.
      // Only the documented ones are listed on their own.
      type = 'trail'; tags = ['hiking', 'trail', 'nature'];
      needsArticle = true;
      q = 30 + wiki(12);
    }
    if (TRAIL_MINOR.test(name)) q -= 12;
  } else if (t.boundary === 'protected_area' || t.boundary === 'national_park' || t.leisure === 'nature_reserve') {
    if (EASEMENT.test(name) || EASEMENT.test(t.protection_title || '') || PRIVATE_NAME.test(name)) return null;
    if (/^(2[1-9]|99)$/.test(t.protect_class || '')) return null;
    type = 'park'; tags = ['park', 'nature', 'forest', 'hiking'];
    q = 30;
    if (/national park|national seashore|national recreation area/i.test(name)) q += 35;
    else if (/state park/i.test(name)) q += 28;
    else if (/national wildlife refuge|wilderness|national forest|national monument|national historical park|national battlefield|national military park|national historic site/i.test(name)) q += 25;
    else if (/nature (preserve|center|park)|sanctuary|arboretum|\bpreserve\b|conservation (area|park)|environmental (area|center)|regional park|natural area|natural environment area/i.test(name)) q += 12;
    else if (/state forest|natural resources? management area|\bnrma\b/i.test(name)) q += 10;
    else if (/wildlife management area|\bwma\b/i.test(name)) q += 2;
    else if (/state game lands?|hunting|hunt club|shooting/i.test(name)) q -= 12;
    if (/wildlife|refuge|sanctuary|\bbird/i.test(name)) tags.push('wildlife');
    q += wiki(10) + (km >= 1 ? 4 : 0) + (km >= 3 ? 4 : 0) - (km && km < 0.25 ? 15 : 0);
    if (PARK_DULL.test(name)) q -= 20;
    if (PARK_LOCAL.test(name)) q -= 10;
    // Protected on paper is not enough: it needs size, a telling name or an article
    if (q + (mayHaveArticle ? 10 : 0) < 34) return null;
  } else if (t.leisure === 'park') {
    if (PRIVATE_NAME.test(name) || EASEMENT.test(name)) return null;
    type = /\bbeach\b/i.test(name) ? 'beach' : 'park';
    tags = type === 'beach' ? ['beach', 'waterfront', 'water', 'park'] : ['park', 'nature'];
    q = 22 + wiki(12) + (km >= 0.8 ? 6 : 0) + (km >= 2 ? 6 : 0);
    if (/state park|national park/i.test(name)) q += 28;
    else if (PARK_NATURE.test(name)) q += 8;
    if (PARK_WATER.test(name)) { q += 5; if (!tags.includes('waterfront')) tags.push('waterfront'); }
    if (PARK_DULL.test(name)) q -= 20;
    if (PARK_LOCAL.test(name)) q -= 10;
    // An ordinary park has to be big or clearly about nature to be a destination
    if (q + 12 < 33 || (!t.wikidata && !t.wikipedia && q < 33)) return null;
  } else if (t.tourism === 'attraction') {
    // A catch-all tag: zoo animals, rides, shops. Only the documented, outdoor ones are kept.
    needsArticle = true;
    if (t.attraction || t.zoo || t.amenity || t.shop || /memorial|monument|statue|plaque/.test(t.historic || '') || t.memorial) return null;
    if (ATTRACTION_DULL.test(name) || (t.building && t.building !== 'ruins')) return null;
    type = 'gems'; tags = ['gems']; q = 30 + wiki(12);
  } else {
    return null;
  }

  if (descriptive) q -= 12;
  if (type === 'gems' && GEM_DULL.test(name)) q -= 14;
  if (type === 'gems' && /\bsite$|substation|\bbranch$|\brailway$|\brailroad$|\bturnpike$|\broad$/i.test(name)) q -= 10;
  if (t.website || t['contact:website']) q += 2;
  q = Math.min(q, OSM_CAP);
  if (!mayHaveArticle) { bonus = 0; if (needsArticle) return null; }
  if (q + bonus < KEEP) return null;

  return {
    name, type, tags: [...new Set(tags)], q, bonus, needsArticle, needsHost,
    lat: +el.lat.toFixed(5), lng: +el.lng.toFixed(5),
    km,
    facts: facts(t),
    osm: el.key,
    wikidata: t.wikidata || null,
    wikipedia: t.wikipedia || null,
    website: t.website || t['contact:website'] || null,
    osmDesc: /^[A-Z]/.test(t.description || '') && t.description.length > 30 && t.description.length < 400 ? t.description : null,
  };
}

function loadTowns(rawDir) {
  const towns = [];
  const seen = new Set();
  for (const file of fs.readdirSync(rawDir)) {
    if (!file.startsWith('towns_')) continue;
    for (const el of JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')).elements) {
      const name = el.tags?.name;
      if (!name || seen.has(el.id)) continue;
      seen.add(el.id);
      towns.push({ name, kind: el.tags.place, lat: el.lat, lng: el.lon });
    }
  }
  return towns;
}

module.exports = { loadElements, loadTowns, classify, KEEP, OSM_CAP };
