// End-to-end tests: the real app in a headless browser against a fake Google
// Sheet. Run: node tests/app_test.js
const assert = require('assert');
const { start } = require('./lib');

const tests = [];
const test = (name, fn, options) => tests.push({ name, fn, options });
const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── Finding places ──────────────────────────────────────────
test('the list opens on the best places, nearest good ones first', async rig => {
  const a = await rig.device();
  const names = await a.names();
  assert.strictEqual(names[0], 'Downs Park');
  assert.ok(names.includes('Old Rag Mountain'), 'a must-see far away is still listed');
  assert.deepStrictEqual(a.errors, []);
});

test('a category and its chips narrow the list', async rig => {
  const a = await rig.device();
  await a.category('gems');
  assert.deepStrictEqual(await a.names(), ['Daniels Ghost Town']);
  await a.sub('caves');
  assert.deepStrictEqual(await a.names(), []);
  await a.sub('abandoned');
  assert.deepStrictEqual(await a.names(), ['Daniels Ghost Town']);
});

test('the distance filter leaves out what is too far', async rig => {
  const a = await rig.device();
  await a.tap('#dist-pills [data-miles="15"]');
  const names = await a.names();
  assert.ok(names.includes('Downs Park') && !names.includes('Old Rag Mountain') && !names.includes('Kilgore Falls'));
});

test('typing in search finds a place by name, whatever the category', async rig => {
  const a = await rig.device();
  await a.category('waterfall');
  await a.type('#search-input', 'old rag');
  await rig.until(async () => (await a.names()).join() === 'Old Rag Mountain', 'search result');
});

test('a starting point far outside the area says so instead of showing huge distances', async rig => {
  const a = await rig.device();
  await a.evaluate(() => {
    navigator.geolocation.getCurrentPosition = ok => ok({ coords: { latitude: 38.72, longitude: -9.14 } });  // Lisbon
  });
  await a.tap('#origin-btn');
  await a.tap('[data-act="origin-gps"]');
  await rig.until(() => a.evaluate(() => !document.getElementById('notice').classList.contains('hidden')), 'the notice');
  assert.match(await a.evaluate(() => document.getElementById('notice').textContent), /miles from the area this app covers/);
  await a.tap('#notice [data-act="origin-home"]');
  await rig.until(() => a.evaluate(() => document.getElementById('notice').classList.contains('hidden')), 'notice gone');
  assert.match(await a.evaluate(() => document.querySelector('#list .card .dist').textContent), /^\d+(\.\d)? mi$/);
});

test('indoor places stay out of the everyday list but can be searched', async rig => {
  const a = await rig.device();
  assert.ok(!(await a.names()).includes('National Cryptologic Museum'));
  assert.ok(await a.evaluate(() => document.getElementById('rain-tip').classList.contains('hidden')), 'no rain tip on a dry day');
  await a.type('#search-input', 'cryptologic');
  await rig.until(async () => (await a.names()).join() === 'National Cryptologic Museum', 'search result');
});

test('when it is raining the app offers the Rainy day list', async rig => {
  const a = await rig.device();
  await rig.until(() => a.evaluate(() => !document.getElementById('rain-tip').classList.contains('hidden')), 'the rain tip');
  assert.match(await a.evaluate(() => document.getElementById('rain-tip').textContent), /Raining near Pasadena, MD/);
  await a.tap('#rain-tip');
  assert.deepStrictEqual(await a.names(), ['National Cryptologic Museum']);
  assert.strictEqual(await a.evaluate(() => document.querySelector('.cat.active').dataset.cat), 'rain');
  await a.sub('free');
  assert.deepStrictEqual(await a.names(), ['National Cryptologic Museum']);
  await a.sub('caves');
  assert.deepStrictEqual(await a.names(), []);
}, { raining: true });

// ── Saving ──────────────────────────────────────────────────
test('a saved place moves to My Places and reaches the sheet', async rig => {
  const a = await rig.device();
  await a.heart('seed:downspark');
  assert.ok(!(await a.names()).includes('Downs Park'), 'saved places leave the discovery list');
  await a.category('saved');
  assert.deepStrictEqual(await a.names(), ['Downs Park']);
  await rig.until(() => rig.sheet()['seed:downspark'] === 1, 'the row in the sheet');
});

test('a second device sees it, and un-saving there reaches the first', async rig => {
  const a = await rig.device();
  await a.heart('c:kilgorefalls');
  await rig.until(() => rig.sheet()['c:kilgorefalls'] === 1, 'save in sheet');

  const b = await rig.device();
  await b.category('saved');
  await rig.until(async () => (await b.names()).join() === 'Kilgore Falls', 'B shows the saved place');
  await b.heart('c:kilgorefalls');
  await rig.until(() => rig.sheet()['c:kilgorefalls'] === 0, 'un-save in sheet');

  await a.open();
  await a.category('saved');
  await rig.until(async () => (await a.names()).length === 0, 'A no longer shows it');
});

