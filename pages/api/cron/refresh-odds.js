// pages/api/cron/refresh-odds.js
// Skupi kandidate (vbl_full -> union), expand-uj fixture-e (sa cap-om), izbaci Reserve/U/W i BLOCKED_LEAGUE_IDS,
// povuci kvote (AF odds) gde treba, izračunaj edge, rangiraj, napiši locked feed + reason logging.
// Poštuje per-slot cap: late ≤1000, am ≤2000, pm ≤3000.

import * as s from "../../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const API_HOST = "https://v3.football.api-sports.io";
const SLOT_CAPS = { late: 1000, am: 2000, pm: 3000 };

const BLOCKED_LEAGUE_IDS = [
  // dodaj ovde ID-eve liga koje želiš da sakriješ zauvek (hard blok)
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

function spentKey(ymd, slot){ return `afc:spent:${ymd}:${slot}`; }
async function getSpent(ymd, slot){ try { return Number(await s.kvGet(spentKey(ymd, slot)) || 0); } catch { return 0; } }
async function incSpent(ymd, slot, by=1){ try { await s.kvSet(spentKey(ymd, slot), String((await getSpent(ymd, slot))+by)); } catch {} }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

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

async function countedAF(url, ymd, slot, headers = {}) {
  const spent = await getSpent(ymd, slot);
  if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
  const r = await fetch(url, { headers: { "accept": "application/json", ...headers } });
  await incSpent(ymd, slot, 1);
  return r;
}

// Expand fixture (AF fixtures)
async function expandFixture(id, ymd, slot, apiKey) {
  const url = `${API_HOST}/fixtures?id=${id}&timezone=${encodeURIComponent(TZ)}`;
  const r = await countedAF(url, ymd, slot, { "x-apisports-key": apiKey });
  const data = await r.json();
  const row = Array.isArray(data?.response) ? data.response[0] : null;
  if (!row) return null;
  const leagueId = row?.league?.id ?? null;
  const league = row?.league?.name ?? null;
  const home = row?.teams?.home?.name ?? null;
  const away = row?.teams?.away?.name ?? null;
  const kickoff = row?.fixture?.date ?? null;

  if (!home || !away || !kickoff) return null;
  if (isBlockedLeagueName(league)) return null;
  if (typeof leagueId === "number" && BLOCKED_LEAGUE_IDS.includes(leagueId)) return null;

  const obj = {
    id, leagueId, league,
    home, away, kickoff,
    homeTeam: home, awayTeam: away, leagueName: league, start: kickoff, startTime: kickoff
  };
  // Keširaj radi apply-learning opcije
  try { await s.kvSet(`vb:fixture:${id}`, obj); } catch {}
  return obj;
}

// Odds (AF odds endpoint) – uzmi prvi raspoloživ "Match Winner" (1X2) market
function tryParseOddsAF(data) {
  // očekujemo data.response[0].bookmakers[].bets[].values[{value:"Home/Draw/Away", odd:"1.85"}]
  const resp = Array.isArray(data?.response) ? data.response : [];
  for (const bk of resp) {
    const bets = Array.isArray(bk?.bets) ? bk.bets : [];
    for (const bet of bets) {
      const name = sval(bet?.name || bet?.label || "").toLowerCase();
      if (!name) continue;
      if (name.includes("match") && (name.includes("winner") || name.includes("1x2") || name.includes("result"))) {
        const vals = Array.isArray(bet?.values) ? bet.values : [];
        let H = null, D = null, A = null;
        for (const v of vals) {
          const label = sval(v?.value || v?.label).toLowerCase();
          const o = Number(v?.odd ?? v?.odds ?? v?.price);
          if (!isFinite(o) || o <= 1.0) continue;
          if (label.includes("home") || label === "1") H = H ?? o;
          else if (label.includes("draw") || label === "x") D = D ?? o;
          else if (label.includes("away") || label === "2") A = A ?? o;
        }
        if (H || D || A) return { H, D, A, bookmaker: bk?.name || bk?.bookmaker };
      }
    }
  }
  return null;
}

async function fetchOddsAF(fixtureId, ymd, slot, apiKey) {
  const url = `${API_HOST}/odds?fixture=${fixtureId}`;
  const r = await countedAF(url, ymd, slot, { "x-apisports-key": apiKey });
  const data = await r.json();
  const parsed = tryParseOddsAF(data);
  return parsed; // može biti null
}

function implied(p) { return p > 0 ? (1 / p) : null; }

function edgeFromBaseline(odds) {
  if (!odds) return null;
  // bazne stope (globalne): možeš fino podešavati po ligi kasnije
  const BASE = { H: 0.45, D: 0.27, A: 0.28 };
  const iH = implied(odds.H), iD = implied(odds.D), iA = implied(odds.A);
  const probs = [iH, iD, iA].filter(x => x != null);
  if (!probs.length) return null;
  const sum = probs.reduce((a,b) => a+b, 0);
  const nH = iH != null ? iH / sum : null;
  const nD = iD != null ? iD / sum : null;
  const nA = iA != null ? iA / sum : null;

  const eH = nH != null ? (BASE.H - nH) : -Infinity;
  const eD = nD != null ? (BASE.D - nD) : -Infinity;
  const eA = nA != null ? (BASE.A - nA) : -Infinity;

  const arr = [{mkt:"H", edge:eH}, {mkt:"D", edge:eD}, {mkt:"A", edge:eA}].filter(x => isFinite(x.edge));
  if (!arr.length) return null;
  arr.sort((a,b)=>b.edge - a.edge);
  const best = arr[0];
  return { best: best.mkt, edge: Number(best.edge.toFixed(4)), probs: { H:nH, D:nD, A:nA } };
}

async function pickSources(ymd, slot) {
  const sources = [
    `vbl_full:${ymd}:${slot}`,
    `vbl_full:${ymd}`,
    `vb:day:${ymd}:union`,
  ];
  for (const k of sources) {
    try {
      const v = await s.kvGet(k);
      const ids = uniqueIds(v);
      if (ids.length) return { key: k, ids };
    } catch {}
  }
  return { key: null, ids: [] };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);

    const apiKey = (process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || "").trim();
    if (!apiKey) return res.status(200).json({ ok:false, error:"NO_API_FOOTBALL_KEY" });

    const src = await pickSources(ymd, slot);
    let ids = src.ids;

    // Expand dok ne sakupimo dovoljno kandidata za ovaj slot (poštujući cap)
    const toExpand = [...ids];
    const expanded = [];
    let spent = await getSpent(ymd, slot);
    const maxCallsLeft = Math.max(0, capFor(slot) - spent);

    while (toExpand.length && expanded.length < 60 && (await getSpent(ymd, slot)) < capFor(slot)) {
      const id = toExpand.shift();
      try {
        const fixture = await expandFixture(id, ymd, slot, apiKey);
        if (fixture && inSlotWindow(fixture.kickoff, slot)) expanded.push(fixture);
      } catch { /* ignore one-off */ }
    }

    // Rangiranje: prvo pokušaj da dodaš odds i edge
    const withOdds = [];
    const withoutOdds = [];

    for (const f of expanded) {
      // 1) probaj postojeći KV sa kvotama (bez trošenja cap)
      let odds = null;
      try {
        const fromKV = await s.kvGet(`vb-odds:last:${f.id}`);
        if (fromKV) odds = fromKV;
      } catch {}

      // 2) ako nema u KV, uzmi sa AF (troši cap)
      if (!odds && (await getSpent(ymd, slot)) < capFor(slot)) {
        try {
          const pulled = await fetchOddsAF(f.id, ymd, slot, apiKey);
          if (pulled) {
            odds = pulled;
            try { await s.kvSet(`vb-odds:last:${f.id}`, odds); } catch {}
          }
        } catch { /* ignore */ }
      }

      if (odds) {
        const ed = edgeFromBaseline(odds);
        withOdds.push({ ...f, odds, __edge: ed });
      } else {
        withoutOdds.push({ ...f, odds: null, __edge: null });
      }
    }

    // Sortiraj: prvo oni sa većim edge, pa po kickoff
    withOdds.sort((a,b)=>{
      const ea = a.__edge?.edge ?? -Infinity;
      const eb = b.__edge?.edge ?? -Infinity;
      if (eb !== ea) return eb - ea;
      return String(a.kickoff).localeCompare(String(b.kickoff));
    });
    withoutOdds.sort((a,b)=> String(a.kickoff).localeCompare(String(b.kickoff)));

    // Formiraj finalu listu: preferiraj sa odds; dopuni bez-odds do 15
    const primary = withOdds.slice(0, 15);
    let final = [...primary];
    if (final.length < 15) {
      final = final.concat(withoutOdds.slice(0, 15 - final.length));
    }

    // Ako posle svih filtera (Reserve/U/W + slot) ostane premalo, bezbedan fallback:
    // dopuni do minimuma 6 kom iz ostatka dana (ali i dalje bez Reserve/U/W i bez block ID)
    let fallback_used = false;
    if (final.length < 6) {
      const unionDay = uniqueIds(await s.kvGet(`vb:day:${ymd}:union`) || []);
      const extras = [];
      // pokušaćemo da nadjemo najbliže kickoffe iz pukog keša (vb:fixture:<id>) – bez trošenja cap-a
      for (const id of unionDay) {
        if (final.find(x => x.id === id)) continue;
        const row = await s.kvGet(`vb:fixture:${id}`).catch(()=>null);
        if (!row) continue;
        if (isBlockedLeagueName(row.leagueName || row.league)) continue;
        if (typeof row.leagueId === "number" && BLOCKED_LEAGUE_IDS.includes(row.leagueId)) continue;
        extras.push(row);
        if (final.length + extras.length >= 6) break;
      }
      if (extras.length) { final = final.concat(extras); fallback_used = true; }
    }

    // Upis locked feed-a (ID-evi + pune stavke + meta) + reason logging
    const idsOut = final.map(x => x.id);
    const gamesOut = final.map((x, i) => {
      const base = { id: x.id, home: x.home, away: x.away, league: x.league, leagueId: x.leagueId,
        kickoff: x.kickoff, homeTeam: x.homeTeam, awayTeam: x.awayTeam, leagueName: x.leagueName,
        start: x.start, startTime: x.startTime };
      if (x.odds) base.odds = x.odds;
      if (x.__edge) base.edge = x.__edge;
      return base;
    });

    const meta = { ymd, slot, ts: new Date().toISOString(), last_odds_refresh: new Date().toISOString() };
    await s.kvSet("vb-locked:kv:hit", idsOut);
    await s.kvSet("vb-locked:kv:hit:games", gamesOut);
    await s.kvSet("vb-locked:kv:hit:meta", meta);

    // Reason logging po fixture-u
    for (let i = 0; i < gamesOut.length; i++) {
      const g = gamesOut[i];
      const reason = {
        ymd, slot, rank: i+1,
        league: g.leagueName || g.league, leagueId: g.leagueId ?? null,
        kickoff: g.kickoff,
        oddsOk: !!g.odds,
        edge: g.edge ?? null,
        source: "refresh-odds"
      };
      try { await s.kvSet(`vb:explain:${ymd}:${g.id}`, reason); } catch {}
    }

    // Telemetrija cap-a
    try {
      await s.kvSet(`afc:log:${ymd}:${slot}`, {
        ts: meta.ts, spent: await getSpent(ymd, slot), picked: idsOut.length,
        sourceKey: src.key, withOdds: withOdds.length, withoutOdds: withoutOdds.length, fallback_used
      });
    } catch {}

    return res.status(200).json({ ok: true, ymd, slot, cap: capFor(slot), spent: await getSpent(ymd, slot), note: "refresh-odds (cap enforced)" });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
