#!/usr/bin/env python3
"""
Cavaleiro Andante — Sunset Spots Scraper
Searches Reddit + OSM for the best sunset viewing locations
in the MD/DC/VA/WV region.

Usage:
  python3 sunset_sweep.py
"""

import json, re, os, time, urllib.request, urllib.parse, ssl, math
ssl._create_default_https_context = ssl._create_unverified_context

PLACES_JS    = os.path.join(os.path.dirname(__file__), "places.js")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
NOMINATIM    = "https://nominatim.openstreetmap.org/search"
HOME         = (39.1037, -76.5338)

LAT_MIN, LAT_MAX = 37.0, 40.8
LNG_MIN, LNG_MAX = -81.0, -74.5

# Reddit searches focused on sunsets
SEARCHES = [
    ("marylandhiking",  "best sunset"),
    ("marylandhiking",  "sunset view"),
    ("maryland",        "best sunset spot"),
    ("maryland",        "sunset view"),
    ("maryland",        "sunset beach"),
    ("dmv",             "best sunset"),
    ("dmv",             "sunset view"),
    ("washingtondc",    "best sunset"),
    ("washingtondc",    "sunset spot"),
    ("nova",            "sunset view"),
    ("nova",            "best sunset"),
    ("virginia",        "best sunset overlook"),
    ("virginia",        "sunset view"),
    ("westvirginia",    "sunset view"),
    ("ShenandoahNP",    "sunset"),
    ("appalachiantrail","sunset view maryland"),
    ("hiking",          "maryland sunset"),
    ("hiking",          "dc sunset overlook"),
    ("Maryland",        "sunset photography"),
    ("Maryland",        "golden hour"),
    ("chesapeakebay",   "sunset"),
    ("chesapeakebay",   "best sunset spot"),
]

PLACE_PATTERNS = [
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,4})\s+(?:State Park|State Forest|National Park|Wildlife Refuge|Natural Area|Wilderness)\b",
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,4})\s+(?:Beach|Overlook|Viewpoint|Observation|Point|Cliffs?|Bluff|Heights?)\b",
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,4})\s+(?:Mountain|Peak|Ridge|Summit|Rock|Rocks)\b",
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})\s+(?:Park|Pier|Marina|Harbor|Shore|Island|Bay|Cove|Waterfront)\b",
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,4})\s+(?:Trail|Trailhead|Loop|Path)\b",
    r"(?:sunset at|sunsets? from|watch.*sunset.*at|golden hour at|great.*sunset.*at|best.*sunset.*(?:is|at|from)|go to)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){1,4})",
    r"(?:head to|check out|recommend)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){1,4})\s+for.*sunset",
]

SKIP_NAMES = {
    "google maps", "trail head", "parking lot", "national park", "state park",
    "the area", "the region", "the park", "the trail", "this place", "alltrails",
    "this trail", "this park", "right there", "just outside", "near there",
    "eastern shore", "western md", "northern va", "the bay", "the river",
    "golden hour", "the sunset", "the view", "the overlook", "the beach",
}

# Overpass zones to query for viewpoints + waterfront
OVERPASS_ZONES = [
    {"name": "Washington DC Metro",     "lat": 38.907, "lng": -77.037, "radius": 28000},
    {"name": "Montgomery County MD",    "lat": 39.084, "lng": -77.152, "radius": 25000},
    {"name": "Annapolis & Anne Arundel","lat": 38.972, "lng": -76.501, "radius": 25000},
    {"name": "Eastern Shore",           "lat": 38.770, "lng": -76.070, "radius": 35000},
    {"name": "Southern Maryland",       "lat": 38.550, "lng": -76.600, "radius": 30000},
    {"name": "Northern Virginia",       "lat": 38.850, "lng": -77.200, "radius": 25000},
    {"name": "Shenandoah & Blue Ridge", "lat": 38.900, "lng": -78.000, "radius": 40000},
    {"name": "Harpers Ferry area",      "lat": 39.325, "lng": -77.730, "radius": 25000},
    {"name": "Frederick & Catoctin",    "lat": 39.415, "lng": -77.410, "radius": 28000},
    {"name": "WV Highlands",            "lat": 38.830, "lng": -79.370, "radius": 30000},
    {"name": "Upper Chesapeake",        "lat": 39.520, "lng": -76.050, "radius": 28000},
    {"name": "Assateague & Lower Shore","lat": 38.100, "lng": -75.450, "radius": 30000},
]


