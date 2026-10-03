// Runs gas_sync.js in Node with an in-memory stand-in for Google Sheets.
// Cells behave like the real thing where it matters: a string that looks
// like a number becomes a number unless the cell was formatted as text, and
// anything over 50,000 characters is silently not written.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeSheet() {
  const cells = new Map();
  const text = new Set();
  const key = (r, c) => r + ':' + c;
  const convert = (v, k) => {
    if (typeof v !== 'string') return v;
    if (v.length > 50000) return undefined;
    if (!text.has(k) && v.trim() !== '' && /^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim())) return Number(v);
    return v;
  };
  const a1 = s => { const m = /^([A-Z]+)(\d+)$/.exec(s); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return [Number(m[2]), c]; };
  const range = (r, c, nr = 1, nc = 1) => ({
    getValue() { const v = cells.get(key(r, c)); return v === undefined ? '' : v; },
    getValues() {
      return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
        const v = cells.get(key(r + i, c + j)); return v === undefined ? '' : v;
      }));
    },
    setValue(v) { const cv = convert(v, key(r, c)); if (cv !== undefined) cells.set(key(r, c), cv); return this; },
    setValues(vals) {
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
        const cv = convert(vals[i][j], key(r + i, c + j));
        if (cv !== undefined) cells.set(key(r + i, c + j), cv);
      }
      return this;
    },
    setNumberFormat(f) { if (f === '@') for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) text.add(key(r + i, c + j)); return this; },
    clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cells.delete(key(r + i, c + j)); return this; },
  });
  return {
    cells,
    getRange(a, b, c, d) { if (typeof a === 'string') { const [r, col] = a1(a); return range(r, col); } return range(a, b, c, d); },
    getLastRow() { let m = 0; for (const k of cells.keys()) m = Math.max(m, Number(k.split(':')[0])); return m; },
  };
}

function loadGas(file = path.join(__dirname, '..', 'gas_sync.js')) {
  const sheets = new Map();
  const ss = {
    getSheetByName: n => sheets.get(n) || null,
    insertSheet(n) { const s = makeSheet(); sheets.set(n, s); return s; },
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      // Like the real service, refuses base64 that is not padded to a multiple of 4
      base64DecodeWebSafe: s => {
        if (s.length % 4) throw new Error('Could not decode string.');
        return [...Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')];
      },
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    },
    ContentService: {
      MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput: t => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
    },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return {
    sheets,
    // Same as the browser calling the web app with these URL parameters
    get(params) {
      const text = ctx.doGet({ parameter: params }).getContent();
      return JSON.parse(params.callback ? text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')) : text);
    },
    rows(name) { const s = sheets.get(name); return s ? s.getRange(1, 1, s.getLastRow() || 1, 3).getValues().filter(r => r[0] !== '') : []; },
    // Sets the script's clock (seconds), to test "changed since"
    setNow(n) { ctx.nowSec = () => n; },
  };
}

module.exports = { loadGas };
