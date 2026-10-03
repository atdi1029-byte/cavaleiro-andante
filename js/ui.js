// Everything that turns data into HTML. No app state in here: functions take
// what they need and return markup or fill a given element.

import { CATEGORIES, DISTANCES, HOME, TYPES, typeOf } from './config.js';
import * as store from './store.js';

const $ = id => document.getElementById(id);

export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtMiles(d) {
  if (!Number.isFinite(d)) return '';
  return (d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString()) + ' mi';
}

// ── Category cards and chips ────────────────────────────────
export function renderCategories() {
  $('cats').innerHTML = CATEGORIES.map(c => `
    <button class="cat" data-cat="${c.id}">
      <img src="${c.photo}" alt="" loading="lazy">
      <span class="cat-label">${c.emoji} ${c.label}</span>
    </button>`).join('');
}

export function markCategory(active) {
  document.querySelectorAll('#cats .cat').forEach(btn => {
    const on = btn.dataset.cat === active;
    btn.classList.toggle('active', on);
    if (on) btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  });
}

export function renderSubs(categoryId, activeSub) {
  const cat = CATEGORIES.find(c => c.id === categoryId);
  const el = $('subs');
  if (!cat?.subs) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const first = cat.allLabel || 'All ' + cat.label.toLowerCase();
  el.classList.remove('hidden');
  el.innerHTML = [{ id: '', label: first }, ...cat.subs].map(s =>
    `<button class="chip${(s.id || null) === (activeSub || null) ? ' active' : ''}" data-sub="${s.id}">${esc(s.label)}</button>`).join('');
}

export function renderDistances(activeMiles) {
  $('dist-pills').innerHTML = DISTANCES.map(d =>
    `<button class="chip${d.miles === activeMiles ? ' active' : ''}" data-miles="${d.miles}">${d.label}</button>`).join('');
}

export function renderSort(sort) {
  $('sort-btn').textContent = sort === 'near' ? '↕ Nearest first' : '↕ Best first';
}

// ── Cards ───────────────────────────────────────────────────
function factTags(p) {
  const f = p.facts || {};
  const out = [];
  if (f.len)    out.push(`${f.len} mi of trail`);
  if (f.gain)   out.push(`↑ ${Number(f.gain).toLocaleString()} ft`);
  if (f.height) out.push(`${f.height} ft tall`);
  return out;
}