def build_sunset_query(lat, lng, radius):
    r = radius
    return (
        f"[out:json][timeout:45];"
        f"("
        # Named viewpoints
        f'node["tourism"="viewpoint"]["name"](around:{r},{lat},{lng});'
        f'way["tourism"="viewpoint"]["name"](around:{r},{lat},{lng});'
        # Named peaks / summits
        f'node["natural"="peak"]["name"](around:{r},{lat},{lng});'
        # Beaches (great for bay/ocean sunsets)
        f'node["natural"="beach"]["name"](around:{r},{lat},{lng});'
        f'way["natural"="beach"]["name"](around:{r},{lat},{lng});'
        # Observation towers
        f'node["man_made"="tower"]["tourism"="viewpoint"]["name"](around:{r},{lat},{lng});'
        f'node["man_made"="observation_tower"]["name"](around:{r},{lat},{lng});'
        # Lighthouses (coastal sunset spots)
        f'node["man_made"="lighthouse"]["name"](around:{r},{lat},{lng});'
        f'way["man_made"="lighthouse"]["name"](around:{r},{lat},{lng});'
        f');\nout center 150;'
    )


def fetch_overpass(query):
    data = ('data=' + urllib.parse.quote(query)).encode()
    req  = urllib.request.Request(
        OVERPASS_URL, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "User-Agent": "CavaleiroAndante/1.0"}
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read())


