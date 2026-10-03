#!/usr/bin/env python3
"""
Cavaleiro Andante — Park Interior Sweep
Finds named parks/forests in the region, then sweeps INSIDE each one
for trails, features, viewpoints, and points of interest.

Usage:
  python3 sweep_parks.py
"""

import sys, json, time, urllib.request, urllib.parse, re, os, ssl, math
ssl._create_default_https_context = ssl._create_unverified_context

PLACES_JS    = os.path.join(os.path.dirname(__file__), "places.js")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
HOME         = (39.1037, -76.5338)

# Big parks/forests to drill into — found by name in OSM
# These are centers of major recreation areas where we want trail-level detail
MAJOR_PARKS = [
    # National Parks & Forests
    {"name": "Rock Creek Park",                   "lat": 38.960, "lng": -77.050, "radius": 6000},
    {"name": "Shenandoah National Park area",     "lat": 38.530, "lng": -78.350, "radius": 12000},
    {"name": "C&O Canal – Western",               "lat": 39.300, "lng": -77.800, "radius": 8000},
    {"name": "C&O Canal – Central",               "lat": 39.200, "lng": -77.500, "radius": 8000},
    {"name": "C&O Canal – Eastern",               "lat": 39.100, "lng": -77.200, "radius": 6000},
    {"name": "Catoctin Mountain Park",             "lat": 39.630, "lng": -77.460, "radius": 5000},
    {"name": "Harpers Ferry NHP",                 "lat": 39.325, "lng": -77.730, "radius": 4000},
    {"name": "Assateague Island NS",              "lat": 38.050, "lng": -75.250, "radius": 8000},
    {"name": "George Washington NF – North",      "lat": 38.900, "lng": -78.400, "radius": 10000},
    {"name": "Seneca Rocks area",                 "lat": 38.830, "lng": -79.370, "radius": 5000},
    {"name": "Monongahela NF – Spruce Knob",      "lat": 38.700, "lng": -79.500, "radius": 8000},
    {"name": "Gettysburg NMP",                    "lat": 39.815, "lng": -77.235, "radius": 5000},
    # State Parks & Forests
    {"name": "Patapsco Valley State Park",        "lat": 39.270, "lng": -76.800, "radius": 8000},
    {"name": "Gunpowder Falls State Park",        "lat": 39.480, "lng": -76.480, "radius": 8000},
    {"name": "Calvert Cliffs State Park",         "lat": 38.420, "lng": -76.430, "radius": 4000},
    {"name": "Cunningham Falls State Park",       "lat": 39.630, "lng": -77.460, "radius": 3000},
    {"name": "Gambrill State Park",               "lat": 39.450, "lng": -77.500, "radius": 3000},
    {"name": "Greenbrier State Park",             "lat": 39.700, "lng": -77.640, "radius": 3000},
    {"name": "Savage River State Forest",         "lat": 39.560, "lng": -79.100, "radius": 8000},
    {"name": "Green Ridge State Forest",          "lat": 39.600, "lng": -78.560, "radius": 8000},
    {"name": "Deep Creek Lake SP",                "lat": 39.520, "lng": -79.320, "radius": 5000},
    {"name": "Elk Neck State Park",               "lat": 39.460, "lng": -75.980, "radius": 4000},
    {"name": "Susquehanna State Park",            "lat": 39.580, "lng": -76.080, "radius": 4000},
    {"name": "Swallow Falls State Park",          "lat": 39.500, "lng": -79.400, "radius": 3000},
    {"name": "New Germany State Park",            "lat": 39.540, "lng": -79.120, "radius": 3000},
    {"name": "South Mountain State Park",         "lat": 39.560, "lng": -77.560, "radius": 6000},
    {"name": "Seneca Creek State Park",           "lat": 39.170, "lng": -77.280, "radius": 5000},
    {"name": "Black Hill Regional Park",          "lat": 39.170, "lng": -77.280, "radius": 3000},
    {"name": "Little Bennett Regional Park",      "lat": 39.270, "lng": -77.280, "radius": 4000},
    # Virginia/WV
    {"name": "Prince William Forest Park",        "lat": 38.570, "lng": -77.350, "radius": 5000},
    {"name": "Sky Meadows State Park",            "lat": 38.990, "lng": -77.980, "radius": 3000},
    {"name": "G. Richard Thompson WMA",           "lat": 38.970, "lng": -77.990, "radius": 4000},
    {"name": "Massanutten Mountain",              "lat": 38.600, "lng": -78.690, "radius": 8000},
    {"name": "Dolly Sods Wilderness",             "lat": 38.980, "lng": -79.290, "radius": 5000},
    {"name": "Canaan Valley",                     "lat": 39.000, "lng": -79.450, "radius": 5000},
]


