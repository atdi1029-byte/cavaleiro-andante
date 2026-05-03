#!/usr/bin/env python3
"""
Cavaleiro Andante — Sweep Script
Queries Overpass for outdoor spots in a zone, appends to places.js

Usage:
  python3 sweep.py                    # sweep all zones
  python3 sweep.py "Eastern Shore"    # sweep one zone by name
  python3 sweep.py --list             # list all zones
"""

import sys, json, time, urllib.request, urllib.parse, re, os, ssl
ssl._create_default_https_context = ssl._create_unverified_context

# ── SWEEP ZONES ──────────────────────────────────────────────
# Broad geographic areas, not individual neighborhoods
ZONES = [
  { "name": "Washington DC Metro",     "lat": 38.907, "lng": -77.037, "radius": 28000 },
  { "name": "Montgomery County MD",    "lat": 39.084, "lng": -77.152, "radius": 25000 },
  { "name": "Prince George's County",  "lat": 38.830, "lng": -76.850, "radius": 25000 },
  { "name": "Baltimore City",          "lat": 39.290, "lng": -76.612, "radius": 20000 },
  { "name": "Baltimore County",        "lat": 39.400, "lng": -76.720, "radius": 25000 },
  { "name": "Howard County MD",        "lat": 39.215, "lng": -76.850, "radius": 20000 },
  { "name": "Annapolis & Anne Arundel","lat": 38.972, "lng": -76.501, "radius": 25000 },
  { "name": "Eastern Shore North",     "lat": 39.210, "lng": -76.070, "radius": 30000 },
  { "name": "Eastern Shore Central",   "lat": 38.770, "lng": -76.070, "radius": 28000 },
  { "name": "Eastern Shore South",     "lat": 38.430, "lng": -76.050, "radius": 30000 },
  { "name": "Southern Maryland",       "lat": 38.550, "lng": -76.600, "radius": 30000 },
  { "name": "Northern Virginia",       "lat": 38.850, "lng": -77.200, "radius": 25000 },
  { "name": "Shenandoah & Western MD", "lat": 38.900, "lng": -78.000, "radius": 40000 },
  { "name": "Harpers Ferry & Loudoun", "lat": 39.325, "lng": -77.730, "radius": 30000 },
  { "name": "Frederick & Catoctin",    "lat": 39.415, "lng": -77.410, "radius": 28000 },
  { "name": "Philadelphia & Delaware", "lat": 39.950, "lng": -75.165, "radius": 25000 },
  { "name": "Deep Creek & Garrett County", "lat": 39.530, "lng": -79.300, "radius": 30000 },
  { "name": "WV Highlands",            "lat": 38.830, "lng": -79.370, "radius": 30000 },
  { "name": "Gettysburg & Adams County","lat": 39.830, "lng": -77.230, "radius": 28000 },
  { "name": "Assateague & Lower Shore", "lat": 38.100, "lng": -75.450, "radius": 30000 },
  { "name": "Delaware Beaches",        "lat": 38.720, "lng": -75.080, "radius": 25000 },
  { "name": "Upper Chesapeake & Elk Neck","lat": 39.520, "lng": -76.050, "radius": 28000 },
]

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
PLACES_JS    = os.path.join(os.path.dirname(__file__), "places.js")
HOME         = (39.1037, -76.5338)  # Pasadena MD

# ── OVERPASS QUERIES (split into two to avoid timeout) ────────
def build_query_nature(lat, lng, radius):
    r = radius
    return (
        f"[out:json][timeout:45];"
        f"("
        f'node["natural"="waterfall"](around:{r},{lat},{lng});'
        f'node["waterway"="waterfall"](around:{r},{lat},{lng});'
        f'node["natural"="beach"]["name"](around:{r},{lat},{lng});'
        f'way["natural"="beach"]["name"](around:{r},{lat},{lng});'
        f'node["natural"="peak"]["name"](around:{r},{lat},{lng});'
        f'node["tourism"="viewpoint"]["name"](around:{r},{lat},{lng});'
        f'way["leisure"="park"]["name"](around:{r},{lat},{lng});'
        f'relation["leisure"="park"]["name"](around:{r},{lat},{lng});'
        f');\nout center 200;'
    )