def fetch_reddit(subreddit, query):
    url = (f"https://www.reddit.com/r/{subreddit}/search.json"
           f"?q={urllib.parse.quote(query)}&restrict_sr=1&sort=top&limit=25&t=all")
    req = urllib.request.Request(url, headers={
        "User-Agent": "CavaleiroAndante/1.0 (sunset finder bot)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  ✗ {e}")
        return None


def geocode(name):
    params = urllib.parse.urlencode({
        "q": name + " Maryland Virginia DC",
        "format": "json", "limit": 3,
        "bounded": 1,
        "viewbox": f"{LNG_MIN},{LAT_MAX},{LNG_MAX},{LAT_MIN}",
    })
    url = NOMINATIM + "?" + params
    req = urllib.request.Request(url, headers={
        "User-Agent": "CavaleiroAndante/1.0",
        "Accept-Language": "en",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            results = json.loads(r.read())
        for res in results:
            lat = float(res["lat"]); lng = float(res["lon"])
            if LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX:
                return lat, lng, res.get("display_name", "")
    except Exception as e:
        print(f"    geocode error: {e}")
    return None, None, None


def dist_miles(lat1, lng1, lat2, lng2):
    R = 3958.8
    dlat = (lat2 - lat1) * math.pi / 180
    dlng = (lng2 - lng1) * math.pi / 180
    a = math.sin(dlat/2)**2 + math.cos(lat1*math.pi/180)*math.cos(lat2*math.pi/180)*math.sin(dlng/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def slug(name):
    return re.sub(r'[^a-z0-9]', '', name.lower())[:20]


def classify_sunset_subtype(t):
    """Give extra context tags based on OSM tags."""
    tags = ["sunset", "viewpoint", "scenic"]
    if t.get("natural") == "peak":          tags += ["hiking", "nature"]
    if t.get("natural") == "beach":         tags += ["water", "beach"]
    if t.get("man_made") in ("lighthouse", "observation_tower", "tower"):
        tags += ["gems"]
    return list(dict.fromkeys(tags))


def build_desc_osm(t, zone):
    parts = [f"In {zone}"]
    if t.get("description"): parts.append(t["description"])
    if t.get("ele"):         parts.append(f"Elevation: {t['ele']}m")
    if t.get("website"):     parts.append(f"Website available")
    parts.append("Sunset viewing spot")
    return " · ".join(parts)


def parse_overpass(data, zone):
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

        skip = ["parking", "restroom", "toilet", "trash"]
        if any(s in name.lower() for s in skip): continue

        tags = classify_sunset_subtype(t)
        dist = round(dist_miles(HOME[0], HOME[1], lat, lng), 1)
        desc = build_desc_osm(t, zone)

        out.append({
            "id":          f"sun:osm:{slug(name)}",
            "name":        name,
            "type":        "sunset",
            "tags":        tags,
            "lat":         round(lat, 5),
            "lng":         round(lng, 5),
            "dist":        dist,
            "description": desc,
            "zone":        zone,
            "source":      "sunset_osm",
            "score":       0,
        })
    return out


def extract_names_from_text(text):
    names = []
    for pat in PLACE_PATTERNS:
        for m in re.finditer(pat, text):
            full = m.group(0).strip()
            # Use last captured group for patterns with leading verb
            name = m.group(m.lastindex).strip()
            if 3 <= len(name) <= 60 and name.lower() not in SKIP_NAMES:
                names.append(name)
    return list(dict.fromkeys(names))


def scrape_reddit(all_names):
    """Returns list of (name, lat, lng, url, subreddit) tuples."""
    results = []
    seen_names = set(all_names)

    for subreddit, query in SEARCHES:
        print(f"  r/{subreddit}: {query}")
        data = fetch_reddit(subreddit, query)
        if not data:
            time.sleep(4)
            continue

        posts = data.get("data", {}).get("children", [])
        candidates = set()
        for post in posts:
            pd = post.get("data", {})
            text = (pd.get("title", "") + " " +
                    pd.get("selftext", "") + " " +
                    pd.get("url", ""))
            for name in extract_names_from_text(text):
                candidates.add((name, pd.get("url", "")))

        print(f"    {len(candidates)} candidates to geocode")
        for name, url in candidates:
            if name.lower() in seen_names:
                continue
            lat, lng, display = geocode(name)
            time.sleep(3)
            if lat is None:
                continue
            dist = round(dist_miles(HOME[0], HOME[1], lat, lng), 1)
            seen_names.add(name.lower())
            results.append({
                "id":          f"sun:rd:{slug(name)}",
                "name":        name,
                "type":        "sunset",
                "tags":        ["sunset", "viewpoint", "scenic"],
                "lat":         round(lat, 5),
                "lng":         round(lng, 5),
                "dist":        dist,
                "description": f"Sunset spot recommended on r/{subreddit}",
                "zone":        display.split(",")[2].strip() if display.count(",") >= 2 else "",
                "source":      "sunset_reddit",
                "url":         url if url.startswith("http") else "",
                "score":       0,
            })
            print(f"    ✓ {name} ({lat:.3f}, {lng:.3f}) — {dist} mi")

        time.sleep(3)

    return results


def load_existing():
    if not os.path.exists(PLACES_JS):
        return [], set()
    with open(PLACES_JS) as f:
        content = f.read()
    all_names = set()
    for pat in [r'"name"\s*:\s*"([^"]+)"']:
        for match in re.finditer(pat, content):
            all_names.add(match.group(1).lower())
    # Extract existing SUNSET_PLACES if any
    m = re.search(r"const SUNSET_PLACES\s*=\s*(\[.*?\]);", content, re.DOTALL)
    existing = []
    if m:
        try: existing = json.loads(m.group(1))
        except: pass
    return existing, all_names


def save(places):
    with open(PLACES_JS) as f:
        content = f.read()
    js = "\n// Sunset viewing spots\nconst SUNSET_PLACES = "
    js += json.dumps(places, indent=2, ensure_ascii=False) + ";\n"
    content = re.sub(
        r"\n// Sunset viewing.*?const SUNSET_PLACES\s*=\s*\[.*?\];\n",
        "", content, flags=re.DOTALL
    )
    content += js
    with open(PLACES_JS, "w") as f:
        f.write(content)
    print(f"  → Saved {len(places)} sunset places")


def main():
    existing, all_names = load_existing()
    print(f"Known names: {len(all_names)}")

    all_new = []

    # Phase 1: OSM viewpoints, peaks, beaches, lighthouses
    print("\n🌅 Phase 1: OSM viewpoints & coastal spots")
    for zone in OVERPASS_ZONES:
        print(f"  {zone['name']}")
        try:
            q    = build_sunset_query(zone["lat"], zone["lng"], zone["radius"])
            data = fetch_overpass(q)
            new  = parse_overpass(data, zone["name"])
            added = [p for p in new if p["name"].lower() not in all_names]
            for p in added:
                all_names.add(p["name"].lower())
            all_new.extend(added)
            print(f"    ✓ {len(added)} new sunset spots")
            time.sleep(3)
        except Exception as e:
            print(f"    ✗ {e}")
            time.sleep(6)

    # Phase 2: Reddit sunset recommendations
    print("\n🌅 Phase 2: Reddit sunset recommendations")
    reddit_results = scrape_reddit(all_names)
    all_new.extend(reddit_results)

    existing.extend(all_new)
    print(f"\n✅ Added {len(all_new)} sunset places. Total: {len(existing)}")
    save(existing)


if __name__ == "__main__":
    main()
