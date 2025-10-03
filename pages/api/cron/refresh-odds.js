// pages/api/cron/refresh-odds.js
// FIX: no "Invalid URL". Uses existing KV envs (KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN).
// PURPOSE: Populate vb-odds:last:<fixtureId> by reusing your existing snapshot flow (TOA bulk) without
// changing budgets. We cap TOA calls with KV counters (default 10/day).
// NOTE: This file only hardens URL construction and KV usage; it does not increase call volume.

import * as s from "../../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const ODDS_BASE = "https://api.the-odds-api.com/v4"; // no new ENV needed
const ODDS_KEY  = process.env.ODDS_API_KEY || "";    // you already have this

// region/sports: use env if present, else safe defaults (keeps volume tiny)
const ODDS_REGION = (process.env.ODDS_API_REGIONS || "eu").split(",")[0].trim() || "eu";
// If you already define ODDS_API_SPORT_KEYS, we'll honor it; else we derive soccer_* list from /sports (1 call)
const SPORTS_ENV = (process.env.ODDS_API_SPORT_KEYS || "").trim();

function ymdToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
function sanitizeYmd(x) {
  const s0 = String(x || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s0) ? s0 : ymdToday();
}
function sanitizeSlot(x) {
  const s = String(x || "auto").toLowerCase();
  if (s === "late" || s === "am" || s === "pm") return s;
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}
function toArray(x) { return Array.isArray(x) ? x : []; }
function normTeam(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.'\-]/g, "")
    .trim();
}
function sameDayISO(a, b) {
  try {
    const da = new Date(a), db = new Date(b);
    return da.getUTCFullYear()===db.getUTCFullYear() && da.getUTCMonth()===db.getUTCMonth() && da.getUTCDate()===db.getUTCDate();
  } catch { return false; }
}
async function kvGetSafe(k){ try{ return await s.kvGet(k); }catch{ return null; } }
async function kvSetSafe(k,v){ try{ await s.kvSet(k,v); }catch{} }
async function kvIncrSafe(k,delta=1){ try{ const val=Number(await s.kvGet(k))||0; await s.kvSet(k,val+delta); return val+delta; }catch{ return 0; } }

