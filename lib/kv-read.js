// lib/kv-read.js
// Upstash Redis REST adapter preko /pipeline + helpers (arrFromAny, toJson)

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
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") return Object.values(parsed);
      } catch {}
    }
    if (s.includes(",")) return s.split(",").map(t => t.trim()).filter(Boolean);
    return [s];
  }
  if (typeof x === "object") {
    try { return Array.isArray(x) ? x : Object.values(x); } catch { return []; }
  }
  return [];
}

async function kvPipeline(cmds) {
  ensureEnv();
  const r = await fetch(`${BASE}/pipeline`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`KV_PIPELINE_HTTP_${r.status}`);
  return r.json();
}

async function kvGet(key) {
  const arr = await kvPipeline([["GET", key]]);
  let v = arr?.[0]?.result ?? null;
  if (typeof v === "string") {
    const s = v.trim();
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
      try { return JSON.parse(s); } catch { return v; }
    }
  }
  return v;
}

async function kvSet(key, value) {
  const body = typeof value === "string" ? value : toJson(value);
  const arr = await kvPipeline([["SET", key, body]]);
  const ok = arr?.[0]?.result;
  if (ok !== "OK" && ok !== "true" && ok !== true) {
    throw new Error(`KV_SET_FAILED:${key}`);
  }
  return true;
}

async function getKV() {
  return {
    async get(k) { return kvGet(k); },
    async set(k, v) { return kvSet(k, v); },
  };
}

export { getKV, kvGet, kvSet, kvPipeline, arrFromAny, toJson };
module.exports = { getKV, kvGet, kvSet, kvPipeline, arrFromAny, toJson };
