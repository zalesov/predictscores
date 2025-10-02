// pages/api/value-bets-locked.js
// Returns up to 15 matches for the current slot: full cards + (if present) odds/edge.
// If locked full items are missing, it fills details from vb:fixture:<id> (KV cache only).
// Filters out Reserve/U/W leagues and respects slot windows. No external API calls.

import * as s from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Optional hard blacklist by league ID
const BLOCKED_LEAGUE_IDS = [
  // e.g.: 128, 71,
];

/* ---------------- utilities ---------------- */
function isBlockedLeagueName(name) {
  const n = String(name || "").toLowerCase();
  // crude filters: women/reserve/u-xx
  if (/\bu\d{2}\b/.test(n)) return true;
  if (/(women|femin|ladies|female)/i.test(name || "")) return true;
  if (/(reserve|reserves|b team|ii)$/.test(n)) return true;
  return false;
}
function hourInTZ(iso, tz = TZ) {
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d));
  } catch { return NaN; }
}
function inSlotWindow(iso, slot) {
  const h = hourInTZ(iso);
  if (!Number.isFinite(h)) return true;
  if (slot === "late") return h < 10;
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
function sanitizeYmd(x) {
  const s = String(x || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
function sanitizeSlot(x) {
  const s = String(x || "auto").toLowerCase();
  if (s === "late" || s === "am" || s === "pm") return s;
  // auto by Belgrade hour
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour:"2-digit", hour12:false }).format(new Date()));
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}

/* ---------------- robust KV readers ---------------- */
function oddsKvFallbackEnv() {
  // secondary backend used by refresh-odds writer in some deployments
  const url = (process.env.UPSTASH_KV_REST_URL || "").replace(/\/+$/,"");
  const token = process.env.UPSTASH_KV_REST_TOKEN || "";
  return (url && token) ? { url, token } : null;
}

