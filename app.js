// ================================================
// CAVALEIRO ANDANTE
// Find trails, parks, waterfalls & weird spots
// ================================================

// ---- Config ----
const HOME = {
  lat: 39.1037,
  lng: -76.5338,
  label: 'Pasadena, MD'
};

// ~100 miles in meters (≈ 2 hours from home base)
const RADIUS_M = 160934;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const CACHE_KEY  = 'ca_places_cache';
const CACHE_TTL  = 30 * 60 * 1000; // 30 min

// ---- State ----
let currentLoc = { ...HOME };
let places     = [];
let activeFilter = 'all';
let activeView   = 'list';
let leafletMap, mapMarkers = [];

// ---- Storage Keys ----
const SK = {
  taste:     'ca_taste',
  favorites: 'ca_favorites',
  visited:   'ca_visited',
  bad:       'ca_bad'
};

// ================================================
// TASTE PROFILE
// ================================================

const DEFAULT_TASTE = {
  waterfall: 1.0,
  forest:    1.0,
  hiking:    1.0,
  trail:     1.0,
  park:      1.0,
  water:     1.0,
  weird:     1.0,
  historic:  1.0,
  viewpoint: 1.0,
  running:   1.0,
  nature:    1.0,
  scenic:    1.0
};

function loadTaste() {
  try {
    return Object.assign(
      { ...DEFAULT_TASTE },
      JSON.parse(localStorage.getItem(SK.taste) || '{}')
    );
  } catch { return { ...DEFAULT_TASTE }; }
}

function saveTaste(t) {
  localStorage.setItem(SK.taste, JSON.stringify(t));
}

function applyTasteDelta(tags, delta) {
  const taste = loadTaste();
  for (const tag of tags) {
    if (tag in taste) {
      taste[tag] = Math.max(0.1, Math.min(3.0, taste[tag] + delta));
    }
  }
  saveTaste(taste);
}

function tasteScore(tags) {
  if (!tags || !tags.length) return 1.0;
  const taste = loadTaste();
  const sum = tags.reduce((acc, t) => acc + (taste[t] || 1.0), 0);
  return Math.round((sum / tags.length) * 100) / 100;
}

// ================================================
// FAVORITES / VISITED / BAD
// ================================================

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch { return new Set(); }
}

function saveSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

function toggleFavorite(id, tagsJson) {
  const tags = JSON.parse(tagsJson);
  const favs = loadSet(SK.favorites);
  const bad  = loadSet(SK.bad);
  if (favs.has(id)) {
    favs.delete(id);
    applyTasteDelta(tags, -0.1);
  } else {
    favs.add(id);
    bad.delete(id);
    saveSet(SK.bad, bad);
    applyTasteDelta(tags, +0.15);
  }
  saveSet(SK.favorites, favs);
  rerenderCard(id);
}

function toggleVisited(id, tagsJson) {
  const tags = JSON.parse(tagsJson);
  const vis  = loadSet(SK.visited);
  if (vis.has(id)) {
    vis.delete(id);
  } else {
    vis.add(id);
    applyTasteDelta(tags, +0.05);
  }
  saveSet(SK.visited, vis);
  rerenderCard(id);
}

function toggleBad(id, tagsJson) {
  const tags = JSON.parse(tagsJson);
  const bad  = loadSet(SK.bad);
  const favs = loadSet(SK.favorites);
  if (bad.has(id)) {
    bad.delete(id);
    applyTasteDelta(tags, +0.05);
  } else {
    bad.add(id);
    favs.delete(id);
    saveSet(SK.favorites, favs);
    applyTasteDelta(tags, -0.15);
  }
  saveSet(SK.bad, bad);
  // Remove from list view and close modal if open
  rerenderCard(id);
  closeModal();
}

// ================================================
// OSM TAG CLASSIFICATION
// ================================================