def build_query_historic(lat, lng, radius):
    r = radius
    return (
        f"[out:json][timeout:45];"
        f"("
        f'node["historic"]["name"](around:{r},{lat},{lng});'
        f'way["historic"]["name"](around:{r},{lat},{lng});'
        f'way["leisure"="nature_reserve"]["name"](around:{r},{lat},{lng});'
        f'relation["leisure"="nature_reserve"]["name"](around:{r},{lat},{lng});'
        f'relation["boundary"="national_park"]["name"](around:{r},{lat},{lng});'
        f'node["tourism"="attraction"]["name"](around:{r},{lat},{lng});'
        f');\nout center 150;'
    )

def fetch_overpass(query):
    data = ('data=' + urllib.parse.quote(query)).encode()
    req  = urllib.request.Request(
        OVERPASS_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "User-Agent": "CavaleiroAndante/1.0"}
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read())

# ── CLASSIFY ─────────────────────────────────────────────────
def classify(t):
    if t.get("natural") == "waterfall" or t.get("waterway") == "waterfall":
        return "waterfall"
    if t.get("natural") in ("beach", "coastline"):     return "water"
    if t.get("natural") == "water":                    return "water"
    if t.get("natural") == "peak":                     return "hike"
    if t.get("route") in ("hiking", "foot"):           return "trail"
    if t.get("highway") in ("path", "track", "footway"): return "trail"
    if t.get("boundary") in ("national_park", "protected_area", "national_forest"):
        return "park"
    if t.get("leisure") in ("nature_reserve",):        return "park"
    if t.get("leisure") == "park":                     return "park"
    if t.get("tourism") == "viewpoint":                return "viewpoint"
    if t.get("historic") or t.get("tourism") in ("attraction", "artwork"):
        return "weird"
    return None

def get_tags(t, type_):
    tags = []
    if type_ == "waterfall":  tags += ["waterfall", "water", "scenic"]
    if type_ == "water":      tags += ["water", "scenic"]
    if type_ == "trail":      tags += ["trail", "hiking", "nature"]
    if type_ == "park":       tags += ["park", "nature"]
    if type_ == "hike":       tags += ["hiking", "scenic", "nature"]
    if type_ == "viewpoint":  tags += ["viewpoint", "scenic"]
    if type_ == "weird":      tags += ["weird"]
    if t.get("leisure") == "nature_reserve": tags += ["forest", "hiking"]
    if t.get("boundary") == "national_park": tags += ["forest", "hiking"]
    if t.get("historic"):     tags += ["historic"]
    if t.get("sac_scale"):    tags += ["hiking"]
    if t.get("natural") in ("wood",): tags += ["forest"]
    return list(dict.fromkeys(tags))  # dedupe preserving order

