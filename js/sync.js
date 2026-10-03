// Cloud sync with the Google Sheet behind gas_sync.js.
//
// Always PULL, then PUSH. The push only ever carries entries this device
// changed, each with its timestamp, and the server keeps the newest per
// entry. A wiped phone has nothing to push, so it cannot erase the sheet;
// it simply gets everything back on the pull.

import { SYNC_URL } from './config.js';
import * as store from './store.js';

// Each request is a GET, so the payload has to fit in a URL
const MAX_OPS_CHARS = 1500;
const DEBOUNCE_MS = 1500;
// Apps Script sometimes takes a minute to answer, or does not answer at all.
// Give up on a request after this long and try the whole sync again later.
const TIMEOUT_MS = 40000;
const RETRY_MS = [60000, 120000, 300000];

let running = null;
let again = false;
let timer = null;
let failures = 0;

async function call(params) {
  const url = SYNC_URL + '?' + new URLSearchParams(params);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('sync HTTP ' + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'sync refused');
  return data;
}

function base64url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pull() {
  const data = await call({ action: 'load2', since: store.since() });
  store.mergeRemote(data);
}

async function push() {
  const todo = store.pending();
  const ops = [
    ...todo.s.map(row => ({ kind: 's', row, text: `s~${row[0]}~${row[1]}~${row[2]}` })),
    ...todo.t.map(row => ({ kind: 't', row, text: `t~${row[0]}~${row[1]}~${row[2]}` })),
    ...todo.c.map(row => ({ kind: 'c', row, text: `c~${row[0]}~${row[2]}~${base64url(JSON.stringify(row[1]))}` })),
  ];
  // Batches go one after another; each is confirmed before the next is sent
  while (ops.length) {
    const batch = [];
    let size = 0;
    while (ops.length && (!batch.length || size + ops[0].text.length < MAX_OPS_CHARS)) {
      size += ops[0].text.length + 1;
      batch.push(ops.shift());
    }
    await call({ action: 'put', d: batch.map(op => op.text).join('!') });
    const sent = { s: [], t: [], c: [] };
    batch.forEach(op => sent[op.kind].push(op.row));
    store.confirmSent(sent);
  }
}

// Pull, merge, push. Calls made while one is running are folded into a
// single follow-up run.
export function syncNow() {
  if (running) { again = true; return running; }
  running = (async () => {
    let ok = false;
    try {
      await pull();
      await push();
      ok = true;
    } catch (e) {
      console.warn('[sync]', e.message);
    } finally {
      running = null;
      failures = ok ? 0 : failures + 1;
      if (again) { again = false; syncSoon(); }
      else if (!ok) syncSoon(RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]);
    }
    return ok;
  })();
  return running;
}

export function syncSoon(delay = DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export function startSync() {
  // Local changes (not ones that came from the cloud) schedule a push
  store.onChange(what => { if (what !== 'remote') syncSoon(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('online', syncNow);
  return syncNow();
}