def build_park_interior_query(lat, lng, radius):
    r = radius
    return (
        f"[out:json][timeout:60];"
        f"("
        # Named trails / paths
        f'way["highway"="path"]["name"](around:{r},{lat},{lng});'
        f'way["highway"="footway"]["name"](around:{r},{lat},{lng});'
        f'way["highway"="track"]["name"]["sac_scale"](around:{r},{lat},{lng});'
        # Named hiking routes
        f'relation["route"="hiking"]["name"](around:{r},{lat},{lng});'
        f'relation["route"="foot"]["name"](around:{r},{lat},{lng});'
        f'relation["route"="mtb"]["name"](around:{r},{lat},{lng});'
        # Natural features inside parks
        f'node["natural"="waterfall"](around:{r},{lat},{lng});'
        f'node["waterway"="waterfall"](around:{r},{lat},{lng});'
        f'node["natural"="peak"]["name"](around:{r},{lat},{lng});'
        f'node["tourism"="viewpoint"]["name"](around:{r},{lat},{lng});'
        f'node["natural"="spring"]["name"](around:{r},{lat},{lng});'
        f'node["natural"="cave_entrance"]["name"](around:{r},{lat},{lng});'
        # Amenity points inside parks
        f'node["leisure"="picnic_table"]["name"](around:{r},{lat},{lng});'
        f'node["tourism"="camp_site"]["name"](around:{r},{lat},{lng});'
        f'node["amenity"="shelter"]["name"](around:{r},{lat},{lng});'
        f');\nout center 300;'
    )


