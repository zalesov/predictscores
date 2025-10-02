// lib/sources/theOddsApi.js
// The Odds API (backup) helper – odvojen budžet i keš (Upstash REST), bez @vercel/kv

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_DAILY_BUDGET = parseInt(process.env.ODDS_API_DAILY_BUDGET || "10", 10);
const ODDS_API_REGIONS = (process.env.ODDS_API_REGIONS || "eu").split(",").map(s => s.trim()).filter(Boolean);
const ODDS_API_MARKETS = (process.env.ODDS_API_MARKETS || "h2h").split(",").map(s => s.trim()).filter(Boolean);
const ODDS_API_SPORT_KEYS = (process.env.ODDS_API_SPORT_KEYS || "soccer_epl,soccer_spain_la_liga,soccer_italy_serie_a,soccer_germany_bundesliga,soccer_france_ligue_one").split(",").map(s => s.trim()).filter(Boolean);

const TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "0") === "1";
const TRUSTED_BOOKIES = (process.env.TRUSTED_BOOKIES || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// --- Upstash KV REST (no @vercel/kv) ---
const KV_URL = process.env.UPSTASH_KV_REST_URL;
const KV_TOKEN = process.env.UPSTASH_KV_REST_TOKEN;

async function kv(cmd, ...args) {
  if (!KV_URL || !KV_TOKEN) throw new Error("Upstash KV env missing");
  const body = JSON.stringify([cmd, ...args]);
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json"
    },
    body
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`KV ${cmd} failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.result;
}

async function kvGet(key) {
  const v = await kv("GET", key);
  return v ?? null;
}

async function kvSet(key, value, ttlSec) {
  if (ttlSec) {
    return await kv("SET", key, typeof value === "string" ? value : JSON.stringify(value), "EX", ttlSec);
  }
  return await kv("SET", key, typeof value === "string" ? value : JSON.stringify(value));
}

async function kvIncrBy(key, n) {
  const res = await kv("INCRBY", key, n);
  return res; // number
}

async function kvExpireAtEndOfDay(key, ymd) {
  // expire at 23:59:59 Europe/Belgrade for given ymd
  // compute seconds until end-of-day from now (approx; OK for our use)
  const now = new Date();
  const [Y, M, D] = ymd.split("-").map(Number);
  const end = new Date(Date.UTC(Y, M - 1, D, 23, 59, 59));
  const ttlSec = Math.max(60, Math.floor((end.getTime() - now.getTime()) / 1000));
  await kv("EXPIRE", key, ttlSec);
}

function ymdFromIso(iso) {
  return (iso || new Date().toISOString()).slice(0, 10);
}

function normTeamName(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/\b(fc|cf|sc|afc|u\d\d|u\d)\b/g, "")      // common suffixes
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function minutesDiff(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 60000);
}

function withinKickoffWindow(aIso, bIso, windowMin = 120) {
  return minutesDiff(aIso, bIso) <= windowMin;
}

function pickSlot(date = new Date()) {
  const h = date.getHours();
  if (h < 10) return "late";  // posle ponoći do 10h
  if (h < 15) return "am";    // 10–15h
  return "pm";                // 15+ h
}

// --- Budget helpers (TOA only, strictly separated) ---
async function toaLimitFor(ymd) {
  let lim = await kvGet(`toa:limit:${ymd}`);
  if (lim == null) {
    lim = ODDS_API_DAILY_BUDGET;
    await kvSet(`toa:limit:${ymd}`, String(lim));
    await kvExpireAtEndOfDay(`toa:limit:${ymd}`, ymd);
  } else {
    lim = parseInt(lim, 10) || ODDS_API_DAILY_BUDGET;
  }
  return lim;
}

async function toaSpentFor(ymd) {
  const v = await kvGet(`toa:spent:${ymd}`);
  return v == null ? 0 : parseInt(v, 10);
}

async function toaBudgetAllowed(ymd, cost = 1) {
  const [lim, spent] = await Promise.all([toaLimitFor(ymd), toaSpentFor(ymd)]);
  return (spent + cost) <= lim;
}

async function toaBudgetConsume(ymd, cost = 1) {
  if (!(await toaBudgetAllowed(ymd, cost))) {
    return { allowed: false, spent: await toaSpentFor(ymd), limit: await toaLimitFor(ymd) };
  }
  const newSpent = await kvIncrBy(`toa:spent:${ymd}`, cost);
  await kvExpireAtEndOfDay(`toa:spent:${ymd}`, ymd);
  return { allowed: true, spent: newSpent, limit: await toaLimitFor(ymd) };
}

// --- Snapshots ---
function snapKey(ymd, sportKey, markets, region) {
  return `toa:snap:${ymd}:${sportKey}:${markets}:${region}`;
}

async function getToaSnapshot(ymd, sportKey, markets, region) {
  const raw = await kvGet(snapKey(ymd, sportKey, markets, region));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function putToaSnapshot(ymd, sportKey, markets, region, payload, ttlSec = 3 * 3600) {
  await kvSet(snapKey(ymd, sportKey, markets, region), JSON.stringify(payload), ttlSec);
}

async function getSlotSig(ymd, slot) {
  return await kvGet(`toa:sig:${ymd}:${slot}`);
}
async function setSlotSig(ymd, slot) {
  await kvSet(`toa:sig:${ymd}:${slot}`, new Date().toISOString());
  await kvExpireAtEndOfDay(`toa:sig:${ymd}:${slot}`, ymd);
}

// --- The Odds API fetch (bulk) ---
async function fetchToaBulk({ sportKey, regions, markets, dateFilterISO }) {
  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY missing");
  // v4: /v4/sports/{sport_key}/odds/?regions=eu&markets=h2h&dateFormat=iso
  const params = new URLSearchParams();
  params.set("apiKey", ODDS_API_KEY);
  params.set("regions", regions);
  params.set("markets", markets);
  params.set("dateFormat", "iso");
  // optional: dateFilterISO (kickoff) – The Odds API nema striktnu "date" ali vraća tekuće i buduće evente; filter radi lokalno
  const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/odds?${params.toString()}`;

  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`TOA fetch failed ${res.status}: ${t}`);
  }
  const json = await res.json();
  // json je niz eventa; svaki ima {id, sport_key, commence_time, home_team, away_team, bookmakers:[{key,markets:[{key:"h2h",outcomes:[{name,price}]}]}]}
  // dateFilterISO – lokalno filtriramo ako je zadato (±1 dan)
  if (dateFilterISO) {
    const ymd = dateFilterISO.slice(0, 10);
    return json.filter(ev => (ev.commence_time || "").slice(0,10) === ymd);
  }
  return json;
}

