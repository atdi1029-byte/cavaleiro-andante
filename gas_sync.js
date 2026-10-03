// Cavaleiro Andante: cloud sync (Google Apps Script web app)
// Deployed with: .clasp/gas_deploy.sh cavaleiro   (Web App, execute as me, anyone)
//
// Version 2 keeps one spreadsheet ROW per thing, each with its own timestamp,
// and merges on the server (newest wins). A phone can only ever add or update
// rows, so a wiped or half-loaded device cannot erase the cloud copy.
//
//   State   id | flags | t | received     flags: 1 saved, 2 been there, 4 not for me, 8 hidden
//   Taste   tag | weight | t | received
//   Custom  id | json | t | received      places the user added himself
//
// t is when the change was made (the phone's clock); "received" is when it
// reached this sheet (the server's clock).
//
//   ?action=load2[&since=n]     everything, or only rows received after `since`
//                               (`since` is the `now` of an earlier answer)
//   ?action=put&d=<ops>         ops joined by "!", fields joined by "~":
//                                 s~<id>~<flags>~<t>
//                                 t~<tag>~<weight>~<t>
//                                 c~<id>~<t>~<websafe base64 of JSON>
//
// The version 1 actions (load, save, save_chunk, save_done) still answer so an
// old copy of the app keeps working until it updates.

var STATE_SHEET  = 'State';
var TASTE_SHEET  = 'Taste';
var CUSTOM_SHEET = 'Custom';
var LEGACY_SHEET = 'CavaleiroSync';

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    var action = p.action || 'load';
    if      (action === 'load2')      out = load2(p.since);
    else if (action === 'put')        out = put(p.d || '');
    else if (action === 'save')       out = legacySave(p.data || '');
    else if (action === 'save_chunk') out = legacyChunk(p.i, p.cd);
    else if (action === 'save_done')  out = legacyDone(p.n);
    else                              out = legacyLoad();
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  var body = JSON.stringify(out);
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + '(' + body + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function rows(name) {
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (!last) return [];
  return sh.getRange(1, 1, last, 4).getValues().filter(function (r) { return r[0] !== ''; });
}

// ── Version 2 ───────────────────────────────────────────────

function load2(since) {
  var min = Number(since) || 0;
  // "Changed since" goes by when a row reached the sheet, not by the phone's
  // clock: a phone whose clock runs behind, or an imported mark with no real
  // date, would otherwise never be passed on. Rows from before this column
  // existed have no receipt time and are always included.
  var newer = function (r) { return r[3] === '' || Number(r[3]) > min; };
  return {
    ok: true, v: 2, now: nowSec(),
    s: rows(STATE_SHEET).filter(newer).map(function (r) { return [String(r[0]), Number(r[1]) || 0, Number(r[2]) || 0]; }),
    t: rows(TASTE_SHEET).filter(newer).map(function (r) { return [String(r[0]), Number(r[1]) || 0, Number(r[2]) || 0]; }),
    c: rows(CUSTOM_SHEET).filter(newer).map(function (r) { return [String(r[0]), String(r[1]), Number(r[2]) || 0]; })
  };
}

// The app sends base64 without the trailing "=" (they are not URL-safe);
// the decoder here insists on them.
function decodeJson(b64) {
  var padded = String(b64);
  while (padded.length % 4) padded += '=';
  var json = Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString();
  JSON.parse(json); // refuse anything that is not JSON
  return json;
}