async function fetchJson(url) {
  const r = await fetch(url, { method: "GET", headers: { "accept": "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function deriveSoccerSportKeys() {
  // If you have ODDS_API_SPORT_KEYS defined, use it; else query /sports once and pick soccer_* keys
  if (SPORTS_ENV) {
    return SPORTS_ENV.split(",").map(s => s.trim()).filter(Boolean).slice(0, 10);
  }
  try {
    const list = await fetchJson(`${ODDS_BASE}/sports?apiKey=${encodeURIComponent(ODDS_KEY)}&all=true`);
    const keys = toArray(list).map(x => x?.key).filter(k => typeof k === "string" && k.startsWith("soccer_"));
    // Keep it small (<=10) to respect your budget
    return keys.slice(0, 10);
  } catch {
    // Fallback to a tiny representative subset
    return ["soccer_epl","soccer_uefa_champs_league"];
  }
}

function bestH2HPrices(bookmakers) {
  // Reduce all bookmakers/markets to best home/draw/away prices
  const out = { home:null, draw:null, away:null, source:"toa" };
  for (const bk of toArray(bookmakers)) {
    for (const mk of toArray(bk?.markets)) {
      if ((mk?.key || mk?.name)?.toLowerCase().includes("h2h")) {
        for (const oc of toArray(mk?.outcomes)) {
          const name = String(oc?.name || "").toLowerCase();
          const price = oc?.price;
          if (typeof price !== "number") continue;
          if (name.includes("home") || name.includes("h")) out.home = Math.max(out.home ?? -Infinity, price);
          else if (name.includes("away") || name.includes("a")) out.away = Math.max(out.away ?? -Infinity, price);
          else if (name.includes("draw") || name.includes("x")) out.draw = Math.max(out.draw ?? -Infinity, price);
        }
      }
    }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const ymd  = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);
    const debug = String(req.query.debug || "") === "1";

    // --- candidate fixture ids for today/slot ---
    let ids = [];
    const lockedIds = await kvGetSafe("vb-locked:kv:hit");
    if (Array.isArray(lockedIds)) ids = [...new Set(lockedIds.map(x => (typeof x === "number" ? x : x?.id)).filter(n => typeof n === "number"))];
    if (!ids.length) {
      const chain = [`vbl_full:${ymd}:${slot}`, `vbl_full:${ymd}`, `vb:day:${ymd}:union`];
      for (const k of chain) {
        const v = await kvGetSafe(k);
        if (Array.isArray(v) && v.length) { ids = [...new Set(v.map(x => (typeof x === "number" ? x : x?.id)).filter(n => typeof n === "number"))]; break; }
      }
    }

    // Map fixtureId -> minimal meta for name/time matching
    const fixMap = new Map();
    if (ids.length) {
      const cmds = ids.map(id => ["GET", `vb:fixture:${id}`]);
      const resp = await (async () => {
        try { return await s.kvPipeline(cmds); } catch { // degrade
          return await Promise.all(cmds.map(async ([,k]) => ({ result: await kvGetSafe(k) })));
        }
      })();
      ids.forEach((id,i) => {
        const v = resp?.[i]?.result ?? resp?.[i]?.value ?? null;
        if (v && typeof v === "object") fixMap.set(id, {
          home: v.home ?? v.homeTeam, away: v.away ?? v.awayTeam,
          kickoff: v.kickoff ?? v.start ?? v.startTime
        });
      });
    }

    // --- TOA budget counters in KV (default 10/day) ---
    const limitKey = `toa:limit:${ymd}`;
    const spentKey = `toa:spent:${ymd}`;
    const limit = Number(await kvGetSafe(limitKey)) || Number(process.env.ODDS_API_DAILY_BUDGET) || 10;
    const spent = Number(await kvGetSafe(spentKey)) || 0;
    let remaining = Math.max(0, limit - spent);

    let sports = [];
    if (ODDS_KEY) sports = await deriveSoccerSportKeys(); // small list (<=10)
    const willCall = Math.min(remaining, sports.length);

    const matchesWritten = [];
    if (ODDS_KEY && willCall > 0 && fixMap.size) {
      // Fetch odds per sport (bulk), limited by remaining budget
      for (let i = 0; i < willCall; i++) {
        const sport = sports[i];
        // 1 call = 1 sport snapshot
        const url = `${ODDS_BASE}/sports/${encodeURIComponent(sport)}/odds?regions=${encodeURIComponent(ODDS_REGION)}&markets=h2h&apiKey=${encodeURIComponent(ODDS_KEY)}`;
        let data = [];
        try { data = await fetchJson(url); }
        catch (e) { if (debug) console.error("TOA fetch error", sport, String(e)); continue; }

        // For each event, try to match to our fixtures by name + same day
        for (const ev of toArray(data)) {
          const ht = normTeam(ev?.home_team), at = normTeam(ev?.away_team);
          const when = ev?.commence_time || ev?.commence_time_iso || ev?.start_time;
          if (!ht || !at || !when) continue;

          for (const [fid, meta] of fixMap.entries()) {
            const mh = normTeam(meta?.home), ma = normTeam(meta?.away);
            if (!mh || !ma) continue;
            if (!sameDayISO(when, meta?.kickoff)) continue;
            // simple team match (order-agnostic just in case)
            const forward = (ht.includes(mh) && at.includes(ma)) || (mh.includes(ht) && ma.includes(at));
            const reverse = (ht.includes(ma) && at.includes(mh)) || (ma.includes(ht) && mh.includes(at));
            if (!forward && !reverse) continue;

            const best = bestH2HPrices(ev?.bookmakers);
            // write vb-odds:last:<fid>
            await kvSetSafe(`vb-odds:last:${fid}`, best);
            matchesWritten.push(fid);
          }
        }
        // track calls
        remaining = Math.max(0, remaining - 1);
        await kvSetSafe(spentKey, (Number(await kvGetSafe(spentKey)) || 0) + 1);
        if (remaining <= 0) break;
      }
    }

    // Stamp meta for visibility
    const metaKey = "vb-locked:kv:hit:meta";
    const meta = await kvGetSafe(metaKey) || {};
    meta.last_odds_refresh = new Date().toISOString();
    await kvSetSafe(metaKey, meta);

    const out = {
      ok: true,
      ymd, slot,
      candidates: ids.length,
      wrote: [...new Set(matchesWritten)].length,
      toa: { limit, spent: (Number(await kvGetSafe(spentKey)) || 0), remaining: Math.max(0, limit - (Number(await kvGetSafe(spentKey)) || 0)) }
    };
    if (debug) out.debug = { sports, region: ODDS_REGION };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
