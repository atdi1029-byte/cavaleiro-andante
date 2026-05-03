#!/usr/bin/env python3
"""
Cavaleiro Andante — Wikipedia Geosearch Scraper
Finds notable places (landmarks, mountains, waterfalls, parks) that have
Wikipedia articles near each sweep zone. Places with Wikipedia articles
are proven to be interesting/notable.

Usage:
  python3 atlas_obscura.py
"""

import json, re, os, time, urllib.request, urllib.parse, ssl
ssl._create_default_https_context = ssl._create_unverified_context

PLACES_JS = os.path.join(os.path.dirname(__file__), "places.js")
HOME      = (39.1037, -76.5338)   # Pasadena MD
WIKI_API  = "https://en.wikipedia.org/w/api.php"

# Wikipedia geo feature types to include
# https://en.wikipedia.org/wiki/Wikipedia:GEO#Feature_types
GOOD_TYPES = {
    "mountain", "isle", "waterfall", "river", "forest", "landmark",
    "cave", "glacier", "park", "lighthouse", "adm3rd", "adm4th",
    "airport",  # skip
}
SKIP_TYPES = {"city", "country", "state", "airport", "edu", "railwaystation"}

# Zones to sweep (same as sweep.py + gap zones)
ZONES = [
    { "name": "Annapolis & Anne Arundel","lat": 38.972, "lng": -76.501, "radius": 25 },
    { "name": "Baltimore City",          "lat": 39.290, "lng": -76.612, "radius": 20 },
    { "name": "Baltimore County",        "lat": 39.400, "lng": -76.720, "radius": 25 },
    { "name": "Howard County MD",        "lat": 39.215, "lng": -76.850, "radius": 20 },
    { "name": "Washington DC Metro",     "lat": 38.907, "lng": -77.037, "radius": 28 },
    { "name": "Montgomery County MD",    "lat": 39.084, "lng": -77.152, "radius": 25 },
    { "name": "Prince George's County",  "lat": 38.830, "lng": -76.850, "radius": 25 },
    { "name": "Eastern Shore North",     "lat": 39.210, "lng": -76.070, "radius": 30 },
    { "name": "Eastern Shore Central",   "lat": 38.770, "lng": -76.070, "radius": 28 },
    { "name": "Eastern Shore South",     "lat": 38.430, "lng": -76.050, "radius": 30 },
    { "name": "Southern Maryland",       "lat": 38.550, "lng": -76.600, "radius": 30 },
    { "name": "Northern Virginia",       "lat": 38.850, "lng": -77.200, "radius": 25 },
    { "name": "Shenandoah & Western MD", "lat": 38.900, "lng": -78.000, "radius": 40 },
    { "name": "Harpers Ferry & Loudoun", "lat": 39.325, "lng": -77.730, "radius": 30 },
    { "name": "Frederick & Catoctin",    "lat": 39.415, "lng": -77.410, "radius": 28 },
    { "name": "Deep Creek & Garrett County", "lat": 39.530, "lng": -79.300, "radius": 30 },
    { "name": "WV Highlands",            "lat": 38.830, "lng": -79.370, "radius": 30 },
    { "name": "Gettysburg & Adams County","lat": 39.830, "lng": -77.230, "radius": 28 },
    { "name": "Assateague & Lower Shore", "lat": 38.100, "lng": -75.450, "radius": 30 },
    { "name": "Delaware Beaches",        "lat": 38.720, "lng": -75.080, "radius": 25 },
    { "name": "Upper Chesapeake & Elk Neck","lat": 39.520, "lng": -76.050, "radius": 28 },
]

# Skip Wikipedia articles that are clearly not worth visiting
SKIP_WORDS = [
    "school", "church", "cemetery", "hospital", "station", "road",
    "highway", "route", "bridge", "dam", "reservoir", "neighborhood",
    "county", "township", "borough", "city", "town", "village",
    "census", "unincorporated", "subdivision",
]