function put(d) {
  var ops = { s: [], t: [], c: [] };
  var skipped = 0;
  String(d).split('!').forEach(function (op) {
    var f = op.split('~');
    if (f[0] === 's' && f.length === 4 && f[1]) {
      ops.s.push([f[1], Number(f[2]) || 0, Number(f[3]) || 0]);
    } else if (f[0] === 't' && f.length === 4 && f[1]) {
      ops.t.push([f[1], Number(f[2]) || 0, Number(f[3]) || 0]);
    } else if (f[0] === 'c' && f.length === 4 && f[1]) {
      // One unreadable entry must not hold up the rest of the batch
      try { ops.c.push([f[1], decodeJson(f[3]), Number(f[2]) || 0]); } catch (e) { skipped++; }
    }
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var applied = merge(STATE_SHEET, ops.s) + merge(TASTE_SHEET, ops.t) + merge(CUSTOM_SHEET, ops.c);
    return { ok: true, applied: applied, skipped: skipped, now: nowSec() };
  } finally {
    lock.releaseLock();
  }
}

// Newest timestamp wins, row by row. Rows are never removed.
// Marks carried over from the first version of the app are stamped 1
// ("imported, date unknown"). Two of those for the same place are combined
// (flags OR-ed) instead of one replacing the other: each old device knew
// only its own marks.
var IMPORTED = 1;

function merge(name, incoming) {
  if (!incoming.length) return 0;
  var sh = sheet(name);
  var data = rows(name);
  var at = {};
  data.forEach(function (r, i) { at[String(r[0])] = i; });
  var applied = 0;
  var received = nowSec();
  incoming.forEach(function (r) {
    var i = at[r[0]];
    if (i === undefined) {
      at[r[0]] = data.length;
      data.push([r[0], r[1], r[2], received]);
      applied++;
    } else if (Number(r[2]) > Number(data[i][2])) {
      data[i] = [r[0], r[1], r[2], received];
      applied++;
    } else if (name === STATE_SHEET && Number(r[2]) <= IMPORTED && Number(data[i][2]) <= IMPORTED &&
               (Number(data[i][1]) | Number(r[1])) !== Number(data[i][1])) {
      data[i] = [r[0], Number(data[i][1]) | Number(r[1]), IMPORTED, received];
      applied++;
    }
  });
  if (applied) {
    // Rows from before the "received" column existed get one now
    data.forEach(function (r) { if (r[3] === '' || r[3] === undefined) r[3] = received; });
    // The id column is plain text so "123" or "1e5" is not turned into a number
    sh.getRange(1, 1, data.length, 1).setNumberFormat('@');
    sh.getRange(1, 1, data.length, 4).setValues(data);
  }
  return applied;
}

// ── Version 1 (old copies of the app) ───────────────────────

function legacyLoad() {
  var sh = sheet(LEGACY_SHEET);
  return { ok: true, data: sh.getRange('A1').getValue() || '{}', ts: sh.getRange('B1').getValue() || null };
}

function legacySave(data) {
  return legacyStore(data);
}

function legacyChunk(i, chunk) {
  sheet(LEGACY_SHEET).getRange('C' + ((parseInt(i, 10) || 0) + 1)).setValue(chunk || '');
  return { ok: true };
}

function legacyDone(n) {
  var sh = sheet(LEGACY_SHEET);
  var count = parseInt(n, 10) || 1;
  var full = '';
  for (var i = 0; i < count; i++) full += sh.getRange('C' + (i + 1)).getValue();
  for (var j = 0; j < count; j++) sh.getRange('C' + (j + 1)).clearContent();
  return legacyStore(full);
}

// A version 1 save replaces the whole blob. It used to wipe the cloud copy
// whenever a chunk failed to arrive; now anything that is not real data is
// refused, and whatever it holds is also copied into the version 2 rows.
function legacyStore(text) {
  var parsed;
  try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  if (typeof parsed === 'string') {
    // The old Android app sent its JSON encoded twice
    try { parsed = JSON.parse(parsed); } catch (e) { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || !Object.keys(parsed).length) {
    return { ok: false, error: 'empty or broken save refused' };
  }
  var sh = sheet(LEGACY_SHEET);
  var json = JSON.stringify(parsed);
  if (json.length < 50000) {
    sh.getRange('A1').setValue(json);
    sh.getRange('B1').setValue(new Date().toISOString());
  }
  importLegacy(parsed);
  return { ok: true, size: json.length };
}

// Old saves have no timestamps, so they are stamped "imported": they add rows
// version 2 has never seen and combine with other imported marks, but they
// cannot undo anything done in the new app.
function importLegacy(parsed) {
  var bits = { ca_favorites: 1, ca_visited: 2, ca_bad: 4, ca_hidden: 8 };
  var flags = {};
  Object.keys(bits).forEach(function (key) {
    var v = parsed[key];
    var ids = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v) : []);
    ids.forEach(function (id) { flags[id] = (flags[id] || 0) | bits[key]; });
  });
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    merge(STATE_SHEET, Object.keys(flags).map(function (id) { return [id, flags[id], IMPORTED]; }));

    var taste = parsed.ca_taste;
    if (taste && typeof taste === 'object') {
      var knownTags = {};
      rows(TASTE_SHEET).forEach(function (r) { knownTags[String(r[0])] = true; });
      merge(TASTE_SHEET, Object.keys(taste).filter(function (t) { return !knownTags[t]; })
        .map(function (t) { return [t, Number(taste[t]) || 1, 1]; }));
    }
  } finally {
    lock.releaseLock();
  }
}
