// lineup_health_check.js — warns if starters have risky/OUT statuses

const BASE = "https://api.sleeper.app/v1";
const LEAGUE_ID = process.env.LEAGUE_ID || "1259729726277160960";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK) { console.error("Missing DISCORD_WEBHOOK_URL"); process.exit(1); }

const j = (u) => fetch(u).then(r => r.json());

// Season window guard (America/Chicago) — adjust if you like
function inSeasonWindow() {
  const now = new Date();
  const chicagoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const seasonStart = new Date('2025-09-04T00:00:00-05:00'); // CDT
  const seasonEnd   = new Date('2026-01-06T23:59:59-06:00'); // CST
  return chicagoNow >= seasonStart && chicagoNow <= seasonEnd;
}

async function main() {
  if (!inSeasonWindow()) { console.log("Out of season — skipping."); return; }

  // Pull rosters (starters) + users (team names)
  const [rosters, users] = await Promise.all([
    j(`${BASE}/league/${LEAGUE_ID}/rosters`),
    j(`${BASE}/league/${LEAGUE_ID}/users`)
  ]);
  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const teamNameByRoster = Object.fromEntries(
    rosters.map(r => [r.roster_id, (userById[r.owner_id]?.metadata?.team_name) || userById[r.owner_id]?.display_name || `Roster ${r.roster_id}`])
  );

  // Pull players directory (has status/injury_status/etc.)
  const players = await j(`${BASE}/players/nfl`); // ~5–6MB; fine a few times per week
  // Status buckets
  const CRITICAL = new Set(["Out", "IR", "PUP", "Suspended"]);
  const RISKY = new Set(["Doubtful", "Questionable", "GTD", "DTD", "Probable"]);

  // Build warnings per team
  const fields = [];
  for (const r of rosters) {
    const starters = Array.isArray(r.starters) ? r.starters.map(String) : [];
    if (!starters.length) continue;

    const critical = [];
    const risky = [];

    for (const pid of starters) {
      const p = players[pid];
      if (!p) continue; // unknown id (unlikely)
      // Prefer p.injury_status when present; fall back to p.status
      const tag = p.injury_status || p.status || "";
      if (!tag) continue;

      // Build a readable name like "Patrick Mahomes (KC QB)"
      const full =
        (p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ")) ||
        (p.last_name || pid);
      const pos = p.position || (p.fantasy_positions?.[0] || "");
      const nfl = p.team || "";
      const label = `${full} (${nfl} ${pos}) — ${tag}`;

      if (CRITICAL.has(tag)) critical.push(label);
      else if (RISKY.has(tag)) risky.push(label);
    }

    if (critical.length || risky.length) {
      const lines = [];
      if (critical.length) lines.push(`**Critical (bench these)**:\n• ${critical.join("\n• ")}`);
      if (risky.length)    lines.push(`**Risky (monitor)**:\n• ${risky.join("\n• ")}`);
      fields.push({ name: teamNameByRoster[r.roster_id], value: lines.join("\n\n").slice(0, 1024), inline: false });
    }
  }

  // Nothing to warn? Still post a tiny heartbeat so folks know we checked.
  if (!fields.length) {
    const payload = { embeds: [{ title: "Lineup Health Check", description: "All clear ✅ — no risky/OUT starters detected.", footer: { text: "Note: Injury tags can linger through bye weeks." } }] };
    const resp = await fetch(WEBHOOK, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    console.log("Discord webhook status:", resp.status);
    return;
  }

  const payload = {
    embeds: [{
      title: "Lineup Health Check",
      description: "Heads up on starters with injury/suspension designations.",
      footer: { text: "Sleeper injury tags; bye weeks can retain last week’s tag." },
      fields
    }]
  };

  const resp = await fetch(WEBHOOK, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  console.log("Discord webhook status:", resp.status);
}

main().catch(err => { console.error(err); process.exit(1); });
