// Checks places.json itself: everything is in the area, nothing is junk, and
// the places that must be there are there. Run: node tests/data_test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { HOME, REGION, MAX_MILES, miles } = require('../data/region');

const ROOT = path.join(__dirname, '..');
const places = JSON.parse(fs.readFileSync(path.join(ROOT, 'places.json'), 'utf8'));
const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'archive.json'), 'utf8'));
const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'legacy', 'old_places.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n').slice(0, 12).join('\n      ')); process.exitCode = 1; }
}
const flat = s => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, ' ').trim();
const has = name => places.some(p => flat(p.name).includes(flat(name)));

test('every place is in the covered area (nothing "5,000 miles away")', () => {
  const far = places.filter(p =>
    miles(HOME.lat, HOME.lng, p.lat, p.lng) > MAX_MILES ||
    p.lat < REGION.south || p.lat > REGION.north || p.lng < REGION.west || p.lng > REGION.east);
  assert.deepStrictEqual(far.map(p => p.name), []);
  assert.ok(places.every(p => /, (MD|DC|VA|WV|PA|DE)$|^(MD|DC|VA|WV|PA|DE)$/.test(p.where)), 'every place says which state it is in');
});

test('every place has the fields the app needs, and ids are unique', () => {
  const ids = new Set();
  for (const p of places) {
    assert.ok(p.id && p.name && p.type && Array.isArray(p.tags) && p.tags.length, 'incomplete: ' + JSON.stringify(p).slice(0, 120));
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat || p.lng), 'no coordinates: ' + p.name);
    assert.ok(p.q >= 30 && p.q <= 99, 'q out of range: ' + p.name);
    assert.ok(!ids.has(p.id), 'duplicate id ' + p.id);
    ids.add(p.id);
  }
});

test('the junk that used to fill the list is gone', () => {
  const junk = places.filter(p => p.q < 60 && (
    /plaque|boundary stone|mile ?marker|milestone|\bmonument\b.*\b(regiment|infantry|battery|cavalry)\b/i.test(p.name) ||
    /^\d+(\/\d+)?$/.test(p.name) ||
    /(hoa|homeowners|tot lot|playground|tennis courts?|dog park)\b/i.test(p.name) ||
    /^elevation: \d+m$/i.test(p.desc || '')));
  assert.deepStrictEqual(junk.map(p => p.name), []);
  // The old list had 5,335 swept entries and 498 "gems" that were just nearby Wikipedia articles
  const gemsNoStory = places.filter(p => p.type === 'gems' && !p.desc && !p.url);
  assert.ok(gemsNoStory.length < places.filter(p => p.type === 'gems').length * 0.6, 'most gems should say what they are');
});

test('the places Alex already loves are all there', () => {
  const favorites = ['Maryland Heights', 'Downs Park', 'Lake Waterford Park', 'Kinder Farm Park', 'Piney Orchard Nature Preserve',
    'Calvert Cliffs State Park', "Scott's Run Nature Preserve", 'Easton Point Park', 'Pot Rocks', 'Dolly Sods',
    'White Cliffs of Conoy', 'Hooper', 'Terrapin Nature Park', 'Fort Smallwood Park', 'Beverly', 'Paw Paw Tunnel',
    'Crystal Grottoes', 'Sideling Hill', 'Gathland', 'Battle Creek Cypress Swamp', 'Franciscan Monastery'];
  assert.deepStrictEqual(favorites.filter(n => !has(n)), []);
});

test('the well-known places of the region are all there', () => {
  const known = [
    // hikes and views
    'Old Rag', 'Whiteoak Canyon', 'Hawksbill', 'Stony Man', 'Marys Rock', 'Bearfence', 'Billy Goat Trail', 'Sugarloaf Mountain',
    'Annapolis Rock', 'Weverton Cliffs', 'Chimney Rock', 'King and Queen Seat', 'Raven Rocks', 'Bears Den', 'Big Schloss',
    'Seneca Rocks', 'Spruce Knob', 'Bear Rocks', 'Lindy Point', 'Pole Steeple', 'Chickies Rock', 'Pinnacle Overlook', 'Signal Knob',
    // waterfalls
    'Great Falls', 'Kilgore Falls', 'Cunningham Falls', 'Muddy Creek Falls', 'Swallow Falls', 'Blackwater Falls', 'Dark Hollow Falls',
    'Cascade Falls', 'Overall Run Falls',
    // beaches, bay and shore
    'Sandy Point State Park', 'Quiet Waters Park', 'North Point State Park', 'Elk Neck State Park', 'Point Lookout State Park',
    'Flag Ponds', 'Matapeake', 'Assateague', 'Cape Henlopen', 'Blackwater National Wildlife Refuge', 'Eastern Neck',
    'Janes Island', 'Bombay Hook', 'Trap Pond',
    // parks
    'Patapsco Valley State Park', 'Gunpowder Falls State Park', 'Catoctin Mountain Park', 'Shenandoah National Park',
    'Rocks State Park', 'Susquehanna State Park', 'Soldiers Delight', 'Loch Raven', 'Oregon Ridge', 'Seneca Creek State Park',
    'Rock Creek Park', 'Prince William Forest Park', 'Sky Meadows', 'Greenbrier State Park', 'Rocky Gap', 'Tuckahoe State Park',
    'Jug Bay', 'Huntley Meadows', 'Mason Neck', 'Theodore Roosevelt Island', 'Kenilworth',
    // gems
    'Luray Caverns', 'Mallows Bay', 'Fort McHenry', 'Fort Washington', 'Turkey Point Light', 'Conowingo Dam', 'Ladew',
    'National Arboretum', 'Abandoned Pennsylvania Turnpike', 'Monocacy Aqueduct', 'Antietam',
  ];
  assert.deepStrictEqual(known.filter(n => !has(n)), []);
});

