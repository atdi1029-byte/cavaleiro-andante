#!/usr/bin/env python3
"""
Cavaleiro Andante — Reddit Hidden Gems Scraper
Searches outdoor/local subreddits for hidden gem recommendations,
extracts place names, geocodes them, and adds to places.js

Usage:
  python3 reddit_gems.py
"""

import json, re, os, time, urllib.request, urllib.parse, ssl
ssl._create_default_https_context = ssl._create_unverified_context

PLACES_JS = os.path.join(os.path.dirname(__file__), "places.js")
HOME      = (39.1037, -76.5338)  # Pasadena MD

# Bounding box — within ~3hrs of Pasadena MD
LAT_MIN, LAT_MAX = 37.0, 40.8
LNG_MIN, LNG_MAX = -81.0, -74.5

NOMINATIM = "https://nominatim.openstreetmap.org/search"

# Subreddits + search queries
SEARCHES = [
    ("marylandhiking",  "hidden gem"),
    ("marylandhiking",  "secret"),
    ("marylandhiking",  "underrated"),
    ("marylandhiking",  "locals only"),
    ("marylandhiking",  "best hike"),
    ("marylandhiking",  "swimming hole"),
    ("marylandhiking",  "waterfall"),
    ("maryland",        "hidden gem hike"),
    ("maryland",        "best hike"),
    ("maryland",        "swimming hole"),
    ("dmv",             "hidden gem outdoor"),
    ("dmv",             "hike trail"),
    ("washingtondc",    "hidden gem nature"),
    ("nova",            "hidden gem hike"),
    ("virginia",        "hidden gem hike"),
    ("virginia",        "swimming hole"),
    ("westvirginia",    "hidden gem"),
    ("westvirginia",    "hiking"),
    ("Delaware",        "hiking hidden gem"),
    ("hiking",          "maryland hidden gem"),
    ("camping",         "maryland virginia hidden"),
    ("ShenandoahNP",    "hidden gem"),
    ("ShenandoahNP",    "off trail"),
    ("appalachiantrail","hidden gem maryland"),
]

# Place-name patterns to extract from post text
PLACE_PATTERNS = [
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,4})\s+(?:State Park|State Forest|National Park|National Forest|Wildlife Management Area|Natural Area|Wilderness Area)\b",
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,4})\s+(?:Falls|Waterfall|Run|Creek|River|Lake|Pond|Reservoir)\b",
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,4})\s+(?:Trail|Trailhead|Path|Loop|Ridge|Overlook|Overlook|Summit|Peak|Mountain|Hollow|Gorge|Canyon|Cliffs?|Rocks?)\b",
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})\s+(?:Park|Preserve|Reserve|Sanctuary|Refuge|Marsh|Beach|Point|Island|Cove|Bay)\b",
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s+(?:Tunnel|Bridge|Cave|Grotto|Quarry|Mine|Fort|Manor|Mansion|Castle|Tower|Lock)\b",
    r"(?:visit|check out|go to|been to|try|recommend|discovered|found)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){1,4})",
]

SKIP_NAMES = {
    "google maps", "trail head", "parking lot", "national park", "state park",
    "hiking trail", "the area", "the region", "the park", "the trail",
    "the falls", "the lake", "the river", "the creek", "this place",
    "alltrails", "trail app", "this trail", "this park", "the summit",
    "right there", "just outside", "near there", "very close",
    "eastern shore", "western md", "northern va",
}


