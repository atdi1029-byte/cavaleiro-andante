// Is it raining where you are? Asked from Open-Meteo (free, no key).
// Used only to offer the Rainy day list at the right moment.

const TTL = 20 * 60 * 1000;
let last = null;   // { key, at, answer }

// Weather codes: drizzle 51-57, rain 61-67, showers 80-82, thunderstorm 95-99
const WET = code => (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

// → { now: true|false, soon: true|false }, or null when it cannot be known
export async function rainAt(origin) {
  const key = origin.lat.toFixed(2) + ',' + origin.lng.toFixed(2);
  if (last && last.key === key && Date.now() - last.at < TTL) return last.answer;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: origin.lat.toFixed(3), longitude: origin.lng.toFixed(3),
      current: 'precipitation,weather_code',
      hourly: 'precipitation_probability', forecast_hours: '4', timezone: 'auto',
    });
    const data = await (await fetch(url)).json();
    const now = WET(data.current?.weather_code) || data.current?.precipitation > 0.1;
    const soon = !now && (data.hourly?.precipitation_probability || []).some(p => p >= 60);
    last = { key, at: Date.now(), answer: { now, soon } };
    return last.answer;
  } catch {
    return null;
  }
}
