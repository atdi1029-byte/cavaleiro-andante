// Cavaleiro Andante: find hikes, beaches, waterfalls, views and odd corners
// near you. This file holds the app's state and wires the pieces together:
//
//   config.js   settings (categories, colors, map layers)
//   store.js    what you saved / visited / hid, and your taste
//   sync.js     keeps store.js in step with the Google Sheet
//   catalog.js  the places: loading, filtering, ranking
//   ui.js       HTML for cards, the detail sheet, etc.
//   map.js      the Leaflet map
//   addplace.js adding a place of your own (shared from Google Maps or typed)
//   weather.js  is it raining? (offers the Rainy day list)

import { HOME, COVERAGE_MILES, REGION_BOX, TASTE_STEP, CATEGORIES } from './config.js';
import * as store from './store.js';
import * as catalog from './catalog.js';
import * as ui from './ui.js';
import * as mapView from './map.js';
import { startSync } from './sync.js';
import { parseShared, locate as findCoords, placeFromDraft, validCoords } from './addplace.js';
import { rainAt } from './weather.js';

const $ = id => document.getElementById(id);
const PAGE = 30;

// What is on screen right now
const view = {
  category: 'all',
  sub: null,
  maxMiles: Infinity,
  sort: 'best',       // 'best' | 'near'
  text: '',
  mode: 'list',       // 'list' | 'map'
};
let origin = { ...HOME, kind: 'home' };   // kind: home | gps | search
let results = [];       // ranked places for the current view
let shown = 0;          // how many cards are in the list so far
let peekId = null;      // place previewed on the map
let ready = false;

// ── Rendering ───────────────────────────────────────────────
function countLabel() {
  $('count').textContent = view.text
    ? `${results.length} for “${view.text}”`
    : `${results.length.toLocaleString()} place${results.length === 1 ? '' : 's'}`;
}

// The kinds of place the current category is about (ranked ahead of the rest)
const ownTypes = () => (view.text ? [] : CATEGORIES.find(c => c.id === view.category)?.types || []);

function drawPins() {
  // The map always puts the best places on top, whatever the list is sorted by
  const best = view.sort === 'best' ? results : catalog.rank(results, 'best', ownTypes());
  mapView.setPins(best, view.text ? [] : catalog.savedFor(view));
  if (peekId && !results.some(p => p.id === peekId) && !store.isSaved(peekId)) hidePeek();
}

// Work out what belongs on screen and draw it. keepLength re-draws as many
// cards as were showing, so the page does not jump while you are scrolled down.
function refresh(keepLength = false) {
  if (!ready) return;
  results = catalog.rank(catalog.select(view), view.category === 'saved' ? 'near' : view.sort, ownTypes());
  countLabel();
  if (view.mode === 'map') return drawPins();
  const n = Math.min(results.length, keepLength ? Math.max(shown, PAGE) : PAGE);
  const addButton = view.category === 'saved' && !view.sub && !view.text
    ? '<button class="add-place" data-act="add-place">＋ Add a place of your own</button>' : '';
  $('list').innerHTML = results.length ? addButton + results.slice(0, n).map(ui.cardHtml).join('') : ui.emptyHtml(view);
  shown = n;
}

function showMore() {
  if (shown >= results.length) return;
  const next = results.slice(shown, shown + PAGE);
  $('list').insertAdjacentHTML('beforeend', next.map(ui.cardHtml).join(''));
  shown += next.length;
}

// After a heart / been there / hide: take cards out that no longer belong and
// fix the hearts, without re-sorting the list under the user's thumb.
function afterFlagChange() {
  if (!ready) return;
  const belongs = new Set(catalog.select(view).map(p => p.id));
  const kept = results.filter(p => belongs.has(p.id));
  if (kept.length < belongs.size) return refresh(true);   // something came back (Undo)
  results = kept;
  countLabel();
  if (view.mode === 'map') {
    drawPins();
    const p = peekId && catalog.placeById(peekId);
    if (p) $('map-peek').innerHTML = ui.cardHtml(p);
    return;
  }
  document.querySelectorAll('#list .card').forEach(card => {
    if (!belongs.has(card.dataset.id)) { card.remove(); shown--; return; }
    const heart = card.querySelector('.card-heart');
    const on = store.isSaved(card.dataset.id);
    heart.classList.toggle('on', on);
    heart.textContent = on ? '♥' : '♡';
  });
  if (!results.length) $('list').innerHTML = ui.emptyHtml(view);
}

