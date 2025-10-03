// pages/api/cron/refresh-odds.js
// FIX: use today's vbl_full:<ymd>:<slot> as primary candidates (union with locked IDs).
// Keeps TOA budget (default 10/day) and AF quotas unchanged. No new ENV.

import * as s from "../../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const ODDS_BASE = "https://api.the-odds-api.com/v4"; // no new ENV needed
const ODDS_KEY  = process.env.ODDS_API_KEY || "";
const ODDS_REGION = (process.env.ODDS_API_REGIONS || "eu").split(",")[0].trim() || "eu";
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
function uniqNums(arr) { return [...new Set(toArray(arr).map(x => typeof x === "number" ? x : x?.id).filter(n => typeof n === "number"))]; }
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
  if (SPORTS_ENV) return SPORTS_ENV.split(",").map(s => s.trim()).filter(Boolean).slice(0, 10);
  try {
    const list = await fetchJson(`${ODDS_BASE}/sports?apiKey=${encodeURIComponent(ODDS_KEY)}&all=true`);
    const keys = toArray(list).map(x => x?.key).filter(k => typeof k === "string" && k.startsWith("soccer_"));
    return keys.slice(0, 10);
  } catch {
    return ["soccer_epl","soccer_uefa_champs_league"];
  }
}

function bestH2HPrices(bookmakers) {
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

    // ---- PRIMARY CANDIDATES: today's vbl_full:<ymd>:<slot> ----
    const vblSlot = uniqNums(await kvGetSafe(`vbl_full:${ymd}:${slot}`));
    // ---- UNION with locked IDs (if present) ----
    const lockedIds = uniqNums(await kvGetSafe("vb-locked:kv:hit"));
    const ids = uniqNums([...(vblSlot || []), ...(lockedIds || [])]);

    // Build fixture meta map for name/time matching
    const fixMap = new Map();
    if (ids.length) {
      const pipeline = ids.map(id => ["GET", `vb:fixture:${id}`]);
      let resp = null;
      try { resp = await s.kvPipeline(pipeline); } catch {
        resp = await Promise.all(pipeline.map(async ([,k]) => ({ result: await kvGetSafe(k) })));
      }
      ids.forEach((id,i) => {
        const v = resp?.[i]?.result ?? resp?.[i]?.value ?? null;
        if (v && typeof v === "object") fixMap.set(id, {
          home: v.home ?? v.homeTeam, away: v.away ?? v.awayTeam,
          kickoff: v.kickoff ?? v.start ?? v.startTime
        });
      });
    }

    // ---- TOA call budget (unchanged: default 10/day) ----
    const limitKey = `toa:limit:${ymd}`;
    const spentKey = `toa:spent:${ymd}`;
    const limit = Number(await kvGetSafe(limitKey)) || Number(process.env.ODDS_API_DAILY_BUDGET) || 10;
    const spent = Number(await kvGetSafe(spentKey)) || 0;
    let remaining = Math.max(0, limit - spent);

    let sports = [];
    if (ODDS_KEY) sports = await deriveSoccerSportKeys();
    const willCall = Math.min(remaining, sports.length);

    const matchedIds = new Set();

    if (ODDS_KEY && willCall > 0 && fixMap.size) {
      for (let i = 0; i < willCall; i++) {
        const sport = sports[i];
        const url = `${ODDS_BASE}/sports/${encodeURIComponent(sport)}/odds?regions=${encodeURIComponent(ODDS_REGION)}&markets=h2h&apiKey=${encodeURIComponent(ODDS_KEY)}`;
        let data = [];
        try { data = await fetchJson(url); }
        catch (e) { if (debug) console.error("TOA fetch error", sport, String(e)); continue; }

        for (const ev of toArray(data)) {
          const ht = normTeam(ev?.home_team), at = normTeam(ev?.away_team);
          const when = ev?.commence_time || ev?.commence_time_iso || ev?.start_time;
          if (!ht || !at || !when) continue;

          for (const [fid, meta] of fixMap.entries()) {
            if (matchedIds.has(fid)) continue;
            const mh = normTeam(meta?.home), ma = normTeam(meta?.away);
            if (!mh || !ma) continue;
            if (!sameDayISO(when, meta?.kickoff)) continue;

            const forward = (ht.includes(mh) && at.includes(ma)) || (mh.includes(ht) && ma.includes(at));
            const reverse = (ht.includes(ma) && at.includes(mh)) || (ma.includes(ht) && mh.includes(at));
            if (!forward && !reverse) continue;

            const best = bestH2HPrices(ev?.bookmakers);
            await kvSetSafe(`vb-odds:last:${fid}`, best);
            matchedIds.add(fid);
          }
        }

        // spend one TOA call
        remaining = Math.max(0, remaining - 1);
        await kvSetSafe(spentKey, (Number(await kvGetSafe(spentKey)) || 0) + 1);
        if (remaining <= 0) break;
      }
    }

    // Stamp meta
    const metaKey = "vb-locked:kv:hit:meta";
    const meta = await kvGetSafe(metaKey) || {};
    meta.last_odds_refresh = new Date().toISOString();
    await kvSetSafe(metaKey, meta);

    const wrote = matchedIds.size;
    const newSpent = Number(await kvGetSafe(spentKey)) || 0;
    const out = {
      ok: true, ymd, slot,
      candidates: ids.length,
      wrote,
      toa: { limit, spent: newSpent, remaining: Math.max(0, limit - newSpent) }
    };
    if (debug) out.debug = { sports, region: ODDS_REGION };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
