// pages/api/value-bets-locked.js
// UVEK puni kartice (home/away/league/kickoff + aliasi) i vraća offers (odds) iz KV.
// Plus: filtrira "rezervne", "U-lige (U23/U21/U20/U19/U18/U17...)" i ženske/W lige.
// Slot prozori: late = 00:00–09:59, am = 10:00–14:59, pm = 15:00–23:59 (Europe/Belgrade).
// Fallback na izvore ID-eva: vb-locked:kv:hit -> vbl_full:<ymd>:<slot> -> vbl_full:<ymd> -> vb:day:<ymd>:union.
// AF pozivi cap: late≤1000 / am≤2000 / pm≤3000 (samo za expand).
// Nikad 500 – u catch vraćamo { ok:false, error } sa 200.

import * as s from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HOST = "https://v3.football.api-sports.io";
const API_HINTS = ["api-sports.io", "api-football"];

// Kandidat ključeva za odds po fixture-ID-u (uzima prvi koji postoji)
const ODDS_KEYS = [
  (id) => `vb-odds:last:${id}`,
  (id) => `odds:last:${id}`,
  (id) => `af:odds:last:${id}`,
  (id) => `odds:byFixture:${id}`,
  (id) => `odds:${id}`,
];

/** -------------------- BLOK LISTA LIGA -------------------- */
// Pazimo na false-positive (npr. "World Cup" ne treba blokirati iako sadrži "W").
const RE_YOUTH = /\bU(?:23|22|21|20|19|18|17|16|15)\b/i;  // U23, U21, U20...
const RE_YOUTH_WORDS = /\b(under\s?(?:23|22|21|20|19|18|17|16|15)|primavera|youth|junior[es]?|sub\s?(?:23|22|21|20|19|18|17|16|15))\b/i;

const RE_RESERVE = /\b(reserve|res\.|reserves)\b/i;

const RE_WOMEN = new RegExp(
  [
    // women (razni jezici/oblici)
    "\\bwomen'?s?\\b",
    "\\bfemeni\\w*\\b",    // femenino, feminina, féminin, féminin(e), femenil
    "\\blad(?:y|ies)\\b",  // lady, ladies
    // ' W ' liga (ali ne 'World')
    "(?<!world)\\sW(\\s|\\b|[-)]|$)",
    "\\bW-?league\\b",
    "\\bW\\.?\\s?cup\\b"  // ako eksplicitno označena ženska W Cup
  ].join("|"),
  "i"
);

// Pomoćno: bezbedno dohvatimo string
function sval(x) { return (x == null) ? "" : String(x); }

function isBlockedLeague(leagueNameRaw) {
  const name = sval(leagueNameRaw).trim();
  if (!name) return false;

  // Women
  if (RE_WOMEN.test(name)) return true;

  // Youth/U
  if (RE_YOUTH.test(name) || RE_YOUTH_WORDS.test(name)) return true;

  // Reserve
  if (RE_RESERVE.test(name)) return true;

  return false;
}
/** --------------------------------------------------------- */

