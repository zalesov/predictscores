// pages/api/cron/rebuild.js
// REST-based KV + ensure union from snapshot chunks (no external deps added)

import { afxGetJson } from '../../../lib/sources/apiFootball';

// ---------- KV helpers (REST) ----------
function kvEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url: url.replace(/\/+$/, ''), token: String(token) };
}
async function kvSetRaw(key, value) {
  const { url, token } = kvEnv();
  await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?token=${token}`, { method: 'POST' });
}
async function kvSetJson(key, value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  await kvSetRaw(key, payload);
}

// ---------- time helpers ----------
function ymdFromTZ(tz = 'Europe/Belgrade') {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function slotByHour(h) {
  if (h < 12) return 'am';
  if (h < 17) return 'pm';
  return 'late';
}
function detectSlot(tz = 'Europe/Belgrade') {
  const h = Number(new Date(new Date().toLocaleString('en-US', { timeZone: tz })).getHours());
  return slotByHour(h);
}

// ---------- snapshot helpers ----------
const API_TIMEZONE = 'Europe/Belgrade';
const DEFAULT_CHUNK_SIZE = 200;
const HARD_PAGE_LIMIT = 10;
const SNAPSHOT_CHUNK_SIZE = (() => {
  const candidates = [
    process.env.VB_SNAPSHOT_CHUNK_SIZE,
    process.env.VB_SNAPSHOT_CHUNK,
    process.env.SNAPSHOT_CHUNK_SIZE,
  ];
  for (const cand of candidates) {
    const n = Number(cand);
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
  }
  return DEFAULT_CHUNK_SIZE;
})();
const LEAGUE_DENY_REGEXES = [
  /women/i,
  /feminine/i,
  /girls/i,
  /ladies/i,
  /youth/i,
  /academy/i,
  /reserves?/i,
  /amateur/i,
  /futsal/i,
  /e-?sports/i,
  /u-?\d{2}/i,
];
const BAD_STATUS = new Set(['FT', 'AET', 'PEN', 'ABD', 'CANC', 'AWD', 'WO']);

function fixtureIdFrom(row) {
  if (!row) return null;
  const candidates = [row?.fixture?.id, row?.fixture_id, row?.id];
  for (const cand of candidates) {
    const num = Number(cand);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function isLeagueDenied(league) {
  const name = typeof league?.name === 'string'
    ? league.name
    : typeof league === 'string'
      ? league
      : '';
  if (!name) return false;
  return LEAGUE_DENY_REGEXES.some((rx) => rx.test(name));
}

function isStatusAllowed(short) {
  if (!short) return true;
  const code = String(short).trim().toUpperCase();
  if (!code) return true;
  return !BAD_STATUS.has(code);
}

function chunkArray(arr, size) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const n = Number.isFinite(size) && size > 0 ? size : DEFAULT_CHUNK_SIZE;
  const out = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

async function fetchFixtureIds(ymd, tz) {
  const ids = [];
  const seen = new Set();
  const pages = [];
  const issues = [];
  let page = 1;
  let totalPages = 1;
  const timezone = tz || API_TIMEZONE;

  while (page <= totalPages && page <= HARD_PAGE_LIMIT) {
    const qs = [`date=${encodeURIComponent(ymd)}`, `timezone=${encodeURIComponent(timezone)}`, `page=${page}`].join('&');
    const path = `/fixtures?${qs}`;
    let json;
    try {
      json = await afxGetJson(path, {
        cacheKey: `af:fixtures:${ymd}:${timezone}:p${page}`,
        ttlSeconds: 5 * 60,
        priority: 'P1',
        skipOnNoBudget: false,
      });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[rebuild] fixtures page ${page} failed: ${msg}`);
      issues.push({ page, error: msg });
      page += 1;
      continue;
    }

    if (!json) {
      const msg = 'no-response';
      console.warn(`[rebuild] fixtures page ${page} returned no data`);
      issues.push({ page, error: msg });
      page += 1;
      continue;
    }

    const arr = Array.isArray(json?.response) ? json.response : [];
    const stat = { page, fetched: arr.length, accepted: 0, skipped: 0 };
    for (const row of arr) {
      const id = fixtureIdFrom(row);
      if (!id) { stat.skipped += 1; continue; }
      if (seen.has(id)) { stat.skipped += 1; continue; }
      if (isLeagueDenied(row?.league)) { stat.skipped += 1; continue; }
      if (!isStatusAllowed(row?.fixture?.status?.short)) { stat.skipped += 1; continue; }
      seen.add(id);
      ids.push(id);
      stat.accepted += 1;
    }
    pages.push(stat);

    const tot = Number(json?.paging?.total);
    if (Number.isFinite(tot) && tot > totalPages) {
      totalPages = Math.min(tot, HARD_PAGE_LIMIT);
    }
    page += 1;
  }

  return { ids, pages, issues };
}

async function writeSnapshot({ ymd, tz, ids, pages, issues }) {
  const chunkSize = SNAPSHOT_CHUNK_SIZE;
  const chunks = chunkArray(ids, chunkSize);
  const chunkKeys = [];
  const ts = new Date().toISOString();

  for (let i = 0; i < chunks.length; i += 1) {
    const key = `vb:day:${ymd}:snapshot:${i}`;
    chunkKeys.push(key);
    await kvSetJson(key, chunks[i]);
  }

  const indexDoc = {
    ymd,
    timezone: tz,
    size: ids.length,
    chunks: chunks.length,
    chunk_size: chunkSize,
    fetched: pages.reduce((sum, p) => sum + (p?.fetched || 0), 0),
    accepted: ids.length,
    skipped: pages.reduce((sum, p) => sum + (p?.skipped || 0), 0),
    updated_at: ts,
    source: 'api-football:fixtures',
  };
  if (chunkKeys.length) indexDoc.chunk_keys = chunkKeys;
  if (issues.length) indexDoc.issues = issues.slice(0, 6);

  await kvSetJson(`vb:day:${ymd}:snapshot:index`, indexDoc);

  const union = Array.from(new Set(ids));
  await kvSetJson(`vb:day:${ymd}:union`, union);

  return { indexDoc, union, issues };
}

export default async function handler(req, res) {
  const tz = 'Europe/Belgrade';
  const ymd = (req.query.ymd || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.ymd : ymdFromTZ(tz);
  const slot = (req.query.slot || '').match(/^(am|pm|late)$/) ? req.query.slot : detectSlot(tz);

  try {
    const { ids, pages, issues } = await fetchFixtureIds(ymd, tz);
    const snapshot = await writeSnapshot({ ymd, tz, ids, pages, issues });

    const summary = {
      size: snapshot.indexDoc.size,
      chunks: snapshot.indexDoc.chunks,
      chunk_size: snapshot.indexDoc.chunk_size,
      fetched: snapshot.indexDoc.fetched,
      skipped: snapshot.indexDoc.skipped,
    };

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      snapshot: summary,
      union: { count: snapshot.indexDoc.accepted },
      issues: snapshot.issues,
    });
  } catch (e) {
    console.error('[rebuild] failed', e);
    return res.status(200).json({ ok: false, ymd, slot, error: String(e?.message || e) });
  }
}