function renderChrome() {
  ui.markCategory(view.text ? null : view.category);
  ui.renderSubs(view.text ? null : view.category, view.sub);
  ui.renderDistances(view.maxMiles);
  ui.renderSort(view.sort);
  $('filters').classList.toggle('hidden', view.category === 'saved' || !!view.text);
  $('search-clear').classList.toggle('hidden', !view.text);
}

function setMode(mode) {
  view.mode = mode;
  document.body.classList.toggle('map-mode', mode === 'map');
  document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('list-view').classList.toggle('hidden', mode === 'map');
  $('map-view').classList.toggle('hidden', mode !== 'map');
  hidePeek();
  if (mode === 'map') {
    window.scrollTo(0, 0);
    mapView.initMap(origin, showPeek, hidePeek);
    mapView.refreshSize();
  }
  refresh();
  if (mode === 'map' && view.text) mapView.fitTo(results.slice(0, 40));
}

// ── Map preview card ────────────────────────────────────────
function showPeek(place) {
  peekId = place.id;
  $('map-peek').innerHTML = ui.cardHtml(place);
  $('map-peek').classList.remove('hidden');
  $('map-view').classList.add('has-peek');
  mapView.setPicked(place);
}
function hidePeek() {
  peekId = null;
  $('map-peek').classList.add('hidden');
  $('map-view').classList.remove('has-peek');
  mapView.setPicked(null);
}

// ── Rain ────────────────────────────────────────────────────
// When it is raining at the starting point (or about to), offer the Rainy
// day list instead of a page of hikes.
async function checkRain() {
  const from = origin;
  const rain = await rainAt(from);
  if (from !== origin) return;
  const tip = $('rain-tip');
  const show = rain && (rain.now || rain.soon) && view.category !== 'rain';
  tip.classList.toggle('hidden', !show);
  if (show) {
    tip.innerHTML = `<span>${rain.now ? '🌧️ Raining' : '🌦️ Rain on the way'} near ${ui.esc(origin.label)}</span><b>Rainy-day ideas ›</b>`;
  }
}

// ── Starting point ──────────────────────────────────────────
function setOrigin(next) {
  origin = next;
  $('origin-label').textContent = origin.label;
  catalog.measureFrom(origin);
  mapView.setOrigin(origin);
  mapView.recenter(origin);

  // Far outside the covered area every distance would read in the thousands
  // of miles. Say what is going on and offer the way back.
  const away = catalog.miles(HOME.lat, HOME.lng, origin.lat, origin.lng);
  const notice = $('notice');
  if (away > COVERAGE_MILES) {
    notice.innerHTML = `You are about <b>${Math.round(away).toLocaleString()} miles</b> from the area this app covers
      (Maryland, DC, Virginia, West Virginia, Pennsylvania and Delaware), so everything will look far away.
      <br><button data-act="origin-home">Measure from home instead</button>`;
    notice.classList.remove('hidden');
  } else {
    notice.classList.add('hidden');
  }
  refresh();
  checkRain();
}

