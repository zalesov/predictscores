// lib/kv-read.js
// Unified KV adapter (Upstash REST) + helpers koje rute očekuju (arrFromAny, toJson)

const URL_A = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOK_A = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

function trimSlash(u) { return (u || "").replace(/\/+$/, ""); }
const BASE = trimSlash(URL_A);
const AUTH = TOK_A ? `Bearer ${TOK_A}` : "";

function ensureEnv() {
  if (!BASE || !AUTH) {
    throw new Error("KV adapter: missing REST URL/TOKEN (KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN)");
  }
}

// Helpers koje neke rute/testovi traže
function toJson(v) {
  try { return JSON.stringify(v); }
  catch { try { return JSON.stringify(String(v)); } catch { return "null"; } }
}

function arrFromAny(x) {
  if (Array.isArray(x)) return x;
  if (x == null) return [];
  if (typeof x === "number") return [x];
  if (typeof x === "string") {
    const s = x.trim();
    if (!s) return [];
    // JSON?
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") return Object.values(parsed);
      } catch {}
    }
    // CSV
    if (s.includes(",")) return s.split(",").map(t => t.trim()).filter(Boolean);
    return [s];
  }
  if (typeof x === "object") {
    try { return Array.isArray(x) ? x : Object.values(x); } catch { return []; }
  }
  return [];
}

async function kvGet(key) {
  ensureEnv();
  const r = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`KV GET failed ${r.status}`);
  const { result } = await r.json();
  if (typeof result === "string") {
    const s = result.trim();
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
      try { return JSON.parse(s); } catch { return result; }
    }
  }
  return result;
}

async function kvSet(key, value) {
  ensureEnv();
  const body = typeof value === "string" ? value : toJson(value);
  const r = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: toJson({ value: body }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`KV SET failed ${r.status}: ${txt}`);
  }
  return true;
}

async function getKV() {
  return {
    async get(k) { return kvGet(k); },
    async set(k, v) { return kvSet(k, v); },
  };
}

export { getKV, kvGet, kvSet, arrFromAny, toJson };
module.exports = { getKV, kvGet, kvSet, arrFromAny, toJson };
