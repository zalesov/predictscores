// pages/api/odds-sports.js
// Bulk odds fetcher for The Odds API using separate budget and KV cache.
// Intended for internal cron use (prefetch), not user-triggered SSR.

const TOA = require("../../lib/sources/theOddsApi.js");
const KV_URL = process.env.UPSTASH_KV_REST_URL;
const KV_TOKEN = process.env.UPSTASH_KV_REST_TOKEN;

async function kv(cmd, ...args) {
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([cmd, ...args])
  });
  const data = await res.json();
  return data.result;
}

function ymdParam(req) {
  const { searchParams } = new URL(req.url);
  return (searchParams.get("ymd") || new Date().toISOString().slice(0,10));
}
function slotParam(req) {
  const { searchParams } = new URL(req.url);
  const s = (searchParams.get("slot") || "").toLowerCase();
  return ["late","am","pm"].includes(s) ? s : TOA.pickSlot();
}

export default async function handler(req, res) {
  try {
    const ymd = ymdParam(req);
    const slot = slotParam(req);
    const debug = new URL(req.url).searchParams.get("debug");

    const ensured = await TOA.ensureToaSnapshots(ymd, slot);
    const spent = await kv("GET", `toa:spent:${ymd}`);

    res.status(200).json({
      ok: true,
      ymd, slot,
      ensured,
      toa_spent: spent ? parseInt(spent, 10) : 0,
      markets: TOA.ODDS_API_MARKETS,
      regions: TOA.ODDS_API_REGIONS,
      sportKeys: TOA.ODDS_API_SPORT_KEYS,
      trusted_only: TOA.TRUSTED_ONLY
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