function ymdNow(tz = TZ) {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function slotByHour(h){ if (h < 12) return "am"; if (h < 17) return "pm"; return "late"; }
function detectSlot(tz = TZ){
  const h = Number(new Date(new Date().toLocaleString("en-US", { timeZone: tz })).getHours());
  return slotByHour(h);
}
function sanitizeYmd(v){
  const sVal = decodeURIComponent(String(v || "")).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(sVal) ? sVal : null;
}
function sanitizeSlot(v){
  const sVal = decodeURIComponent(String(v || "")).trim().toLowerCase();
  return /^(am|pm|late)$/.test(sVal) ? sVal : null;
}
function spentKey(ymd, slot){ return `afc:spent:${ymd}:${slot}`; }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

// Iz ISO datuma uzmi lokalni sat (parsiramo „T HH:MM” deo – u stringu već stoji +02:00)
function hourFromIsoLocal(iso) {
  if (typeof iso !== "string") return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}
// Slot prozori po zahtevu korisnika: 00–09:59 (late), 10–14:59 (am), 15–23:59 (pm)
function inSlotWindow(kickoffIso, slot) {
  const h = hourFromIsoLocal(kickoffIso);
  if (h == null) return false;
  if (slot === "late") return h >= 0 && h < 10;
  if (slot === "am")   return h >= 10 && h < 15;
  if (slot === "pm")   return h >= 15 && h <= 23;
  return true;
}

async function countedAF(url, opts, ymd, slot) {
  const u = typeof url === "string" ? url : String(url?.url || url);
  if (!API_HINTS.some(h => u.includes(h))) return fetch(url, opts);
  let spent = 0;
  try { spent = Number((await s.kvGet(spentKey(ymd, slot))) || 0); } catch {}
  if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
  const resp = await fetch(url, opts);
  try { await s.kvSet(spentKey(ymd, slot), String(spent + 1)); } catch {}
  return resp;
}

function normalizeOne(row, id) {
  if (!row) return null;
  const home = row.home || row.homeTeam || row?.teams?.home?.name || null;
  const away = row.away || row.awayTeam || row?.teams?.away?.name || null;
  const league = row.league || row.leagueName || row?.league?.name || null;
  const kickoff = row.kickoff || row.start || row.startTime || row?.fixture?.date || null;
  if (!home || !away || !kickoff) return null;
  // BLOKIRAJ po nazivu lige
  if (isBlockedLeague(league)) return null;

  return {
    id: id ?? row.id,
    home, away, league, kickoff,
    // aliasi za kompatibilnost
    homeTeam: home,
    awayTeam: away,
    leagueName: league,
    start: kickoff,
    startTime: kickoff,
  };
}

async function expandOne(id, { ymd, slot, apiKey }) {
  const url = `${API_HOST}/fixtures?id=${id}&timezone=${encodeURIComponent(TZ)}`;
  const r = await countedAF(url, { headers: { "x-apisports-key": apiKey, "accept": "application/json" } }, ymd, slot);
  const data = await r.json();
  if (data?.errors && Object.keys(data.errors).length > 0) return null;
  const row = Array.isArray(data?.response) ? data.response[0] : null;
  if (!row) return null;
  return normalizeOne({
    id,
    home: row?.teams?.home?.name,
    away: row?.teams?.away?.name,
    league: row?.league?.name,
    kickoff: row?.fixture?.date,
  }, id);
}

async function expandMissing(ids, haveMap, { ymd, slot }) {
  const keyRaw = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  const apiKey = (keyRaw || "").trim();
  if (!apiKey) return [];

  // expand samo koliko treba da dođemo do 15 punih
  const need = ids.filter(id => !haveMap.has(id)).slice(0, Math.max(0, 15 - haveMap.size));
  const tasks = need.map(id => expandOne(id, { ymd, slot, apiKey }).catch(() => null));
  const out = (await Promise.all(tasks)).filter(Boolean);
  return out;
}

async function uniqueIdList(arr) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const id = typeof v === "number" ? v : v?.id;
    if (typeof id === "number" && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

async function pickIds(ymd, slot) {
  // 1) locked
  try {
    const locked = await s.kvGet("vb-locked:kv:hit");
    const ids = await uniqueIdList(locked);
    if (ids.length) return ids;
  } catch {}
  // 2) vbl_full:<ymd>:<slot>
  try {
    const vblSlot = await s.kvGet(`vbl_full:${ymd}:${slot}`);
    const ids = await uniqueIdList(vblSlot);
    if (ids.length) return ids;
  } catch {}
  // 3) vbl_full:<ymd>
  try {
    const vblDay = await s.kvGet(`vbl_full:${ymd}`);
    const ids = await uniqueIdList(vblDay);
    if (ids.length) return ids;
  } catch {}
  // 4) union
  try {
    const union = await s.kvGet(`vb:day:${ymd}:union`);
    const ids = await uniqueIdList(union);
    if (ids.length) return ids;
  } catch {}
  return [];
}

async function readLockedSeeds() {
  let seeds = [];
  try {
    const fromLocked = await s.kvGet("vb-locked:kv:hit") || [];
    for (const it of Array.isArray(fromLocked) ? fromLocked : []) {
      const obj = normalizeOne(it, it?.id ?? (typeof it === "number" ? it : null));
      if (obj) seeds.push(obj);
    }
  } catch {}
  try {
    const games = await s.kvGet("vb-locked:kv:hit:games") || [];
    for (const g of Array.isArray(games) ? games : []) {
      const obj = normalizeOne(g, g?.id);
      if (obj) seeds.push(obj);
    }
  } catch {}
  // uniq by id
  const map = new Map(seeds.map(x => [x.id, x]));
  return Array.from(map.values());
}

async function readMeta(ymd, slot) {
  let meta = null;
  try { meta = await s.kvGet("vb-locked:kv:hit:meta"); } catch {}
  const nowIso = new Date().toISOString();
  return {
    ymd, slot,
    source: "vb-locked:kv:hit",
    ts: meta?.ts || nowIso,
    last_odds_refresh: meta?.last_odds_refresh || nowIso
  };
}

// Pročitaj odds za ID-eve – pokušaj više kandidata po redosledu
async function readOddsBulk(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cmds = [];
  const keyIndex = []; // [id, keyString]
  for (const id of ids) {
    for (const f of ODDS_KEYS) {
      const k = f(id);
      cmds.push(["GET", k]);
      keyIndex.push([id, k]);
    }
  }
  let resp = null;
  try { resp = await s.kvPipeline(cmds); } catch { resp = null; }
  if (!resp || !Array.isArray(resp)) return out;

  // group results by id (take first non-null)
  const firstNonNullPerId = new Map();
  for (let i = 0; i < resp.length; i++) {
    const [id, k] = keyIndex[i];
    const val = resp[i]?.result ?? null;
    if (val == null) continue;
    if (!firstNonNullPerId.has(id)) firstNonNullPerId.set(id, val);
  }

  for (const id of ids) {
    let raw = firstNonNullPerId.get(id);
    if (typeof raw === "string") {
      const s = raw.trim();
      if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
        try { raw = JSON.parse(s); } catch {}
      }
    }
    out.set(id, raw ?? null);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const ymd = sanitizeYmd(req.query.ymd) || ymdNow(TZ);
    const slot = sanitizeSlot(req.query.slot) || detectSlot(TZ);

    // 1) Seeds (iz locked) – često već pune stavke (tu već čistimo blokirane lige)
    const seeds = await readLockedSeeds();
    const seedsMap = new Map(seeds.map(x => [x.id, x]));

    // 2) Lista ID-eva sa fallback lancem
    let ids = await pickIds(ymd, slot);
    // filtriraj po slot prozoru na osnovu kickoff-a (iz seeds ako postoji)
    ids = ids.filter(id => {
      const k = seedsMap.get(id)?.kickoff;
      return !k || inSlotWindow(k, slot); // ako nemamo kickoff još, dozvoli (expand će kasnije filtrirati)
    });

    // 3) Upotpuni detalje (expand) samo za nedostajuće
    const haveMap = new Map(seeds.map(x => [x.id, x]));
    const expanded = await expandMissing(ids, haveMap, { ymd, slot });
    for (const e of expanded) haveMap.set(e.id, e);

    // 4) Finalni izbor: slot prozor + izbaciti blokirane lige + sort po kickoff
    const detailed = ids
      .map(id => haveMap.get(id))
      .filter(Boolean)
      .filter(g => inSlotWindow(g.kickoff, slot))
      .filter(g => !isBlockedLeague(g.league)) // <- ključna linija: ukloni rezervne/U/W lige
      .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)))
      .slice(0, 15);

    // 5) Odds – za finalnih do 15 kom, čitaj iz KV (bez AF poziva)
    const oddsMap = await readOddsBulk(detailed.map(g => g.id));
    const items = detailed.map(g => {
      const odds = oddsMap.get(g.id) ?? null;
      return { ...g, odds };
    });

    // 6) Meta
    const meta = await readMeta(ymd, slot);
    meta.returned = items.length;
    meta.cap = 15;

    // 7) Odgovor (shape koji UI već očekuje)
    return res.status(200).json({
      items,              // pune kartice + odds
      ids: items.map(x => x.id),
      games: items,       // isti kao items (kompat)
      meta
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
