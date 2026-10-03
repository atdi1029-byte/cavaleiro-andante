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

test('since= returns only what changed after it', () => {
  const gas = loadGas();
  gas.get({ action: 'put', d: 's~a:1~1~100!s~a:2~1~200' });
  assert.deepStrictEqual(gas.get({ action: 'load2', since: '150' }).s, [['a:2', 1, 200]]);
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

test('the old Android app\'s double-encoded save is understood', () => {
  const gas = loadGas();
  const res = gas.get({ action: 'save', data: JSON.stringify(JSON.stringify({ ca_favorites: ['sw:x'] })) });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(gas.get({ action: 'load2' }).s, [['sw:x', 1, 1]]);
});

console.log(`${passed} passed`);
