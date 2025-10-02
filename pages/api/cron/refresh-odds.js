// pages/api/cron/refresh-odds.js
// Održava kvote: prvo API-Football (postojeća logika), potom The Odds API fallback (backup, strogo limitiran)

import { NextResponse } from "next/server"; // for edge runtime, if you're using it; else ignore
// Ako nisi na edge, možeš koristiti standardni res.status/json

const KV_URL = process.env.UPSTASH_KV_REST_URL;
const KV_TOKEN = process.env.UPSTASH_KV_REST_TOKEN;
const TZ_DISPLAY = process.env.TZ_DISPLAY || "Europe/Belgrade";

// --- Local KV helpers (REST) ---
async function kv(cmd, ...args) {
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([cmd, ...args])
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`KV ${cmd} failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.result;
}
async function kvGet(key) { return await kv("GET", key); }
async function kvSet(key, val, ttlSec) {
  if (ttlSec) return await kv("SET", key, typeof val === "string" ? val : JSON.stringify(val), "EX", ttlSec);
  return await kv("SET", key, typeof val === "string" ? val : JSON.stringify(val));
}
async function kvExpire(key, ttlSec) { return await kv("EXPIRE", key, ttlSec); }

// --- Helpers ---
function ymdParam(request) {
  const { searchParams } = new URL(request.url);
  return (searchParams.get("ymd") || new Date().toISOString().slice(0,10));
}
function slotParam(request) {
  const { searchParams } = new URL(request.url);
  const s = (searchParams.get("slot") || "").toLowerCase();
  return ["late","am","pm"].includes(s) ? s : "am";
}
function hoursFromNow(iso) { return (new Date(iso).getTime() - Date.now())/3600000; }
function isWithinSlotWindow(iso, slot) {
  // limit refreshing only for next ~6h to save budget
  const h = hoursFromNow(iso);
  return h >= -0.5 && h <= 6;
}

// --- The Odds API helper (backup) ---
const TOA = require("../../../lib/sources/theOddsApi.js");

// --- AF (primary) odds fetcher (stub: keep your existing logic!) ---
async function fetchAfOddsForFixture(fixture) {
  // Ostavite vašu postojeću AF logiku:
  // - čitanje iz keša ako je sveže
  // - ako nije, poziv ka AF i upis u vb-odds:last:<id>
  // Ovde samo probamo da pročitamo već postojeći AF zapis:
  const raw = await kvGet(`vb-odds:last:${fixture.id}`);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    // očekujemo { home, draw, away, ts, source: "AF" }
    if (obj && obj.source === "AF") return obj;
    // Ako nema meta, i dalje može biti validno
    return obj;
  } catch { return null; }
}

async function writeOdds(id, payload) {
  // payload: { home, draw, away, ts, source }
  await kvSet(`vb-odds:last:${id}`, JSON.stringify(payload));
  await kvSet(`vb-odds:last-meta:${id}`, JSON.stringify({ source: payload.source, ts: payload.ts, bookmaker: payload.bookmaker || null, reason: payload.reason || null }));
}

// --- Source data (fixtures to refresh) ---
async function readVbList(ymd, slot) {
  // prefer vbl_full (apply-learning), else fall back to union
  let ids = [];
  const vbl = await kvGet(`vbl_full:${ymd}:${slot}`);
  if (vbl) {
    try {
      const arr = JSON.parse(vbl);
      if (Array.isArray(arr)) ids = arr;
    } catch {}
  }
  if (!ids.length) {
    const u = await kvGet(`vb:day:${ymd}:union`);
    if (u) { try {
      const arr = JSON.parse(u);
      if (Array.isArray(arr)) ids = arr;
    } catch {} }
  }
  // Hard cap: refresh odds only for those with kickoff in next hours, but we need fixture meta; try to expand from `value-bets-locked` if available
  const slim = await kvGet(`vb-locked:kv:hit:${ymd}:${slot}`);
  let expanded = [];
  if (slim) { try {
    const obj = JSON.parse(slim);
    // could be object with items or just array
    const items = obj.items || obj.games || obj.ids || obj;
    const list = Array.isArray(items) ? items : [];
    for (const it of list) {
      if (typeof it === "number") expanded.push({ id: it });
      else if (it && typeof it === "object") expanded.push({ id: it.id, home: it.home || it.homeTeam, away: it.away || it.awayTeam, league: it.league || it.leagueName, kickoff: it.kickoff || it.start || it.startTime, leagueId: it.leagueId || null });
    }
  } catch {} }
  // Merge info: ensure at least IDs present
  if (!expanded.length) expanded = ids.map(id => ({ id }));
  return expanded.slice(0, 50); // safety
}

// --- API handler ---
export default async function handler(req, res) {
  try {
    const ymd = ymdParam(req);
    const slot = slotParam(req);
    const debug = new URL(req.url).searchParams.get("debug");

    // 1) Skupi listu kandidata
    const fixtures = await readVbList(ymd, slot);

    // 2) Pokušaj AF kvote ili postojeći zapis
    const results = [];
    for (const fx of fixtures) {
      const af = await fetchAfOddsForFixture(fx);
      if (af && af.home != null) {
        results.push({ id: fx.id, source: "AF" });
        continue;
      }
      results.push({ id: fx.id, source: null });
    }

    // 3) TheOdds snapshot ensure (prefetch per slot, once)
    //    - radi se samo ako imamo makar jedan “prazan” fixture u narednih ~6h
    const needToa = fixtures.some((fx, i) => {
      if (!results[i] || results[i].source) return false;
      if (!fx.kickoff) return true; // ako ne znamo kickoff, možda nam treba
      return isWithinSlotWindow(fx.kickoff, slot);
    });

    if (needToa) {
      const ensured = await TOA.ensureToaSnapshots(ymd, slot);
      // ako budget exhausted, nastavićemo bez TOA
    }

    // 4) Popuni praznine iz TOA keša (bez novih poziva)
    for (let i = 0; i < fixtures.length; i++) {
      if (results[i].source) continue; // već imamo AF
      const fx = fixtures[i];
      const found = await TOA.findOddsForFixtureFromSnapshots(ymd, fx);
      if (found && found.h2h) {
        const pay = {
          home: found.h2h.home ?? null,
          draw: found.h2h.draw ?? null,
          away: found.h2h.away ?? null,
          bookmaker: found.bookmaker || null,
          ts: new Date().toISOString(),
          source: "TOA",
          reason: "af_missing_or_stale→toa_cache"
        };
        await writeOdds(fx.id, pay);
        results[i].source = "TOA";
      }
    }

    // 5) Ako i dalje postoje praznine i postoji budžet, uradi JEDAN bulk poziv (osveži keš) pa pokušaj opet
    if (results.some(r => !r.source)) {
      // pokušaj "once per slot" je već urađen u ensureToaSnapshots; ovde pokušamo drugi region/sportKey samo ako budžet dozvoli
      // (ostavljamo minimalizam — već imamo ensure)
      // drugi pokušaj: ništa; rely na sledeći slot ili AF kvote
    }

    const cap = (slot === "late") ? 1000 : (slot === "am" ? 2000 : 3000);
    const spentToa = await kvGet(`toa:spent:${ymd}`);

    const payload = {
      ok: true,
      ymd, slot,
      note: "refresh-odds (AF primary + TOA backup)",
      refreshed: results.filter(r => r.source).length,
      empty: results.filter(r => !r.source).map(x => x.id).slice(0, 20),
      toa_spent: spentToa ? parseInt(spentToa, 10) : 0,
      cap
    };

    if (debug) {
      res.status(200).json(payload);
    } else {
      res.status(200).json({ ok: true, ymd, slot, cap, note: "refresh-odds (cap enforced)" });
    }
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
