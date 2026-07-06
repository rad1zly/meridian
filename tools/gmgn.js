import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required for the GMGN fee source.");
  return key;
}

export function hasGmgnApiKey() {
  return !!(config.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Token fees (SOL) for the minTokenFeesSol gate ──────────────
// Returns { total_fee, trade_fee } in SOL, or null on missing key / error
// so callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    return {
      total_fee: num(info.total_fee),
      trade_fee: num(info.trade_fee),
    };
  } catch (error) {
    log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// ─── Token snapshot for coverage formula (bins_below) ────────────
// Returns { price, price_1h, price_5m, buys_1h, sells_1h } or null.
// Caller owns the per-cycle cache — pass `cache.get(mint)` if cached,
// otherwise we'll fetch and caller stores result. Used by computeCoverageBins.
const _snapshotCache = new Map(); // mint → snapshot OR null (negative cache)

export async function getGmgnTokenSnapshot(mint) {
  if (!mint) return null;
  if (_snapshotCache.has(mint)) return _snapshotCache.get(mint);
  if (!hasGmgnApiKey()) {
    _snapshotCache.set(mint, null);
    return null;
  }
  try {
    const payload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") {
      _snapshotCache.set(mint, null);
      return null;
    }
    const priceObj = info.price || {};
    const snapshot = {
      price: num(priceObj.price),
      price_1h: num(priceObj.price_1h),
      price_5m: num(priceObj.price_5m),
      buys_1h: num(priceObj.buys_1h),
      sells_1h: num(priceObj.sells_1h),
    };
    // Sanity: need price + price_1h at minimum for coverage to work
    if (!Number.isFinite(snapshot.price) || !Number.isFinite(snapshot.price_1h)) {
      _snapshotCache.set(mint, null);
      return null;
    }
    _snapshotCache.set(mint, snapshot);
    return snapshot;
  } catch (error) {
    log("gmgn", `token snapshot lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    _snapshotCache.set(mint, null);
    return null;
  }
}

/** Clear per-cycle snapshot cache. Call at start of each screening cycle. */
export function clearGmgnSnapshotCache() {
  _snapshotCache.clear();
}

// ─── Coverage-based bins_below calculator ────────────────────────
// Pure function — no I/O. Caller supplies GMGN snapshot + organic + volatility.
// Formula (user-designed 2026-06-28 + vol_adj 2026-06-29):
//
//   change_1h  = (price - price_1h) / price_1h × 100
//   change_5m  = (price - price_5m) / price_5m × 100
//   buy_pct    = buys_1h / (buys_1h + sells_1h) × 100
//
//   base       = max(|change_1h| × 2.5, |change_5m| × 6.0, 15)
//   dir_adj    = change_1h < 0 ? 1.15 : 0.85     // bearish → wider range
//   mom_adj    = buy_pct < 35 ? 1.15 : (buy_pct > 65 ? 0.90 : 1.0)
//   health_adj = organic >= 75 ? 0.95 : (organic < 50 ? 1.15 : 1.0)
//   vol_adj    = max(1.0, volatility / 5)         // 2026-06-29: high-vol tokens
//                                                 //   get wider range — vol is the
//                                                 //   expected swing, formula must
//                                                 //   match it. vol < 5 → no change.
//
//   coverage   = base × dir_adj × mom_adj × health_adj × vol_adj
//   bins_below = clamp(round(coverage / (binStep / 100)), 40, 150)
//
// Returns null when snapshot missing or binStep invalid — caller falls back
// to Formula A (vol-based) in that case.
export function computeCoverageBins({ snapshot, organic, binStep, volatility }) {
  if (!snapshot) return null;
  if (!Number.isFinite(binStep) || binStep <= 0) return null;

  const priceNow = Number(snapshot.price);
  const price1h = Number(snapshot.price_1h);
  const price5m = Number(snapshot.price_5m);
  if (!Number.isFinite(priceNow) || !Number.isFinite(price1h) || price1h <= 0) return null;

  const change1h = ((priceNow - price1h) / price1h) * 100;
  const change5m = Number.isFinite(price5m) && price5m > 0
    ? ((priceNow - price5m) / price5m) * 100
    : 0;
  const buys = Number(snapshot.buys_1h) || 0;
  const sells = Number(snapshot.sells_1h) || 0;
  const totalSwaps = buys + sells;
  const buyPct = totalSwaps > 0 ? (buys / totalSwaps) * 100 : 50;

  // Severity-tiered 1h multiplier (2026-06-30): severe dumps need wider buffer
  // -15% threshold → 4× (was 2.5× flat across all move sizes).
  // BULLWIF-style -19% 1h dumps now get 76 base × dir × health × vol ≈ 90 bins (vs 53 before).
  // Mild moves (<15%) keep 2.5× ratio — no over-coverage in calm pools.
  const ch1hMult = change1h <= -15 ? 4.0 : 2.5;
  const base = Math.max(Math.abs(change1h) * ch1hMult, Math.abs(change5m) * 6.0, 15);
  const dirAdj = change1h < 0 ? 1.15 : 0.85;
  const momAdj = buyPct < 35 ? 1.15 : (buyPct > 65 ? 0.90 : 1.0);
  const organicNum = Number(organic) || 0;
  const healthAdj = organicNum >= 75 ? 0.95 : (organicNum < 50 ? 1.15 : 1.0);
  const volNum = Number(volatility);
  // vol_adj divisor lowered 3.5 → 3.0 (2026-06-30): wider coverage for vol >= 3 tokens.
  // vol=3 → 1.0, vol=4 → 1.33, vol=6 → 2.0, vol=9 → 3.0. Sub-3 pools unchanged (calm pools stay tight).
  const volAdj = Number.isFinite(volNum) && volNum > 0 ? Math.max(1.0, volNum / 3.0) : 1.0;

  const coverage = base * dirAdj * momAdj * healthAdj * volAdj;
  const bins = coverage / (binStep / 100);
  const clamped = Math.max(40, Math.min(150, Math.round(bins)));
  return clamped;
}