def fetch_overpass(query):
    data = ('data=' + urllib.parse.quote(query)).encode()
    req  = urllib.request.Request(
        OVERPASS_URL, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "User-Agent": "CavaleiroAndante/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def classify(t):
    if t.get("natural") == "waterfall" or t.get("waterway") == "waterfall": return "waterfall"
    if t.get("natural") == "peak":      return "hike"
    if t.get("tourism") == "viewpoint": return "viewpoint"
    if t.get("natural") == "cave_entrance": return "gems"
    if t.get("natural") == "spring":    return "water"
    if t.get("route") in ("hiking", "foot", "mtb"): return "trail"
    if t.get("highway") in ("path", "footway", "track"): return "trail"
    if t.get("leisure") == "picnic_table": return "park"
    if t.get("tourism") == "camp_site": return "park"
    if t.get("amenity") == "shelter":   return "park"
    return "trail"


def get_tags(t, type_):
    tags = []
    if type_ == "waterfall":   tags += ["waterfall", "water", "scenic"]
    if type_ == "water":       tags += ["water", "scenic"]
    if type_ == "trail":       tags += ["trail", "hiking", "nature"]
    if type_ == "park":        tags += ["park", "nature"]
    if type_ == "hike":        tags += ["hiking", "scenic", "nature"]
    if type_ == "viewpoint":   tags += ["viewpoint", "scenic"]
    if type_ == "gems":        tags += ["gems"]
    if t.get("sac_scale"):     tags += ["hiking"]
    if t.get("mtb:scale"):     tags += ["mtb"]
    return list(dict.fromkeys(tags))


def dist_miles(lat1, lng1, lat2, lng2):
    R = 3958.8
    dlat = (lat2 - lat1) * math.pi / 180
    dlng = (lng2 - lng1) * math.pi / 180
    a = math.sin(dlat/2)**2 + math.cos(lat1*math.pi/180)*math.cos(lat2*math.pi/180)*math.sin(dlng/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def build_desc(t, park_name):
    parts = [f"In {park_name}"]
    if t.get("description"):   parts.append(t["description"])
    if t.get("sac_scale"):     parts.append(f"Difficulty: {t['sac_scale'].replace('_',' ')}")
    if t.get("distance"):      parts.append(f"Length: {t['distance']} km")
    if t.get("ele"):           parts.append(f"Elevation: {t['ele']}m")
    if t.get("surface"):       parts.append(f"Surface: {t['surface']}")
    return " · ".join(parts)


def parse(data, park_name):
    out, seen = [], set()
    for el in data.get("elements", []):
        t    = el.get("tags", {})
        name = t.get("name") or t.get("name:en")
        if not name: continue
        key = name.lower().strip()
        if key in seen: continue
        seen.add(key)

        if el["type"] == "node":
            lat, lng = el["lat"], el["lon"]
        elif el.get("center"):
            lat, lng = el["center"]["lat"], el["center"]["lon"]
        else:
            continue

        skip = ["parking", "restroom", "bathroom", "toilet", "trash", "dumpster"]
        if any(s in name.lower() for s in skip): continue

        type_ = classify(t)
        tags  = get_tags(t, type_)
        dist  = round(dist_miles(HOME[0], HOME[1], lat, lng), 1)
        slug  = re.sub(r'[^a-z0-9]', '', name.lower())[:20]
        desc  = build_desc(t, park_name)

        out.append({
            "id":          f"pk:{slug}",
            "name":        name,
            "type":        type_,
            "tags":        tags,
            "lat":         round(lat, 5),
            "lng":         round(lng, 5),
            "dist":        dist,
            "description": desc,
            "zone":        park_name,
            "source":      "park_sweep",
            "score":       0,
        })
    return out


def load_existing():
    if not os.path.exists(PLACES_JS):
        return [], set()
    with open(PLACES_JS) as f:
        content = f.read()
    m = re.search(r"const PARK_PLACES\s*=\s*(\[.*?\]);", content, re.DOTALL)
    existing = []
    if m:
        try: existing = json.loads(m.group(1))
        except: pass
    # All known names across all sources
    all_names = set()
    for pat in [r'"name"\s*:\s*"([^"]+)"']:
        for match in re.finditer(pat, content):
            all_names.add(match.group(1).lower())
    return existing, all_names


def save(places):
    with open(PLACES_JS) as f:
        content = f.read()
    js = "\n// Park interior trails and features\nconst PARK_PLACES = "
    js += json.dumps(places, indent=2, ensure_ascii=False) + ";\n"
    content = re.sub(r"\n// Park interior.*?const PARK_PLACES\s*=\s*\[.*?\];\n", "", content, flags=re.DOTALL)
    content += js
    with open(PLACES_JS, "w") as f:
        f.write(content)
    print(f"  → Saved {len(places)} park interior places")


def main():
    existing, all_names = load_existing()
    print(f"Known names: {len(all_names)}")

    all_new = []
    for park in MAJOR_PARKS:
        print(f"\n🏞 {park['name']}")
        try:
            q    = build_park_interior_query(park["lat"], park["lng"], park["radius"])
            data = fetch_overpass(q)
            new  = parse(data, park["name"])
            added = [p for p in new if p["name"].lower() not in all_names]
            for p in added:
                all_names.add(p["name"].lower())
            all_new.extend(added)
            print(f"  ✓ {len(new)} found, {len(added)} new")
            time.sleep(4)
        except Exception as e:
            print(f"  ✗ {e}")
            time.sleep(8)

    existing.extend(all_new)
    print(f"\n✅ Added {len(all_new)} park interior places. Total: {len(existing)}")
    save(existing)


if __name__ == "__main__":
    main()
