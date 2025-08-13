// weather_watch.js — Wind & Weather Watch for NFL games (Thu/Sun/Mon)
// Sources:
// - Schedule: nflverse (Lee Sharpe) games/schedules (free, public)
// - Weather: Open-Meteo hourly forecast + geocoding (free, no key)
// Times are aligned to EASTERN (ET) because the schedule's kickoffs are published in ET.
//
// Thresholds (override via env): WIND_SUSTAINED (mph), WIND_GUST (mph), PRECIP_PCT (%)

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK) { console.error("Missing DISCORD_WEBHOOK_URL"); process.exit(1); }

const SEASON = Number(process.env.SEASON) || new Date().getFullYear();
const WIND_SUSTAINED = Number(process.env.WIND_SUSTAINED || 18);
const WIND_GUST = Number(process.env.WIND_GUST || 30);
const PRECIP_PCT = Number(process.env.PRECIP_PCT || 40); // show rain chance when >= this

// Only regular season (REG). You can widen if you post in preseason/postseason.
const GAME_TYPE = "REG";

// nflverse schedules (CSV): maintained & refreshed frequently
// (We read the "games" CSV which includes season, week, home/away, stadium, roof, date, ET kickoff)
const NFLVERSE_GAMES_CSV =
  "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

// Sleeper to get the current NFL week (handy, you’re already using it)
const SLEEPER_STATE = "https://api.sleeper.app/v1/state/nfl";

// Open-Meteo forecast + geocoding
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";

// Small helpers
const j = (u, opts) => fetch(u, opts).then(r => r.json());
const t = (s) => s == null ? "" : String(s).trim();

// Simple robust CSV parser that handles quoted commas
function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return rows;
  const headers = splitCSVLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = parts[idx] ?? "");
    rows.push(obj);
  }
  return rows;
}
function splitCSVLine(line) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Geocode cache for this run
const geoCache = new Map();
async function geocodeStadium(stadium, location) {
  const key = `${stadium}|${location}`.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  const q = encodeURIComponent(`${stadium} ${location} stadium`);
  const url = `${OPEN_METEO_GEOCODE}?name=${q}&count=1&language=en&format=json&countryCode=US`;
  const res = await j(url);
  const hit = res?.results?.[0];
  if (!hit) return null;
  const info = { lat: hit.latitude, lon: hit.longitude, tz: hit.timezone || "America/New_York" };
  geoCache.set(key, info);
  return info;
}

// Find the ET (Eastern Time) hour string in Open-Meteo (we request ET from API)
function findKickIndex(times, dayISO, etHHmm) {
  const [HH, MM] = String(etHHmm).split(":");
  const target = `${dayISO}T${String(HH).padStart(2,"0")}:00`;
  let idx = times.indexOf(target);
  if (idx !== -1) return idx;
  // fallback: nearest by hour
  const targetDate = new Date(`${dayISO}T${String(HH).padStart(2,"0")}:00:00-04:00`); // ET (EDT); close enough for index fallback
  let best = -1, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i] + ":00-04:00");
    const diff = Math.abs(d - targetDate);
    if (diff < bestDiff) { best = i; bestDiff = diff; }
  }
  return best;
}

function pickEmoji(roof, wind, gust) {
  if (roof && /dome/i.test(roof)) return "🏟️"; // roof closed → not wind-affected
  if (gust >= 35) return "🌬️💥";
  if (wind >= 20 || gust >= 30) return "🌬️";
  return "🌤️";
}

