// post_weekly_recap.js — LinkedIn Zone weekly recap (embeds + extra commentary)

const BASE = "https://api.sleeper.app/v1";
const LEAGUE_ID = process.env.LEAGUE_ID || "1259729726277160960";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK) { console.error("Missing DISCORD_WEBHOOK_URL"); process.exit(1); }

const j = (u) => fetch(u).then(r => r.json());

// OPTIONAL: Only run inside your season window (America/Chicago).
// Safe to keep or remove if you've already added this guard elsewhere.
function inSeasonWindow() {
  const now = new Date();
  const chicagoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const seasonStart = new Date('2025-09-04T00:00:00-05:00'); // CDT
  const seasonEnd   = new Date('2026-01-06T23:59:59-06:00'); // CST (includes Tue 1/6/26 recap)
  return chicagoNow >= seasonStart && chicagoNow <= seasonEnd;
}

// Week helper: find the most recent week (<= current) that actually has matchups
async function firstWeekWithMatchups(leagueId, startWeek) {
  const start = Number(startWeek || 1);
  for (let w = start; w >= 1; w--) {
    const m = await j(`${BASE}/league/${leagueId}/matchups/${w}`);
    if (Array.isArray(m) && m.length > 0) return { week: w, matchups: m };
  }
  return { week: null, matchups: [] };
}

// Load player directory (for Mahomes check)
async function getPlayers() {
  // This is a big JSON; fine for a weekly run. We’ll just read names/position/team.
  const players = await j(`${BASE}/players/nfl`);
  const byId = {};
  for (const [id, p] of Object.entries(players)) {
    byId[id] = {
      full_name: p?.full_name || [p?.first_name, p?.last_name].filter(Boolean).join(" "),
      position: p?.position || "",
      team: p?.team || p?.fantasy_positions?.[0] || ""
    };
  }
  return byId;
}

// Find Mahomes-like player IDs (robust to naming variants)
function mahomesIds(playersById) {
  const ids = [];
  for (const [id, p] of Object.entries(playersById)) {
    const name = (p.full_name || "").toLowerCase();
    if (name.includes("mahomes") && (p.position === "QB") && (p.team === "KC")) {
      ids.push(id);
    }
  }
  return new Set(ids);
}

