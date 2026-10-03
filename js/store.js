// What the user has done: saved, been there, not for me, taste weights, and
// places added by hand. Kept in localStorage; sync.js mirrors it to the cloud.
//
// Every entry carries the time it last changed, so two devices can merge
// without one undoing the other (the newest change wins).

import { DEFAULT_TASTE, TASTE_RANGE } from './config.js';

export const FLAG = { SAVED: 1, VISITED: 2, BAD: 4, HIDDEN: 8 };

const KEY = {
  state:  'cavaleiro_state',   // { placeId: [flags, t] }
  taste:  'cavaleiro_taste',   // { tag: [weight, t] }  only tags that moved off the default
  custom: 'cavaleiro_custom',  // { placeId: [place, t] }
  dirty:  'cavaleiro_dirty',   // { s: [ids], t: [tags], c: [ids] }  waiting to be pushed
  since:  'cavaleiro_since',   // server time of the last pull
};

const now = () => Math.floor(Date.now() / 1000);
// A change must always be newer than the entry it replaces, even when both
// happen within the same second or this device's clock runs behind.
const after = previous => Math.max(now(), (previous || 0) + 1);

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

let state  = read(KEY.state, null);
let taste  = read(KEY.taste, {});
let custom = read(KEY.custom, {});
let dirty  = read(KEY.dirty, { s: [], t: [], c: [] });

// ── Version 1 → 2 ───────────────────────────────────────────
// The first version kept four separate id lists with no timestamps. They are
// read once and left in place as a backup.
const V1_DEFAULT_TASTE = {
  waterfall: 1.2, forest: 1.1, hiking: 1.1, trail: 1.2, park: 1.2, water: 1.4, gems: 1.2,
  historic: 1.0, viewpoint: 1.2, swimming: 1.3, running: 1.3, nature: 1.1, scenic: 1.2,
};

if (state === null) {
  state = {};
  const t = now();
  const lists = { ca_favorites: FLAG.SAVED, ca_visited: FLAG.VISITED, ca_bad: FLAG.BAD, ca_hidden: FLAG.HIDDEN };
  for (const [key, bit] of Object.entries(lists)) {
    const v = read(key, []);
    const ids = Array.isArray(v) ? v : Object.keys(v);
    for (const id of ids) state[id] = [(state[id]?.[0] || 0) | bit, t];
  }
  const oldTaste = read('ca_taste', {});
  for (const [tag, w] of Object.entries(oldTaste)) {
    if (typeof w === 'number' && w !== V1_DEFAULT_TASTE[tag]) taste[tag] = [w, t];
  }
  dirty = { s: Object.keys(state), t: Object.keys(taste), c: [] };
  write(KEY.state, state);
  write(KEY.taste, taste);
  write(KEY.dirty, dirty);
}

// ── Change notifications ────────────────────────────────────
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); }
function changed(what) { listeners.forEach(fn => fn(what)); }

function markDirty(kind, id) {
  if (!dirty[kind].includes(id)) dirty[kind].push(id);
  write(KEY.dirty, dirty);
}

// ── Flags ───────────────────────────────────────────────────
export function flags(id)       { return state[id]?.[0] || 0; }
export function isSaved(id)     { return !!(flags(id) & FLAG.SAVED); }
export function isVisited(id)   { return !!(flags(id) & FLAG.VISITED); }
export function isDismissed(id) { return !!(flags(id) & (FLAG.BAD | FLAG.HIDDEN)); }

export function idsWith(bits) {
  return Object.keys(state).filter(id => state[id][0] & bits);
}

function setFlags(id, value) {
  state[id] = [value, after(state[id]?.[1])];
  write(KEY.state, state);
  markDirty('s', id);
  changed('flags');
}

export function setSaved(id, on) {
  // Saving something also takes it off the "not for me" pile
  const f = flags(id);
  setFlags(id, on ? (f | FLAG.SAVED) & ~(FLAG.BAD | FLAG.HIDDEN) : f & ~FLAG.SAVED);
}
export function setVisited(id, on) {
  const f = flags(id);
  setFlags(id, on ? f | FLAG.VISITED : f & ~FLAG.VISITED);
}
export function setDismissed(id, on) {
  const f = flags(id);
  setFlags(id, on ? (f | FLAG.BAD) & ~FLAG.SAVED : f & ~(FLAG.BAD | FLAG.HIDDEN));
}

// ── Taste ───────────────────────────────────────────────────
export function tasteWeights() {
  const out = { ...DEFAULT_TASTE };
  for (const [tag, [w]] of Object.entries(taste)) out[tag] = w;
  return out;
}

export function nudgeTaste(tags, delta) {
  const weights = tasteWeights();
  for (const tag of tags) {
    if (!(tag in weights)) continue;
    const w = Math.max(TASTE_RANGE[0], Math.min(TASTE_RANGE[1], weights[tag] + delta));
    taste[tag] = [Math.round(w * 100) / 100, after(taste[tag]?.[1])];
    markDirty('t', tag);
  }
  write(KEY.taste, taste);
  changed('taste');
}

