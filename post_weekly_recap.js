// post_weekly_recap.js
const BASE = "https://api.sleeper.app/v1";
const LEAGUE_ID = process.env.LEAGUE_ID || "1259729726277160960"; // your league
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL; // set in GitHub Secrets

if (!WEBHOOK) {
  console.error("Missing DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const j = (u) => fetch(u).then(r => r.json());

const nameFromUser = (u) =>
  (u?.metadata?.team_name) || u?.display_name || "Unknown Team";

async function main() {
  // current NFL week
  const state = await j(`${BASE}/state/nfl`);
  const week = state.week || state.leg;

  // league data
  const [matchups, rosters, users] = await Promise.all([
    j(`${BASE}/league/${LEAGUE_ID}/matchups/${week}`),
    j(`${BASE}/league/${LEAGUE_ID}/rosters`),
    j(`${BASE}/league/${LEAGUE_ID}/users`),
  ]);

  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const teamNameByRoster = Object.fromEntries(
    rosters.map(r => [r.roster_id, nameFromUser(userById[r.owner_id])])
  );

  const teams = matchups.map(m => ({
    roster_id: m.roster_id,
    name: teamNameByRoster[m.roster_id] || `Roster ${m.roster_id}`,
    points: Number(m.points || 0),
    matchup_id: m.matchup_id
  }));

  // high/low
  const top = teams.reduce((a,b)=> (b.points > a.points ? b : a), teams[0]);
  const bottom = teams.reduce((a,b)=> (b.points < a.points ? b : a), teams[0]);

  // matchup notes
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

  const trash = [
    `🏆 ${top.name} got *endorsed for touchdowns* (${top.points.toFixed(2)}).`,
    `🪦 ${bottom.name}, update your status to **Open to Work** (on waivers).`
  ].join(" ");

  const content = [
    `🏈 **LinkedIn Zone — Week ${week} Recap**`,
    `• High Score: **${top.name}** (${top.points.toFixed(2)})`,
    `• Low Score: **${bottom.name}** (${bottom.points.toFixed(2)})`,
    ...(notes.length ? ["", ...notes] : []),
    "",
    `💬 ${trash}`
  ].join("\n");

  // Discord webhook (content has a 2000-char limit; we're well under it)
  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });
}

main().catch(err => { console.error(err); process.exit(1); });