async function kvPipelineDual(cmds) {
  // 1) primary via shared adapter
  try {
    const r = await s.kvPipeline(cmds);
    if (Array.isArray(r)) {
      // if at least one non-null, accept
      if (r.some(x => (x?.result ?? x?.value ?? null) != null)) return r;
    }
  } catch {}
  // 2) fallback: Upstash KV REST (if configured)
  const fb = oddsKvFallbackEnv();
  if (!fb) return null;
  try {
    const r = await fetch(`${fb.url}/pipeline`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${fb.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
      cache: "no-store"
    });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}

async function kvGetDual(key) {
  try {
    const v = await s.kvGet(key);
    if (v !== undefined && v !== null) return v;
  } catch {}
  const fb = oddsKvFallbackEnv();
  if (!fb) return null;
  try {
    const r = await fetch(`${fb.url}/get/${encodeURIComponent(key)}`, {
      headers: { "Authorization": `Bearer ${fb.token}` },
      cache: "no-store"
    });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return (j && (j.result ?? j.value)) ?? null;
  } catch { return null; }
}

/* Batch: read odds from KV (tries both backends) */
async function readOddsBulk(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cmds = ids.map(id => ["GET", `vb-odds:last:${id}`]);
  let resp = null;
  try { resp = await kvPipelineDual(cmds); } catch { resp = null; }
  if (Array.isArray(resp)) {
    ids.forEach((id, i) => {
      const payload = resp[i]?.result ?? resp[i]?.value ?? null;
      let parsed = null;
      if (payload && typeof payload === "string") { try { parsed = JSON.parse(payload); } catch { parsed = null; } }
      else if (payload && typeof payload === "object") { parsed = payload; }
      out.set(id, parsed ?? null);
    });
  }
  return out;
}

/* Batch: read fixture meta (home/away/league/kickoff) from KV */
async function readFixturesBulk(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cmds = ids.map(id => ["GET", `vb:fixture:${id}`]);
  let resp = null;
  try { resp = await s.kvPipeline(cmds); } catch { resp = null; }
  if (!Array.isArray(resp)) {
    // try fallback once
    resp = await kvPipelineDual(cmds);
  }
  if (Array.isArray(resp)) {
    ids.forEach((id, i) => {
      const v = resp[i]?.result ?? resp[i]?.value ?? null;
      if (v && typeof v === "object") out.set(id, v);
      else if (typeof v === "string") { try {
        const obj = JSON.parse(v);
        if (obj && typeof obj === "object") out.set(id, obj);
      } catch {} }
    });
  }
  return out;
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd  = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);

    // 1) Try locked games (full items with confidence if available)
    let games = [];
    try {
      const g = await s.kvGet("vb-locked:kv:hit:games");
      if (Array.isArray(g)) games = g;
    } catch {}

    // 2) If no full items, use ID list then fill details from vb:fixture:<id>
    let ids = [];
    if (!games.length) {
      try { ids = uniqueIds(await s.kvGet("vb-locked:kv:hit") || []); } catch { ids = []; }
      if (!ids.length) {
        const chain = [`vbl_full:${ymd}:${slot}`, `vbl_full:${ymd}`, `vb:day:${ymd}:union`];
        for (const k of chain) {
          try {
            const v = await s.kvGet(k);
            ids = uniqueIds(v);
            if (ids.length) break;
          } catch {}
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
            leagueId: v.leagueId ?? (v.league && v.league.id) ?? null,
            kickoff: v.kickoff ?? v.start ?? v.startTime ?? null,
            homeTeam: v.home ?? v.homeTeam ?? null,
            awayTeam: v.away ?? v.awayTeam ?? null,
            leagueName: v.leagueName ?? v.league ?? null,
            start: v.kickoff ?? v.start ?? v.startTime ?? null,
            startTime: v.kickoff ?? v.start ?? v.startTime ?? null,
          };
        });
      }
    }

    // 3) Filter by slot window + league blocks
    games = games.filter(g => {
      const league = g.leagueName ?? g.league ?? null;
      if (league && isBlockedLeagueName(league)) return false;
      const lid = g.leagueId;
      if (typeof lid === "number" && BLOCKED_LEAGUE_IDS.includes(lid)) return false;
      if (g.kickoff && !inSlotWindow(g.kickoff, slot)) return false;
      return true;
    });

    // 4) Odds from KV (no AF calls) + sort by kickoff
    const oddsMap = await readOddsBulk(games.map(g => g.id));
    games.sort((a,b)=> String(a.kickoff||"").localeCompare(String(b.kickoff||"")));

    // 5) Take first 15
    const picked = games.slice(0, 15).map(g => {
      const odds = oddsMap.get(g.id) ?? null;
      const obj = {
        id: g.id, leagueId: (typeof g.leagueId === "number") ? g.leagueId : null,
        home: g.home ?? g.homeTeam ?? undefined,
        away: g.away ?? g.awayTeam ?? undefined,
        league: g.league ?? g.leagueName ?? undefined,
        kickoff: g.kickoff ?? g.start ?? g.startTime ?? undefined,
        homeTeam: g.home ?? g.homeTeam ?? undefined,
        awayTeam: g.away ?? g.awayTeam ?? undefined,
        leagueName: g.league ?? g.leagueName ?? undefined,
        start: g.kickoff ?? g.start ?? g.startTime ?? undefined,
        startTime: g.kickoff ?? g.start ?? g.startTime ?? undefined
      };
      if (odds) obj.odds = odds;
      if (g.confidence_pct != null) obj.confidence_pct = g.confidence_pct;
      else if (g.confidence != null) obj.confidence = g.confidence;
      return obj;
    });

    // 6) Tickets (4×4): try primary KV then fallback KV
    let tickets = await s.kvGet(`tickets:${ymd}:${slot}`).catch(()=>null);
    if (!tickets) {
      const raw = await kvGetDual(`tickets:${ymd}:${slot}`);
      if (raw) {
        try { tickets = (typeof raw === "string") ? JSON.parse(raw) : raw; } catch { tickets = null; }
      }
    }
    if (!tickets || typeof tickets !== "object") {
      tickets = { btts:[], ou25:[], htft:[], fh_ou15:[] };
    }

    // 7) Meta
    const metaRaw = await s.kvGet("vb-locked:kv:hit:meta").catch(()=>null);
    const nowIso = new Date().toISOString();
    const meta = {
      ymd, slot, source:"vb-locked:kv:hit",
      ts: metaRaw?.ts || nowIso,
      last_odds_refresh: metaRaw?.last_odds_refresh || nowIso,
      returned: picked.length, cap: 15,
      fallback_used: false
    };

    return res.status(200).json({
      items: picked,
      ids: picked.map(x => x.id),
      games: picked,
      tickets,
      meta
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