export function cardHtml(p) {
  const t = typeOf(p);
  const saved = store.isSaved(p.id);
  const photo = p.img ? `<img class="card-photo" src="${esc(p.img)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  const tags = [`<span class="tag dist">${p.nowhere ? 'No location yet' : fmtMiles(p.dist)}</span>`,
    ...factTags(p).slice(0, 2).map(x => `<span class="tag">${esc(x)}</span>`)].join('');
  return `
<article class="card" data-id="${esc(p.id)}" style="--c:${t.color}">
  <div class="card-thumb">
    <span class="card-emoji">${t.emoji}</span>${photo}
    ${p.q >= 80 ? '<span class="card-top">★ Top pick</span>' : ''}
  </div>
  <div class="card-body">
    <h3 class="card-name">${esc(p.name)}</h3>
    <p class="card-sub"><b>${t.label}</b>${p.where ? ' · ' + esc(p.where) : ''}</p>
    ${p.desc ? `<p class="card-desc">${esc(p.desc)}</p>` : ''}
    <p class="card-foot">${tags}</p>
  </div>
  <button class="card-heart${saved ? ' on' : ''}" data-act="save" aria-label="${saved ? 'Remove from My Places' : 'Save to My Places'}">${saved ? '♥' : '♡'}</button>
</article>`;
}

export function emptyHtml(view) {
  if (view.text) {
    return `<div class="empty"><span class="empty-icon">🔎</span><h3>No place called “${esc(view.text)}”</h3>
      <p>Try fewer letters, or a town name.</p><button data-act="clear-search">Clear search</button></div>`;
  }
  if (view.category === 'saved') {
    const what = view.sub === 'been' ? ['✅', 'Nowhere marked yet', 'Open a place and tap “Been there” to keep a list of where you have been.']
      : view.sub === 'hidden' ? ['🙈', 'Nothing hidden', 'Places you mark “Not for me” end up here, and you can bring them back.']
      : ['❤️', 'No saved places yet', 'Tap the heart on any place and it shows up here.'];
    return `<div class="empty"><span class="empty-icon">${what[0]}</span><h3>${what[1]}</h3><p>${what[2]}</p>
      ${view.sub ? '' : '<button data-act="add-place">＋ Add a place of your own</button>'}</div>`;
  }
  return `<div class="empty"><span class="empty-icon">🧭</span><h3>Nothing that close</h3>
    <p>No places match within this distance.</p><button data-act="any-distance">Show any distance</button></div>`;
}

// ── Place details ───────────────────────────────────────────
function bigPhoto(url) {
  // Wikimedia thumbnails come in fixed widths; ask for the larger one
  return url.replace(/\/(\d+)px-/, (m, w) => (Number(w) < 960 ? '/960px-' : m)).replace(/([?&]width=)\d+/, '$1960');
}

export function detailHtml(p) {
  const t = typeOf(p);
  const saved = store.isSaved(p.id), been = store.isVisited(p.id), gone = store.isDismissed(p.id);
  const f = p.facts || {};
  const q = encodeURIComponent(p.name + (p.where ? ', ' + p.where : ''));
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

  // Short facts become tiles; long ones (a fee with conditions) become lines
  const all = [
    Number.isFinite(p.dist) && ['Distance', fmtMiles(p.dist)],
    f.len && ['Length', `${f.len} mi`],
    f.gain && ['Climb', `${Number(f.gain).toLocaleString()} ft`],
    f.height && ['Height', `${f.height} ft`],
    f.ele && ['Elevation', `${Number(f.ele).toLocaleString()} ft`],
    f.built && ['Built', f.built],
    f.abandoned && ['Abandoned', f.abandoned],
    f.fee && ['Fee', f.fee],
    f.hours && ['Open', f.hours],
    f.reserve && ['Tickets', f.reserve],
    f.dogs && ['Dogs', f.dogs],
    f.swim && ['Swimming', f.swim],
  ].filter(Boolean).map(([k, v]) => [k, String(v)]);
  const facts = all.filter(([, v]) => v.length <= 18)
    .map(([k, v]) => `<div class="fact">${k}<b>${esc(v)}</b></div>`).join('');
  const lines = all.filter(([, v]) => v.length > 18)
    .map(([k, v]) => `<p class="place-line"><b>${k}:</b> ${esc(v)}</p>`).join('');

  const links = [
    `<a class="link" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener"><span>🗺️</span>Google Maps</a>`,
    `<a class="link" href="https://www.google.com/search?tbm=isch&q=${q}" target="_blank" rel="noopener"><span>📷</span>Photos</a>`,
    p.url && `<a class="link" href="${esc(p.url)}" target="_blank" rel="noopener"><span>${/wikipedia\.org/.test(p.url) ? '📖' : '🔗'}</span>${/wikipedia\.org/.test(p.url) ? 'Wikipedia' : 'Website'}</a>`,
    ['hike', 'trail', 'waterfall', 'viewpoint', 'run'].includes(p.type) &&
      `<a class="link" href="https://www.alltrails.com/search?q=${encodeURIComponent(p.name)}" target="_blank" rel="noopener"><span>🥾</span>AllTrails</a>`,
    ['gems', 'caves', 'historic', 'weird'].includes(p.type) &&
      `<a class="link" href="https://www.atlasobscura.com/search?q=${encodeURIComponent(p.name)}" target="_blank" rel="noopener"><span>🔮</span>Atlas Obscura</a>`,
    `<button class="link" data-act="map"><span>📍</span>Show on map</button>`,
    `<button class="link" data-act="claude"><span>🤖</span>Ask Claude</button>`,
  ].filter(Boolean).join('');

  return `
<div class="place" data-id="${esc(p.id)}" style="--c:${t.color}">
  <div class="hero${p.img ? '' : ' hero-plain'}">
    <span class="hero-emoji">${t.emoji}</span>
    ${p.img ? `<img src="${esc(bigPhoto(p.img))}" data-small="${esc(p.img)}" alt=""
      onerror="if(this.dataset.tried){this.remove()}else{this.dataset.tried=1;this.src=this.dataset.small}">
    <span class="hero-credit">Photo: Wikimedia Commons</span>` : ''}
  </div>
  <div class="sheet-pad">
    <span class="place-type">${t.emoji} ${t.label}${p.q >= 80 ? ' · ★ Top pick' : ''}</span>
    <h2 class="sheet-title">${esc(p.name)}</h2>
    ${p.where || p.in ? `<p class="place-where">${p.where ? esc(p.where) : ''}${p.where && p.in ? ' · ' : ''}${p.in ? '<b>' + esc(p.in) + '</b>' : ''}</p>` : ''}
    ${facts ? `<div class="facts">${facts}</div>` : ''}
    ${p.desc ? `<p class="place-desc">${esc(p.desc)}</p>` : ''}
    ${lines}
    ${f.access ? `<p class="place-note">⚠️ ${esc(f.access)}</p>` : ''}
    ${p.nowhere ? `<p class="place-note">📍 This place was saved without a location, so it has no distance and is not on the map.</p>
    <div class="btn-row"><button class="btn btn-go" data-act="find-custom">🔎 Find where it is</button></div>` : `
    <div class="btn-row">
      <a class="btn btn-go" href="${directions}" target="_blank" rel="noopener">🚗 Directions</a>
    </div>`}
    <div class="btn-row">
      <button class="btn btn-save${saved ? ' on' : ''}" data-act="save">${saved ? '♥ Saved' : '♡ Save'}</button>
      <button class="btn btn-been${been ? ' on' : ''}" data-act="been">${been ? '✓ Been there' : 'Been there'}</button>
    </div>
    <div class="links">${links}</div>
    ${p.custom
      ? '<button class="quiet-btn" data-act="delete-custom">🗑 Delete this place (you added it)</button>'
      : `<button class="quiet-btn" data-act="dismiss">${gone ? '↩︎ Bring this place back' : '🙈 Not for me (hide it)'}</button>`}
  </div>
</div>`;
}

