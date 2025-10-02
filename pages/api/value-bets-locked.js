// pages/api/value-bets-locked.js
// Vraća finalnih do 15 mečeva za slot: pune kartice + odds, bez Reserve/U/W, sa hard BLOCKED_LEAGUE_IDS.
// Odds-gate: preferira sa kvotama; ako ostane <6, bezbedan fallback do 6 bez odds.
// Nikad 500: u grešci vraćamo { ok:false, error } sa 200.

import * as s from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const SLOT_CAPS = { late: 1000, am: 2000, pm: 3000 };
const API_HOST = "https://v3.football.api-sports.io";

// Hard blacklist po league ID-u
const BLOCKED_LEAGUE_IDS = [
  // npr 128, 71 ...
];

// Regex blokovi po nazivu lige
const RE_YOUTH = /\bU(?:23|22|21|20|19|18|17|16|15)\b/i;
const RE_YOUTH_WORDS = /\b(under\s?(?:23|22|21|20|19|18|17|16|15)|primavera|youth|junior[es]?|sub\s?(?:23|22|21|20|19|18|17|16|15))\b/i;
const RE_RESERVE = /\b(reserve|res\.|reserves)\b/i;
const RE_WOMEN = new RegExp([
  "\\bwomen'?s?\\b", "\\bfemeni\\w*\\b", "\\blad(?:y|ies)\\b",
  "(?<!world)\\sW(\\s|\\b|[-)]|$)", "\\bW-?league\\b", "\\bW\\.?\\s?cup\\b"
].join("|"), "i");

function sval(x){ return (x==null) ? "" : String(x); }
function isBlockedLeagueName(nameRaw){
  const name = sval(nameRaw).trim();
  if (!name) return false;
  if (RE_WOMEN.test(name)) return true;
  if (RE_YOUTH.test(name) || RE_YOUTH_WORDS.test(name)) return true;
  if (RE_RESERVE.test(name)) return true;
  return false;
}

function ymdNow() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function sanitizeYmd(v){
  const sVal = decodeURIComponent(String(v || "")).trim(); 
  return /^\d{4}-\d{2}-\d{2}$/.test(sVal) ? sVal : ymdNow();
}
function sanitizeSlot(v){
  const sVal = decodeURIComponent(String(v || "")).trim().toLowerCase();
  return /^(am|pm|late)$/.test(sVal) ? sVal : detectSlot();
}
function detectSlot(){
  const h = Number(new Date(new Date().toLocaleString("en-US", { timeZone: TZ })).getHours());
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}

function hourFromIsoLocal(iso) {
  if (typeof iso !== "string") return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}
function inSlotWindow(kickoffIso, slot) {
  const h = hourFromIsoLocal(kickoffIso);
  if (h == null) return false;
  if (slot === "late") return h >= 0 && h < 10;
  if (slot === "am")   return h >= 10 && h < 15;
  if (slot === "pm")   return h >= 15 && h <= 23;
  return true;
}