test('Undo puts a saved place back', async rig => {
  const a = await rig.device();
  await a.heart('osm:n1');
  await a.tap('#toast button');
  assert.ok((await a.names()).includes('Bodkin Overlook'));
  await rig.sleep(2500);
  assert.ok(!rig.sheet()['osm:n1'], 'nothing left saved in the sheet');
});

test('“been there” and “not for me” take a place out of the list and into My Places', async rig => {
  const a = await rig.device();
  await a.tap('#list .card[data-id="osm:n2"]');
  await a.tap('#sheet-body [data-act="been"]');
  await a.tap('#sheet-close');
  await a.tap('#list .card[data-id="osm:n1"]');
  await a.tap('#sheet-body [data-act="dismiss"]');
  const names = await a.names();
  assert.ok(!names.includes('Magothy Greenway') && !names.includes('Bodkin Overlook'));
  await a.category('saved');
  await a.sub('been');
  assert.deepStrictEqual(await a.names(), ['Magothy Greenway']);
  await a.sub('hidden');
  assert.deepStrictEqual(await a.names(), ['Bodkin Overlook']);
  await rig.until(() => rig.sheet()['osm:n2'] === 2 && rig.sheet()['osm:n1'] === 4, 'both rows');
});

// ── Sync safety ─────────────────────────────────────────────
test('a wiped device cannot erase the sheet; it gets everything back', async rig => {
  const a = await rig.device();
  await a.heart('seed:downspark');
  await a.heart('c:oldrag');
  await rig.until(() => Object.keys(rig.sheet()).length === 2, 'two rows');

  const wiped = await rig.device();          // brand-new storage
  await wiped.category('saved');
  await rig.until(async () => (await wiped.names()).length === 2, 'both places restored');
  await rig.sleep(2500);
  assert.deepStrictEqual(rig.sheet(), { 'seed:downspark': 1, 'c:oldrag': 1 });
});

test('a saved place that the cleanup archived still shows after a restore from the cloud', async rig => {
  rig.gas.get({ action: 'put', d: 's~sw:oldjunk~1~500!s~seed:downspark~1~500' });
  const fresh = await rig.device();
  await fresh.category('saved');
  await rig.until(async () => (await fresh.names()).sort().join() === 'Downs Park,Old Junk Park', 'both, one of them from archive.json');
});

test('changes made with no signal are kept and sent later', async rig => {
  const a = await rig.device();
  rig.state.online = false;
  await a.heart('c:danielsruins');
  await rig.sleep(2500);
  assert.deepStrictEqual(rig.sheet(), {});
  assert.deepStrictEqual((await a.storage('cavaleiro_dirty')).s, ['c:danielsruins']);
  rig.state.online = true;
  await a.open();
  await rig.until(() => rig.sheet()['c:danielsruins'] === 1, 'the late push');
  assert.deepStrictEqual((await a.storage('cavaleiro_dirty')).s, []);
});

test('two devices changing different places both keep their changes', async rig => {
  const a = await rig.device();
  const b = await rig.device();
  await a.heart('seed:downspark');
  await b.heart('c:oldrag');
  await rig.until(() => Object.keys(rig.sheet()).length === 2, 'two rows');
  for (const d of [a, b]) {
    await d.open();
    await d.category('saved');
    await rig.until(async () => (await d.names()).length === 2, 'both on each device');
  }
});

test('saved places from the first version of the app carry over', async rig => {
  const hidden = Array.from({ length: 300 }, (_, i) => 'sw:junk' + i);
  const a = await rig.device({
    ca_favorites: JSON.stringify(['seed:downspark', 'sw:oldjunk']),
    ca_visited: JSON.stringify(['osm:n2']),
    ca_hidden: JSON.stringify(hidden),
    ca_taste: JSON.stringify({ water: 1.85, park: 1.2 }),
  });
  await a.category('saved');
  // sw:oldjunk is no longer in places.json; it comes back from archive.json
  assert.deepStrictEqual((await a.names()).sort(), ['Downs Park', 'Old Junk Park']);
  await rig.until(() => Object.keys(rig.sheet()).length === 303, 'all 303 rows (several requests)', 20000);
  assert.strictEqual(rig.sheet()['osm:n2'], 2);
  assert.deepStrictEqual(rig.gas.rows('Taste').map(r => r.slice(0, 2)), [['water', 1.85]]);
  assert.ok(rig.state.calls.filter(c => c.action === 'put').every(c => c.d.length <= 1600), 'each request fits in a URL');
  assert.deepStrictEqual(await a.storage('ca_favorites'), ['seed:downspark', 'sw:oldjunk'], 'the old list is left as a backup');
});

// ── Places of your own ──────────────────────────────────────
test('a place added on another device shows up under My Places', async rig => {
  const place = { id: 'user:secret_cove', name: 'Secret Cove', type: 'water', tags: ['water'], lat: 39.05, lng: -76.45 };
  rig.gas.get({ action: 'put', d: `c~user:secret_cove~500~${b64(JSON.stringify(place))}!s~user:secret_cove~1~500` });
  const a = await rig.device();
  await a.category('saved');
  await rig.until(async () => (await a.names()).join() === 'Secret Cove', 'the custom place');
});