function classifyPlace(t) {
  if (t.natural === 'waterfall') return 'waterfall';
  if (t.natural === 'beach')     return 'water';
  if (t.natural === 'water' || t.waterway) return 'water';
  if (t.route === 'hiking' || t.route === 'foot') return 'trail';
  if (t.highway === 'path' || t.highway === 'track'
      || t.highway === 'footway') return 'trail';
  if (t.boundary === 'national_park'
      || t.boundary === 'protected_area'
      || t.boundary === 'national_forest'
      || t.leisure  === 'nature_reserve') return 'park';
  if (t.leisure === 'park') return 'park';
  if (t.route === 'running') return 'run';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (t.historic || t.tourism === 'attraction'
      || t.tourism === 'artwork') return 'weird';
  return 'other';
}

function getPlaceTags(t) {
  const tags = [];
  if (t.natural === 'waterfall')  tags.push('waterfall', 'water', 'scenic');
  if (t.natural === 'water'
      || t.waterway)              tags.push('water');
  if (t.natural === 'beach')      tags.push('water', 'scenic');
  if (t.route === 'hiking'
      || t.route === 'foot')      tags.push('hiking', 'trail', 'nature');
  if (t.highway === 'path'
      || t.highway === 'track'
      || t.highway === 'footway') tags.push('trail', 'hiking');
  if (t.boundary === 'national_park'
      || t.boundary === 'national_forest') tags.push('park', 'forest', 'hiking', 'nature');
  if (t.leisure === 'nature_reserve') tags.push('park', 'forest', 'nature', 'hiking');
  if (t.leisure === 'park')       tags.push('park', 'nature');
  if (t.tourism === 'viewpoint')  tags.push('viewpoint', 'scenic');
  if (t.historic)                 tags.push('historic', 'weird');
  if (t.tourism === 'attraction') tags.push('weird');
  if (t.tourism === 'artwork')    tags.push('weird', 'scenic');
  if (t.natural === 'wood'
      || t.landuse === 'forest')  tags.push('forest', 'nature');
  if (t.route === 'running')      tags.push('running', 'trail');
  if (t.sac_scale)                tags.push('hiking', 'trail');
  if (t.ele)                      tags.push('scenic');
  return [...new Set(tags)];
}

// ================================================
// FILTER LOGIC
// ================================================

function matchesFilter(p) {
  if (activeFilter === 'all')  return p.type !== 'other';
  if (activeFilter === 'hike') return p.type === 'trail'
    || p.tags.includes('hiking');
  if (activeFilter === 'trail') return p.type === 'trail';
  if (activeFilter === 'park')  return p.type === 'park';
  if (activeFilter === 'waterfall') return p.type === 'waterfall';
  if (activeFilter === 'run')   return p.type === 'run'
    || p.tags.includes('running');
  if (activeFilter === 'water') return p.type === 'water'
    || p.tags.includes('water');
  if (activeFilter === 'weird') return p.type === 'weird'
    || p.tags.includes('weird')
    || p.tags.includes('historic');
  return true;
}

// ================================================
// DISTANCE
// ================================================

function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ================================================
// OVERPASS API
// ================================================

function buildQuery(lat, lng, r) {
  return `
[out:json][timeout:40];
(
  node["natural"="waterfall"](around:${r},${lat},${lng});
  way["natural"="water"]["name"](around:${r},${lat},${lng});
  node["natural"="beach"]["name"](around:${r},${lat},${lng});
  way["leisure"="park"]["name"](around:${r},${lat},${lng});
  relation["leisure"="park"]["name"](around:${r},${lat},${lng});
  way["leisure"="nature_reserve"]["name"](around:${r},${lat},${lng});
  relation["leisure"="nature_reserve"]["name"](around:${r},${lat},${lng});
  relation["boundary"="national_park"]["name"](around:${r},${lat},${lng});
  relation["route"="hiking"]["name"](around:${r},${lat},${lng});
  node["tourism"="viewpoint"]["name"](around:${r},${lat},${lng});
  node["tourism"="attraction"]["name"](around:${r},${lat},${lng});
  node["historic"]["name"](around:${r},${lat},${lng});
  way["historic"]["name"](around:${r},${lat},${lng});
);
out center 400;
`.trim();
}

async function fetchOverpass(lat, lng) {
  const query = buildQuery(lat, lng, RADIUS_M);
  // Overpass requires application/x-www-form-urlencoded with data= prefix
  const body  = 'data=' + encodeURIComponent(query);
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`Overpass ${url} failed:`, e.message);
    }
  }
  throw new Error('All Overpass endpoints failed. Check connection.');
}