function locate(quiet) {
  if (!navigator.geolocation) { if (!quiet) ui.toast('This device has no location service'); return; }
  if (!quiet) ui.toast('Finding you…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    setOrigin({ lat, lng, label: 'your location', kind: 'gps' });
    // Put a town name on it when the network allows
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=12`);
      const a = (await res.json()).address || {};
      const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
      const state = (a['ISO3166-2-lvl4'] || '').split('-')[1] || a.state || '';
      if (town && origin.kind === 'gps') {
        origin.label = state ? `${town}, ${state}` : town;
        $('origin-label').textContent = origin.label;
      }
    } catch { /* keep "your location" */ }
  }, err => {
    if (!quiet) ui.toast(err.code === 1 ? 'Location is switched off for this app' : 'Could not find your location');
  }, { timeout: 10000, maximumAge: 300000 });
}

// "Look around another town": only places inside the covered region count,
// so a typo can no longer drop the starting point on another continent.
async function searchArea(query) {
  const msg = $('area-msg');
  msg.textContent = 'Looking…';
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&bounded=1' +
      `&viewbox=${REGION_BOX.join(',')}&q=${encodeURIComponent(query)}`;
    const hits = await (await fetch(url)).json();
    if (!hits.length) {
      msg.textContent = 'No town by that name in Maryland or the states around it.';
      return;
    }
    const parts = hits[0].display_name.split(',').map(s => s.trim());
    setOrigin({ lat: +hits[0].lat, lng: +hits[0].lon, label: parts.slice(0, 2).join(', '), kind: 'search' });
    closeSheet();
  } catch {
    msg.textContent = 'Search needs an internet connection.';
  }
}

// ── Actions on a place ──────────────────────────────────────
function toggleSaved(id) {
  const p = catalog.placeById(id);
  if (!p) return;
  const on = !store.isSaved(id);
  store.setSaved(id, on);
  store.nudgeTaste(p.tags, on ? TASTE_STEP.save : TASTE_STEP.unsave);
  ui.toast(on ? 'Saved to My Places' : 'Removed from My Places', () => {
    store.setSaved(id, !on);
    store.nudgeTaste(p.tags, on ? -TASTE_STEP.save : -TASTE_STEP.unsave);
  });
}

function toggleVisited(id) {
  const p = catalog.placeById(id);
  if (!p) return;
  const on = !store.isVisited(id);
  store.setVisited(id, on);
  if (on) store.nudgeTaste(p.tags, TASTE_STEP.visit);
  ui.toast(on ? 'Marked as been there' : 'No longer marked as been there', () => {
    store.setVisited(id, !on);
    if (on) store.nudgeTaste(p.tags, -TASTE_STEP.visit);
  });
}

function toggleDismissed(id) {
  const p = catalog.placeById(id);
  if (!p) return;
  const on = !store.isDismissed(id);
  store.setDismissed(id, on);
  store.nudgeTaste(p.tags, on ? TASTE_STEP.dismiss : TASTE_STEP.restore);
  ui.toast(on ? 'Hidden. Find it under My Places › Hidden' : 'Brought back', () => {
    store.setDismissed(id, !on);
    store.nudgeTaste(p.tags, on ? -TASTE_STEP.dismiss : -TASTE_STEP.restore);
  });
}

function askClaude(p) {
  const text = `Tell me about this place and whether it is worth visiting:

Name: ${p.name}
Kind: ${p.type}${p.where ? '\nWhere: ' + p.where : ''}${p.in ? '\nInside: ' + p.in : ''}
Coordinates: ${p.lat}, ${p.lng}
Distance from me: ${ui.fmtMiles(p.dist)}
${p.desc ? 'What I know: ' + p.desc + '\n' : ''}
Is it worth the drive? What should I expect, when is the best time to go, where do I park, and is there anything good nearby to pair it with? Talk like a local friend who knows the area.`;
  if (window.CavaleiroNative?.copy) window.CavaleiroNative.copy(text);
  else navigator.clipboard?.writeText(text).catch(() => {});
  ui.toast('Question copied. Paste it into Claude');
  window.open('https://claude.ai/new', '_blank', 'noopener');
}

// ── Sheets ──────────────────────────────────────────────────
// Opening a sheet adds a history entry, so the phone's Back button closes
// the sheet instead of leaving the app.
let sheetKind = null;
let sheetPlace = null;

function openSheet(kind, html) {
  if (!ui.sheetIsOpen()) history.pushState({ sheet: true }, '');
  sheetKind = kind;
  ui.openSheet(html);
}
function closeSheet() {
  if (!ui.sheetIsOpen()) return;
  ui.closeSheet();
  sheetKind = sheetPlace = null;
  if (history.state?.sheet) history.back();
}

function openPlace(id) {
  const p = catalog.placeById(id);
  if (!p) return;
  sheetPlace = id;
  openSheet('place', ui.detailHtml(p));
}

// ── Adding a place of your own ──────────────────────────────
let draft = null;       // the place being added
let draftType = 'gems';
let draftStatus = 'looking';

function drawDraft() {
  const name = $('add-name');
  if (name) draft.name = name.value.trim();
  const distance = validCoords(draft.lat, draft.lng) ? catalog.miles(origin.lat, origin.lng, draft.lat, draft.lng) : NaN;
  openSheet('add', ui.addDraftHtml(draft, draftStatus, draftType, distance));
}

// text: what another app shared ("Pot Rocks\nhttps://maps…"), or what was
// typed into "Add a place". The Android shell expands short links first.
async function startAdd(text) {
  draft = parseShared(text);
  draftType = 'gems';
  draftStatus = validCoords(draft.lat, draft.lng) ? 'found' : 'looking';
  drawDraft();
  if (draftStatus === 'looking') {
    const adding = draft;
    const ok = await findCoords(adding);
    if (draft !== adding || sheetKind !== 'add') return;   // closed or replaced meanwhile
    draftStatus = ok ? 'found' : 'missing';
    drawDraft();
  }
}

function finishAdd() {
  draft.name = $('add-name').value.trim();
  const typed = $('add-coords') && parseShared($('add-coords').value);
  if (typed && validCoords(typed.lat, typed.lng)) { draft.lat = typed.lat; draft.lng = typed.lng; }
  if (!draft.name) return ui.toast('Give it a name first');
  if (!validCoords(draft.lat, draft.lng)) return ui.toast('It needs a location before it can be added');
  const place = placeFromDraft(draft, draftType, id => !!catalog.placeById(id));
  store.saveCustomPlace(place);
  store.setSaved(place.id, true);
  draft = null;
  closeSheet();
  view.category = 'saved'; view.sub = null; view.text = '';
  $('search-input').value = '';
  renderChrome();
  refresh();
  ui.toast(`Added “${place.name}” to My Places`);
}

async function findCustom(id) {
  const p = catalog.placeById(id);
  if (!p) return;
  ui.toast('Looking for it…');
  const d = { name: p.name, query: p.name, url: p.url };
  if (await findCoords(d)) {
    store.saveCustomPlace({ id: p.id, name: p.name, type: p.type, tags: p.tags, lat: +d.lat.toFixed(5), lng: +d.lng.toFixed(5), url: p.url || '' });
    if (sheetPlace === id) openSheet('place', ui.detailHtml(catalog.placeById(id)));
    ui.toast('Found it. Check the distance looks right');
  } else {
    ui.toast('Could not find it by name. Delete it and share it from Google Maps again');
  }
}

// ── Events ──────────────────────────────────────────────────
function wire() {
  $('cats').addEventListener('click', e => {
    const btn = e.target.closest('.cat');
    if (!btn) return;
    view.category = btn.dataset.cat;
    view.sub = null;
    view.text = '';
    $('search-input').value = '';
    renderChrome();
    refresh();
    checkRain();
  });

  $('subs').addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    view.sub = btn.dataset.sub || null;
    renderChrome();
    refresh();
  });

  $('dist-pills').addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    view.maxMiles = Number(btn.dataset.miles);
    renderChrome();
    refresh();
  });

  $('sort-btn').addEventListener('click', () => {
    view.sort = view.sort === 'best' ? 'near' : 'best';
    renderChrome();
    refresh();
  });

  $('mode').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn && btn.dataset.mode !== view.mode) setMode(btn.dataset.mode);
  });

  $('rain-tip').addEventListener('click', () => {
    view.category = 'rain'; view.sub = null; view.text = '';
    $('search-input').value = '';
    $('rain-tip').classList.add('hidden');
    renderChrome();
    refresh();
  });

  $('surprise-btn').addEventListener('click', () => {
    const pick = catalog.surprise(results, ownTypes());
    if (pick) openPlace(pick.id); else ui.toast('Nothing to pick from here');
  });

  // Search filters by name as you type
  let typing = null;
  $('search-input').addEventListener('input', e => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      view.text = e.target.value.trim();
      renderChrome();
      refresh();
      if (view.text && view.mode === 'map') mapView.fitTo(results.slice(0, 40));
    }, 160);
  });
  $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('search-clear').addEventListener('click', clearSearch);

  $('origin-btn').addEventListener('click', () => openSheet('origin', ui.originHtml(origin)));
  $('taste-btn').addEventListener('click', () => openSheet('taste', ui.tasteHtml(store.tasteWeights())));
  $('map-home').addEventListener('click', () => mapView.recenter(origin));

  // Cards: in the list and in the map preview
  const onCard = e => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (e.target.closest('[data-act="save"]')) toggleSaved(card.dataset.id);
    else openPlace(card.dataset.id);
  };
  $('list').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'clear-search') return clearSearch();
    if (act === 'add-place') return openSheet('add', ui.addStartHtml());
    if (act === 'any-distance') { view.maxMiles = Infinity; renderChrome(); return refresh(); }
    onCard(e);
  });
  $('map-peek').addEventListener('click', onCard);

  $('notice').addEventListener('click', e => {
    if (e.target.closest('[data-act="origin-home"]')) setOrigin({ ...HOME, kind: 'home' });
  });

  // Everything inside the bottom sheet
  $('sheet-body').addEventListener('click', e => {
    const typeChip = e.target.closest('[data-add-type]');
    if (typeChip) { draftType = typeChip.dataset.addType; return drawDraft(); }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const id = sheetPlace;
    if (act === 'find-custom') return findCustom(id);
    if (act === 'delete-custom') {
      const name = catalog.placeById(id)?.name;
      store.deleteCustomPlace(id);
      closeSheet();
      return ui.toast(`Deleted “${name}”`);
    }
    if (act === 'save')    { toggleSaved(id); return openSheet('place', ui.detailHtml(catalog.placeById(id))); }
    if (act === 'been')    { toggleVisited(id); return openSheet('place', ui.detailHtml(catalog.placeById(id))); }
    if (act === 'dismiss') { toggleDismissed(id); return closeSheet(); }
    if (act === 'claude')  return askClaude(catalog.placeById(id));
    if (act === 'map') {
      const p = catalog.placeById(id);
      closeSheet();
      if (view.mode !== 'map') setMode('map');
      mapView.flyTo(p);
      return showPeek(p);
    }
    if (act === 'origin-gps')  { closeSheet(); return locate(false); }
    if (act === 'origin-home') { closeSheet(); return setOrigin({ ...HOME, kind: 'home' }); }
    if (act === 'taste-reset') { store.resetTaste(); return openSheet('taste', ui.tasteHtml(store.tasteWeights())); }
  });
  $('sheet-body').addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.id === 'area-form') {
      const q = $('area-input').value.trim();
      if (q) searchArea(q);
    } else if (e.target.id === 'add-find-form') {
      const q = $('add-find-input').value.trim();
      if (q) startAdd(q);
    } else if (e.target.id === 'add-form') {
      finishAdd();
    }
  });

  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', e => { if (e.target.id === 'sheet-backdrop') closeSheet(); });
  window.addEventListener('popstate', () => { if (ui.sheetIsOpen()) { ui.closeSheet(); sheetKind = sheetPlace = null; } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  // More cards as the end of the list comes into view
  new IntersectionObserver(entries => {
    if (entries.some(en => en.isIntersecting) && view.mode === 'list') showMore();
  }, { rootMargin: '600px' }).observe($('more-sentinel'));

  store.onChange(what => {
    if (what === 'remote' || what === 'custom') {
      // Places you added yourself, here or on another device
      catalog.addCustom();
      catalog.measureFrom(origin);
      refresh(true);
      // Saved places pulled from the cloud may be ones the cleanup archived
      if (what === 'remote') {
        catalog.addArchived().then(added => {
          if (added) { catalog.measureFrom(origin); refresh(true); }
        });
      }
    } else if (what === 'flags') {
      afterFlagChange();
    }
    // 'taste' changes take effect the next time the list is sorted
  });
}

function clearSearch() {
  view.text = '';
  $('search-input').value = '';
  renderChrome();
  refresh();
}

// ── Start ───────────────────────────────────────────────────
async function start() {
  ui.renderCategories();
  renderChrome();
  wire();
  try {
    await catalog.loadPlaces();
  } catch (e) {
    $('list').innerHTML = `<div class="empty"><span class="empty-icon">📡</span><h3>Could not load the places</h3>
      <p>Check your connection and open the app again.</p></div>`;
    console.error(e);
    return;
  }
  catalog.measureFrom(origin);
  ready = true;
  refresh();
  startSync();
  checkRain();

  // A place shared from Google Maps: the Android shell calls cavaleiroShared;
  // the installed web app receives it as ?text=… (see manifest.json)
  window.cavaleiroShared = startAdd;
  window.CavaleiroNative?.ready?.();
  const shared = new URLSearchParams(location.search);
  const sharedText = ['title', 'text', 'url'].map(k => shared.get(k)).filter(Boolean).join('\n');
  if (sharedText) {
    history.replaceState(null, '', location.pathname);
    startAdd(sharedText);
  }

  // Use the phone's location straight away only when that was already
  // allowed; otherwise wait until "Where I am right now" is tapped.
  if (window.CavaleiroNative?.hasLocation) {
    if (window.CavaleiroNative.hasLocation()) locate(true);
    return;
  }
  try {
    const perm = await navigator.permissions.query({ name: 'geolocation' });
    if (perm.state === 'granted') locate(true);
  } catch { /* Permissions API missing: stay on home */ }
}

start();
