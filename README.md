# Cavaleiro Andante

Find hikes, beaches, waterfalls, views and odd corners within a day trip of
Pasadena, MD. A web app (GitHub Pages) that the Android app also runs inside.

Live: https://atdi1029-byte.github.io/cavaleiro-andante/

## How it fits together

```
index.html, style.css      the page and its look
js/app.js                  state + wiring (start here)
js/config.js               settings: categories, place types, colors, map layers
js/catalog.js              the places: loading, filtering, "Best first" ranking
js/store.js                what you saved / visited / hid, taste, places you added
js/sync.js                 keeps store.js in step with the Google Sheet
js/ui.js                   HTML for cards, the detail sheet, etc.
js/map.js                  the map (best places in view, no clusters)
js/addplace.js             adding a place from a Google Maps share or by name
js/weather.js              is it raining? offers the Rainy day list (Open-Meteo, no key)
places.json                every place the app shows (built, do not edit by hand)
archive.json               old places that were dropped; only used if one was saved
gas_sync.js                the Google Apps Script behind sync
sw.js                      offline support (bump CACHE after every change)
```

The Android app (`../CavaleiroApp`) is a shell: a full-screen WebView on the
live URL plus three things a web page cannot do (share from Google Maps,
location permission, one-time import of the old native app's data). Pushing
here updates the phone too; the APK only needs rebuilding when the shell
itself changes.

## The places

`places.json` is built, in two steps:

```
node data/sweep_osm.js     # download OpenStreetMap features into data/raw/ (cached, ~40 min the first time)
node data/build.js         # merge with data/curated/, add Wikipedia photos and text, write places.json
```

- `data/curated/*.json` are hand-checked lists (Alex's own in `00_alex.json`,
  then one research list per region, one for abandoned places and one for
  rainy days). A curated entry always wins over the OpenStreetMap entry for
  the same place. **To add or fix a place, edit these files and run
  `node data/build.js`.**
- The research lists were compiled from the web in October 2026. Fees, hours
  and closures in them go stale; the app shows them as notes, not promises.
- `data/lib/osm.js` decides which OpenStreetMap features are worth showing
  and scores them (`q`, 0-100). Curated places score 60-92.
- `data/region.js` is the area covered: the box around MD/DC/VA/WV/PA/DE and
  180 miles from home. Nothing outside it gets in.
- Ids are stable. A place that existed before October 2026 keeps its old id
  (`seed:`, `sw:`, `pk:`, `wp:`), so saved places survive a rebuild.

## Sync

One spreadsheet row per saved place, each with a timestamp; the newest change
wins. A device only ever sends the rows it changed, so an empty or wiped
device cannot erase anything. Deploy the script with
`../.clasp/gas_deploy.sh cavaleiro`.

## Tests

```
cd tests && npm install    # once
node tests/gas_test.js     # the Apps Script, against a fake sheet
node tests/data_test.js    # places.json: in the area, no junk, nothing missing
node tests/app_test.js     # the real app in headless Chrome for Testing: lists, saving, sync between two devices
node tests/shell_server.js # serves the app with a fake sheet for trying the Android shell on the emulator
```

The tests never touch the real sheet.