function parseResults(data, userLat, userLng) {
  const out  = [];
  const seen = new Set();

  for (const el of data.elements) {
    const t    = el.tags || {};
    const name = t.name || t['name:en'];
    if (!name) continue;

    const key = name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);

    let lat, lng;
    if (el.type === 'node') {
      lat = el.lat;
      lng = el.lon;
    } else if (el.center) {
      lat = el.center.lat;
      lng = el.center.lon;
    } else continue;

    const type = classifyPlace(t);
    const tags = getPlaceTags(t);
    const dist = Math.round(
      distanceMiles(userLat, userLng, lat, lng) * 10
    ) / 10;

    // Build description from available OSM tags
    const parts = [];
    if (t.description)    parts.push(t.description);
    if (t.sac_scale)      parts.push(`Difficulty: ${t.sac_scale.replace(/_/g, ' ')}`);
    if (t.distance)       parts.push(`Length: ${t.distance} km`);
    if (t.ele)            parts.push(`Elevation: ${t.ele}m`);
    if (t.surface)        parts.push(`Surface: ${t.surface}`);
    if (t.opening_hours)  parts.push(`Hours: ${t.opening_hours}`);
    if (t.fee)            parts.push(`Fee: ${t.fee}`);
    if (t.access && t.access !== 'yes') parts.push(`Access: ${t.access}`);
    if (t.dog)            parts.push(`Dogs: ${t.dog}`);
    if (t.historic)       parts.push(`Type: ${t.historic.replace(/_/g, ' ')}`);
    if (t.wikipedia && !t.description)
      parts.push(`Wikipedia: ${t.wikipedia}`);

    out.push({
      id:      `${el.type}:${el.id}`,
      osmId:   el.id,
      osmType: el.type,
      name,
      type,
      tags,
      lat,
      lng,
      dist,
      description: parts.join(' · '),
      osmTags: t,
      score:   0
    });
  }

  return out;
}

// ================================================
// SCORING & SORTING
// ================================================

function ranked(list) {
  const favs = loadSet(SK.favorites);
  const bad  = loadSet(SK.bad);
  return list
    .filter(p => !bad.has(p.id))
    .map(p => ({ ...p, score: tasteScore(p.tags) }))
    .sort((a, b) => {
      const fa = favs.has(a.id) ? 1 : 0;
      const fb = favs.has(b.id) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      if (Math.abs(a.score - b.score) > 0.05) return b.score - a.score;
      return a.dist - b.dist;
    });
}

// ================================================
// RENDER
// ================================================

const TYPE_EMOJI = {
  waterfall: '💧',
  park:      '🌲',
  trail:     '🌿',
  water:     '🌊',
  weird:     '👁️',
  viewpoint: '🔭',
  run:       '🏃',
  hike:      '🥾',
  other:     '📍'
};