def fetch_json(url, retries=4):
    req = urllib.request.Request(url, headers={
        "User-Agent": "CavaleiroAndante/1.0 (outdoor discovery app)",
        "Accept": "application/json",
    })
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except Exception as e:
            if "429" in str(e):
                wait = 10 * (attempt + 1)
                print(f"  ⏳ rate limited, waiting {wait}s…")
                time.sleep(wait)
            else:
                print(f"  ✗ {e}")
                return None
    print(f"  ✗ gave up after {retries} retries")
    return None


def dist_miles(lat1, lng1, lat2, lng2):
    import math
    R = 3958.8
    dlat = (lat2 - lat1) * math.pi / 180
    dlng = (lng2 - lng1) * math.pi / 180
    a = (math.sin(dlat/2)**2
         + math.cos(lat1*math.pi/180) * math.cos(lat2*math.pi/180) * math.sin(dlng/2)**2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def classify_wiki(title, gtype, categories):
    cats = " ".join(categories).lower()
    t    = (title + " " + gtype).lower()

    if gtype == "waterfall" or "waterfall" in cats:   return "waterfall"
    if gtype in ("river",) or "river" in cats:        return "water"
    if gtype in ("isle",) or "island" in cats:        return "water"
    if "beach" in cats or "beach" in t:               return "water"
    if gtype == "mountain" or "mountain" in cats:     return "hike"
    if "trail" in cats or "hiking" in cats:           return "trail"
    if gtype == "forest" or "forest" in cats:         return "trail"
    if gtype == "park" or "park" in cats:             return "park"
    if gtype == "cave" or "cave" in t:                return "gems"
    if gtype == "lighthouse":                          return "gems"
    if "historic" in cats or "battlefield" in cats:   return "gems"
    if gtype == "landmark":                            return "gems"
    return "gems"


def get_tags(type_, title, categories):
    cats = " ".join(categories).lower()
    tags = []
    if type_ == "waterfall":   tags += ["waterfall", "water", "scenic"]
    if type_ == "water":       tags += ["water", "scenic"]
    if type_ == "trail":       tags += ["trail", "hiking", "nature"]
    if type_ == "park":        tags += ["park", "nature"]
    if type_ == "hike":        tags += ["hiking", "scenic", "nature"]
    if type_ == "gems":        tags += ["gems", "weird"]
    if "historic" in cats:     tags += ["historic"]
    if "swimming" in cats:     tags += ["swimming"]
    if "waterfall" in cats:    tags += ["waterfall", "water"]
    return list(dict.fromkeys(tags))


def geosearch_zone(zone):
    """Fetch Wikipedia pages near a zone center"""
    lat, lng = zone["lat"], zone["lng"]
    radius_m = zone["radius"] * 1000  # km → m, max 10000
    radius_m = min(radius_m, 10000)   # Wikipedia caps at 10km

    # Make multiple queries to cover the full zone radius
    results = []
    seen_ids = set()

    # Single center point query per zone (avoid rate limits)
    points = [(lat, lng)]

    for plat, plng in points:
        params = urllib.parse.urlencode({
            "action":   "query",
            "list":     "geosearch",
            "gscoord":  f"{plat}|{plng}",
            "gsradius": 10000,
            "gslimit":  50,
            "gsprop":   "dim|globe|type",
            "format":   "json",
        })
        data = fetch_json(f"{WIKI_API}?{params}")
        if not data:
            continue
        for item in data.get("query", {}).get("geosearch", []):
            pid = item["pageid"]
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            results.append(item)
        time.sleep(2)

    return results


def get_page_details(pageids):
    """Fetch categories and extract info for a batch of page IDs"""
    ids_str = "|".join(str(i) for i in pageids)
    params  = urllib.parse.urlencode({
        "action":    "query",
        "pageids":   ids_str,
        "prop":      "categories|extracts|coordinates",
        "exintro":   1,
        "exsentences": 2,
        "explaintext": 1,
        "cllimit":   20,
        "format":    "json",
    })
    data = fetch_json(f"{WIKI_API}?{params}")
    if not data:
        return {}
    return data.get("query", {}).get("pages", {})


def sweep_zone(zone, existing_names):
    print(f"\n🔍 {zone['name']}")
    geo_results = geosearch_zone(zone)
    if not geo_results:
        print(f"  (no results)")
        return []

    # Batch page details
    pageids = [r["pageid"] for r in geo_results]
    details = {}
    for i in range(0, len(pageids), 20):
        batch = pageids[i:i+20]
        d = get_page_details(batch)
        details.update(d)
        time.sleep(1.5)

    out = []
    for r in geo_results:
        pid   = str(r["pageid"])
        title = r["title"]
        lat   = r.get("lat", zone["lat"])
        lng   = r.get("lon", zone["lng"])
        gtype = r.get("type") or "landmark"

        # Skip non-point features or bad types
        if gtype in SKIP_TYPES:
            continue
        if any(w in title.lower() for w in SKIP_WORDS):
            continue

        key = title.lower()
        if key in existing_names:
            continue

        page  = details.get(pid, {})
        cats  = [c.get("title", "").replace("Category:", "").lower()
                 for c in page.get("categories", [])]
        desc  = page.get("extract", "").strip()
        # Clean up description
        if desc:
            desc = re.sub(r"\s+", " ", desc)[:300]

        type_  = classify_wiki(title, gtype, cats)
        tags   = get_tags(type_, title, cats)
        dist   = round(dist_miles(HOME[0], HOME[1], lat, lng), 1)
        slug   = re.sub(r"[^a-z0-9]", "", title.lower())[:20]
        wiki_url = f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"

        out.append({
            "id":          f"wp:{slug}",
            "name":        title,
            "type":        type_,
            "tags":        tags,
            "lat":         round(lat, 5),
            "lng":         round(lng, 5),
            "dist":        dist,
            "description": desc,
            "zone":        zone["name"],
            "source":      "wikipedia",
            "url":         wiki_url,
            "score":       0,
        })
        existing_names.add(key)

    print(f"  ✓ {len(geo_results)} found, {len(out)} new notable places")
    return out


def load_existing_wiki():
    if not os.path.exists(PLACES_JS):
        return [], set()
    with open(PLACES_JS) as f:
        content = f.read()
    m = re.search(r"const WIKI_PLACES\s*=\s*(\[.*?\]);", content, re.DOTALL)
    if not m:
        return [], set()
    try:
        places = json.loads(m.group(1))
        names  = {p["name"].lower() for p in places}
        return places, names
    except:
        return [], set()


def load_swept_names():
    """Get all names already in SWEPT_PLACES and SEED_PLACES to avoid duplicates"""
    if not os.path.exists(PLACES_JS):
        return set()
    with open(PLACES_JS) as f:
        content = f.read()
    names = set()
    for pattern in [r"const SWEPT_PLACES\s*=\s*(\[.*?\]);",
                    r"const SEED_PLACES\s*=\s*(\[.*?\]);"]:
        m = re.search(pattern, content, re.DOTALL)
        if m:
            try:
                for p in json.loads(m.group(1)):
                    names.add(p["name"].lower())
            except:
                pass
    return names


def save_wiki(places):
    if not os.path.exists(PLACES_JS):
        print("places.js not found")
        return

    with open(PLACES_JS) as f:
        content = f.read()

    js_block = "\n// Wikipedia geosearch — notable landmarks and features\nconst WIKI_PLACES = "
    js_block += json.dumps(places, indent=2, ensure_ascii=False)
    js_block += ";\n"

    # Remove old WIKI_PLACES block if present
    content = re.sub(
        r"\n// Wikipedia geosearch.*?const WIKI_PLACES\s*=\s*\[.*?\];\n",
        "",
        content,
        flags=re.DOTALL
    )
    content += js_block

    with open(PLACES_JS, "w") as f:
        f.write(content)
    print(f"\n  → Saved {len(places)} Wikipedia places to places.js")


def main():
    existing, existing_names = load_existing_wiki()
    existing_names |= load_swept_names()   # don't duplicate swept places
    print(f"Loaded {len(existing)} existing Wikipedia places ({len(existing_names)} known names)")

    all_new = []
    for zone in ZONES:
        new = sweep_zone(zone, existing_names)
        all_new.extend(new)
        time.sleep(3)

    existing.extend(all_new)
    print(f"\n✅ Added {len(all_new)} new places. Total Wikipedia places: {len(existing)}")
    save_wiki(existing)


if __name__ == "__main__":
    main()
