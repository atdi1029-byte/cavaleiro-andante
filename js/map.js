// The map view (Leaflet, loaded in index.html).
//
// Instead of piling thousands of pins into numbered clusters, the map shows
// the best places in view, spaced so pins never sit on top of each other.
// Zoom in and the next-best ones appear.

import { MAP_LAYERS, typeOf } from './config.js';

const LAYER_KEY = 'cavaleiro_map_layer';
const MAX_PINS = 70;   // on screen at once
const MIN_GAP = 42;    // pixels between two pins

let map = null;
let tiles = null;
let originMarker = null;
let onPick = () => {};
let ranked = [];       // places from the current filter, best first
let hearts = [];       // saved places, always shown
let picked = null;     // the place whose preview card is showing
const markers = new Map();   // place id → { marker, saved }

function pinIcon(place, saved) {
  const t = typeOf(place);
  return L.divIcon({
    className: '',
    html: `<div class="pin${saved ? ' pin-saved' : ''}" style="--c:${saved ? '#f2545b' : t.color}">` +
          `<span>${saved ? '❤️' : t.emoji}</span></div>`,
    iconSize: [36, 44],
    iconAnchor: [18, 42],
  });
}

function setLayer(id) {
  const layer = MAP_LAYERS.find(l => l.id === id) || MAP_LAYERS[0];
  if (tiles) tiles.remove();
  tiles = L.tileLayer(layer.url, { maxZoom: layer.maxZoom, attribution: layer.attribution }).addTo(map);
  try { localStorage.setItem(LAYER_KEY, layer.id); } catch { /* ignore */ }
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === layer.id));
}

// Pick which places get a pin for what the map is showing right now
function draw() {
  if (!map) return;
  const bounds = map.getBounds().pad(0.05);
  const taken = [];
  const chosen = new Map();
  let more = 0;

  const consider = (place, saved) => {
    if (chosen.has(place.id) || place.nowhere || !bounds.contains([place.lat, place.lng])) return;
    const pt = map.latLngToContainerPoint([place.lat, place.lng]);
    if (!saved) {
      if (chosen.size >= MAX_PINS) { more++; return; }
      for (const t of taken) {
        if (Math.abs(t.x - pt.x) < MIN_GAP && Math.abs(t.y - pt.y) < MIN_GAP) { more++; return; }
      }
    }
    taken.push(pt);
    chosen.set(place.id, { place, saved });
  };
  hearts.forEach(p => consider(p, true));
  if (picked && !chosen.has(picked.id)) {
    // The previewed place keeps its pin even when better ones crowd it out
    taken.push(map.latLngToContainerPoint([picked.lat, picked.lng]));
    chosen.set(picked.id, { place: picked, saved: false });
  }
  ranked.forEach(p => consider(p, false));

  for (const [id, m] of markers) {
    const keep = chosen.get(id);
    if (!keep || keep.saved !== m.saved) { m.marker.remove(); markers.delete(id); }
  }
  for (const [id, { place, saved }] of chosen) {
    if (markers.has(id)) continue;
    const z = Math.round(place.q || 0) * 10;
    const marker = L.marker([place.lat, place.lng], { icon: pinIcon(place, saved), zIndexOffset: saved ? 5000 : z }).addTo(map);
    marker.on('click', e => { L.DomEvent.stopPropagation(e); onPick(place); });
    markers.set(id, { marker, saved, z });
  }

  for (const [id, m] of markers) {
    const on = !!picked && picked.id === id;
    m.marker.getElement()?.firstElementChild?.classList.toggle('picked', on);
    m.marker.setZIndexOffset(on ? 9000 : m.saved ? 5000 : m.z);
  }

  const hint = document.getElementById('map-hint');
  hint.textContent = more ? `Best ${chosen.size} here · zoom in for ${more.toLocaleString()} more` : '';
  hint.classList.toggle('hidden', !more);
}

// Creates the map the first time it is shown
export function initMap(origin, pick, dismissPick) {
  if (map) return;
  onPick = pick;
  map = L.map('map', { zoomControl: false, maxZoom: 19 }).setView([origin.lat, origin.lng], 10);
  map.attributionControl.setPrefix(false);
  map.on('click', dismissPick);
  map.on('moveend zoomend', draw);

  const layers = document.getElementById('map-layers');
  layers.innerHTML = MAP_LAYERS
    .map(l => `<button class="layer-btn" data-layer="${l.id}">${l.label}</button>`).join('');
  layers.addEventListener('click', e => {
    const btn = e.target.closest('.layer-btn');
    if (btn) setLayer(btn.dataset.layer);
  });
  let saved = null;
  try { saved = localStorage.getItem(LAYER_KEY); } catch { /* ignore */ }
  setLayer(saved);

  setOrigin(origin);
}

export function setOrigin(origin) {
  if (!map) return;
  if (originMarker) originMarker.remove();
  originMarker = L.marker([origin.lat, origin.lng], {
    icon: L.divIcon({ className: '', html: '<div class="you-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
    interactive: false,
    zIndexOffset: -1000,
  }).addTo(map);
}

export function recenter(origin) {
  if (map) map.setView([origin.lat, origin.lng], 10, { animate: true });
}

// The map was hidden while the list was showing, so it has to re-measure
export function refreshSize() {
  if (map) { map.invalidateSize(); draw(); }
}

export function flyTo(place) {
  if (map) map.setView([place.lat, place.lng], Math.max(map.getZoom(), 13), { animate: true });
}

// candidates: places from the current filter, best first; saved: hearts
export function setPins(candidates, saved) {
  ranked = candidates;
  hearts = saved;
  // Start clean so a place whose rank changed is re-drawn
  for (const m of markers.values()) m.marker.remove();
  markers.clear();
  draw();
}

// Marks the pin whose preview card is open (null clears it)
export function setPicked(place) {
  picked = place && !place.nowhere ? place : null;
  draw();
}

// Zoom to show everything in the list (used after a search)
export function fitTo(list) {
  if (!map || !list.length) return;
  map.fitBounds(L.latLngBounds(list.map(p => [p.lat, p.lng])).pad(0.15), { maxZoom: 13 });
}
