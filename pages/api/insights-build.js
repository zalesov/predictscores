// pages/api/insights-build.js
// PURPOSE: Build and store tickets:<ymd>:<slot> based on existing KV sources.
// Safe-guards: coalesce any undefined arrays to [] so we never throw on ".length".
// No external API calls; budgets unchanged.

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

function byConfidenceDesc(a, b) {
  const ca = (typeof a?.confidence_pct === "number" ? a.confidence_pct
           : (typeof a?.confidence === "number" ? a.confidence
           : (typeof a?.score === "number" ? a.score : 0)));
  const cb = (typeof b?.confidence_pct === "number" ? b.confidence_pct
           : (typeof b?.confidence === "number" ? b.confidence
           : (typeof b?.score === "number" ? b.score : 0)));
  return cb - ca;
}

function mkTicketBuckets(fromCombined) {
  const out = { btts: [], ou25: [], fh_ou15: [], htft: [] };
  for (const it of toArray(fromCombined)) {
    const mk = String(it?.market_key ?? it?.market ?? it?.type ?? "").toLowerCase();
    const base = {
      id: it?.fixture_id ?? it?.id,
      confidence_pct:
        (typeof it?.confidence_pct === "number" ? it.confidence_pct
          : (typeof it?.confidence === "number" ? it.confidence
          : (typeof it?.score === "number" ? it.score : 0))),
      kickoff: it?.kickoff ?? it?.start ?? it?.startTime,
      leagueId: it?.leagueId ?? it?.league?.id,
      league: it?.leagueName ?? it?.league,
      home: it?.home ?? it?.homeTeam,
      away: it?.away ?? it?.awayTeam
    };
    if (typeof base.id !== "number") continue;

    if (mk.includes("btts")) out.btts.push(base);
    else if (mk.includes("ou25") || mk.includes("over_2_5") || mk.includes("over25") || mk.includes("over 2.5")) out.ou25.push(base);
    else if (mk.includes("fh_ou15") || mk.includes("over15_ht") || mk.includes("over 1.5 ht") || mk.includes("ht over 1.5")) out.fh_ou15.push(base);
    else if (mk.includes("htft")) out.htft.push(base);
  }
  // rank & cap to 4 each
  for (const k of Object.keys(out)) {
    out[k].sort(byConfidenceDesc);
    out[k] = out[k].slice(0, 4);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd  = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);
    const debug = String(req.query.debug || "") === "1";

    // Sources (KV only). Any of these can be missing; coalesce to [].
    const lockedGames = toArray(await s.kvGet("vb-locked:kv:hit:games"));
    const combined    = toArray(await s.kvGet(`vb:day:${ymd}:combined`));
    const vblSlot     = toArray(await s.kvGet(`vbl_full:${ymd}:${slot}`));

    // Prefer combined to build tickets (carries market info).
    const tickets = mkTicketBuckets(combined);

    // Write snapshot
    await s.kvSet(`tickets:${ymd}:${slot}`, tickets);

    const out = { ok: true, wrote: `tickets:${ymd}:${slot}`, counts: {
      lockedGames: lockedGames.length, combined: combined.length, vbl: vblSlot.length,
      btts: tickets.btts.length, ou25: tickets.ou25.length, fh_ou15: tickets.fh_ou15.length, htft: tickets.htft.length
    }};

    if (debug) out.debug = { ymd, slot, ts: new Date().toISOString() };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
