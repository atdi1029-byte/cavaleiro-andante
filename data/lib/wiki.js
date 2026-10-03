// Gives places a real photo and a real description.
//
// A place is tied to an English Wikipedia article in one of three ways:
//   1. its OpenStreetMap tags name one (wikipedia=en:Title)
//   2. its OpenStreetMap tags give a Wikidata item that links to one
//   3. hand-picked places: an article whose title is the place's name AND
//      whose coordinates are close by, so a "Cascade Falls" in another state
//      can never supply the photo
//
// Wikidata is asked in bulk (one query for hundreds of items). Wikipedia
// allows anonymous clients very few requests (HTTP 429, wait a minute), so
// its requests are batched, spaced out, and done best-places-first; the
// build can be stopped and run again, and picks up where it left off.
// Everything fetched is cached in data/cache/wiki.json.

const fs = require('fs');
const path = require('path');
const { miles, nameMatch } = require('./geo');

const UA = 'CavaleiroAndante/2.0 (personal outdoor app; data build)';
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'wiki.json');
const PACE = 3000;   // ms between Wikipedia requests
const sleep = ms => new Promise(r => setTimeout(r, ms));

let online = true;
let cache = { wd: {}, geo: {}, page: {} };
try { cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) }; } catch { /* first run */ }
function saveCache() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

async function request(url, options = {}) {
  let wait = 5000;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers: { 'User-Agent': UA, ...options.headers }, signal: AbortSignal.timeout(60000) });
      if (res.status === 429 || res.status >= 500) {
        // Told to slow down: wait as long as asked
        const asked = Number(res.headers.get('retry-after')) * 1000 + 2000;
        if (asked > wait) wait = Math.min(asked, 180000);
        throw new Error('HTTP ' + res.status);
      }
      return await res.json();
    } catch (e) {
      if (attempt === 10) throw e;
      await sleep(wait);
      wait = Math.min(wait * 1.5, 180000);
    }
  }
}

const wikipedia = params =>
  request('https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params }));

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// Wikidata items → English article title and picture (P18), 300 per query
async function fetchWikidata(ids) {
  const todo = online ? [...new Set(ids)].filter(id => /^Q\d+$/.test(id) && !(cache.wd[id] && 'image' in cache.wd[id])) : [];
  for (const batch of chunks(todo, 300)) {
    const query = `SELECT ?item ?image ?article WHERE {
      VALUES ?item { ${batch.map(id => 'wd:' + id).join(' ')} }
      OPTIONAL { ?item wdt:P18 ?image }
      OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
    }`;
    const data = await request('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body: 'query=' + encodeURIComponent(query),
    });
    for (const id of batch) cache.wd[id] = { title: null, image: null };
    for (const row of data.results.bindings) {
      const entry = cache.wd[row.item.value.split('/').pop()];
      if (row.article && !entry.title) entry.title = decodeURIComponent(row.article.value.split('/wiki/')[1]).replace(/_/g, ' ');
      if (row.image && !entry.image) entry.image = decodeURIComponent(row.image.value.split('/Special:FilePath/')[1]);
    }
    saveCache();
    await sleep(1500);
  }
}

// Thumbnail, opening sentences and coordinates for articles, 20 per request
async function fetchPages(titles, log) {
  const todo = online ? [...new Set(titles)].filter(t => t && !(t in cache.page)) : [];
  let done = 0;
  for (const batch of chunks(todo, 20)) {
    const data = await wikipedia({
      action: 'query', titles: batch.join('|'), redirects: '1',
      prop: 'pageimages|extracts|coordinates|pageprops',
      piprop: 'thumbnail|name', pithumbsize: '330', pilimit: '20',
      exintro: '1', explaintext: '1', exsentences: '3', exlimit: '20',
      colimit: '20', ppprop: 'disambiguation',
    });
    const alias = {};
    for (const r of [...(data.query?.normalized || []), ...(data.query?.redirects || [])]) alias[r.from] = r.to;
    const resolve = t => { let x = t; for (let i = 0; i < 4 && alias[x]; i++) x = alias[x]; return x; };
    const pages = {};
    for (const p of data.query?.pages || []) pages[p.title] = p;
    for (const t of batch) {
      const p = pages[resolve(t)];
      cache.page[t] = !p || p.missing || p.invalid || p.pageprops?.disambiguation !== undefined ? { missing: true } : {
        title: p.title,
        thumb: p.thumbnail?.source || null,
        image: p.pageimage || null,
        extract: p.extract || '',
        lat: p.coordinates?.[0]?.lat ?? null,
        lng: p.coordinates?.[0]?.lon ?? null,
      };
    }
    saveCache();
    done += batch.length;
    if (done % 100 === 0 || done === todo.length) log(`  articles: ${done}/${todo.length}`);
    await sleep(PACE);
  }
}