def dist_miles(lat1, lng1, lat2, lng2):
    import math
    R = 3958.8
    dlat = (lat2 - lat1) * math.pi / 180
    dlng = (lng2 - lng1) * math.pi / 180
    a = math.sin(dlat/2)**2 + math.cos(lat1*math.pi/180)*math.cos(lat2*math.pi/180)*math.sin(dlng/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def build_desc(t):
    parts = []
    if t.get("description"):   parts.append(t["description"])
    if t.get("sac_scale"):     parts.append(f"Difficulty: {t['sac_scale'].replace('_',' ')}")
    if t.get("distance"):      parts.append(f"Length: {t['distance']} km")
    if t.get("ele"):           parts.append(f"Elevation: {t['ele']}m")
    if t.get("opening_hours"): parts.append(f"Hours: {t['opening_hours']}")
    if t.get("fee"):           parts.append(f"Fee: {t['fee']}")
    if t.get("dog"):           parts.append(f"Dogs: {t['dog']}")
    if t.get("historic"):      parts.append(f"Historic: {t['historic'].replace('_',' ')}")
    return " · ".join(parts)

# ── PARSE RESULTS ─────────────────────────────────────────────
def parse(data, zone_name):
    out  = []
    seen = set()
    for el in data.get("elements", []):
        t    = el.get("tags", {})
        name = t.get("name") or t.get("name:en")
        if not name: continue
        key  = name.lower().strip()
        if key in seen: continue
        seen.add(key)

        if el["type"] == "node":
            lat, lng = el["lat"], el["lon"]
        elif el.get("center"):
            lat, lng = el["center"]["lat"], el["center"]["lon"]
        else:
            continue

        type_ = classify(t)
        if not type_: continue

        # Skip tiny urban parks and generic names
        skip = ["parking","rest area","rest stop","playground","dog park",
                "community garden","school","church","cemetery","memorial park"]
        if any(s in name.lower() for s in skip): continue

        tags = get_tags(t, type_)
        desc = build_desc(t)
        dist = round(dist_miles(HOME[0], HOME[1], lat, lng), 1)
        slug = re.sub(r'[^a-z0-9]', '', name.lower())[:20]

        out.append({
            "id":      f"sw:{slug}",
            "name":    name,
            "type":    type_,
            "tags":    tags,
            "lat":     round(lat, 5),
            "lng":     round(lng, 5),
            "dist":    dist,
            "description": desc,
            "zone":    zone_name,
            "osmTags": {},
            "osmType": el["type"],
            "osmId":   el["id"],
            "score":   0
        })
    return out

# ── LOAD / SAVE PLACES.JS ─────────────────────────────────────
def load_existing():
    """Extract existing swept places from places.js"""
    if not os.path.exists(PLACES_JS):
        return [], set()
    with open(PLACES_JS) as f:
        content = f.read()
    # Find the SWEPT_PLACES array
    m = re.search(r'const SWEPT_PLACES\s*=\s*(\[.*?\]);', content, re.DOTALL)
    if not m:
        return [], set()
    try:
        places = json.loads(m.group(1))
        names  = {p["name"].lower() for p in places}
        return places, names
    except:
        return [], set()

def save_places(places):
    js = "// Auto-generated by sweep.py — do not edit by hand\n"
    js += "// Swept places database for Cavaleiro Andante\n\n"
    js += "const SWEPT_PLACES = "
    js += json.dumps(places, indent=2, ensure_ascii=False)
    js += ";\n"
    with open(PLACES_JS, "w") as f:
        f.write(js)
    print(f"  → Saved {len(places)} total places to places.js")

def load_sweep_status():
    """Track which zones have been swept"""
    status_file = os.path.join(os.path.dirname(__file__), ".sweep_status.json")
    if os.path.exists(status_file):
        with open(status_file) as f:
            return json.load(f)
    return {}

def save_sweep_status(status):
    status_file = os.path.join(os.path.dirname(__file__), ".sweep_status.json")
    with open(status_file, "w") as f:
        json.dump(status, f, indent=2)

# ── MAIN ──────────────────────────────────────────────────────
def sweep_zone(zone, existing_places, existing_names):
    print(f"\n🔍 Sweeping: {zone['name']}")
    total_new, total_added = 0, 0
    for label, qfn in [("nature", build_query_nature), ("historic", build_query_historic)]:
        try:
            q    = qfn(zone["lat"], zone["lng"], zone["radius"])
            data = fetch_overpass(q)
            new  = parse(data, zone["name"])
            added = [p for p in new if p["name"].lower() not in existing_names]
            for p in added:
                existing_names.add(p["name"].lower())
                existing_places.append(p)
            total_new += len(new); total_added += len(added)
            time.sleep(2)
        except Exception as e:
            print(f"  ✗ {label} query failed: {e}")
    print(f"  ✓ Found {total_new} places, added {total_added} new")
    return total_added

def main():
    args = sys.argv[1:]

    if "--list" in args:
        print("\nSweep zones:")
        status = load_sweep_status()
        for z in ZONES:
            s = status.get(z["name"], {})
            swept = f"✓ {s.get('count',0)} places ({s.get('date','?')})" if s else "○ not swept"
            print(f"  {swept:35s} {z['name']}")
        return

    existing, existing_names = load_existing()
    status = load_sweep_status()
    print(f"Loaded {len(existing)} existing places")

    if args:
        target = " ".join(args)
        zones  = [z for z in ZONES if target.lower() in z["name"].lower()]
        if not zones:
            print(f"No zone matching '{target}'. Use --list to see zones.")
            return
    else:
        zones = ZONES

    total_added = 0
    for zone in zones:
        count  = sweep_zone(zone, existing, existing_names)
        total_added += count
        status[zone["name"]] = {
            "date":  __import__("datetime").date.today().isoformat(),
            "count": status.get(zone["name"], {}).get("count", 0) + count
        }
        save_sweep_status(status)
        if len(zones) > 1:
            time.sleep(3)  # be polite to Overpass

    save_places(existing)
    print(f"\n✅ Done. Added {total_added} new places. Total: {len(existing)}")

if __name__ == "__main__":
    main()
