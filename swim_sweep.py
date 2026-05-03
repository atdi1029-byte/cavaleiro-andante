#!/usr/bin/env python3
"""
Cavaleiro Andante — Swimming Holes & Beaches Sweep
Queries OSM for swimming spots, beaches, river access,
and designated swim areas across the MD/DC/VA/WV region.

Usage:
  python3 swim_sweep.py
"""

import sys, json, time, urllib.request, urllib.parse, re, os, ssl, math
ssl._create_default_https_context = ssl._create_unverified_context

PLACES_JS    = os.path.join(os.path.dirname(__file__), "places.js")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
HOME         = (39.1037, -76.5338)

ZONES = [
    {"name": "Washington DC Metro",       "lat": 38.907, "lng": -77.037, "radius": 28000},
    {"name": "Montgomery County MD",      "lat": 39.084, "lng": -77.152, "radius": 25000},
    {"name": "Prince George's County",    "lat": 38.830, "lng": -76.850, "radius": 25000},
    {"name": "Baltimore City",            "lat": 39.290, "lng": -76.612, "radius": 20000},
    {"name": "Baltimore County",          "lat": 39.400, "lng": -76.720, "radius": 25000},
    {"name": "Howard County MD",          "lat": 39.215, "lng": -76.850, "radius": 20000},
    {"name": "Annapolis & Anne Arundel",  "lat": 38.972, "lng": -76.501, "radius": 25000},
    {"name": "Eastern Shore North",       "lat": 39.210, "lng": -76.070, "radius": 30000},
    {"name": "Eastern Shore Central",     "lat": 38.770, "lng": -76.070, "radius": 28000},
    {"name": "Eastern Shore South",       "lat": 38.430, "lng": -76.050, "radius": 30000},
    {"name": "Southern Maryland",         "lat": 38.550, "lng": -76.600, "radius": 30000},
    {"name": "Northern Virginia",         "lat": 38.850, "lng": -77.200, "radius": 25000},
    {"name": "Shenandoah & Western MD",   "lat": 38.900, "lng": -78.000, "radius": 40000},
    {"name": "Harpers Ferry & Loudoun",   "lat": 39.325, "lng": -77.730, "radius": 30000},
    {"name": "Frederick & Catoctin",      "lat": 39.415, "lng": -77.410, "radius": 28000},
    {"name": "Deep Creek & Garrett County","lat": 39.530, "lng": -79.300, "radius": 30000},
    {"name": "WV Highlands",              "lat": 38.830, "lng": -79.370, "radius": 30000},
    {"name": "Gettysburg & Adams County", "lat": 39.830, "lng": -77.230, "radius": 28000},
    {"name": "Assateague & Lower Shore",  "lat": 38.100, "lng": -75.450, "radius": 30000},
    {"name": "Delaware Beaches",          "lat": 38.720, "lng": -75.080, "radius": 25000},
    {"name": "Upper Chesapeake & Elk Neck","lat": 39.520, "lng": -76.050, "radius": 28000},
    {"name": "Philadelphia & Delaware",   "lat": 39.950, "lng": -75.165, "radius": 25000},
]


def build_swim_query(lat, lng, radius):
    r = radius
    return (
        f"[out:json][timeout:60];"
        f"("
        # Designated swimming areas
        f'node["leisure"="swimming_area"]["name"](around:{r},{lat},{lng});'
        f'way["leisure"="swimming_area"]["name"](around:{r},{lat},{lng});'
        f'node["leisure"="swimming_pool"]["access"="yes"]["name"](around:{r},{lat},{lng});'
        # Beaches
        f'node["natural"="beach"]["name"](around:{r},{lat},{lng});'
        f'way["natural"="beach"]["name"](around:{r},{lat},{lng});'
        f'node["leisure"="beach_resort"]["name"](around:{r},{lat},{lng});'
        f'way["leisure"="beach_resort"]["name"](around:{r},{lat},{lng});'
        # Swimming holes — river/lake access tagged for swimming
        f'node["swimming"="yes"]["name"](around:{r},{lat},{lng});'
        f'node["sport"="swimming"]["name"](around:{r},{lat},{lng});'
        f'way["sport"="swimming"]["name"](around:{r},{lat},{lng});'
        # Water access points
        f'node["amenity"="swimming_area"]["name"](around:{r},{lat},{lng});'
        # Named ford crossings and swimming spots on rivers
        f'node["ford"]["name"](around:{r},{lat},{lng});'
        f'node["natural"="water"]["name"]["swimming"](around:{r},{lat},{lng});'
        f');\nout center 200;'
    )


