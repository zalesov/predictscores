// pages/api/insights-build.js
// Build tickets:<ymd>:<slot> with array guards (no crashes). KV-only.

import * as s from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function todayYmd() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
function sanitizeYmd(x) {
  const s0 = String(x || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s0) ? s0 : todayYmd();
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
function conf(it) {
  return (typeof it?.confidence_pct === "number" ? it.confidence_pct
    : (typeof it?.confidence === "number" ? it.confidence
    : (typeof it?.score === "number" ? it.score : 0)));
}
function byConfDesc(a,b){ return conf(b) - conf(a); }
function makeTickets(combined) {
  const out = { btts: [], ou25: [], fh_ou15: [], htft: [] };
  for (const it of toArray(combined)) {
    const mk = String(it?.market_key ?? it?.market ?? it?.type ?? "").toLowerCase();
    const row = {
      id: it?.fixture_id ?? it?.id,
      confidence_pct: conf(it),
      kickoff: it?.kickoff ?? it?.start ?? it?.startTime,
      leagueId: it?.leagueId ?? it?.league?.id,
      league: it?.leagueName ?? it?.league,
      home: it?.home ?? it?.homeTeam,
      away: it?.away ?? it?.awayTeam
    };
    if (typeof row.id !== "number") continue;
    if (mk.includes("btts")) out.btts.push(row);
    else if (mk.includes("ou25") || mk.includes("over_2_5") || mk.includes("over25") || mk.includes("over 2.5")) out.ou25.push(row);
    else if (mk.includes("fh_ou15") || mk.includes("over15_ht") || mk.includes("over 1.5 ht") || mk.includes("ht over 1.5")) out.fh_ou15.push(row);
    else if (mk.includes("htft")) out.htft.push(row);
  }
  for (const k of Object.keys(out)) {
    out[k].sort(byConfDesc);
    out[k] = out[k].slice(0, 4);
  }
  return out;
}

async function kvGetSafe(k){ try{ return await s.kvGet(k); }catch{ return null; } }
async function kvSetSafe(k,v){ try{ await s.kvSet(k,v); }catch{} }

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd  = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);
    const debug = String(req.query.debug || "") === "1";

    const combined = toArray(await kvGetSafe(`vb:day:${ymd}:combined`));
    const locked   = toArray(await kvGetSafe("vb-locked:kv:hit:games"));
    const vbl      = toArray(await kvGetSafe(`vbl_full:${ymd}:${slot}`));

    const tickets = makeTickets(combined);
    await kvSetSafe(`tickets:${ymd}:${slot}`, tickets);

    const out = { ok:true, wrote:`tickets:${ymd}:${slot}`, counts:{
      lockedGames: locked.length, combined: combined.length, vbl: vbl.length,
      btts: tickets.btts.length, ou25: tickets.ou25.length, fh_ou15: tickets.fh_ou15.length, htft: tickets.htft.length
    }};
    if (debug) out.debug = { ymd, slot, ts: new Date().toISOString() };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
