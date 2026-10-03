// Everything that is a setting rather than logic lives here.

export const HOME = { lat: 39.1037, lng: -76.5338, label: 'Pasadena, MD' };

// The places in places.json all sit within about 170 miles of home. If the
// starting point is further away than this, distances stop meaning anything
// and the app says so instead of listing things "5,000 miles away".
export const COVERAGE_MILES = 260;

// Box used to keep "search another area" inside the region the app covers
// (west, north, east, south)
export const REGION_BOX = [-80.2, 40.9, -74.6, 37.5];

export const SYNC_URL = 'https://script.google.com/macros/s/AKfycbyRQc5H6hcG3S-h3it4J48bemgpelQgXxmCy1KX-MlTVnAhThuOEDmm3JL2UyB22Ce5/exec';

// ── Place types ─────────────────────────────────────────────
// Every place has exactly one type. Color and emoji drive the cards and the
// map pins.
export const TYPES = {
  hike:      { label: 'Hike',       emoji: '🥾', color: '#f08a24' },
  trail:     { label: 'Trail',      emoji: '🌿', color: '#5aa845' },
  park:      { label: 'Park',       emoji: '🌲', color: '#2fa84f' },
  garden:    { label: 'Garden',     emoji: '🌷', color: '#e5589b' },
  waterfall: { label: 'Waterfall',  emoji: '💧', color: '#2f9fe0' },
  beach:     { label: 'Beach',      emoji: '🏖️', color: '#f4a62a' },
  water:     { label: 'Waterfront', emoji: '🌊', color: '#2f9fe0' },
  swim:      { label: 'Swim spot',  emoji: '🏊', color: '#12b5a6' },
  viewpoint: { label: 'View',       emoji: '🌄', color: '#e2a400' },
  gems:      { label: 'Gem',        emoji: '💎', color: '#8b5cf6' },
  caves:     { label: 'Cave',       emoji: '🦇', color: '#7c6f64' },
  historic:  { label: 'Historic',   emoji: '🏰', color: '#b0703c' },
  run:       { label: 'Run',        emoji: '🏃', color: '#12b5a6' },
  indoor:    { label: 'Indoors',    emoji: '🏛️', color: '#5b7bd5' },
  camp:      { label: 'Camp',       emoji: '⛺', color: '#5aa845' },
  other:     { label: 'Place',      emoji: '📍', color: '#7a8b80' },
};
// Types used by older data
TYPES.weird = TYPES.gems;
TYPES.sunset = TYPES.viewpoint;

export function typeOf(place) {
  return TYPES[place.type] || TYPES.other;
}

// ── Categories (the photo cards across the top) ─────────────
// `match` decides whether a place belongs; `types` are the kinds of place the
// category is really about (they are listed ahead of places that merely have
// a matching tag); `subs` are the optional chips that narrow it further.
const has = (p, ...tags) => tags.some(t => p.tags.includes(t));
const isType = (p, ...types) => types.includes(p.type);
const photo = id => `https://images.unsplash.com/photo-${id}?w=300&h=180&q=75&auto=format&fit=crop`;

