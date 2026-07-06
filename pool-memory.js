/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";
import { addToPoolBlacklist } from "./pool-blacklist.js";

import { repoPath } from "./repo-root.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");
const MAX_NOTE_LENGTH = 280;

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

function isFeeGeneratingDeploy(deploy) {
  const minFeeEarnedPct = Number(config.management.repeatDeployCooldownMinFeeEarnedPct ?? 0);
  const feeEarnedPct = Number(deploy.fee_earned_pct ?? 0);
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = (Number.isFinite(feesUsd) && feesUsd > 0) || (Number.isFinite(feesSol) && feesSol > 0);
  if (!hasFees) return false;
  return Number.isFinite(feeEarnedPct) && feeEarnedPct >= minFeeEarnedPct;
}

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  return cooldownUntil;
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    pnl_sol: deployData.pnl_sol ?? null,
    pnl_sol_pct: deployData.pnl_sol_pct ?? null,
    fees_earned_usd: deployData.fees_earned_usd ?? null,
    fees_earned_sol: deployData.fees_earned_sol ?? null,
    fee_earned_pct: deployData.fee_earned_pct ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
    entry_mcap: deployData.entry_mcap ?? null,
    entry_tvl: deployData.entry_tvl ?? null,
    entry_volume: deployData.entry_volume ?? null,
    exit_mcap: deployData.exit_mcap ?? null,
    exit_tvl: deployData.exit_tvl ?? null,
    exit_volume: deployData.exit_volume ?? null,
  };

  // ── Hybrid dedup (2026-07-03 HARDCODED) ─────────────────────────
  // When 2 NFTs of a hybrid pair close together, lessons.js calls recordPoolDeploy
  // twice (once per NFT). To make win-streak cooldown count 1 deploy per pool
  // (not 2), we merge the 2nd record into the 1st if they arrive within 60s.
  const HYBRID_DEDUP_WINDOW_MS = 60_000;
  const prev = entry.deploys[entry.deploys.length - 1];
  let mergedInto = null;
  if (
    prev &&
    prev.closed_at &&
    deploy.closed_at &&
    Math.abs(new Date(deploy.closed_at).getTime() - new Date(prev.closed_at).getTime()) < HYBRID_DEDUP_WINDOW_MS &&
    prev.deployed_at === deploy.deployed_at
  ) {
    // Same pool, same deploy time, closed within 60s → hybrid partner close.
    // Combine PnL fields (sum USD/SOL, weighted avg pct by USD), preserve prev record.
    const combinedUsd = (prev.pnl_usd ?? 0) + (deploy.pnl_usd ?? 0);
    const combinedSol = (prev.pnl_sol ?? 0) + (deploy.pnl_sol ?? 0);
    const combinedFeesUsd = (prev.fees_earned_usd ?? 0) + (deploy.fees_earned_usd ?? 0);
    const combinedFeesSol = (prev.fees_earned_sol ?? 0) + (deploy.fees_earned_sol ?? 0);
    const prevUsdAbs = Math.abs(prev.pnl_usd ?? 0);
    const curUsdAbs = Math.abs(deploy.pnl_usd ?? 0);
    const totalUsdAbs = prevUsdAbs + curUsdAbs;
    const weightedPct = totalUsdAbs > 0
      ? ((prev.pnl_pct ?? 0) * prevUsdAbs + (deploy.pnl_pct ?? 0) * curUsdAbs) / totalUsdAbs
      : ((prev.pnl_pct ?? 0) + (deploy.pnl_pct ?? 0)) / 2;
    prev.pnl_usd = Math.round(combinedUsd * 100) / 100;
    prev.pnl_sol = Math.round(combinedSol * 10000) / 10000;
    prev.pnl_pct = Math.round(weightedPct * 100) / 100;
    prev.fees_earned_usd = (prev.fees_earned_usd ?? 0) + (deploy.fees_earned_usd ?? 0);
    prev.fees_earned_sol = (prev.fees_earned_sol ?? 0) + (deploy.fees_earned_sol ?? 0);
    if (prev.fee_earned_pct != null && deploy.fee_earned_pct != null) {
      prev.fee_earned_pct = Math.round((prev.fee_earned_pct + deploy.fee_earned_pct) * 100) / 100;
    } else {
      prev.fee_earned_pct = prev.fee_earned_pct ?? deploy.fee_earned_pct ?? null;
    }
    prev.strategy = prev.strategy && deploy.strategy && prev.strategy !== deploy.strategy
      ? "hybrid"
      : prev.strategy || deploy.strategy;
    prev.close_reason = `${prev.close_reason || "?"}+hybrid-partner`;
    prev.hybrid = true;
    mergedInto = entry.deploys.length - 1;
    log("pool-memory", `Hybrid dedup merged 2 NFT closes into deploy #${mergedInto + 1} for ${entry.name}: combined PnL $${prev.pnl_usd.toFixed(2)} (${prev.pnl_pct.toFixed(2)}%)`);
  } else {
    entry.deploys.push(deploy);
  }

  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
    : 0;

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // Set cooldown for low yield closes — pool wasn't profitable enough, don't redeploy soon
  if (deploy.close_reason === "low yield") {
    const cooldownHours = 0;
    const cooldownUntil = setPoolCooldown(entry, cooldownHours, "low yield");
    log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (low yield close)`);
  }

  const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = config.management.oorCooldownHours ?? 12;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorCloseReason(d.close_reason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = setPoolCooldown(entry, oorCooldownHours, reason);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
    // Base mint (token) cooldown disabled per user request — pool cooldown still active.
  }

  if (config.management.repeatDeployCooldownEnabled) {
    const triggerCount = Math.max(1, Number(config.management.repeatDeployCooldownTriggerCount ?? 3));
    const cooldownHours = Math.max(0, Number(config.management.repeatDeployCooldownHours ?? 12));
    const rawScope = String(config.management.repeatDeployCooldownScope || "token").toLowerCase();
    const scope = ["pool", "token", "both"].includes(rawScope) ? rawScope : "token";
    const recentRepeatDeploys = entry.deploys.slice(-triggerCount);
    const repeatedFeeGeneratingDeploys =
      cooldownHours > 0 &&
      recentRepeatDeploys.length >= triggerCount &&
      recentRepeatDeploys.every((d) => d.pnl_pct != null && isFeeGeneratingDeploy(d));

    if (repeatedFeeGeneratingDeploys) {
      const reason = `repeat fee-generating deploys (${triggerCount}x)`;
      if (scope === "pool" || scope === "both" || !entry.base_mint) {
        const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
        log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
        if (mintCooldownUntil) {
          log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
        }
      }
    }
  }

  // Loss-based cooldown: skip pool/token for X hours after a single loss close
  // Tiered: mild loss (PnL >= threshold) gets short cooldown, severe loss (PnL < threshold) gets long cooldown
  if (config.management.lossCooldownEnabled) {
    const scope = ["pool", "token", "both"].includes(String(config.management.lossCooldownScope || "token").toLowerCase())
      ? String(config.management.lossCooldownScope || "token").toLowerCase()
      : "token";
    const minLossPct = Number(config.management.lossCooldownMinLossPct ?? 0);
    const pnlPctLoss = deploy.pnl_pct != null && deploy.pnl_pct < minLossPct;
    // Exemption: if SOL-denominated PnL is positive, skip cooldown even if USD PnL is negative.
    // Rationale: we LP in SOL; if we gained SOL units, the "loss" is just SOL/USD price movement, not a bad trade.
    const pnlSolGain = deploy.pnl_sol != null && deploy.pnl_sol > 0;
    // Exemption: structural OOR / directional-pump closes are not discretionary losses.
    // The price moved through the bins (asymmetric pump up or down), the position got carried out of range,
    // and the close is forced by OOR policy. Not a signal that the trade thesis was wrong.
    // Patterns: "pumped far above range", "Out of range for Xm", "OOR", "pumped"/"dump"/"dumped",
    //           "hybrid-partner" (sync close).
    const reasonLower = String(deploy.close_reason || "").toLowerCase();
    const isStructuralOorClose =
      reasonLower.includes("pumped") ||
      reasonLower.includes("dumped") ||
      reasonLower.includes("out of range") ||
      reasonLower.includes("oor") ||
      reasonLower.includes("hybrid-partner");
    const isLoss = pnlPctLoss && !pnlSolGain && !isStructuralOorClose;
    if (isLoss) {
      const severityThreshold = Number(config.management.lossCooldownSeverityThresholdPct ?? -20);
      const isSevere = deploy.pnl_pct < severityThreshold;
      const permanentOnSevere = config.management.lossCooldownPermanentOnSevere ?? true;
      // Permanent cooldown = 999999 hours (~114 years), effectively forever
      const PERMANENT_COOLDOWN_HOURS = 999999;
      const hours = isSevere
        ? (permanentOnSevere
            ? PERMANENT_COOLDOWN_HOURS
            : Math.max(0, Number(config.management.lossCooldownHours ?? 999)))
        : Math.max(0, Number(config.management.lossCooldownHoursMild ?? 6));
      const severityLabel = isSevere ? (permanentOnSevere ? "severe - permanent" : "severe") : "mild";
      if (hours > 0) {
        const reason = `loss close (pnl ${deploy.pnl_pct.toFixed(2)}% - ${severityLabel})`;
        if (scope === "pool" || scope === "both" || !entry.base_mint) {
          const poolCooldownUntil = setPoolCooldown(entry, hours, reason);
          log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
        }
        if ((scope === "token" || scope === "both") && entry.base_mint) {
          const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, hours, reason);
          if (mintCooldownUntil) {
            log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
          }
        }
      }
    }
  }

  // Win streak cooldown: pause token after N consecutive wins to force diversification
  if (config.management.winStreakCooldownEnabled) {
    const threshold = Math.max(2, Number(config.management.winStreakThreshold ?? 3));
    const hours = Math.max(0, Number(config.management.winStreakCooldownHours ?? 24));
    const rawScope = String(config.management.winStreakCooldownScope || "token").toLowerCase();
    const scope = ["pool", "token", "both"].includes(rawScope) ? rawScope : "token";
    const recentDeploys = entry.deploys.slice(-threshold);
    const hasStreak = recentDeploys.length === threshold &&
      recentDeploys.every((d) => d.pnl_pct != null && d.pnl_pct > 0);
    if (hasStreak && hours > 0) {
      const reason = `win streak (${threshold}x consecutive wins)`;
      if (scope === "pool" || scope === "both" || !entry.base_mint) {
        const poolCooldownUntil = setPoolCooldown(entry, hours, reason);
        log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, hours, reason);
        if (mintCooldownUntil) {
          log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
        }
      }
    }
  }

  // Post-close observation cooldown (REMOVED 2026-07-01 per user request — gak perlu, fee/tvl filter udah cukup)

  // Stop loss → permanently blocklist the pool
  const closeReasonText = String(deploy.close_reason || "").toLowerCase();
  const isStopLoss = closeReasonText.includes("stop loss");
  if (isStopLoss) {
    const result = addToPoolBlacklist({
      poolAddress,
      reason: `stop loss close (pnl ${deploy.pnl_pct?.toFixed(2) ?? "?"}%)`,
    });
    if (result.blacklisted) {
      log("pool-memory", `Pool ${entry.name} blocklisted — stop loss triggered`);
    }
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  return new Date(entry.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}