async function main() {
  // Optional seasonal guard
  if (!inSeasonWindow()) {
    console.log("Out of season — skipping post.");
    return;
  }

  // Current NFL week from Sleeper
  const state = await j(`${BASE}/state/nfl`);
  const currentWeek = Number(state.week || state.leg || 1);

  // League maps
  const [rosters, users] = await Promise.all([
    j(`${BASE}/league/${LEAGUE_ID}/rosters`),
    j(`${BASE}/league/${LEAGUE_ID}/users`)
  ]);
  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const nameByRoster = Object.fromEntries(
    rosters.map(r => {
      const u = userById[r.owner_id];
      return [r.roster_id, (u?.metadata?.team_name) || u?.display_name || `Roster ${r.roster_id}`];
    })
  );

  // Week + matchups (falls back if current is empty)
  const { week, matchups } = await firstWeekWithMatchups(LEAGUE_ID, currentWeek);

  // Preseason / no data yet
  if (!matchups.length) {
    const payload = {
      embeds: [{
        title: "LinkedIn Zone — Preseason Check",
        description: "Webhook is live ✅. Waiting for regular-season matchups to post weekly recaps."
      }]
    };
    const resp = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    console.log("Discord webhook status:", resp.status);
    return;
  }

  // Build team objects (carry original matchup row for starters/players_points)
  const teams = matchups.map(m => ({
    roster_id: m.roster_id,
    name: nameByRoster[m.roster_id] || `Roster ${m.roster_id}`,
    points: Number(m.points || 0),
    matchup_id: m.matchup_id,
    starters: Array.isArray(m.starters) ? m.starters.map(String) : [],
    players_points: (m.players_points && typeof m.players_points === "object") ? m.players_points : null
  }));

  // Pair by matchup and compute winners/losers, margins
  const byMatch = {};
  for (const t of teams) (byMatch[t.matchup_id] ??= []).push(t);

  const winners = [];
  const losers  = [];
  const extremes = []; // {a,b, diff, sum}
  for (const [mid, pair] of Object.entries(byMatch)) {
    if (pair.length !== 2) continue; // ignore odd/median matchups
    const [a, b] = pair;
    const diff = Math.abs(a.points - b.points);
    const sum  = (a.points + b.points);
    extremes.push({ a, b, diff, sum, mid });

    if (a.points > b.points) { winners.push(a); losers.push(b); }
    else if (b.points > a.points) { winners.push(b); losers.push(a); }
    // ties: ignore for win/loss awards
  }

  // Core highs/lows
  const top = teams.reduce((a,b)=> (b.points > a.points ? b : a));
  const bottom = teams.reduce((a,b)=> (b.points < a.points ? b : a));

  // DOGE’d: highest score in a loss
  const doged = losers.length ? losers.reduce((a,b)=> (b.points > a.points ? b : a)) : null;

  // Subsidized: lowest score in a win
  const subsidized = winners.length ? winners.reduce((a,b)=> (b.points < a.points ? b : a)) : null;

  // Extremes
  const blowout = extremes.length ? extremes.reduce((a,b)=> (b.diff > a.diff ? b : a)) : null;
  const nailbiter = extremes.length ? extremes.reduce((a,b)=> (b.diff < a.diff ? b : a)) : null;
  const fireworks = extremes.length ? extremes.reduce((a,b)=> (b.sum > a.sum ? b : a)) : null;

  // League average (for side-quips)
  const avg = teams.reduce((s,t)=> s + t.points, 0) / teams.length;

  // Mahomes Watch
  const playersById = await getPlayers();
  const mahomesSet = mahomesIds(playersById);
  let mahomesNote = null;
  if (mahomesSet.size) {
    // which team started Mahomes?
    const mahomesTeams = teams.filter(t => t.starters.some(pid => mahomesSet.has(String(pid))));
    if (mahomesTeams.length) {
      // for each such team, did they win?
      const idsInWinners = new Set(winners.map(w => w.roster_id));
      for (const t of mahomesTeams) {
        const won = idsInWinners.has(t.roster_id);
        mahomesNote = won
          ? `👑 **Mahomes Watch:** ${t.name} won. Wow, such bravery starting Patrick. Truly disruptive.`
          : `🎉 **Mahomes Watch:** ${t.name} lost. The kingdom wobbles. Rejoice, peasants.`;
        break; // if multiple, just report first
      }
    } else {
      mahomesNote = "👀 **Mahomes Watch:** No one started Mahomes this week.";
    }
  }

  // Optional: bench heat (only if players_points is present)
  function benchPoints(t) {
    if (!t.players_points || !t.starters?.length) return null;
    const starters = new Set(t.starters.map(String));
    let bench = 0;
    for (const [pid, pts] of Object.entries(t.players_points)) {
      const v = Number(pts || 0);
      if (!starters.has(String(pid))) bench += v;
    }
    return bench;
  }
  let benchCallout = null;
  const withBench = teams.map(t => ({ t, bench: benchPoints(t) })).filter(x => x.bench !== null);
  if (withBench.length) {
    const worst = withBench.reduce((a,b)=> (b.bench > a.bench ? b : a));
    if (worst.bench >= 30) { // only call out if it's a lot
      benchCallout = `🧠 **Bench Brilliance:** ${worst.t.name} left ${worst.bench.toFixed(1)} on the bench. Bold strategy, Cotton.`;
    }
  }

  // Build embed
  const lines = [
    `• High Score: **${top.name}** (${top.points.toFixed(2)})`,
    `• Low Score: **${bottom.name}** (${bottom.points.toFixed(2)})`
  ];

  const awards = [];
  if (doged) awards.push(`🐕 **DOGE’d (High L in L):** ${doged.name} (${doged.points.toFixed(2)})`);
  if (subsidized) awards.push(`🍼 **Subsidized (Low W):** ${subsidized.name} (${subsidized.points.toFixed(2)})`);
  if (blowout) {
    const winner = blowout.a.points > blowout.b.points ? blowout.a : blowout.b;
    const loser  = blowout.a.points > blowout.b.points ? blowout.b : blowout.a;
    awards.push(`💥 **Biggest Blowout:** ${winner.name} over ${loser.name} by ${blowout.diff.toFixed(1)}`);
  }
  if (nailbiter && nailbiter.diff <= 5) {
    const winner = nailbiter.a.points > nailbiter.b.points ? nailbiter.a : nailbiter.b;
    const loser  = nailbiter.a.points > nailbiter.b.points ? nailbiter.b : nailbiter.a;
    awards.push(`🧊 **Nail-biter:** ${winner.name} edged ${loser.name} by ${nailbiter.diff.toFixed(1)}`);
  }
  if (fireworks) {
    awards.push(`🎆 **Highest Combined:** ${fireworks.a.name} vs ${fireworks.b.name} = ${(fireworks.sum).toFixed(1)}`);
  }
  // Bonus quip: any winner below league average
  const underAvg = winners.filter(w => w.points < avg);
  if (underAvg.length) {
    const names = underAvg.map(t => t.name).slice(0,3).join(", ");
    awards.push(`🪙 **Won Below Average:** ${names}${underAvg.length>3?"…":""} (the algorithm favored you)`);
  }
  if (benchCallout) awards.push(benchCallout);

  const embed = {
    title: `LinkedIn Zone — Week ${week} Recap`,
    description: lines.join("\n"),
    footer: { text: "Endorsed for Touchdowns" },
    fields: []
  };
  if (awards.length) embed.fields.push({ name: "Awards & Notables", value: awards.join("\n"), inline: false });
  if (mahomesNote) embed.fields.push({ name: "Mahomes Watch", value: mahomesNote, inline: false });

  const payload = { embeds: [embed] };

  const resp = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  console.log("Discord webhook status:", resp.status);
}

main().catch(err => { console.error(err); process.exit(1); });
