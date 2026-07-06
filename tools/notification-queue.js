// Persistent notification queue (2026-06-29) — survives bot restart.
// When a Telegram send fails (network blip, live message blocking, etc.)
// the notification is enqueued to disk. A periodic drain + a poll-recovery
// hook flushes queued notifications when Telegram is reachable again.
//
// Trade-off vs. fire-and-forget: small disk I/O per failed notif, but
// critical money events (close/deploy) are guaranteed to reach the user.
//
// Concurrency: serialized via Promise chain (single-process bot, simple lock).

import fs from "fs";
import path from "path";
import { log } from "../logger.js";

const QUEUE_PATH = path.join(process.cwd(), "logs", "notification-queue.json");

let _queue = [];
let _hydrated = false;
let _lock = Promise.resolve();

function ensureLoaded() {
  if (_hydrated) return;
  try {
    if (fs.existsSync(QUEUE_PATH)) {
      const raw = fs.readFileSync(QUEUE_PATH, "utf-8");
      const data = JSON.parse(raw);
      _queue = Array.isArray(data) ? data : [];
    }
  } catch (e) {
    log("notify_warn", `notification-queue: corrupt file, starting fresh: ${e.message}`);
    try {
      fs.renameSync(QUEUE_PATH, `${QUEUE_PATH}.corrupt.${Date.now()}`);
    } catch {}
    _queue = [];
  }
  _hydrated = true;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(_queue, null, 2));
  } catch (e) {
    log("notify_warn", `notification-queue: persist failed: ${e.message}`);
  }
}

// Serialize concurrent enqueue/flush calls through a promise chain.
function withLock(fn) {
  const release = _lock;
  let unlock;
  _lock = new Promise((r) => (unlock = r));
  return Promise.resolve(release).then(fn).finally(unlock);
}

/** Append a failed notification to the queue. Returns new queue size. */
export async function enqueueNotification(item) {
  return withLock(async () => {
    ensureLoaded();
    _queue.push({
      type: item.type,
      payload: item.payload,
      attempts: 0,
      created_at: new Date().toISOString(),
    });
    persist();
    log(
      "notify_warn",
      `notification-queue: enqueued ${item.type} (${_queue.length} pending)`
    );
    return _queue.length;
  });
}

/**
 * Try to send every queued notification. Successful ones are removed.
 * Failed ones are kept (until attempts >= maxAttemptsPerItem).
 *
 * @param {Object} notifiers - { notifyClose?, notifyDeploy?, notifySwap? }
 *   Each function takes (payload, opts) and opts.fromQueue=true skips
 *   live-message waits to avoid re-deferral loops.
 * @returns {Promise<{sent: number, remaining: number}>}
 */
export async function flushQueue(notifiers, { maxAttemptsPerItem = 5 } = {}) {
  return withLock(async () => {
    ensureLoaded();
    if (_queue.length === 0) return { sent: 0, remaining: 0 };

    const remaining = [];
    let sent = 0;
    let dropped = 0;

    for (const item of _queue) {
      item.attempts = (item.attempts ?? 0) + 1;
      try {
        const handler =
          item.type === "close" ? notifiers.notifyClose :
          item.type === "deploy" ? notifiers.notifyDeploy :
          item.type === "swap" ? notifiers.notifySwap :
          null;

        if (!handler) {
          // Unknown type — drop immediately.
          dropped += 1;
          continue;
        }

        await handler(item.payload, { fromQueue: true });
        sent += 1;
      } catch (e) {
        const msg = e?.message ?? String(e);
        if (item.attempts >= maxAttemptsPerItem) {
          log(
            "notify_error",
            `notification-queue: dropping ${item.type} after ${item.attempts} attempts: ${msg}`
          );
          dropped += 1;
        } else {
          remaining.push(item);
        }
      }
    }

    _queue = remaining;
    persist();

    if (sent > 0 || dropped > 0) {
      log(
        "notify",
        `notification-queue: flush sent=${sent} remaining=${_queue.length} dropped=${dropped}`
      );
    }

    return { sent, remaining: _queue.length, dropped };
  });
}

/** Return queue stats (no side effects, safe for diagnostics). */
export function getQueueStats() {
  ensureLoaded();
  const types = {};
  for (const item of _queue) types[item.type] = (types[item.type] ?? 0) + 1;
  return { pending: _queue.length, types };
}

/** Force-clear the queue (admin use only — does not retry). */
export async function clearQueue() {
  return withLock(async () => {
    ensureLoaded();
    const n = _queue.length;
    _queue = [];
    persist();
    log("notify_warn", `notification-queue: cleared ${n} items`);
    return n;
  });
}