async function main() {
  // 1) What NFL week is it?
  const state = await j(SLEEPER_STATE);
  const week = Number(state?.week || state?.leg || 1);

  // 2) Pull schedule rows for this season/week
  const csv = await fetch(NFLVERSE_GAMES_CSV).then(r => r.text());
  const rows = parseCSV(csv).filter(r => {
    const season = Number(r.season || r.Season);
    const wk = Number(r.week || r.Week);
    const type = t(r.game_type || r.game_type_full || r.gm_type || r.Type);
    return season === SEASON && wk === week && type.toUpperCase() === GAME_TYPE;
  });

  if (!rows.length) {
    const payload = { embeds: [{ title: `Wind & Weather Watch — Week ${week}`, description: "No schedule found for this week. (If this is preseason or playoffs, expand GAME_TYPE.)" }] };
    await fetch(WEBHOOK, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    return;
  }

  // 3) Build per-game weather lookups
  const flagged = [];
  for (const r of rows) {
    const day = t(r.gameday || r.gametime_date || r.gamedate || r.game_date);  // ISO 8601 date
    const etTime = t(r.gametime || r.game_time_eastern || r.game_time_et || r.kickoff_time_eastern || "13:00");
    const home = t(r.home_team || r.home);
    const away = t(r.away_team || r.away);
    const stadium = t(r.stadium || r.venue || "");
    const location = t(r.location || r.city || "");
    const roof = t(r.roof || r.roof_type || "");

    // Skip domes unless you want retractables too
    const isDome = /dome/i.test(roof);
    // Keep retractable roofs (teams sometimes open them). Tag as "retractable" for copy.
    const retractable = /retractable/i.test(roof);

    // Geocode the venue to get lat/lon (cached per run)
    const geo = await geocodeStadium(stadium || `${home} stadium`, location);
    if (!geo) continue;

    // Ask Open-Meteo for THIS STADIUM on THIS DATE, hourly, in ET so we can index by ET kickoff
    const q = new URLSearchParams({
      latitude: String(geo.lat),
      longitude: String(geo.lon),
      hourly: "wind_speed_10m,wind_gusts_10m,precipitation_probability",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
      timezone: "America/New_York",
      start_date: day,
      end_date: day
    });
    const wx = await j(`${OPEN_METEO_FORECAST}?${q.toString()}`);
    const times = wx?.hourly?.time || [];
    const idx = findKickIndex(times, day, etTime);
    if (idx < 0) continue;

    const wind = Number(wx.hourly.wind_speed_10m?.[idx] ?? 0);
    const gust = Number(wx.hourly.wind_gusts_10m?.[idx] ?? 0);
    const precipPct = Number(wx.hourly.precipitation_probability?.[idx] ?? 0);

    const risky = (!isDome && (wind >= WIND_SUSTAINED || gust >= WIND_GUST));
    if (risky) {
      flagged.push({
        key: `${away} @ ${home}`,
        stadium, location, roof,
        wind, gust, precipPct, etTime,
        label: retractable ? "retractable" : (isDome ? "dome" : "outdoors")
      });
    }
  }

  // 4) Compose Discord embed
  if (!flagged.length) {
    const payload = {
      embeds: [{
        title: `Wind & Weather Watch — Week ${week}`,
        description: "All clear ✅ — no risky wind at kickoff for outdoor games.",
        footer: { text: `Thresholds: ≥${WIND_SUSTAINED} mph sustained or ≥${WIND_GUST} mph gusts (ET kickoff)` }
      }]
    };
    const resp = await fetch(WEBHOOK, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    console.log("Discord webhook status:", resp.status);
    return;
  }

  // Sort by gusts then sustained
  flagged.sort((a,b)=> (b.gust - a.gust) || (b.wind - a.wind));

  const fields = flagged.slice(0, 10).map(g => {
    const roofNote = g.label === "retractable" ? " (retractable)" : "";
    const rain = g.precipPct >= PRECIP_PCT ? ` • Rain chance ${g.precipPct}%` : "";
    const e = pickEmoji(g.roof, g.wind, g.gust);
    const venue = [g.stadium, g.location].filter(Boolean).join(" — ");
    return {
      name: `${e}  ${g.key} • ${g.etTime} ET`,
      value: `${venue}${roofNote}\nSustained **${g.wind.toFixed(0)} mph**, Gusts **${g.gust.toFixed(0)} mph**${rain}`.slice(0, 1024),
      inline: false
    };
  });

  const payload = {
    embeds: [{
      title: `Wind & Weather Watch — Week ${week}`,
      description: `Flagging games with **≥${WIND_SUSTAINED} mph** sustained or **≥${WIND_GUST} mph** gusts at ET kickoff.`,
      fields,
      footer: { text: "Forecast: Open-Meteo. Schedule: nflverse. Domes skipped; retractables included." }
    }]
  };

  const resp = await fetch(WEBHOOK, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  console.log("Discord webhook status:", resp.status);
}

main().catch(err => { console.error(err); process.exit(1); });