// Articles located near a point
async function fetchNearby(lat, lng) {
  const key = lat.toFixed(3) + ',' + lng.toFixed(3);
  if (!(key in cache.geo)) {
    if (!online) return [];
    const data = await wikipedia({ action: 'query', list: 'geosearch', gscoord: `${lat}|${lng}`, gsradius: '6000', gslimit: '40' });
    cache.geo[key] = (data.query?.geosearch || []).map(g => [g.title, Math.round(g.dist)]);
    saveCache();
    await sleep(PACE);
  }
  return cache.geo[key];
}

// Lead images that are not photos of the place
const NOT_A_PHOTO = /\.svg$|map|atlas|county\.jpg|locator|logo|seal|flag|icon|diagram|coat[_ ]of[_ ]arms|signature|plaque|sign\b|portrait|\.gif$|\.tiff?$|\.pdf$|USA_|_location|relief|\.ogv$|\.webm$/i;

function cleanExtract(text) {
  const s = String(text || '').replace(/\s+/g, ' ')
    .replace(/\s*\((?:[^()]*?(?:pronounced|listen|IPA|\/)[^()]*?)\)/g, '')
    .replace(/\s*\(\s*\)/g, '').trim();
  if (s.length <= 300) return s;
  // Cut at the last sentence end that fits
  const cut = s.slice(0, 300);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('." '));
  return end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

const commonsThumb = file =>
  'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file.replace(/ /g, '_')) + '?width=330';
const articleUrl = title => 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));

// The obvious article title for a hand-picked place:
// "Kilgore Falls (Falling Branch Area)" → "Kilgore Falls"
const guess = p => p.name.replace(/\s*\([^)]*\)/g, '').replace(/\s+[-–:]\s+.*$/, '').trim();

// Fills in p.wikiUrl, p.wikiExtract and p.img where an article or picture exists
async function enrich(places, log = () => {}, offline = false) {
  online = !offline;

  // 1. OpenStreetMap places: their tags say which article is theirs
  await fetchWikidata(places.map(p => p.wikidata).filter(Boolean));
  for (const p of places) {
    const tag = p.wikipedia && /^(en:)?[^:]+$/.test(p.wikipedia) ? p.wikipedia.replace(/^en:/, '') : null;
    p.wikiTitle = tag || cache.wd[p.wikidata]?.title || null;
    p.wikiSure = !!p.wikiTitle;
  }

  // 2. Fetch articles, best places first: the hand-picked ones by their
  //    name, then the tagged ones
  const byQuality = [...places].sort((a, b) => b.q - a.q);
  const untitled = byQuality.filter(p => !p.wikiTitle && p.curated);
  await fetchPages([...untitled.map(guess), ...byQuality.map(p => p.wikiTitle)], log);

  // Top hand-picked places whose name is not an article title: look around them
  for (const p of untitled) {
    const page = cache.page[guess(p)];
    if (page && !page.missing && page.lat != null) { p.wikiTitle = guess(p); continue; }
    if (p.q < 84) continue;
    let best = null, bestScore = 0.82;
    for (const [title] of await fetchNearby(p.lat, p.lng)) {
      const score = nameMatch(p.name, title.replace(/\s*\([^)]*\)\s*$/, ''));
      if (score > bestScore) { bestScore = score; best = title; }
    }
    p.wikiTitle = best;
  }
  await fetchPages(untitled.map(p => p.wikiTitle), log);

  // 3. Photo and description
  let photos = 0, texts = 0;
  for (const p of places) {
    const page = p.wikiTitle ? cache.page[p.wikiTitle] : null;
    const known = page && !page.missing;
    // A guessed article must be about somewhere close by; big parks get more room
    const reach = p.type === 'park' || p.type === 'hike' ? 25 : 10;
    const near = known && page.lat != null && miles(p.lat, p.lng, page.lat, page.lng) <= reach;
    if (p.wikiSure ? !(page && page.missing) : near) {
      p.wikiUrl = articleUrl(known ? page.title : p.wikiTitle);
      if (known) {
        p.wikiExtract = cleanExtract(page.extract);
        if (page.thumb && !NOT_A_PHOTO.test(page.image || '')) p.img = page.thumb;
      }
    }
    const file = cache.wd[p.wikidata]?.image;
    if (!p.img && file && !NOT_A_PHOTO.test(file)) p.img = commonsThumb(file);
    if (p.img) photos++;
    if (p.wikiExtract) texts++;
  }
  log(`  ${texts} Wikipedia descriptions, ${photos} photos`);
}

module.exports = { enrich };
