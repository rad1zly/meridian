/**
 * Pool blacklist — pools the agent should never deploy into.
 *
 * Agent auto-blocklists pools on stop-loss close.
 * Screening filters blacklisted pools before passing candidates to the LLM.
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const BLACKLIST_FILE = repoPath("pool-blacklist.json");

function load() {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  } catch (error) {
    log("pool_blacklist_error", `Invalid ${BLACKLIST_FILE}: ${error.message}`);
    throw new Error(`Safety pool blacklist is unreadable: ${BLACKLIST_FILE}`);
  }
}

function save(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the pool is on the blacklist.
 * Used in screening.js before returning pools to the LLM.
 */
export function isPoolBlacklisted(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  return !!db[poolAddress];
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_pool_blacklist
 */
export function addToPoolBlacklist({ poolAddress, reason }) {
  if (!poolAddress) return { error: "poolAddress required" };

  const db = load();

  if (db[poolAddress]) {
    return {
      already_blacklisted: true,
      poolAddress,
      reason: db[poolAddress].reason,
    };
  }

  db[poolAddress] = {
    reason: reason || "stop loss",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  save(db);
  log("pool_blacklist", `Pool blacklisted: ${poolAddress} — ${reason}`);
  return { blacklisted: true, poolAddress, reason };
}

/**
 * Tool handler: remove_from_pool_blacklist
 */
export function removeFromPoolBlacklist({ poolAddress }) {
  if (!poolAddress) return { error: "poolAddress required" };

  const db = load();

  if (!db[poolAddress]) {
    return { error: `Pool ${poolAddress} not found on blacklist` };
  }

  const entry = db[poolAddress];
  delete db[poolAddress];
  save(db);
  log("pool_blacklist", `Removed pool ${poolAddress} from blacklist`);
  return { removed: true, poolAddress, was: entry };
}

/**
 * Tool handler: list_pool_blacklist
 */
export function listPoolBlacklist() {
  const db = load();
  const entries = Object.entries(db).map(([poolAddress, info]) => ({
    poolAddress,
    ...info,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}
