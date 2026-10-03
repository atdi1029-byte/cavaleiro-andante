// The places themselves: loading, distance, filtering and ranking.
// No DOM in here.

import { CATEGORIES } from './config.js';
import * as store from './store.js';

let places = [];
const byId = new Map();
let aliases = [];   // [oldId, currentId] for entries the rebuild folded together

export function allPlaces() { return places; }
export function placeById(id) { return byId.get(id); }

function add(list) {
  for (const p of list) {
    if (!p || !p.id || byId.has(p.id)) continue;
    p.tags = p.tags || [];
    p.search = [p.name, p.where, p.in].filter(Boolean).join(' ').toLowerCase();
    byId.set(p.id, p);
    places.push(p);
  }
}

export async function loadPlaces() {
  const res = await fetch('places.json');
  if (!res.ok) throw new Error('places.json: HTTP ' + res.status);
  places = [];
  byId.clear();
  add(await res.json());
  aliases = places.flatMap(p => (p.was || []).map(oldId => [oldId, p.id]));
  store.adoptAliases(aliases);
  addCustom();
  await addArchived();
  return places;
}

// Run again after a pull from the cloud: another device may still be saving
// under an old id
export function adoptAliases() {
  return store.adoptAliases(aliases);
}

// Places the user added by hand. Called again whenever they change, so it
// first takes out the ones that were there before.
export function addCustom() {
  places = places.filter(p => !p.custom);
  for (const id of [...byId.keys()]) if (byId.get(id).custom) byId.delete(id);
  add(store.customPlaces().map(p => ({
    q: 70, ...p, tags: p.tags || [p.type], custom: true,
    // The old Android app saved some shared places without coordinates
    nowhere: !(Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat || p.lng)),
  })));
}

// The 2026 cleanup removed thousands of junk entries (pocket parks, plaques,
// unnamed path segments). If one of them was saved or marked "been there",
// it is brought back from archive.json so nothing the user chose disappears.
export async function addArchived() {
  const kept = store.idsWith(store.FLAG.SAVED | store.FLAG.VISITED);
  if (kept.every(id => byId.has(id))) return false;
  try {
    const res = await fetch('archive.json');
    if (!res.ok) return false;
    const wanted = new Set(kept);
    const before = places.length;
    add((await res.json())
      .filter(row => wanted.has(row[0]))
      .map(([id, name, type, lat, lng]) => ({ id, name, type, lat, lng, tags: [type], q: 30 })));
    return places.length > before;
  } catch { return false; /* offline: they come back next time */ }
}

// ── Distance ────────────────────────────────────────────────
export function miles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function measureFrom(origin) {
  for (const p of places) p.dist = p.nowhere ? Infinity : miles(origin.lat, origin.lng, p.lat, p.lng);
}

// ── Taste ───────────────────────────────────────────────────
// Average weight of a place's tags; 1.0 is neutral.
export function tasteScore(p, weights) {
  let sum = 0, n = 0;
  for (const tag of p.tags) {
    if (tag in weights) { sum += weights[tag]; n++; }
  }
  return n ? sum / n : 1;
}

// ── Filtering ───────────────────────────────────────────────
// view = { category, sub, maxMiles, text }
export function select(view) {
  const cat = CATEGORIES.find(c => c.id === view.category) || CATEGORIES[0];
  const sub = cat.subs?.find(s => s.id === view.sub);
  const words = (view.text || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matchesText = p => words.every(w => p.search.includes(w) || p.tags.includes(w));

  // Typing a name searches everything: any category, any distance, saved or
  // not. Only places you hid stay out.
  if (words.length) return places.filter(p => matchesText(p) && !store.isDismissed(p.id));

  if (cat.id === 'saved') {
    // My Places ignores the distance filter: it is a list of what you chose
    const want = sub?.id === 'been' ? p => store.isVisited(p.id)
      : sub?.id === 'hidden' ? p => store.isDismissed(p.id)
      : p => store.isSaved(p.id);
    return places.filter(want);
  }

  return places.filter(p =>
    p.dist <= view.maxMiles &&
    // The lists are for finding somewhere new: saved, visited and dismissed
    // places live under My Places instead
    !store.flags(p.id) &&
    cat.match(p) && (!sub || sub.match(p)));
}

// Saved places that fit the current category, for the map (hearts stay
// visible there even though the list leaves them out)
export function savedFor(view) {
  const cat = CATEGORIES.find(c => c.id === view.category) || CATEGORIES[0];
  if (cat.id === 'saved') return [];
  return places.filter(p => store.isSaved(p.id) && cat.match(p));
}

// ── Ranking ─────────────────────────────────────────────────
// "Best" balances how good a place is (q, 0-100), how well it fits the
// user's taste, and how far away it is. Every mile costs a little, so a
// great park 10 miles away beats a slightly better one 90 miles away, but a
// must-see still shows up from across the region.
//
// Taste is a nudge of up to about ±20%, measured against the user's own
// average: after a year of saving places most weights sit near the maximum,
// and what matters is which kinds stand out from the rest.
const MILE_COST = 0.3;
const OWN_KIND = 12;   // head start for a waterfall in Waterfalls over a park that has one

export function rank(list, sort, types = []) {
  // (places without a location have an infinite distance and go last)
  if (sort === 'near') return [...list].sort((a, b) => (a.dist === b.dist ? 0 : a.dist - b.dist));
  const weights = store.tasteWeights();
  const values = Object.values(weights);
  const usual = values.reduce((a, b) => a + b, 0) / values.length || 1;
  const scored = list.map(p => {
    const lean = Math.max(0.3, Math.min(2, tasteScore(p, weights) / usual));
    return { p, s: (p.q || 30) * (0.8 + 0.2 * lean) - MILE_COST * Math.min(p.dist, 200) + (types.includes(p.type) ? OWN_KIND : 0) };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map(x => x.p);
}

// A random pick from the better half of what is on screen
export function surprise(list, types) {
  const pool = rank(list, 'best', types).slice(0, Math.max(5, Math.min(40, Math.ceil(list.length / 4))));
  return pool[Math.floor(Math.random() * pool.length)];
}