// ── Starting point ──────────────────────────────────────────
export function originHtml(origin) {
  const atHome = origin.kind === 'home';
  return `
<div class="sheet-pad">
  <h2 class="sheet-title">Where are you starting from?</h2>
  <p class="sheet-lead">Distances and “near me” are measured from here.</p>
  <button class="opt${origin.kind === 'gps' ? ' active' : ''}" data-act="origin-gps">
    <span class="opt-icon">📍</span><span><b>Where I am right now</b><small>Uses your phone's location</small></span>
  </button>
  <button class="opt${atHome ? ' active' : ''}" data-act="origin-home">
    <span class="opt-icon">🏡</span><span><b>Home</b><small>${esc(HOME.label)}</small></span>
  </button>
  <p class="sheet-lead" style="margin-top:18px">Or look around another town:</p>
  <form class="area-form" id="area-form">
    <input id="area-input" type="text" placeholder="Frederick, Harpers Ferry, 21401…" autocomplete="off" enterkeyhint="go">
    <button type="submit">Go</button>
  </form>
  <p class="form-msg" id="area-msg"></p>
</div>`;
}

// ── Adding a place of your own ──────────────────────────────
const ADD_TYPES = ['park', 'hike', 'beach', 'water', 'waterfall', 'viewpoint', 'swim', 'gems', 'caves', 'historic', 'run', 'camp'];