export function resetTaste() {
  for (const tag of Object.keys(taste)) {
    taste[tag] = [DEFAULT_TASTE[tag] ?? 1, after(taste[tag][1])];
    markDirty('t', tag);
  }
  write(KEY.taste, taste);
  changed('taste');
}

// ── Places added by hand (shared from Google Maps, or typed in) ──
export function customPlaces() {
  return Object.values(custom).map(([place]) => place).filter(p => p && !p.deleted);
}

export function saveCustomPlace(place) {
  custom[place.id] = [place, after(custom[place.id]?.[1])];
  write(KEY.custom, custom);
  markDirty('c', place.id);
  changed('custom');
}

// Deleting leaves a marker behind so the other devices drop it too
export function deleteCustomPlace(id) {
  if (!custom[id]) return;
  if (state[id]) setFlags(id, 0);
  saveCustomPlace({ id, deleted: true });
}

// ── Coming from the old Android app ─────────────────────────
// The Android app is now a shell around this web app. The first time it
// runs, it hands over what the old native version had stored on the phone
// (the cloud copy of that was empty, so the phone is the only place it lives).
function importFromAndroid() {
  const native = window.CavaleiroNative;
  if (!native || localStorage.getItem('cavaleiro_android_imported')) return;
  let old;
  try { old = JSON.parse(native.legacyData()); } catch { return; }
  const t = now();
  const lists = { favorites: FLAG.SAVED, visited: FLAG.VISITED, bad: FLAG.BAD, hidden: FLAG.HIDDEN };
  for (const [key, bit] of Object.entries(lists)) {
    for (const id of old[key] || []) {
      // Anything already known here (pulled from the cloud) is newer and wins
      if (state[id] && state[id][1] !== t) continue;
      state[id] = [(state[id]?.[0] || 0) | bit, t];
      if (!dirty.s.includes(id)) dirty.s.push(id);
    }
  }
  for (const [tag, w] of Object.entries(old.taste || {})) {
    if (typeof w !== 'number' || Math.abs(w - (V1_DEFAULT_TASTE[tag] ?? 1)) < 0.005 || taste[tag]) continue;
    taste[tag] = [Math.round(w * 100) / 100, t];
    if (!dirty.t.includes(tag)) dirty.t.push(tag);
  }
  for (const p of old.places || []) {
    if (!p.id || custom[p.id]) continue;
    custom[p.id] = [{ id: p.id, name: p.name, type: p.type || 'gems', tags: [p.type || 'gems'], lat: p.lat, lng: p.lng, url: p.url || '' }, t];
    if (!dirty.c.includes(p.id)) dirty.c.push(p.id);
  }
  write(KEY.state, state);
  write(KEY.taste, taste);
  write(KEY.custom, custom);
  write(KEY.dirty, dirty);
  try { localStorage.setItem('cavaleiro_android_imported', String(t)); } catch { /* ignore */ }
}
importFromAndroid();

// ── For sync.js ─────────────────────────────────────────────
export function pending() {
  return {
    s: dirty.s.filter(id => state[id]).map(id => [id, state[id][0], state[id][1]]),
    t: dirty.t.filter(tag => taste[tag]).map(tag => [tag, taste[tag][0], taste[tag][1]]),
    c: dirty.c.filter(id => custom[id]).map(id => [id, custom[id][0], custom[id][1]]),
  };
}

// Called after the server confirmed a batch. An entry that changed again
// while the request was in the air stays dirty.
export function confirmSent(sent) {
  const still = (kind, table, tIndex) => {
    const sentAt = new Map(sent[kind].map(row => [row[0], row[2]]));
    dirty[kind] = dirty[kind].filter(id => !sentAt.has(id) || (table[id] && table[id][tIndex] !== sentAt.get(id)));
  };
  still('s', state, 1);
  still('t', taste, 1);
  still('c', custom, 1);
  write(KEY.dirty, dirty);
}

export function since() { return Number(localStorage.getItem(KEY.since)) || 0; }

// Merge rows pulled from the cloud. Returns true when anything changed.
export function mergeRemote(remote) {
  let any = false;
  for (const [id, f, t] of remote.s || []) {
    if (!state[id] || t > state[id][1]) { state[id] = [f, t]; any = true; }
  }
  for (const [tag, w, t] of remote.t || []) {
    if (!taste[tag] || t > taste[tag][1]) { taste[tag] = [w, t]; any = true; }
  }
  for (const [id, json, t] of remote.c || []) {
    if (!custom[id] || t > custom[id][1]) {
      try { custom[id] = [JSON.parse(json), t]; any = true; } catch { /* skip a broken row */ }
    }
  }
  if (any) {
    write(KEY.state, state);
    write(KEY.taste, taste);
    write(KEY.custom, custom);
  }
  if (remote.now) {
    // Go back a minute so a change that landed during the request is not missed
    try { localStorage.setItem(KEY.since, String(remote.now - 60)); } catch { /* ignore */ }
  }
  if (any) changed('remote');
  return any;
}
