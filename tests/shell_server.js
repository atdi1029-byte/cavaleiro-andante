// Serves the web app with a FAKE Google Sheet, for trying the Android shell
// on the emulator without touching the real sheet:
//
//   node tests/shell_server.js            (prints the address, port 8766)
//   adb -s emulator-5554 shell am start -n com.cavaleiro.app/.MainActivity --es url http://10.0.2.2:8766/
//
// GET /_sheet shows what the fake sheet holds.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadGas } = require('./gas_harness');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8766;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const gas = loadGas();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/_gas') {
    const params = Object.fromEntries(url.searchParams);
    console.log('sheet <-', params.action, (params.d || params.since || '').slice(0, 120));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(gas.get(params)));
  }
  if (url.pathname === '/_sheet') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ State: gas.rows('State'), Taste: gas.rows('Taste'), Custom: gas.rows('Custom') }, null, 1));
  }
  const file = path.join(ROOT, decodeURIComponent(url.pathname).replace(/\/$/, '/index.html'));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (file.endsWith(path.join('js', 'config.js'))) {
    // Point sync at the fake sheet on this server
    return res.end(fs.readFileSync(file, 'utf8').replace(/export const SYNC_URL = '[^']+';/, `export const SYNC_URL = location.origin + '/_gas';`));
  }
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '0.0.0.0', () => console.log(`Web app with a fake sheet on http://localhost:${PORT}/ (emulator: http://10.0.2.2:${PORT}/)`));