export function addStartHtml() {
  return `
<div class="sheet-pad">
  <h2 class="sheet-title">Add a place</h2>
  <p class="sheet-lead">Paste a Google Maps link, type coordinates, or just type the name and town.
  From Google Maps you can also tap Share and pick Cavaleiro.</p>
  <form class="area-form" id="add-find-form">
    <input id="add-find-input" type="text" placeholder="Link, or “Pot Rocks, Kingsville MD”" autocomplete="off" enterkeyhint="go">
    <button type="submit">Find</button>
  </form>
  <p class="form-msg" id="add-find-msg"></p>
</div>`;
}

// status: 'looking' | 'found' | 'missing'
export function addDraftHtml(draft, status, type, distance) {
  const where = status === 'looking' ? '🔎 Working out where this is…'
    : status === 'missing' ? `⚠️ Could not work out where this is, so it cannot be added yet. In Google Maps, tap the
       place so its own page opens, then share from there. Or paste its coordinates below.`
    : `📍 ${draft.lat.toFixed(4)}, ${draft.lng.toFixed(4)} · ${fmtMiles(distance)} from you` +
      (draft.guessed ? '<br>Found by name. Check the distance looks right before adding.' : '');
  return `
<div class="sheet-pad">
  <h2 class="sheet-title">Add a place</h2>
  <form id="add-form">
    <p class="sheet-lead">Name</p>
    <div class="area-form"><input id="add-name" type="text" value="${esc(draft.name)}" placeholder="What is it called?" autocomplete="off"></div>
    <p class="sheet-lead" style="margin-top:14px">What kind of place?</p>
    <div class="chip-wrap">${ADD_TYPES.map(t =>
      `<button type="button" class="chip${t === type ? ' active' : ''}" data-add-type="${t}">${TYPES[t].emoji} ${TYPES[t].label}</button>`).join('')}</div>
    <p class="place-note${status === 'missing' ? '' : ' calm'}">${where}</p>
    ${status === 'missing' ? `<div class="area-form"><input id="add-coords" type="text" placeholder="39.4760, -76.4480" autocomplete="off" inputmode="text"></div>` : ''}
    <div class="btn-row"><button class="btn btn-go" type="submit"${status === 'looking' ? ' disabled' : ''}>＋ Add to My Places</button></div>
  </form>
</div>`;
}

// ── Taste ───────────────────────────────────────────────────
export function tasteHtml(weights) {
  const max = Math.max(...Object.values(weights), 1);
  const rows = Object.entries(weights).sort((a, b) => b[1] - a[1]).map(([tag, w]) => `
    <div class="taste-row">
      <span class="taste-label">${esc(tag)}</span>
      <div class="taste-track"><div class="taste-fill${w > 1.5 ? ' high' : w < 0.8 ? ' low' : ''}" style="width:${Math.round(w / max * 100)}%"></div></div>
      <span class="taste-val">${w.toFixed(2)}</span>
    </div>`).join('');
  return `
<div class="sheet-pad">
  <h2 class="sheet-title">What you like</h2>
  <p class="sheet-lead">The app learns from you. Saving a place nudges its kind up, “Not for me” nudges it down, and
  “Best first” puts the kinds you like higher. 1.00 is neutral.</p>
  <div style="margin-top:12px">${rows}</div>
  <button class="quiet-btn" data-act="taste-reset">Start over with the default taste</button>
</div>`;
}

// ── Sheet and toast ─────────────────────────────────────────
export function openSheet(html) {
  $('sheet-body').innerHTML = html;
  $('sheet').scrollTop = 0;
  $('sheet-backdrop').classList.remove('hidden');
}
export function closeSheet() {
  $('sheet-backdrop').classList.add('hidden');
  $('sheet-body').innerHTML = '';
}
export function sheetIsOpen() {
  return !$('sheet-backdrop').classList.contains('hidden');
}

let toastTimer = null;
export function toast(message, undo) {
  const el = $('toast');
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button>Undo</button>' : ''}`;
  el.classList.remove('hidden');
  if (undo) el.querySelector('button').onclick = () => { el.classList.add('hidden'); undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), undo ? 5000 : 2600);
}