def build_bay_beach_query(lat, lng, radius):
    """Chesapeake Bay and ocean beach access — ways without name filter."""
    r = radius
    return (
        f"[out:json][timeout:45];"
        f"("
        f'way["natural"="beach"](around:{r},{lat},{lng});'
        f'node["natural"="beach"](around:{r},{lat},{lng});'
        f');\nout center 150;'
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


def dist_miles(lat1, lng1, lat2, lng2):
    R = 3958.8
    dlat = (lat2 - lat1) * math.pi / 180
    dlng = (lng2 - lng1) * math.pi / 180
    a = math.sin(dlat/2)**2 + math.cos(lat1*math.pi/180)*math.cos(lat2*math.pi/180)*math.sin(dlng/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def classify(t):
    leisure = t.get("leisure", "")
    natural = t.get("natural", "")
    if natural == "beach" or leisure in ("beach_resort",):
        return "beach"
    if leisure == "swimming_area" or t.get("swimming") == "yes" or t.get("sport") == "swimming":
        return "swim"
    if t.get("ford"):
        return "swim"
    return "swim"


def get_tags(t, subtype):
    tags = ["swimming", "water"]
    if subtype == "beach":
        tags += ["beach", "scenic"]
    else:
        tags += ["swimming hole"]
    if t.get("natural") == "beach":
        tags += ["scenic"]
    if t.get("access") in ("yes", "public"):
        tags += ["free"]
    if t.get("fee") == "yes":
        tags += ["fee"]
    if t.get("dog") in ("yes", "leashed"):
        tags += ["dogs"]
    return list(dict.fromkeys(tags))


def build_desc(t, zone):
    parts = []
    if t.get("description"):    parts.append(t["description"])
    if t.get("natural") == "beach": parts.append("Beach")
    if t.get("leisure") == "swimming_area": parts.append("Designated swimming area")
    if t.get("swimming") == "yes": parts.append("Swimming spot")
    if t.get("fee") == "yes":   parts.append("Fee required")
    if t.get("fee") == "no":    parts.append("Free")
    if t.get("dog"):            parts.append(f"Dogs: {t['dog']}")
    if t.get("opening_hours"):  parts.append(f"Hours: {t['opening_hours']}")
    if t.get("lifeguard"):      parts.append(f"Lifeguard: {t['lifeguard']}")
    if not parts:               parts.append(f"Swimming spot in {zone}")
    return " · ".join(parts)


def parse(data, zone):
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

        skip = ["parking", "restroom", "toilet", "private", "members only"]
        if any(s in name.lower() for s in skip): continue
        if t.get("access") in ("private", "no"):  continue

        subtype = classify(t)
        tags    = get_tags(t, subtype)
        dist    = round(dist_miles(HOME[0], HOME[1], lat, lng), 1)
        slug    = re.sub(r'[^a-z0-9]', '', name.lower())[:20]
        desc    = build_desc(t, zone)

        out.append({
            "id":          f"sw2:{slug}",
            "name":        name,
            "type":        "swim",
            "tags":        tags,
            "lat":         round(lat, 5),
            "lng":         round(lng, 5),
            "dist":        dist,
            "description": desc,
            "zone":        zone,
            "source":      "swim_sweep",
            "score":       0,
        })
    return out


def load_existing():
    if not os.path.exists(PLACES_JS):
        return [], set()
    with open(PLACES_JS) as f:
        content = f.read()
    all_names = set()
    for match in re.finditer(r'"name"\s*:\s*"([^"]+)"', content):
        all_names.add(match.group(1).lower())
    m = re.search(r"const SWIM_PLACES\s*=\s*(\[.*?\]);", content, re.DOTALL)
    existing = []
    if m:
        try: existing = json.loads(m.group(1))
        except: pass
    return existing, all_names


def save(places):
    with open(PLACES_JS) as f:
        content = f.read()
    js = "\n// Swimming holes and beaches\nconst SWIM_PLACES = "
    js += json.dumps(places, indent=2, ensure_ascii=False) + ";\n"
    content = re.sub(
        r"\n// Swimming holes.*?const SWIM_PLACES\s*=\s*\[.*?\];\n",
        "", content, flags=re.DOTALL
    )
    content += js
    with open(PLACES_JS, "w") as f:
        f.write(content)
    print(f"  → Saved {len(places)} swim places")


def main():
    existing, all_names = load_existing()
    print(f"Known names: {len(all_names)}")

    all_new = []
    for zone in ZONES:
        print(f"\n🏊 {zone['name']}")
        try:
            q    = build_swim_query(zone["lat"], zone["lng"], zone["radius"])
            data = fetch_overpass(q)
            new  = parse(data, zone["name"])
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
    print(f"\n✅ Added {len(all_new)} swim places. Total: {len(existing)}")
    save(existing)


if __name__ == "__main__":
    main()