function uniqueIds(arr) {
  const seen = new Set(), out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const id = typeof v === "number" ? v : v?.id;
    if (typeof id === "number" && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

async function readLockedSeeds() {
  // Preferiraj pune stavke iz locked games (ako postoje)
  const seeds = [];
  try {
    const games = await s.kvGet("vb-locked:kv:hit:games");
    if (Array.isArray(games)) {
      for (const g of games) {
        if (!g) continue;
        const leagueId = g.leagueId ?? g?.league?.id ?? null;
        const league = g.leagueName ?? g.league ?? null;
        if (isBlockedLeagueName(league)) continue;
        if (typeof leagueId === "number" && BLOCKED_LEAGUE_IDS.includes(leagueId)) continue;
        if (!g.kickoff || !g.home || !g.away) continue;
        seeds.push({
          id: g.id, home:g.home, away:g.away, league: league, leagueId,
          kickoff: g.kickoff, homeTeam:g.home, awayTeam:g.away, leagueName:league,
          start:g.kickoff, startTime:g.kickoff, odds: g.odds ?? null, edge: g.edge ?? null
        });
      }
    }
  } catch {}
  // Ako nema games, bar pročitaj id listu (bez detalja)
  if (!seeds.length) {
    try {
      const ids = uniqueIds(await s.kvGet("vb-locked:kv:hit") || []);
      for (const id of ids) seeds.push({ id });
    } catch {}
  }
  // uniq
  const map = new Map(seeds.map(x => [x.id, x]));
  return Array.from(map.values());
}

async function readOddsBulk(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cmds = [];
  const keyIndex = [];
  for (const id of ids) {
    const k = `vb-odds:last:${id}`;
    cmds.push(["GET", k]); keyIndex.push([id, k]);
  }
  let resp = null;
  try { resp = await s.kvPipeline(cmds); } catch { resp = null; }
  if (!resp || !Array.isArray(resp)) return out;
  for (let i = 0; i < resp.length; i++) {
    const [id] = keyIndex[i];
    const val = resp[i]?.result ?? null;
    out.set(id, val ?? null);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);

    // 1) Seeds iz locked (preferira pune stavke)
    const seeds = await readLockedSeeds();
    const seedsMap = new Map(seeds.map(x => [x.id, x]));

    // 2) Fallback izvori ID-eva (ako locked prazan)
    let ids = [];
    if (!seeds.length) {
      const chain = [
        `vbl_full:${ymd}:${slot}`,
        `vbl_full:${ymd}`,
        `vb:day:${ymd}:union`,
      ];
      for (const k of chain) {
        try {
          const v = await s.kvGet(k);
          ids = uniqueIds(v);
          if (ids.length) break;
        } catch {}
      }
      if (!ids.length) {
        return res.status(200).json({
          items: [], ids: [], games: [],
          meta: { ymd, slot, source:"vb-locked:kv:hit", ts:new Date().toISOString(), last_odds_refresh:new Date().toISOString(), returned:0, cap:15 }
        });
      }
    } else {
      ids = seeds.map(x => x.id);
    }

    // 3) Filtriraj po slot prozoru (na osnovu kickoff ako ga imamo) + liga blokovi
    let prelim = (ids.length ? ids : seeds.map(x=>x.id))
      .map(id => seedsMap.get(id) || { id })
      .filter(row => {
        if (!row.league && !row.kickoff) return true; // biće kompletirano iz front feeda kasnije
        if (row.league && isBlockedLeagueName(row.league)) return false;
        if (typeof row.leagueId === "number" && BLOCKED_LEAGUE_IDS.includes(row.leagueId)) return false;
        if (row.kickoff && !inSlotWindow(row.kickoff, slot)) return false;
        return true;
      });

    // 4) Odds-gate preferencija + fallback (<6)
    // – ako imamo odds u KV ili u seed-u, daj prednost
    const oddsMap = await readOddsBulk(prelim.map(x => x.id));
    const withOdds = [];
    const withoutOdds = [];
    for (const x of prelim) {
      const base = seedsMap.get(x.id) || x;
      const odds = base.odds ?? oddsMap.get(x.id) ?? null;
      const full = { ...base, odds };
      if (odds) withOdds.push(full); else withoutOdds.push(full);
    }

    // Sort po kickoff
    withOdds.sort((a,b)=> String(a.kickoff||"").localeCompare(String(b.kickoff||"")));
    withoutOdds.sort((a,b)=> String(a.kickoff||"").localeCompare(String(b.kickoff||"")));

    let picked = withOdds.slice(0, 15);
    if (picked.length < 15) picked = picked.concat(withoutOdds.slice(0, 15 - picked.length));

    // Bezbedan fallback do minimuma 6 ako je lista suviše kratka
    let fallback_used = false;
    if (picked.length < 6) {
      const unionDay = uniqueIds(await s.kvGet(`vb:day:${ymd}:union`) || []);
      for (const id of unionDay) {
        if (picked.find(p => p.id === id)) continue;
        const row = await s.kvGet(`vb:fixture:${id}`).catch(()=>null);
        if (!row) continue;
        if (isBlockedLeagueName(row.leagueName || row.league)) continue;
        if (typeof row.leagueId === "number" && BLOCKED_LEAGUE_IDS.includes(row.leagueId)) continue;
        if (row.kickoff && !inSlotWindow(row.kickoff, slot)) continue;
        picked.push({
          id: row.id, home:row.home, away:row.away, league:row.leagueName || row.league, leagueId: row.leagueId ?? null,
          kickoff: row.kickoff, homeTeam: row.home, awayTeam: row.away, leagueName: row.leagueName || row.league,
          start: row.kickoff, startTime: row.kickoff, odds: await s.kvGet(`vb-odds:last:${row.id}`).catch(()=>null) ?? null
        });
        if (picked.length >= 6) { fallback_used = true; break; }
      }
    }

    const items = picked.slice(0, 15).map(g => {
      const obj = {
        id: g.id, home: g.home, away: g.away, league: g.league, leagueId: g.leagueId ?? null,
        kickoff: g.kickoff,
        homeTeam: g.home ?? g.homeTeam, awayTeam: g.away ?? g.awayTeam,
        leagueName: g.league ?? g.leagueName,
        start: g.kickoff, startTime: g.kickoff
      };
      if (g.odds) obj.odds = g.odds;
      if (g.edge) obj.edge = g.edge;
      return obj;
    });

    const metaRaw = await s.kvGet("vb-locked:kv:hit:meta").catch(()=>null);
    const nowIso = new Date().toISOString();
    const meta = {
      ymd, slot, source: "vb-locked:kv:hit",
      ts: metaRaw?.ts || nowIso,
      last_odds_refresh: metaRaw?.last_odds_refresh || nowIso,
      returned: items.length, cap: 15,
      fallback_used
    };

    return res.status(200).json({
      items, ids: items.map(x => x.id), games: items, meta
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