// --- H2H extraction with trusted filter ---
function bestH2HFromBookmakers(bookmakers) {
  // returns {home, draw, away, bookmaker} or null
  const trusted = TRUSTED_ONLY ? TRUSTED_BOOKIES : null;
  let best = { home: null, draw: null, away: null, bookmaker: null };

  for (const bk of (bookmakers || [])) {
    const bkKey = String(bk.key || "").toLowerCase();
    if (trusted && !trusted.includes(bkKey)) continue;
    const h2h = (bk.markets || []).find(m => (m.key || "").toLowerCase() === "h2h");
    if (!h2h) continue;
    for (const oc of (h2h.outcomes || [])) {
      const name = String(oc.name || "").toLowerCase();
      const price = oc.price;
      if (price == null) continue;
      if (name.includes("draw")) {
        if (best.draw == null || price > best.draw) { best.draw = price; best.bookmaker = bkKey; }
      } else if (name.includes("home") || name.includes("1")) {
        if (best.home == null || price > best.home) { best.home = price; best.bookmaker = bkKey; }
      } else if (name.includes("away") || name.includes("2")) {
        if (best.away == null || price > best.away) { best.away = price; best.bookmaker = bkKey; }
      } else {
        // Some feeds label by team names:
        // We'll map later by team match; here we just skip.
      }
    }
  }

  if (best.home == null && best.draw == null && best.away == null) return null;
  return best;
}

// --- Match TOA event to our fixture (by names + kickoff proximity) ---
function matchToFixture(ev, fixture) {
  // fixture: { id, homeTeam|home, awayTeam|away, kickoff|start|startTime }
  const fHome = normTeamName(fixture.homeTeam || fixture.home);
  const fAway = normTeamName(fixture.awayTeam || fixture.away);
  const fKick = fixture.kickoff || fixture.start || fixture.startTime;

  const eHome = normTeamName(ev.home_team);
  const eAway = normTeamName(ev.away_team);
  const eKick = ev.commence_time;

  if (!fHome || !fAway || !fKick || !eHome || !eAway || !eKick) return false;
  if (!withinKickoffWindow(fKick, eKick, 150)) return false;

  const nameMatch =
    (fHome.includes(eHome) || eHome.includes(fHome)) &&
    (fAway.includes(eAway) || eAway.includes(fAway));

  return nameMatch;
}

// --- Public: ensure snapshots + get odds for a list of fixtures ---
async function ensureToaSnapshots(ymd, slot) {
  // If slot signature exists, do not fetch again here.
  const sig = await getSlotSig(ymd, slot);
  if (sig) return { ok: true, note: "slot-snap-exists" };

  // Count rough cost as number of sportKeys * regions groups (markets are comma in one call)
  let spent = 0;
  for (const region of ODDS_API_REGIONS) {
    for (const sportKey of ODDS_API_SPORT_KEYS) {
      // check if we already have snap in KV
      const snap = await getToaSnapshot(ymd, sportKey, ODDS_API_MARKETS.join(","), region);
      if (snap) continue;
      // budget check (1 per fetch)
      const budget = await toaBudgetConsume(ymd, 1);
      if (!budget.allowed) return { ok: false, note: "toa-budget-exhausted" };
      const payload = await fetchToaBulk({
        sportKey,
        regions: region,
        markets: ODDS_API_MARKETS.join(","),
        dateFilterISO: ymd + "T00:00:00Z"
      });
      await putToaSnapshot(ymd, sportKey, ODDS_API_MARKETS.join(","), region, payload, 3 * 3600);
      spent += 1;
    }
  }
  await setSlotSig(ymd, slot);
  return { ok: true, spent, note: "slot-snap-fetched" };
}

async function findOddsForFixtureFromSnapshots(ymd, fixture) {
  for (const region of ODDS_API_REGIONS) {
    for (const sportKey of ODDS_API_SPORT_KEYS) {
      const snap = await getToaSnapshot(ymd, sportKey, ODDS_API_MARKETS.join(","), region);
      if (!snap) continue;
      // find matching event
      const ev = snap.find(e => matchToFixture(e, fixture));
      if (!ev) continue;
      const h2h = bestH2HFromBookmakers(ev.bookmakers || []);
      if (h2h) {
        return { h2h, bookmaker: h2h.bookmaker || null, source: "TOA", region, sportKey, evId: ev.id, commence_time: ev.commence_time };
      }
    }
  }
  return null;
}

module.exports = {
  // config
  ODDS_API_SPORT_KEYS,
  ODDS_API_MARKETS,
  ODDS_API_REGIONS,
  TRUSTED_ONLY,
  TRUSTED_BOOKIES,
  // utils
  ymdFromIso,
  pickSlot,
  // budget/snapshots
  ensureToaSnapshots,
  findOddsForFixtureFromSnapshots,
  toaBudgetAllowed,
  toaBudgetConsume
};
