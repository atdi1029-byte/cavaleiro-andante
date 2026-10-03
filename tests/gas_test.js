// Tests for the Apps Script (gas_sync.js). Run: node tests/gas_test.js
const assert = require('assert');
const { loadGas } = require('./gas_harness');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('a new sheet loads as empty', () => {
  const gas = loadGas();
  const out = gas.get({ action: 'load2' });
  assert.deepStrictEqual([out.ok, out.s, out.t, out.c], [true, [], [], []]);
});

test('put stores rows and load2 returns them', () => {
  const gas = loadGas();
  const res = gas.get({ action: 'put', d: 's~seed:downspark~1~100!s~osm:n42~2~101!t~beach~1.55~100' });
  assert.strictEqual(res.applied, 3);
  const out = gas.get({ action: 'load2' });
  assert.deepStrictEqual(out.s, [['seed:downspark', 1, 100], ['osm:n42', 2, 101]]);
  assert.deepStrictEqual(out.t, [['beach', 1.55, 100]]);
});

test('the newest change wins; an older one is ignored', () => {
  const gas = loadGas();
  gas.get({ action: 'put', d: 's~a:1~1~200' });
  gas.get({ action: 'put', d: 's~a:1~0~150' });            // stale phone
  assert.deepStrictEqual(gas.get({ action: 'load2' }).s, [['a:1', 1, 200]]);
  gas.get({ action: 'put', d: 's~a:1~0~300' });            // un-saved later
  assert.deepStrictEqual(gas.get({ action: 'load2' }).s, [['a:1', 0, 300]]);
});

test('a device with nothing to say cannot erase the sheet', () => {
  const gas = loadGas();
  gas.get({ action: 'put', d: 's~a:1~1~200!s~a:2~3~200' });
  gas.get({ action: 'put', d: '' });
  gas.get({ action: 'save_done', n: '1' });                // old app, chunks never arrived
  gas.get({ action: 'save', data: '{}' });
  assert.strictEqual(gas.get({ action: 'load2' }).s.length, 2);
});

test('since= returns what reached the sheet after it, whatever the phone\'s clock said', () => {
  const gas = loadGas();
  gas.setNow(5000);
  gas.get({ action: 'put', d: 's~a:1~1~100' });
  gas.setNow(6000);
  gas.get({ action: 'put', d: 's~a:2~1~50' });            // a phone whose clock runs behind
  gas.get({ action: 'put', d: 's~a:3~2~1!s~a:1~0~1' });   // imported marks; the second is older than what is there
  const out = gas.get({ action: 'load2', since: '5500' });
  assert.deepStrictEqual(out.s, [['a:2', 1, 50], ['a:3', 2, 1]]);
  assert.strictEqual(out.now, 6000);
});

test('rows written before the receipt column existed are still delivered', () => {
  const gas = loadGas();
  gas.sheets.set('State', (() => { gas.get({ action: 'load2' }); return gas.sheets.get('State'); })());
  gas.sheets.get('State').getRange(1, 1, 1, 3).setValues([['old:1', 3, 1]]);
  assert.deepStrictEqual(gas.get({ action: 'load2', since: '999999' }).s, [['old:1', 3, 1]]);
});

test('ids that look like numbers stay text', () => {
  const gas = loadGas();
  gas.get({ action: 'put', d: 's~12345~1~100' });
  gas.get({ action: 'put', d: 's~12345~3~200' });
  assert.deepStrictEqual(gas.get({ action: 'load2' }).s, [['12345', 3, 200]]);
});

test('custom places round-trip as JSON', () => {
  const gas = loadGas();
  const place = { id: 'user:pot_rocks', name: 'Pot Rocks ~ "swim" !', lat: 39.47, lng: -76.44 };
  gas.get({ action: 'put', d: `c~user:pot_rocks~500~${b64(JSON.stringify(place))}` });
  const row = gas.get({ action: 'load2' }).c[0];
  assert.deepStrictEqual([row[0], JSON.parse(row[1]), row[2]], ['user:pot_rocks', place, 500]);
});

test('an unreadable custom place is skipped without losing the rest of the batch', () => {
  const gas = loadGas();
  const res = gas.get({ action: 'put', d: 's~a:1~1~100!c~user:bad~100~@@not-base64@@!s~a:2~1~100' });
  assert.deepStrictEqual([res.ok, res.applied, res.skipped], [true, 2, 1]);
  assert.strictEqual(gas.get({ action: 'load2' }).s.length, 2);
});

test('JSONP callback still works', () => {
  const gas = loadGas();
  assert.strictEqual(gas.get({ action: 'load2', callback: 'cb' }).ok, true);
});

test('a version 1 save is kept for old apps and copied into version 2', () => {
  const gas = loadGas();
  const blob = JSON.stringify({ ca_favorites: ['seed:a', 'sw:b'], ca_visited: ['sw:b'], ca_hidden: ['sw:c'], ca_taste: { water: 1.7 } });
  gas.get({ action: 'save_chunk', i: '0', cd: blob.slice(0, 40) });
  gas.get({ action: 'save_chunk', i: '1', cd: blob.slice(40) });
  assert.strictEqual(gas.get({ action: 'save_done', n: '2' }).ok, true);
  assert.deepStrictEqual(JSON.parse(gas.get({ action: 'load' }).data).ca_favorites, ['seed:a', 'sw:b']);
  const s = Object.fromEntries(gas.get({ action: 'load2' }).s.map(r => [r[0], r[1]]));
  assert.deepStrictEqual(s, { 'seed:a': 1, 'sw:b': 3, 'sw:c': 8 });
  assert.deepStrictEqual(gas.get({ action: 'load2' }).t, [['water', 1.7, 1]]);
});

test('a version 1 save cannot undo a version 2 change', () => {
  const gas = loadGas();
  gas.get({ action: 'put', d: 's~seed:a~0~900' });          // un-saved in the new app
  gas.get({ action: 'save', data: JSON.stringify({ ca_favorites: ['seed:a'] }) });
  assert.deepStrictEqual(gas.get({ action: 'load2' }).s, [['seed:a', 0, 900]]);
});

test('old marks imported from two devices are combined, and never beat a dated change', () => {
  const gas = loadGas();
  gas.get({ action: 'put', d: 's~a:1~2~1!s~a:2~8~1!s~a:3~1~1' });       // phone: been / hidden / saved
  gas.get({ action: 'put', d: 's~a:1~1~1!s~a:2~3~1' });                 // web: saved / saved+been
  const s = Object.fromEntries(gas.get({ action: 'load2' }).s.map(r => [r[0], r.slice(1)]));
  assert.deepStrictEqual(s, { 'a:1': [3, 1], 'a:2': [11, 1], 'a:3': [1, 1] });
  gas.get({ action: 'put', d: 's~a:3~0~900' });                         // un-saved in the new app
  gas.get({ action: 'put', d: 's~a:3~1~1' });                           // an old device imports later
  assert.deepStrictEqual(gas.get({ action: 'load2' }).s.find(r => r[0] === 'a:3'), ['a:3', 0, 900]);
});

test('the old Android app\'s double-encoded save is understood', () => {
  const gas = loadGas();
  const res = gas.get({ action: 'save', data: JSON.stringify(JSON.stringify({ ca_favorites: ['sw:x'] })) });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(gas.get({ action: 'load2' }).s, [['sw:x', 1, 1]]);
});

console.log(`${passed} passed`);