export const CATEGORIES = [
  // Museums and other indoor places only show under Rainy day (and in search)
  { id: 'all', label: 'All', emoji: '🧭', photo: photo('1506905925346-21bda4d32df4'),
    match: p => p.type !== 'indoor' },

  { id: 'hike', label: 'Hikes', emoji: '🥾', photo: photo('1551632811-561732d1e306'), types: ['hike', 'trail'],
    match: p => isType(p, 'hike', 'trail') || has(p, 'hiking'),
    subs: [
      { id: 'view',      label: 'With a view',      match: p => has(p, 'viewpoint', 'summit') },
      { id: 'waterfall', label: 'To a waterfall',   match: p => has(p, 'waterfall') },
      { id: 'ruins',     label: 'Past ruins',       match: p => has(p, 'ruins', 'abandoned', 'historic') },
    ] },

  { id: 'water', label: 'Beaches', emoji: '🏖️', photo: photo('1507525428034-b723cf961d3e'), types: ['beach', 'water'],
    match: p => isType(p, 'beach', 'water') || has(p, 'beach', 'waterfront'),
    subs: [
      { id: 'beach', label: 'Sandy beach',   match: p => isType(p, 'beach') || has(p, 'beach') },
      { id: 'swim',  label: 'Swimming OK',   match: p => has(p, 'swimming') },
      { id: 'fossil', label: 'Fossils',      match: p => has(p, 'fossils') },
    ] },

  { id: 'waterfall', label: 'Waterfalls', emoji: '💧', photo: photo('1433086966358-54859d0ed716'), types: ['waterfall'],
    match: p => isType(p, 'waterfall') || has(p, 'waterfall') },

  { id: 'view', label: 'Views', emoji: '🌄', photo: photo('1503455637927-730bce8583c0'), types: ['viewpoint'],
    match: p => isType(p, 'viewpoint', 'sunset') || has(p, 'viewpoint', 'sunset', 'summit'),
    subs: [
      { id: 'sunset', label: 'Sunset spots', match: p => has(p, 'sunset') },
      { id: 'summit', label: 'Summits',      match: p => has(p, 'summit') },
    ] },

  { id: 'gems', label: 'Gems', emoji: '💎', photo: photo('1518709268805-4e9042af9f23'), types: ['gems', 'caves', 'historic'],
    match: p => isType(p, 'gems', 'weird', 'caves', 'historic') || has(p, 'weird', 'abandoned', 'ghost-town', 'cave'),
    subs: [
      { id: 'abandoned', label: 'Abandoned & ruins', match: p => has(p, 'abandoned', 'ruins', 'ghost-town') },
      { id: 'caves',     label: 'Caves & rocks',     match: p => isType(p, 'caves') || has(p, 'cave', 'geology') },
      { id: 'forts',     label: 'Forts',             match: p => has(p, 'fort', 'military') },
      { id: 'tunnels',   label: 'Tunnels & bridges', match: p => has(p, 'tunnel', 'bridge', 'railway', 'canal') },
      { id: 'lights',    label: 'Lighthouses',       match: p => has(p, 'lighthouse') },
      { id: 'odd',       label: 'Just odd',          match: p => has(p, 'weird') },
    ] },

  // Indoors, underground or under cover: places tagged "rainy" by data/build.js
  { id: 'rain', label: 'Rainy day', emoji: '☔', photo: photo('1515694346937-94d85e41e6f0'),
    match: p => has(p, 'rainy'),
    subs: [
      { id: 'caves',   label: 'Caves & tunnels',     match: p => has(p, 'cave', 'tunnel') },
      { id: 'museums', label: 'Museums & oddities',  match: p => has(p, 'museum', 'interior', 'aquarium', 'market', 'nature-center') },
      { id: 'glass',   label: 'Glasshouses',         match: p => has(p, 'conservatory') },
      { id: 'forts',   label: 'Forts & mills',       match: p => has(p, 'fort', 'mill', 'furnace') },
      { id: 'bridges', label: 'Covered bridges',     match: p => has(p, 'covered') },
      { id: 'free',    label: 'Free',                match: p => has(p, 'free') },
    ] },

  { id: 'swim', label: 'Swim', emoji: '🏊', photo: photo('1530053969600-caed2596d242'), types: ['swim', 'beach'],
    match: p => isType(p, 'swim') || has(p, 'swimming') },

  { id: 'park', label: 'Parks', emoji: '🌲', photo: photo('1448375240586-882707db888b'), types: ['park', 'garden'],
    match: p => isType(p, 'park', 'garden') || has(p, 'park'),
    subs: [
      { id: 'garden',   label: 'Gardens',  match: p => isType(p, 'garden') || has(p, 'garden') },
      { id: 'wildlife', label: 'Wildlife', match: p => has(p, 'wildlife', 'birding') },
    ] },

  { id: 'run', label: 'Run', emoji: '🏃', photo: photo('1476480862126-209bfaa8edc8'), types: ['run'],
    match: p => isType(p, 'run') || has(p, 'running') },

  { id: 'camp', label: 'Camp', emoji: '⛺', photo: photo('1504280390367-361c6d9f38f4'), types: ['camp'],
    match: p => isType(p, 'camp') || has(p, 'camping') },

  // My Places is special-cased in places.js: it lists what you saved
  { id: 'saved', label: 'My Places', emoji: '❤️', photo: photo('1476514525535-07fb3b4ae5f1'),
    match: () => true,
    subs: [
      { id: 'been',   label: 'Been there' },
      { id: 'hidden', label: 'Hidden' },
    ] },
];

export const DISTANCES = [
  { miles: Infinity, label: 'Anywhere' },
  { miles: 15,  label: '15 mi' },
  { miles: 40,  label: '40 mi' },
  { miles: 80,  label: '80 mi' },
];

// ── Taste ───────────────────────────────────────────────────
// Weight per tag. Saving a place nudges its tags up, "not for me" nudges
// them down, and the Best sort uses the average for a place's tags.
export const DEFAULT_TASTE = {
  beach: 1.4, waterfront: 1.4, water: 1.3, swimming: 1.3, running: 1.3,
  waterfall: 1.2, viewpoint: 1.2, sunset: 1.3, summit: 1.2, hiking: 1.1, trail: 1.1,
  park: 1.1, forest: 1.1, nature: 1.1, wildlife: 1.0, garden: 1.0,
  gems: 1.2, weird: 1.3, abandoned: 1.3, ruins: 1.2, cave: 1.2, geology: 1.2,
  historic: 1.0, lighthouse: 1.1, camping: 1.0, scenic: 1.2,
};
export const TASTE_STEP = { save: 0.15, unsave: -0.1, visit: 0.05, dismiss: -0.15, restore: 0.05 };
export const TASTE_RANGE = [0.1, 3.0];

// ── Map ─────────────────────────────────────────────────────
// All three are free and need no API key. (The old CARTO dark tiles now
// answer every request with an "API KEY REQUIRED" picture.)
export const MAP_LAYERS = [
  { id: 'map', label: 'Map',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
    attribution: '© OpenStreetMap contributors' },
  { id: 'terrain', label: 'Terrain',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
    attribution: 'Tiles © Esri' },
  { id: 'satellite', label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
    attribution: 'Imagery © Esri' },
];
