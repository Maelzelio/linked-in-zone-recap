// post_weekly_recap.js
const BASE = "https://api.sleeper.app/v1";
const LEAGUE_ID = process.env.LEAGUE_ID || "1259729726277160960";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK) { console.error("Missing DISCORD_WEBHOOK_URL"); process.exit(1); }

const j = (u) => fetch(u).then(r => r.json());
const teamName = (u) => (u?.metadata?.team_name) || u?.display_name || "Unknown Team";

// Find the most recent week (<= current) that actually has matchups
async function firstWeekWithMatchups(leagueId, startWeek) {
  const start = Number(startWeek || 1);
  for (let w = start; w >= 1; w--) {
    const m = await j(`${BASE}/league/${leagueId}/matchups/${w}`);
    if (Array.isArray(m) && m.length > 0) return { week: w, matchups: m };
  }
  return { week: null, matchups: [] };
}

async function main() {
  // Only run between 2025-09-04 and 2026-01-06 (America/Chicago)
  const now = new Date();
  const chicagoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const seasonStart = new Date('2025-09-04T00:00:00-05:00'); // CDT
  const seasonEnd   = new Date('2026-01-06T23:59:59-06:00'); // CST
  if (chicagoNow < seasonStart || chicagoNow > seasonEnd) {
    console.log('Out of season — skipping post.');
    return; // or process.exit(0);
  }
  
  // Current NFL state (has week/leg) per Sleeper docs
  const state = await j(`${BASE}/state/nfl`);
  const currentWeek = Number(state.week || state.leg || 1);

  // Map roster -> team display
  const [rosters, users] = await Promise.all([
    j(`${BASE}/league/${LEAGUE_ID}/rosters`),
    j(`${BASE}/league/${LEAGUE_ID}/users`)
  ]);
  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const nameByRoster = Object.fromEntries(
    rosters.map(r => [r.roster_id, teamName(userById[r.owner_id])])
  );

  // Get matchups (or detect preseason / no data)
  const { week, matchups } = await firstWeekWithMatchups(LEAGUE_ID, currentWeek);

  // If no matchups exist yet, just verify webhook wiring
  if (!matchups.length) {
    const content = [
      "🏈 **LinkedIn Zone — Preseason Check**",
      "Chair is occupied ✅. Warming up. Watch this space for future commentary."
    ].join("\n");
    const resp = await fetch(WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    console.log("Discord webhook status:", resp.status); // 204 = success
    return;
  }

  // Build team results safely
  const teams = matchups.map(m => ({
    roster_id: m.roster_id,
    name: nameByRoster[m.roster_id] || `Roster ${m.roster_id}`,
    points: Number(m.points || 0),
    matchup_id: m.matchup_id
  }));

  // Safe reducers (teams is non-empty here)
  const top = teams.reduce((a,b)=> (b.points > a.points ? b : a));
  const bottom = teams.reduce((a,b)=> (b.points < a.points ? b : a));

  // Blowouts / nail-biters
  const byMatch = {};
  for (const t of teams) (byMatch[t.matchup_id] ??= []).push(t);
  const notes = [];
  for (const [mid, pair] of Object.entries(byMatch)) {
    if (pair.length === 2) {
      const [a,b] = pair;
      const diff = Math.abs(a.points - b.points);
      if (diff >= 40) notes.push(`💥 **Blowout** M${mid}: ${a.name} vs ${b.name} — ${diff.toFixed(1)} pts`);
      else if (diff <= 5) notes.push(`🧊 **Nail-biter** M${mid}: decided by ${diff.toFixed(1)} pts`);
    }
  }

  const trash = `🏆 ${top.name} got *endorsed for touchdowns* (${top.points.toFixed(2)}). 🪦 ${bottom.name}, update your status to **Open to Work** (on waivers).`;

  const content = [
    `🏈 **LinkedIn Zone — Week ${week} Recap**`,
    `• High Score: **${top.name}** (${top.points.toFixed(2)})`,
    `• Low Score: **${bottom.name}** (${bottom.points.toFixed(2)})`,
    ...(notes.length ? ["", ...notes] : []),
    "",
    `💬 ${trash}`
  ].join("\n");

  const resp = await fetch(WEBHOOK, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }) // Discord webhook content max is 2000 chars
  });
  console.log("Discord webhook status:", resp.status); // 204 or 200 = success
}

main().catch(err => { console.error(err); process.exit(1); });
