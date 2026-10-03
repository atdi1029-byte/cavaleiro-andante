// The area the app covers: day-trip range from home (Pasadena, MD).
// Everything in places.js is inside this box AND within MAX_MILES of home.

const HOME = { lat: 39.1037, lng: -76.5338, label: 'Pasadena, MD' };

const REGION = { south: 37.70, north: 40.75, west: -79.95, east: -74.85 };

// Straight-line miles. Blackwater Falls and Swallow Falls are about 160
// miles out, Coopers Rock about 180.
const MAX_MILES = 180;

const STATES = ['MD', 'DC', 'VA', 'WV', 'PA', 'DE'];

function miles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inRegion(lat, lng) {
  return lat >= REGION.south && lat <= REGION.north &&
    lng >= REGION.west && lng <= REGION.east &&
    miles(HOME.lat, HOME.lng, lat, lng) <= MAX_MILES;
}

module.exports = { HOME, REGION, MAX_MILES, STATES, miles, inRegion };