function cardHtml(p) {
  const favs = loadSet(SK.favorites);
  const vis  = loadSet(SK.visited);
  const bad  = loadSet(SK.bad);
  const isFav  = favs.has(p.id);
  const isVis  = vis.has(p.id);
  const isBad  = bad.has(p.id);

  const emoji = TYPE_EMOJI[p.type] || '📍';
  const cls   = isFav ? 'is-fav' : isVis ? 'is-visited' : isBad ? 'is-bad' : '';
  const tagsJson = JSON.stringify(p.tags).replace(/"/g, '&quot;');

  const tagPills = p.tags.slice(0, 5)
    .map(t => `<span class="tag-pill">${t}</span>`).join('');

  const scoreStr = p.score ? `★ ${p.score.toFixed(1)}` : '';

  return `
<div class="place-card ${cls}" data-id="${p.id}" data-type="${p.type}"
  onclick="openModal('${p.id}')">
  <div class="card-inner">
    <div class="card-top">
      <span class="place-name">${emoji} ${p.name}</span>
      <span class="place-distance">${p.dist} mi</span>
    </div>
    <div class="card-meta">
      <span class="type-badge">${p.type}</span>
      ${scoreStr ? `<span class="taste-score">★ ${p.score.toFixed(1)}</span>` : ''}
    </div>
    ${p.description ? `<p class="place-desc">${p.description}</p>` : ''}
    <div class="card-tags">${tagPills}</div>
    <div class="card-actions" onclick="event.stopPropagation()">
      <button class="action-btn ${isFav ? 'act-fav' : ''}" title="Save"
        onclick="toggleFavorite('${p.id}','${tagsJson}')">
        ${isFav ? '♥' : '♡'}
      </button>
      <button class="action-btn ${isVis ? 'act-visit' : ''}" title="Been there"
        onclick="toggleVisited('${p.id}','${tagsJson}')">
        ${isVis ? '✓' : '○'}
      </button>
      <button class="action-btn ${isBad ? 'act-bad' : ''}" title="Not for me"
        onclick="toggleBad('${p.id}','${tagsJson}')">✕</button>
    </div>
  </div>
</div>`.trim();
}

function renderList() {
  const container = document.getElementById('places-list');
  const list = ranked(places.filter(matchesFilter));
  document.getElementById('count-label').textContent =
    list.length ? `${list.length} places` : '';

  if (!list.length) {
    container.innerHTML = `
<div class="empty-state">
  <h3>Nothing here</h3>
  <p>Try a different filter or reload.</p>
</div>`;
    return;
  }
  container.innerHTML = list.map(cardHtml).join('');
}

function rerenderCard(id) {
  const el = document.querySelector(`.place-card[data-id="${id}"]`);
  if (!el) return;
  const p = places.find(x => x.id === id);
  if (!p) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = cardHtml({ ...p, score: tasteScore(p.tags) });
  el.replaceWith(tmp.firstElementChild);
}

// ================================================
// MAP
// ================================================

function initMap() {
  if (leafletMap) return;
  leafletMap = L.map('map').setView(
    [currentLoc.lat, currentLoc.lng], 10
  );
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      attribution: '© OpenStreetMap contributors © CARTO',
      subdomains: 'abcd',
      maxZoom: 19
    }
  ).addTo(leafletMap);
}