test('a Google Maps share with coordinates becomes a saved place on every device', async rig => {
  const a = await rig.device();
  await a.evaluate(() => window.cavaleiroShared('Hidden Beach\nhttps://www.google.com/maps/place/Hidden+Beach/@39.2,-76.4,15z/data=!3d39.2051!4d-76.4102'));
  await a.waitForSelector('#add-form');
  assert.match(await a.evaluate(() => document.querySelector('.place-note').textContent), /39\.2051, -76\.4102/);
  await a.tap('[data-add-type="beach"]');
  await a.tap('#add-form button[type="submit"]');
  await rig.until(async () => (await a.names()).join() === 'Hidden Beach', 'it is in My Places');
  await rig.until(() => rig.custom()['user:hidden_beach'] && rig.sheet()['user:hidden_beach'] === 1, 'it reached the sheet');
  assert.deepStrictEqual([rig.custom()['user:hidden_beach'].lat, rig.custom()['user:hidden_beach'].type], [39.2051, 'beach']);

  const b = await rig.device();
  await b.category('saved');
  await rig.until(async () => (await b.names()).join() === 'Hidden Beach', 'the other device has it');
  // Deleting it on one device removes it from the other
  await b.tap('#list .card[data-id="user:hidden_beach"]');
  await b.tap('[data-act="delete-custom"]');
  await rig.until(() => rig.custom()['user:hidden_beach']?.deleted === true, 'the delete reached the sheet');
  await a.open();
  await a.category('saved');
  await rig.until(async () => (await a.names()).length === 0, 'gone from the first device');
});

test('a share with only a short link is found by name', async rig => {
  const a = await rig.device();
  await a.evaluate(() => window.cavaleiroShared('Pot Rocks\nhttps://maps.app.goo.gl/AbC123'));
  await rig.until(() => a.evaluate(() => /39\.4760, -76\.4480/.test(document.querySelector('.place-note')?.textContent || '')), 'the geocoded spot');
  await a.tap('#add-form button[type="submit"]');
  await rig.until(async () => (await a.names()).join() === 'Pot Rocks', 'added');
});

test('a place that cannot be located is never saved at 0°, 0°', async rig => {
  const a = await rig.device();
  await a.evaluate(() => window.cavaleiroShared('Mystery Spot\nhttps://www.google.com/maps/@0,0,3z'));
  await rig.until(() => a.evaluate(() => /Could not work out where/.test(document.querySelector('.place-note')?.textContent || '')), 'the warning');
  await a.tap('#add-form button[type="submit"]');
  await rig.sleep(300);
  assert.deepStrictEqual(await a.storage('cavaleiro_custom'), null);
  // …until coordinates are typed in
  await a.type('#add-coords', '39.3000, -76.6000');
  await a.tap('#add-form button[type="submit"]');
  await rig.until(async () => (await a.names()).join() === 'Mystery Spot', 'added with typed coordinates');
});

test('the old Android app\'s saved places and added places come across once', async rig => {
  const android = JSON.stringify({
    favorites: ['seed:downspark', 'user:pot_rocks', 'user:lost'], visited: ['osm:n2'], bad: [], hidden: ['osm:n1'],
    taste: { water: 1.9, park: 1.2 },
    places: [
      { id: 'user:pot_rocks', name: 'Pot Rocks', type: 'swim', lat: 39.476, lng: -76.448, url: 'https://maps.app.goo.gl/x' },
      { id: 'user:lost', name: 'Lost Somewhere', type: 'gems', lat: 0, lng: 0, url: '' },
    ],
  });
  const a = await rig.device({ android });
  await a.category('saved');
  assert.deepStrictEqual((await a.names()).sort(), ['Downs Park', 'Lost Somewhere', 'Pot Rocks']);
  // The one the old app saved at 0°, 0° is listed without a distance instead of "5,497 mi"
  assert.strictEqual(await a.evaluate(() => document.querySelector('.card[data-id="user:lost"] .dist').textContent), 'No location yet');
  await rig.until(() => Object.keys(rig.sheet()).length === 5 && Object.keys(rig.custom()).length === 2, 'everything reached the sheet');
  assert.deepStrictEqual(rig.gas.rows('Taste').map(r => r.slice(0, 2)), [['water', 1.9]]);
  // A second start does not import again
  await a.tap('#list .card[data-id="seed:downspark"] .card-heart');
  await rig.until(() => rig.sheet()['seed:downspark'] === 0, 'un-saved');
  await a.open();
  await a.category('saved');
  assert.ok(!(await a.names()).includes('Downs Park'));
});

(async () => {
  let failed = 0;
  for (const { name, fn, options } of tests) {
    const rig = await start(options);
    try { await fn(rig); console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
    finally { await rig.stop(); }
  }
  console.log(`${tests.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
