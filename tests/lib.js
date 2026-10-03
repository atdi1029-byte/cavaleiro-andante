// Test rig: the real app in headless Chrome for Testing, with the Google
// Sheet replaced by the in-memory one from gas_harness.js. Each "device" is a
// separate browser profile, so two of them behave like a phone and a laptop.
//
// Nothing here can reach the real sheet: every request to script.google.com
// is answered locally, and every other outside host is cut off.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');
const { loadGas } = require('./gas_harness');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Chrome for Testing, never the Chrome app: a test copy of the real Chrome
// would hijack the AppleScript that the outreach night run sends to Chrome.
// Install once: npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
function chromeBin() {
  const root = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const builds = fs.existsSync(root) ? fs.readdirSync(root).filter(d => d.startsWith('mac')).sort().reverse() : [];
  for (const d of builds) for (const sub of ['chrome-mac-arm64', 'chrome-mac-x64']) {
    const p = path.join(root, d, sub, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome for Testing is not installed. Run: npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}

// A few made-up places around Pasadena, MD
const PLACES = [
  { id: 'seed:downspark', name: 'Downs Park', type: 'water', tags: ['water', 'waterfront', 'park'], lat: 39.110, lng: -76.439, where: 'Pasadena, MD', q: 90, desc: 'Bay-front county park.' },
  { id: 'c:kilgorefalls', name: 'Kilgore Falls', type: 'waterfall', tags: ['waterfall', 'water'], lat: 39.690, lng: -76.423, where: 'Pylesville, MD', q: 92 },
  { id: 'c:danielsruins', name: 'Daniels Ghost Town', type: 'gems', tags: ['gems', 'abandoned', 'ruins'], lat: 39.314, lng: -76.816, where: 'Ellicott City, MD', q: 76 },
  { id: 'osm:n1', name: 'Bodkin Overlook', type: 'viewpoint', tags: ['viewpoint', 'scenic'], lat: 39.132, lng: -76.440, where: 'Pasadena, MD', q: 42 },
  { id: 'osm:n2', name: 'Magothy Greenway', type: 'park', tags: ['park', 'nature'], lat: 39.082, lng: -76.503, where: 'Pasadena, MD', q: 45 },
  { id: 'c:cryptologic', name: 'National Cryptologic Museum', type: 'indoor', tags: ['museum', 'rainy', 'free'], lat: 39.115, lng: -76.775, where: 'Fort Meade, MD', q: 76 },
  { id: 'c:oldrag', name: 'Old Rag Mountain', type: 'hike', tags: ['hiking', 'viewpoint'], lat: 38.570, lng: -78.294, where: 'Etlan, VA', q: 92, facts: { len: 9.4, gain: 2348 } },
];

async function start({ places = PLACES, raining = false } = {}) {
  const site = await serve();
  const gas = loadGas();
  const browser = await puppeteer.launch({
    executablePath: chromeBin(), headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const state = { online: true, calls: [], raining };

  // A device: its own storage, the shared fake sheet
  async function device(seed) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true });
    // A service worker would fetch behind the test's back (its requests are
    // not seen here), so the page talks to the network directly.
    await page.setBypassServiceWorker(true);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'serviceWorker', { value: { register: () => Promise.resolve() } });
    });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = new URL(req.url());
      if (url.origin + '/' === site.url) {
        if (url.pathname === '/places.json') return req.respond({ contentType: 'application/json', body: JSON.stringify(places) });
        if (url.pathname === '/archive.json') return req.respond({ contentType: 'application/json', body: JSON.stringify([['sw:oldjunk', 'Old Junk Park', 'park', 39.1, -76.5]]) });
        return req.continue();
      }
      if (url.hostname === 'script.google.com') {
        if (!state.online) return req.abort('internetdisconnected');
        const params = Object.fromEntries(url.searchParams);
        state.calls.push(params);
        return req.respond({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(gas.get(params)) });
      }
      if (url.hostname === 'api.open-meteo.com') {
        const weather = { current: { weather_code: state.raining ? 63 : 1, precipitation: state.raining ? 2.4 : 0 }, hourly: { precipitation_probability: [10, 10, 5, 0] } };
        return req.respond({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(weather) });
      }
      if (url.hostname === 'nominatim.openstreetmap.org' && url.pathname === '/search') {
        // A geocoder that knows exactly one place
        const hit = /pot rocks/i.test(url.searchParams.get('q')) ? [{ lat: '39.4760', lon: '-76.4480', display_name: 'Pot Rocks, Kingsville, Maryland' }] : [];
        return req.respond({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(hit) });
      }
      req.abort();   // fonts, map tiles, photos: not needed, never fetched
    });
    if (seed) {
      // Put things in localStorage before the app's first script runs.
      // "android" stands in for the Android shell's bridge to the old app's data.
      await page.evaluateOnNewDocument(items => {
        if (items.android) window.CavaleiroNative = { legacyData: () => items.android, ready() {} };
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        for (const [k, v] of Object.entries(items)) if (k !== 'android') localStorage.setItem(k, v);
      }, seed);
    }
    page.open = async () => {
      await page.goto(site.url, { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('#list .card, #list .empty'), { timeout: 15000 });
    };
    page.tap = sel => page.evaluate(s => document.querySelector(s).click(), sel);
    page.names = () => page.evaluate(() => [...document.querySelectorAll('#list .card-name')].map(e => e.textContent));
    page.category = async id => { await page.tap(`[data-cat="${id}"]`); await sleep(80); };
    page.sub = async id => { await page.tap(`#subs [data-sub="${id}"]`); await sleep(80); };
    page.heart = id => page.tap(`#list .card[data-id="${id}"] .card-heart`);
    page.storage = key => page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
    await page.open();
    return page;
  }

  // Wait until the fake sheet (or anything else) reaches a state
  async function until(check, what, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await check()) return; await sleep(100); }
    throw new Error('timed out waiting for: ' + what);
  }

  return {
    gas, state, device, until, sleep,
    sheet: () => Object.fromEntries(gas.rows('State').map(r => [r[0], r[1]])),
    custom: () => Object.fromEntries(gas.rows('Custom').map(r => [r[0], JSON.parse(r[1])])),
    stop: async () => { await browser.close(); site.close(); },
  };
}

module.exports = { start, PLACES, sleep };