def fetch(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {
        "User-Agent": "CavaleiroAndante/1.0 (outdoor discovery bot; contact: none)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  ✗ {e}")
        return None


def search_reddit(subreddit, query, limit=25):
    q   = urllib.parse.quote(query)
    url = f"https://www.reddit.com/r/{subreddit}/search.json?q={q}&restrict_sr=1&sort=top&limit={limit}&t=all"
    data = fetch(url)
    if not data:
        return []
    posts = []
    for child in data.get("data", {}).get("children", []):
        p = child.get("data", {})
        posts.append({
            "title": p.get("title", ""),
            "body":  p.get("selftext", ""),
            "score": p.get("score", 0),
            "url":   "https://reddit.com" + p.get("permalink", ""),
        })
    return posts


def extract_place_names(text):
    """Extract candidate place names from post text"""
    names = set()
    for pattern in PLACE_PATTERNS:
        for m in re.finditer(pattern, text, re.IGNORECASE):
            # Get the full match (name + suffix)
            full = m.group(0).strip()
            # Clean up
            full = re.sub(r'\s+', ' ', full)
            if 3 < len(full) < 80:
                names.add(full)
    return names


def geocode(name):
    """Try to geocode a place name, return (lat, lng) if in our bounding box"""
    params = urllib.parse.urlencode({
        "q":              name + " Maryland Virginia West Virginia Delaware Pennsylvania",
        "format":         "json",
        "limit":          3,
        "countrycodes":   "us",
        "bounded":        1,
        "viewbox":        f"{LNG_MIN},{LAT_MAX},{LNG_MAX},{LAT_MIN}",
        "accept-language": "en",
    })
    for attempt in range(4):
        data = fetch(
            f"{NOMINATIM}?{params}",
            headers={"User-Agent": "CavaleiroAndante/1.0 (contact: none)"}
        )
        if data is None:
            wait = 15 * (attempt + 1)
            print(f"    ⏳ rate limited, waiting {wait}s…")
            time.sleep(wait)
            continue
        for r in data:
            lat = float(r.get("lat", 0))
            lng = float(r.get("lon", 0))
            if LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX:
                return lat, lng, r.get("display_name", name)
        return None
    return None


def dist_miles(lat1, lng1, lat2, lng2):
    import math
    R = 3958.8
    dlat = (lat2 - lat1) * math.pi / 180
    dlng = (lng2 - lng1) * math.pi / 180
    a = math.sin(dlat/2)**2 + math.cos(lat1*math.pi/180)*math.cos(lat2*math.pi/180)*math.sin(dlng/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def classify_name(name):
    n = name.lower()
    if any(w in n for w in ("falls", "waterfall", "run")):  return "waterfall"
    if any(w in n for w in ("lake", "pond", "reservoir", "beach", "bay", "cove", "river", "creek", "swimming")):
        return "water"
    if any(w in n for w in ("trail", "path", "loop", "ridge", "hollow", "gorge")):
        return "trail"
    if any(w in n for w in ("mountain", "peak", "summit", "overlook", "cliffs", "rocks")):
        return "hike"
    if any(w in n for w in ("tunnel", "cave", "grotto", "quarry", "mine", "fort", "manor", "mansion", "lock", "bridge")):
        return "gems"
    if any(w in n for w in ("park", "preserve", "reserve", "sanctuary", "refuge", "state", "national", "forest")):
        return "park"
    return "gems"


def get_tags(type_, name):
    tags = []
    n = name.lower()
    if type_ == "waterfall":   tags += ["waterfall", "water", "scenic"]
    if type_ == "water":       tags += ["water", "scenic"]
    if type_ == "trail":       tags += ["trail", "hiking", "nature"]
    if type_ == "park":        tags += ["park", "nature"]
    if type_ == "hike":        tags += ["hiking", "scenic", "nature"]
    if type_ == "gems":        tags += ["gems"]
    if "swimming" in n:        tags += ["swimming"]
    if "historic" in n or any(w in n for w in ("fort", "manor", "tunnel", "lock", "mill")):
        tags += ["historic"]
    return list(dict.fromkeys(tags))


def load_existing_names():
    """All names already in any source in places.js"""
    if not os.path.exists(PLACES_JS):
        return set()
    with open(PLACES_JS) as f:
        content = f.read()
    names = set()
    for m in re.finditer(r'"name"\s*:\s*"([^"]+)"', content):
        names.add(m.group(1).lower())
    return names


def load_existing_reddit():
    if not os.path.exists(PLACES_JS):
        return [], set()
    with open(PLACES_JS) as f:
        content = f.read()
    m = re.search(r"const REDDIT_PLACES\s*=\s*(\[.*?\]);", content, re.DOTALL)
    if not m:
        return [], set()
    try:
        places = json.loads(m.group(1))
        return places, {p["name"].lower() for p in places}
    except:
        return [], set()


def save_reddit(places):
    with open(PLACES_JS) as f:
        content = f.read()

    js_block = "\n// Reddit community hidden gems\nconst REDDIT_PLACES = "
    js_block += json.dumps(places, indent=2, ensure_ascii=False)
    js_block += ";\n"

    content = re.sub(
        r"\n// Reddit community.*?const REDDIT_PLACES\s*=\s*\[.*?\];\n",
        "", content, flags=re.DOTALL
    )
    content += js_block

    with open(PLACES_JS, "w") as f:
        f.write(content)
    print(f"  → Saved {len(places)} Reddit places to places.js")


def main():
    existing_reddit, reddit_names = load_existing_reddit()
    all_names = load_existing_names()
    all_names |= reddit_names
    print(f"Known names: {len(all_names)}")

    candidate_names = {}  # name → {reddit_score, subreddit, url}

    # Phase 1: collect candidate names from Reddit posts
    print("\n── Phase 1: Scraping Reddit ──")
    for subreddit, query in SEARCHES:
        print(f"  r/{subreddit}: \"{query}\"")
        posts = search_reddit(subreddit, query)
        for post in posts:
            text = post["title"] + " " + post["body"]
            names = extract_place_names(text)
            for name in names:
                key = name.lower()
                if key in SKIP_NAMES:
                    continue
                if len(name.split()) < 2:
                    continue
                if key not in candidate_names:
                    candidate_names[key] = {
                        "name":   name,
                        "score":  post["score"],
                        "url":    post["url"],
                        "sub":    subreddit,
                    }
                else:
                    # Accumulate score — more mentions = more popular
                    candidate_names[key]["score"] += post["score"]
        time.sleep(2)

    print(f"\n  Found {len(candidate_names)} candidate place names")

    # Phase 2: geocode and filter
    print("\n── Phase 2: Geocoding candidates ──")
    new_places = []
    sorted_candidates = sorted(candidate_names.values(), key=lambda x: -x["score"])

    for c in sorted_candidates:
        name = c["name"]
        key  = name.lower()
        if key in all_names:
            continue

        geo = geocode(name)
        if not geo:
            continue

        lat, lng, display = geo
        type_ = classify_name(name)
        tags  = get_tags(type_, name)
        dist  = round(dist_miles(HOME[0], HOME[1], lat, lng), 1)
        slug  = re.sub(r"[^a-z0-9]", "", name.lower())[:20]

        place = {
            "id":          f"rd:{slug}",
            "name":        name,
            "type":        type_,
            "tags":        tags,
            "lat":         round(lat, 5),
            "lng":         round(lng, 5),
            "dist":        dist,
            "description": f"Recommended on r/{c['sub']}",
            "zone":        "Reddit",
            "source":      "reddit",
            "url":         c["url"],
            "score":       0,
        }
        new_places.append(place)
        all_names.add(key)
        print(f"  ✓ {name} ({dist} mi) — r/{c['sub']}")
        time.sleep(3)  # be polite to Nominatim

    existing_reddit.extend(new_places)
    print(f"\n✅ Added {len(new_places)} new Reddit-sourced places. Total: {len(existing_reddit)}")
    save_reddit(existing_reddit)


if __name__ == "__main__":
    main()