test('abandoned places and ruins can be found under Gems (the Harpers Ferry factory ruins included)', () => {
  const ruins = places.filter(p => p.tags.includes('abandoned') || p.tags.includes('ruins'));
  assert.ok(ruins.length >= 150, `only ${ruins.length} abandoned places / ruins`);
  const harpersFerry = ruins.filter(p => miles(39.3235, -77.7300, p.lat, p.lng) < 3).map(p => p.name);
  assert.ok(harpersFerry.some(n => /virginius|pulp|shenandoah/i.test(n)), 'Virginius Island / pulp factory ruins near Harpers Ferry: ' + harpersFerry.join(', '));
  for (const name of ['Daniels', 'Paw Paw Tunnel', 'Gathland', 'Catoctin Furnace', 'Seneca', 'Fort Howard', 'Glen Echo']) {
    assert.ok(has(name), 'missing ' + name);
  }
});

test('every curated place made it in (or is outside the area)', () => {
  const curatedDir = path.join(ROOT, 'data', 'curated');
  const missing = [];
  for (const file of fs.readdirSync(curatedDir)) {
    for (const c of JSON.parse(fs.readFileSync(path.join(curatedDir, file), 'utf8'))) {
      if (c.lat == null) continue;
      const inside = miles(HOME.lat, HOME.lng, c.lat, c.lng) <= MAX_MILES && c.lat >= REGION.south && c.lat <= REGION.north && c.lng >= REGION.west && c.lng <= REGION.east;
      if (!inside) continue;
      // Either the place itself or a twin within a few miles under another name
      const found = places.some(p => miles(p.lat, p.lng, c.lat, c.lng) < 10 && (flat(p.name) === flat(c.name) || p.q >= 60 && miles(p.lat, p.lng, c.lat, c.lng) < 2.5));
      if (!found) missing.push(`${c.name} (${file})`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('each category has plenty to show, near home too', () => {
  const near = places.filter(p => miles(HOME.lat, HOME.lng, p.lat, p.lng) <= 40);
  const count = (list, f) => list.filter(f).length;
  const need = (label, n, min) => assert.ok(n >= min, `${label}: ${n} (expected at least ${min})`);
  need('hikes', count(places, p => ['hike', 'trail'].includes(p.type)), 400);
  need('waterfalls', count(places, p => p.type === 'waterfall' || p.tags.includes('waterfall')), 100);
  need('beaches and waterfront', count(places, p => ['beach', 'water'].includes(p.type) || p.tags.includes('waterfront')), 250);
  need('views', count(places, p => p.type === 'viewpoint' || p.tags.includes('viewpoint')), 400);
  need('gems', count(places, p => ['gems', 'caves', 'historic'].includes(p.type)), 350);
  need('running', count(places, p => p.type === 'run' || p.tags.includes('running')), 60);
  need('swimming', count(places, p => p.type === 'swim' || p.tags.includes('swimming')), 60);
  need('within 40 miles of home', near.length, 500);
  need('top picks within 40 miles of home', count(near, p => p.q >= 80), 25);
});

test('old ids still resolve: kept, folded into another entry, or in archive.json', () => {
  const now = new Set([...places.map(p => p.id), ...places.flatMap(p => p.was || []), ...archive.map(r => r[0])]);
  assert.deepStrictEqual(legacy.map(r => r[0]).filter(id => !now.has(id)), []);
  assert.ok(places.filter(p => p.id.startsWith('seed:')).length >= 70, "Alex's own list keeps its ids");
});

test('photos come from Wikimedia and descriptions are not boilerplate', () => {
  const photos = places.filter(p => p.img);
  assert.deepStrictEqual(photos.filter(p => !/^https:\/\/[a-z]+\.wikimedia\.org\//.test(p.img)).map(p => p.img), []);
  assert.ok(photos.length >= 600, `only ${photos.length} places have a photo`);
  assert.ok(places.filter(p => p.desc).length >= places.length * 0.4, 'too few descriptions');
  // Every hand-picked place says what it is
  assert.deepStrictEqual(places.filter(p => /^(seed|c):/.test(p.id) && !p.desc).map(p => p.name), []);
});

console.log(`${passed} passed  (${places.length.toLocaleString()} places)`);
