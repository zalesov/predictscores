// pages/api/value-bets-locked.js
// TOP 15 by confidence (desc) for the current slot. KV-only. No external API calls.
// - Attaches odds from vb-odds:last:<fixtureId>
// - Attaches confidence from locked items, else borrows from vb:day:<ymd>:combined
// - Returns 4x4 tickets from tickets:<ymd>:<slot> or builds from combined as fallback

import * as s from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const BLOCKED_LEAGUE_IDS = [];

function nowHourBG() {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));
}
function todayYmdBG() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
function sanitizeYmd(x) {
  const s0 = String(x || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s0) ? s0 : todayYmdBG();
}
function sanitizeSlot(x) {
  const s = String(x || "auto").toLowerCase();
  if (s === "late" || s === "am" || s === "pm") return s;
  const h = nowHourBG();
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}
function isBlockedLeagueName(name) {
  const n = String(name || "").toLowerCase();
  if (/\bu\d{2}\b/.test(n)) return true;
  if (/(women|femin|ladies|female)/i.test(name || "")) return true;
  if (/(reserve|reserves|b team|ii)$/.test(n)) return true;
  return false;
}
function inSlotWindow(iso, slot) {
  try {
    const hh = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date(iso)));
    if (slot === "late") return hh < 10;
    if (slot === "am")   return hh >= 10 && hh < 15;
    if (slot === "pm")   return hh >= 15 && hh <= 23;
    return true;
  } catch { return true; }
}
function uniqueIds(arr) {
  const seen = new Set(), out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const id = typeof v === "number" ? v : v?.id ?? v?.fixture_id;
    if (typeof id === "number" && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
async function kvGetSafe(key) { try { return await s.kvGet(key); } catch { return null; } }
async function kvPipelineSafe(cmds) {
  try {
    const r = await s.kvPipeline(cmds);
    if (Array.isArray(r)) return r;
  } catch {}
  const out = [];
  for (const [, k] of cmds) { // degrade to sequential gets
    // eslint-disable-next-line no-await-in-loop
    const v = await kvGetSafe(k);
    out.push({ result: v });
  }
  return out;
}
async function readFixturesBulk(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cmds = ids.map(id => ["GET", `vb:fixture:${id}`]);
  const resp = await kvPipelineSafe(cmds);
  ids.forEach((id, i) => {
    const v = resp[i]?.result ?? resp[i]?.value ?? null;
    if (v && typeof v === "object") out.set(id, v);
    else if (typeof v === "string") { try { out.set(id, JSON.parse(v)); } catch {} }
  });
  return out;
}
async function readOddsBulk(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cmds = ids.map(id => ["GET", `vb-odds:last:${id}`]);
  const resp = await kvPipelineSafe(cmds);
  ids.forEach((id, i) => {
    const payload = resp[i]?.result ?? resp[i]?.value ?? null;
    let parsed = null;
    if (payload && typeof payload === "string") { try { parsed = JSON.parse(payload); } catch {} }
    else if (payload && typeof payload === "object") { parsed = payload; }
    out.set(id, parsed ?? null);
  });
  return out;
}
async function readCombined(ymd) {
  const v = await kvGetSafe(`vb:day:${ymd}:combined`);
  return Array.isArray(v) ? v : [];
}
function confidenceMapFrom(arr) {
  const m = new Map();
  for (const it of Array.isArray(arr) ? arr : []) {
    const fid = it?.fixture_id ?? it?.id;
    if (typeof fid !== "number") continue;
    const c =
      (typeof it?.confidence_pct === "number" ? it.confidence_pct : null) ??
      (typeof it?.confidence === "number" ? it.confidence : null) ??
      (typeof it?.score === "number" ? it.score : null);
    if (typeof c === "number") m.set(fid, c);
  }
  return m;
}
function buildTicketsFromCombined(combined) {
  const arr = Array.isArray(combined) ? combined : [];
  const buckets = { btts: [], ou25: [], fh_ou15: [], htft: [] };
  for (const it of arr) {
    const mk = String(it?.market_key ?? it?.market ?? it?.type ?? "").toLowerCase();
    const fid = it?.fixture_id ?? it?.id;
    if (typeof fid !== "number") continue;
    const confidence =
      (typeof it?.confidence_pct === "number" ? it.confidence_pct
        : (typeof it?.confidence === "number" ? it.confidence
        : (typeof it?.score === "number" ? it.score : 0)));
    const base = {
      id: fid,
      confidence_pct: confidence,
      kickoff: it?.kickoff ?? it?.start ?? it?.startTime,
      leagueId: it?.leagueId ?? it?.league?.id,
      league: it?.leagueName ?? it?.league,
      home: it?.home ?? it?.homeTeam,
      away: it?.away ?? it?.awayTeam
    };
    if (mk.includes("btts")) buckets.btts.push(base);
    else if (mk.includes("ou25") || mk.includes("over_2_5") || mk.includes("over25") || mk.includes("over 2.5")) buckets.ou25.push(base);
    else if (mk.includes("fh_ou15") || mk.includes("over15_ht") || mk.includes("over 1.5 ht") || mk.includes("ht over 1.5")) buckets.fh_ou15.push(base);
    else if (mk.includes("htft")) buckets.htft.push(base);
  }
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => (b.confidence_pct ?? 0) - (a.confidence_pct ?? 0));
    buckets[k] = buckets[k].slice(0, 4);
  }
  return buckets;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd  = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);

    let games = [];
    const locked = await kvGetSafe("vb-locked:kv:hit:games");
    if (Array.isArray(locked)) games = locked;

    let ids = [];
    if (!games.length) {
      const idList = await kvGetSafe("vb-locked:kv:hit");
      ids = uniqueIds(idList);
      if (!ids.length) {
        const chain = [`vbl_full:${ymd}:${slot}`, `vbl_full:${ymd}`, `vb:day:${ymd}:union`];
        for (const k of chain) {
          const v = await kvGetSafe(k);
          ids = uniqueIds(v);
          if (ids.length) break;
        }
      }
      if (ids.length) {
        const fixMap = await readFixturesBulk(ids);
        games = ids.map(id => {
          const v = fixMap.get(id) || {};
          return {
            id,
            home: v.home ?? v.homeTeam ?? null,
            away: v.away ?? v.awayTeam ?? null,
            league: v.leagueName ?? v.league ?? null,
            leagueId: v.leagueId ?? v.league?.id ?? null,
            kickoff: v.kickoff ?? v.start ?? v.startTime ?? null,
            homeTeam: v.home ?? v.homeTeam ?? null,
            awayTeam: v.away ?? v.awayTeam ?? null,
            leagueName: v.leagueName ?? v.league ?? null,
            start: v.kickoff ?? v.start ?? v.startTime ?? null,
            startTime: v.kickoff ?? v.start ?? v.startTime ?? null
          };
        });
      }
    }

    // filter by time window/league block
    games = games.filter(g => {
      const league = g.leagueName ?? g.league ?? null;
      if (league && isBlockedLeagueName(league)) return false;
      const lid = g.leagueId;
      if (typeof lid === "number" && BLOCKED_LEAGUE_IDS.includes(lid)) return false;
      if (g.kickoff && !inSlotWindow(g.kickoff, slot)) return false;
      return true;
    });

    // Confidence: prefer on item; else borrow from combined
    let haveAnyConfidence = games.some(g => typeof g.confidence_pct === "number" || typeof g.confidence === "number");
    let combined = [];
    let confMap = new Map();
    if (!haveAnyConfidence) {
      combined = await readCombined(ymd);
      confMap = confidenceMapFrom(combined);
      if (confMap.size) haveAnyConfidence = true;
    }
    const withConf = games.map(g => {
      let c = (typeof g.confidence_pct === "number" ? g.confidence_pct
            : (typeof g.confidence === "number" ? g.confidence
            : confMap.get(g.id)));
      if (typeof c !== "number") c = 0;
      return { ...g, confidence_pct: c };
    });

    // sort by confidence desc (tie: kickoff asc), pick top 15
    withConf.sort((a, b) => {
      const dc = (b.confidence_pct ?? 0) - (a.confidence_pct ?? 0);
      if (dc !== 0) return dc;
      return String(a.kickoff || "").localeCompare(String(b.kickoff || ""));
    });
    const picked = withConf.slice(0, 15);

    // odds for selected
    const oddsMap = await readOddsBulk(picked.map(x => x.id));
    const items = picked.map(g => {
      const odds = oddsMap.get(g.id) ?? null;
      return {
        id: g.id,
        leagueId: (typeof g.leagueId === "number") ? g.leagueId : null,
        home: g.home ?? g.homeTeam ?? undefined,
        away: g.away ?? g.awayTeam ?? undefined,
        league: g.league ?? g.leagueName ?? undefined,
        kickoff: g.kickoff ?? g.start ?? g.startTime ?? undefined,
        homeTeam: g.home ?? g.homeTeam ?? undefined,
        awayTeam: g.away ?? g.awayTeam ?? undefined,
        leagueName: g.league ?? g.leagueName ?? undefined,
        start: g.kickoff ?? g.start ?? g.startTime ?? undefined,
        startTime: g.kickoff ?? g.start ?? g.startTime ?? undefined,
        confidence_pct: g.confidence_pct,
        ...(odds ? { odds } : {})
      };
    });

    // tickets from snapshot or fallback from combined
    let tickets = await kvGetSafe(`tickets:${ymd}:${slot}`);
    if (!tickets || typeof tickets !== "object") {
      if (!combined.length) combined = await readCombined(ymd);
      tickets = buildTicketsFromCombined(combined);
    }

    const metaRaw = await kvGetSafe("vb-locked:kv:hit:meta");
    const nowIso = new Date().toISOString();
    const meta = {
      ymd, slot, source: "vb-locked:kv:hit",
      ts: metaRaw?.ts || nowIso,
      last_odds_refresh: metaRaw?.last_odds_refresh || nowIso,
      returned: items.length, cap: 15,
      sorted_by: "confidence_pct_desc",
      confidence_source: haveAnyConfidence ? (Array.isArray(locked) ? "locked-or-combined" : "combined") : "none"
    };

    return res.status(200).json({ items, ids: items.map(x => x.id), games: items, tickets, meta });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