function renderMapMarkers() {
  if (!leafletMap) return;
  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];

  const favs = loadSet(SK.favorites);
  const list = ranked(places.filter(matchesFilter)).slice(0, 250);

  list.forEach(p => {
    const isFav  = favs.has(p.id);
    const emoji  = TYPE_EMOJI[p.type] || '📍';
    const bg     = isFav ? '#c0392b' : '#1a4a1a';
    const border = isFav ? '#e74c3c' : '#4a9a4a';

    const icon = L.divIcon({
      html: `<div style="
        background:${bg};border:2px solid ${border};
        border-radius:50%;width:28px;height:28px;
        display:flex;align-items:center;
        justify-content:center;font-size:14px;
      ">${emoji}</div>`,
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const m = L.marker([p.lat, p.lng], { icon })
      .addTo(leafletMap)
      .on('click', () => openModal(p.id));

    mapMarkers.push(m);
  });
}

// ================================================
// MODAL
// ================================================

let modalPlaceId = null;

function openModal(id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  modalPlaceId = id;

  const favs  = loadSet(SK.favorites);
  const vis   = loadSet(SK.visited);
  const isFav = favs.has(id);
  const isVis = vis.has(id);

  const emoji     = TYPE_EMOJI[p.type] || '📍';
  const tagsJson  = JSON.stringify(p.tags).replace(/"/g, '&quot;');
  const gmaps     = `https://www.google.com/maps?q=${p.lat},${p.lng}`;
  const osmLink   = `https://www.openstreetmap.org/${p.osmType}/${p.osmId}`;
  const aoSearch  = `https://www.atlasobscura.com/search?q=`
    + encodeURIComponent(p.name);

  const allTags = p.tags
    .map(t => `<span class="tag-pill">${t}</span>`).join('');

  // Extra OSM fields
  const extras = [];
  const ot = p.osmTags;
  if (ot.website || ot['contact:website']) {
    const url = ot.website || ot['contact:website'];
    extras.push(
      `<a href="${url}" target="_blank"
        style="color:#7ecf7e">Website ↗</a>`
    );
  }
  if (ot.phone || ot['contact:phone'])
    extras.push(ot.phone || ot['contact:phone']);
  if (ot.wheelchair)
    extras.push(`♿ ${ot.wheelchair}`);

  document.getElementById('modal-content').innerHTML = `
<h2>${emoji} ${p.name}</h2>
<div class="modal-meta">
  <span class="type-badge badge-${p.type}">${p.type}</span>
  <span style="color:#b8b0a0;font-size:12px">${p.dist} mi away</span>
  <span style="color:#c4a030;font-size:12px">
    ★ ${tasteScore(p.tags).toFixed(2)} match
  </span>
</div>
${p.description
  ? `<p class="modal-desc">${p.description}</p>` : ''}
${extras.length
  ? `<p class="modal-desc" style="font-size:12px">
      ${extras.join(' · ')}</p>` : ''}
<div class="card-tags" style="margin-bottom:14px">${allTags}</div>
<div class="modal-links">
  <a href="${gmaps}" target="_blank" class="modal-link">
    🗺️ Google Maps
  </a>
  <a href="${osmLink}" target="_blank" class="modal-link">
    🌍 OSM
  </a>
  <a href="${aoSearch}" target="_blank" class="modal-link">
    👁️ Atlas Obscura
  </a>
</div>
<div class="modal-actions">
  <button class="modal-action-btn mbtn-fav"
    onclick="toggleFavorite('${id}','${tagsJson}');openModal('${id}')">
    ${isFav ? '♥ Saved' : '♡ Save'}
  </button>
  <button class="modal-action-btn mbtn-visit"
    onclick="toggleVisited('${id}','${tagsJson}');openModal('${id}')">
    ${isVis ? '✓ Been There' : '+ Been There'}
  </button>
  <button class="modal-action-btn mbtn-bad"
    onclick="toggleBad('${id}','${tagsJson}')">
    ✗ Not For Me
  </button>
</div>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  modalPlaceId = null;
}

// ================================================
// TASTE PANEL
// ================================================

function openTastePanel() {
  const taste  = loadTaste();
  const maxVal = Math.max(...Object.values(taste), 1);

  const rows = Object.entries(taste)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, val]) => {
      const pct    = Math.round((val / maxVal) * 100);
      const barCls = val < 0.8 ? 'low' : val > 1.5 ? 'high' : '';
      return `
<div class="taste-row">
  <span class="taste-label">${tag}</span>
  <div class="taste-bar-track">
    <div class="taste-bar-fill ${barCls}" style="width:${pct}%"></div>
  </div>
  <span class="taste-val">${val.toFixed(2)}</span>
</div>`;
    }).join('');

  document.getElementById('taste-content').innerHTML = `
<p class="panel-sub">
  Scores rise when you save a place, fall when you skip it.
  Higher = shown first in results.
</p>
${rows}
<button class="reset-btn" onclick="resetTaste()">
  Reset to defaults
</button>`;

  document.getElementById('taste-panel').classList.remove('hidden');
}

function resetTaste() {
  if (!confirm('Reset taste profile to defaults?')) return;
  saveTaste({ ...DEFAULT_TASTE });
  openTastePanel();
  renderList();
}

// ================================================
// LOCATION
// ================================================

function useCurrentLocation() {
  if (!navigator.geolocation) {
    alert('Geolocation not supported on this device.');
    return;
  }
  const btn = document.getElementById('use-location-btn');
  btn.textContent = 'Locating…';
  btn.disabled    = true;

  navigator.geolocation.getCurrentPosition(
    pos => {
      currentLoc = {
        lat:   pos.coords.latitude,
        lng:   pos.coords.longitude,
        label: 'Current Location'
      };
      document.getElementById('location-text').textContent =
        'Current Location';
      document.getElementById('location-icon').textContent = '🔵';
      btn.textContent = 'Use Home';
      btn.disabled    = false;
      btn.onclick     = useHomeLocation;
      loadPlaces();
    },
    () => {
      alert('Could not get your location. Using home base.');
      btn.textContent = 'Use My Location';
      btn.disabled    = false;
    },
    { timeout: 10000 }
  );
}

function useHomeLocation() {
  currentLoc = { ...HOME };
  document.getElementById('location-text').textContent = HOME.label;
  document.getElementById('location-icon').textContent = '📍';
  const btn = document.getElementById('use-location-btn');
  btn.textContent = 'Use My Location';
  btn.onclick     = useCurrentLocation;
  loadPlaces();
}

// ================================================
// SESSION CACHE
// ================================================

function saveCache(placesArr) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
      places: placesArr,
      lat: currentLoc.lat,
      lng: currentLoc.lng,
      ts:  Date.now()
    }));
  } catch {}
}

function loadCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (Date.now() - c.ts > CACHE_TTL) return null;
    if (distanceMiles(
        c.lat, c.lng, currentLoc.lat, currentLoc.lng) > 5
    ) return null;
    return c.places;
  } catch { return null; }
}

// ================================================
// MAIN LOAD
// ================================================

async function loadPlaces() {
  const loading  = document.getElementById('loading');
  const listView = document.getElementById('list-view');
  const mapView  = document.getElementById('map-view');
  const errEl    = document.getElementById('error-state');

  errEl.classList.add('hidden');
  loading.classList.remove('hidden');
  listView.classList.add('hidden');
  mapView.classList.add('hidden');

  try {
    const data = await fetchOverpass(currentLoc.lat, currentLoc.lng);
    places = parseResults(data, currentLoc.lat, currentLoc.lng);
    saveCache(places);

    loading.classList.add('hidden');

    if (activeView === 'map') {
      mapView.classList.remove('hidden');
      initMap();
      leafletMap.setView([currentLoc.lat, currentLoc.lng], 10);
      renderMapMarkers();
    } else {
      listView.classList.remove('hidden');
      renderList();
    }
  } catch (err) {
    console.error(err);
    loading.classList.add('hidden');
    listView.classList.remove('hidden');
    errEl.classList.remove('hidden');
    document.getElementById('error-msg').textContent =
      err.message || 'Unknown error.';
  }
}

// ================================================
// BOOT
// ================================================

document.addEventListener('DOMContentLoaded', () => {

  // Category photo cards
  document.querySelectorAll('.cat-card').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-card')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderList();
      if (activeView === 'map') renderMapMarkers();
    });
  });

  // View toggle
  document.getElementById('list-view-btn').addEventListener('click', () => {
    if (activeView === 'list') return;
    activeView = 'list';
    document.getElementById('list-view-btn').classList.add('active');
    document.getElementById('map-view-btn').classList.remove('active');
    document.getElementById('list-view').classList.remove('hidden');
    document.getElementById('map-view').classList.add('hidden');
    renderList();
  });

  document.getElementById('map-view-btn').addEventListener('click', () => {
    if (activeView === 'map') return;
    activeView = 'map';
    document.getElementById('map-view-btn').classList.add('active');
    document.getElementById('list-view-btn').classList.remove('active');
    document.getElementById('list-view').classList.add('hidden');
    document.getElementById('map-view').classList.remove('hidden');
    initMap();
    renderMapMarkers();
    setTimeout(() => leafletMap.invalidateSize(), 150);
  });

  // Location button
  document.getElementById('use-location-btn')
    .addEventListener('click', useCurrentLocation);

  // Reload button
  document.getElementById('refresh-btn')
    .addEventListener('click', loadPlaces);

  // Modal close
  document.getElementById('modal-close')
    .addEventListener('click', closeModal);
  document.getElementById('modal-overlay')
    .addEventListener('click', e => {
      if (e.target.id === 'modal-overlay') closeModal();
    });

  // Taste panel
  document.getElementById('taste-btn')
    .addEventListener('click', openTastePanel);
  document.getElementById('taste-close')
    .addEventListener('click', () => {
      document.getElementById('taste-panel').classList.add('hidden');
      renderList();
    });

  // Initial load — try cache first
  const cached = loadCache();
  if (cached && cached.length) {
    places = cached;
    renderList();
  } else {
    loadPlaces();
  }
});
