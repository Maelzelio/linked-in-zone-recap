// post_weekly_recap.js — LinkedIn Zone weekly recap with Power Rankings

const BASE = "https://api.sleeper.app/v1";
const LEAGUE_ID = process.env.LEAGUE_ID || "1259729726277160960";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK) { console.error("Missing DISCORD_WEBHOOK_URL"); process.exit(1); }

const j = (u) => fetch(u).then(r => r.json());

/* ---------- Season window guard (America/Chicago) ---------- */
function inSeasonWindow() {
  const now = new Date();
  const chicagoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const seasonStart = new Date('2025-09-04T00:00:00-05:00'); // CDT
  const seasonEnd   = new Date('2026-01-06T23:59:59-06:00'); // CST
  return chicagoNow >= seasonStart && chicagoNow <= seasonEnd;
}

/* ---------- Helpers ---------- */
async function firstWeekWithMatchups(leagueId, startWeek) {
  const start = Number(startWeek || 1);
  for (let w = start; w >= 1; w--) {
    const m = await j(`${BASE}/league/${leagueId}/matchups/${w}`);
    if (Array.isArray(m) && m.length > 0) return { week: w, matchups: m };
  }
  return { week: null, matchups: [] };
}

async function getPlayers() {
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

function mahomesIds(playersById) {
  const ids = [];
  for (const [id, p] of Object.entries(playersById)) {
    const name = (p.full_name || "").toLowerCase();
    if (name.includes("mahomes") && p.position === "QB" && p.team === "KC") ids.push(id);
  }
  return new Set(ids);
}

/* ---------- Build season-to-date stats for power rankings ---------- */
async function loadWeeksRange(leagueId, startWeek, endWeek) {
  const weeks = {};
  for (let w = startWeek; w <= endWeek; w++) {
    const m = await j(`${BASE}/league/${leagueId}/matchups/${w}`);
    if (Array.isArray(m) && m.length) weeks[w] = m;
  }
  return weeks;
}

function zscore(arr, getter) {
  const vals = arr.map(getter);
  const mean = vals.reduce((s,v)=>s+v,0) / (vals.length || 1);
  const variance = vals.reduce((s,v)=> s + Math.pow(v-mean,2), 0) / (vals.length || 1);
  const std = Math.sqrt(variance) || 1; // avoid div-by-zero
  return (v)=> (v - mean) / std;
}

function minmaxScale(arr, getter) {
  const vals = arr.map(getter);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return (v)=> (max === min) ? 0.5 : (v - min) / (max - min);
}

function computeSeasonStats(weeksMap, nameByRoster) {
  // per-team aggregates
  const teams = {};
  // track opponents per team to compute SOS later
  const opps = {};
  // per-week points history for last-3 calc
  const weeklyPoints = {};

  const weekNums = Object.keys(weeksMap).map(Number).sort((a,b)=>a-b);
  for (const w of weekNums) {
    // group into pairs by matchup_id for W/L; still record points for everyone
    const byMatch = {};
    for (const m of weeksMap[w]) (byMatch[m.matchup_id] ??= []).push(m);

    for (const [mid, pair] of Object.entries(byMatch)) {
      // ensure team records created
      for (const m of pair) {
        const id = m.roster_id;
        if (!teams[id]) teams[id] = { id, name: nameByRoster[id] || `Roster ${id}`, gp:0, wins:0, losses:0, pf:0, pa:0, diff:0 };
        if (!weeklyPoints[id]) weeklyPoints[id] = [];
      }
      // add points
      for (const m of pair) {
        const id = m.roster_id;
        const pts = Number(m.points || 0);
        teams[id].gp += 1;
        teams[id].pf += pts;
        weeklyPoints[id].push({ week:w, pts });
      }
      // set opponents + pa + wins/losses only for real pairs
      if (pair.length === 2) {
        const [a,b] = pair;
        const aId = a.roster_id, bId = b.roster_id;
        const aPts = Number(a.points || 0), bPts = Number(b.points || 0);

        teams[aId].pa += bPts;
        teams[bId].pa += aPts;
        teams[aId].diff += (aPts - bPts);
        teams[bId].diff += (bPts - aPts);

        (opps[aId] ??= []).push(bId);
        (opps[bId] ??= []).push(aId);

        if (aPts > bPts) teams[aId].wins += 1;
        else if (bPts > aPts) teams[bId].wins += 1;
        else { /* tie: ignore */ }
      }
    }
  }

  // derive per-team metrics
  const list = Object.values(teams).map(t => {
    const ppg = t.gp ? t.pf / t.gp : 0;
    const pdg = t.gp ? t.diff / t.gp : 0;
    const winPct = t.gp ? t.wins / t.gp : 0;

    const ptsList = (weeklyPoints[t.id] || []).sort((a,b)=>a.week-b.week).map(x=>x.pts);
    const last3 = ptsList.slice(-3);
    const recent = last3.length ? last3.reduce((s,v)=>s+v,0) / last3.length : 0;

    return { ...t, ppg, pdg, winPct, recent };
  });

  // SOS: average opponent PPG
  const ppgById = Object.fromEntries(list.map(t => [t.id, t.ppg]));
  for (const t of list) {
    const o = (opps[t.id] || []);
    const sos = o.length ? o.reduce((s,id)=> s + (ppgById[id] || 0), 0) / o.length : 0;
    t.sos = sos;
  }

  // Composite Power Score
  const zWin = zscore(list, x=>x.winPct);
  const zPPG = zscore(list, x=>x.ppg);
  const zPDG = zscore(list, x=>x.pdg);
  const zREC = zscore(list, x=>x.recent);
  const zSOS = zscore(list, x=>x.sos);

  for (const t of list) {
    const zsum =
      0.35 * zWin(t.winPct) +
      0.25 * zPPG(t.ppg) +
      0.15 * zPDG(t.pdg) +
      0.15 * zREC(t.recent) +
      0.10 * zSOS(t.sos);
    t._z = zsum;
  }
  const mm = minmaxScale(list, x=>x._z);
  for (const t of list) t.power = Math.round((mm(t._z) * 1000)) / 10; // 0.0–100.0

  // sort best→worst
  list.sort((a,b)=> b.power - a.power);
  // add record string
  for (const t of list) t.rec = `${t.wins}-${t.losses}`;

  return list;
}

/* ---------- Main weekly flow ---------- */
async function main() {
  if (!inSeasonWindow()) {
    console.log("Out of season — skipping post.");
    return;
  }

  const state = await j(`${BASE}/state/nfl`);
  const currentWeek = Number(state.week || state.leg || 1);

  const [rosters, users] = await Promise.all([
    j(`${BASE}/league/${LEAGUE_ID}/rosters`),
    j(`${BASE}/league/${LEAGUE_ID}/users`)
  ]);
  const userById = Object.fromEntries(users.map(u => [u.user_id, u]));
  const nameByRoster = Object.fromEntries(
    rosters.map(r => [r.roster_id, (userById[r.owner_id]?.metadata?.team_name) || userById[r.owner_id]?.display_name || `Roster ${r.roster_id}`])
  );

  const { week, matchups } = await firstWeekWithMatchups(LEAGUE_ID, currentWeek);

  if (!matchups.length) {
    const payload = {
      embeds: [{ title: "LinkedIn Zone — Preseason Check", description: "Webhook is live ✅. Waiting for regular-season matchups to post weekly recaps." }]
    };
    const resp = await fetch(WEBHOOK, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    console.log("Discord webhook status:", resp.status);
    return;
  }

  // Build current-week team objects
  const teams = matchups.map(m => ({
    roster_id: m.roster_id,
    name: nameByRoster[m.roster_id] || `Roster ${m.roster_id}`,
    points: Number(m.points || 0),
    matchup_id: m.matchup_id,
    starters: Array.isArray(m.starters) ? m.starters.map(String) : [],
    players_points: (m.players_points && typeof m.players_points === "object") ? m.players_points : null
  }));

  // Pair current-week matchups for notes
  const byMatch = {};
  for (const t of teams) (byMatch[t.matchup_id] ??= []).push(t);

  const winners = [], losers = [], extremes = [];
  for (const [mid, pair] of Object.entries(byMatch)) {
    if (pair.length !== 2) continue;
    const [a,b] = pair;
    const diff = Math.abs(a.points - b.points);
    const sum  = a.points + b.points;
    extremes.push({ a,b,diff,sum,mid });
    if (a.points > b.points) { winners.push(a); losers.push(b); }
    else if (b.points > a.points) { winners.push(b); losers.push(a); }
  }

  const top = teams.reduce((a,b)=> (b.points > a.points ? b : a));
  const bottom = teams.reduce((a,b)=> (b.points < a.points ? b : a));
  const doged = losers.length ? losers.reduce((a,b)=> (b.points > a.points ? b : a)) : null;
  const subsidized = winners.length ? winners.reduce((a,b)=> (b.points < a.points ? b : a)) : null;

  const blowout = extremes.length ? extremes.reduce((a,b)=> (b.diff > a.diff ? b : a)) : null;
  const nailbiter = extremes.length ? extremes.reduce((a,b)=> (b.diff < a.diff ? b : a)) : null;
  const fireworks = extremes.length ? extremes.reduce((a,b)=> (b.sum > a.sum ? b : a)) : null;

  const avg = teams.reduce((s,t)=> s + t.points, 0) / (teams.length || 1);

  // Mahomes Watch
  const playersById = await getPlayers();
  const mahomesSet = mahomesIds(playersById);
  let mahomesNote = null;
  const mahomesTeams = teams.filter(t => t.starters.some(pid => mahomesSet.has(String(pid))));
  if (mahomesTeams.length) {
    const winnersSet = new Set(winners.map(w => w.roster_id));
    for (const t of mahomesTeams) {
      const won = winnersSet.has(t.roster_id);
      mahomesNote = won
        ? `👑 **Mahomes Watch:** ${t.name} won. Truly disruptive leadership.`
        : `🎉 **Mahomes Watch:** ${t.name} lost. The kingdom wobbles.`;
      break;
    }
  }

  // Bench callout
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
    if (worst.bench >= 30) benchCallout = `🧠 **Bench Brilliance:** ${worst.t.name} left ${worst.bench.toFixed(1)} on the bench. Bold strategy.`;
  }

  /* ---------- Power Rankings ---------- */
  // Build season-to-date through current week
  const weeksToDate = await loadWeeksRange(LEAGUE_ID, 1, week);
  const prNow = computeSeasonStats(weeksToDate, nameByRoster);

  // Build prior week (for movement arrows)
  let prPrev = null;
  if (week > 1) {
    const weeksPrev = await loadWeeksRange(LEAGUE_ID, 1, week - 1);
    prPrev = computeSeasonStats(weeksPrev, nameByRoster);
  }

  const rankIndexPrev = prPrev
    ? Object.fromEntries(prPrev.map((t, i) => [t.id, i]))
    : {};

  function rankLine(t, i) {
    const place = i + 1;
    const delta = (t.id in rankIndexPrev) ? (rankIndexPrev[t.id] - i) : 0; // positive = moved up
    const arrow = (t.id in rankIndexPrev)
      ? (delta > 0 ? `↑${delta}` : (delta < 0 ? `↓${Math.abs(delta)}` : "–"))
      : "–";
    return `${place}. ${t.name} — ${t.power.toFixed(1)}  (${t.rec}, PPG ${t.ppg.toFixed(1)})  ${arrow}`;
  }

  const powerLines = prNow.slice(0, 10).map(rankLine);

  /* ---------- Build Embed ---------- */
  const lines = [
    `• High Score: **${top.name}** (${top.points.toFixed(2)})`,
    `• Low Score: **${bottom.name}** (${bottom.points.toFixed(2)})`
  ];

  const awards = [];
  if (doged) awards.push(`🐕 **DOGE’d (High L):** ${doged.name} (${doged.points.toFixed(2)})`);
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
  if (fireworks) awards.push(`🎆 **Highest Combined:** ${fireworks.a.name} vs ${fireworks.b.name} = ${(fireworks.sum).toFixed(1)}`);
  const underAvg = winners.filter(w => w.points < avg);
  if (underAvg.length) {
    const names = underAvg.map(t => t.name).slice(0,3).join(", ");
    awards.push(`🪙 **Won Below Average:** ${names}${underAvg.length>3?"…":""}`);
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
  if (powerLines.length) embed.fields.push({ name: `Power Rankings (Week ${week})`, value: powerLines.join("\n").slice(0, 1024), inline: false });

  const payload = { embeds: [embed] };

  const resp = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  console.log("Discord webhook status:", resp.status);
}

main().catch(err => { console.error(err); process.exit(1); });
