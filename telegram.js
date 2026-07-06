import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { enqueueNotification, flushQueue as flushNotificationQueue, getQueueStats } from "./tools/notification-queue.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = null;
let _chatIds = []; // 2026-06-29: broadcast notification targets (TELEGRAM_CHAT_IDS = comma-separated list). Single chatId still drives command replies.
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _queueDrainInterval = null;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

// Parse TELEGRAM_CHAT_IDS env var (comma-separated list of notification targets).
// Falls back to single chatId when the multi env is empty so single-chat users
// see no behavior change.
function resolveChatIds() {
  const multi = (process.env.TELEGRAM_CHAT_IDS || "").trim();
  if (!multi) return [];
  const ids = [];
  for (const raw of multi.split(",")) {
    const trimmed = raw.trim();
    if (trimmed) ids.push(trimmed);
  }
  return ids;
}

// ─── chatId persistence ──────────────────────────────────────────
function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
  // user-config wins when set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

function loadChatId() {
  chatId = resolveChatId();
  // _chatIds is the broadcast list for outgoing notifications.
  // Empty list = no broadcast env set → fall back to single chatId so existing
  // single-chat users see no behavior change.
  _chatIds = resolveChatIds();
  if (_chatIds.length === 0 && chatId) {
    _chatIds = [chatId];
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  // Accept incoming from any of the configured chat IDs (broadcast list or fallback single)
  const allowedChats = new Set(_chatIds.length > 0 ? _chatIds : (chatId ? [chatId] : []));
  if (!allowedChats.has(incomingChatId)) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN) return null;
  // If body explicitly specifies chat_id (rare, e.g. some bot flows), honor it.
  if (body && body.chat_id) {
    return postTelegramToChat(method, body, body.chat_id);
  }
  // Default: broadcast to all configured chat IDs.
  if (!chatId) return null;
  if (_chatIds.length <= 1) {
    return postTelegramToChat(method, body, _chatIds[0] || chatId);
  }
  // Multi: send to each chat, capture last successful result.
  let lastResult = null;
  for (const cid of _chatIds) {
    const r = await postTelegramToChat(method, body, cid);
    if (r != null) lastResult = r;
  }
  return lastResult;
}

async function postTelegramToChat(method, body, targetId) {
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envcrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status} for chat ${targetId}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed for chat ${targetId}: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  // Detect valid Telegram HTML tags. If none, send as plain text to avoid 400
  // from stray `<` / `>` in dynamic content (e.g. close_reason like "...12.54% < min 20%").
  // If valid tags present, escape any `<` not part of a valid tag before HTML send.
  const hasValidHtmlTags =
    /<\/?(?:b|i|u|s|strike|del|code|pre)\b/i.test(html) ||
    /<a\s[^>]*href=/i.test(html);
  if (!hasValidHtmlTags) {
    return postTelegram("sendMessage", { text: html.slice(0, 4096) });
  }
  const escaped = html.replace(
    /&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/g,
    "&amp;"
  ).replace(
    /<(?!\/?(?:b|i|u|s|strike|del|code|pre)\b|<a\s)/gi,
    "&lt;"
  );
  return postTelegram("sendMessage", { text: escaped.slice(0, 4096), parse_mode: "HTML" });
}

// ─── Edit message ──────────────────────────────────────────────────────────
export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  let pollErrors = 0;
  let lastErrorStatus = 0;

  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );

      if (!res.ok) {
        lastErrorStatus = res.status;
        const isRateOrServer = res.status === 429 || res.status >= 500;
        if (isRateOrServer) {
          pollErrors++;
          const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, pollErrors));
          const wasRateLimited = res.status === 429;
          log("telegram_warn",
            `Poll ${res.status}${wasRateLimited ? ' RATE LIMITED' : ' SERVER ERROR'} — ` +
            `backoff ${(backoffMs / 1000).toFixed(0)}s (attempt ${pollErrors})`
          );
          await sleep(backoffMs);
          continue;
        }
        // 4xx non-429 (e.g. bad token): wait longer, don't spin
        log("telegram_error", `Poll HTTP ${res.status} — backing off 10s`);
        await sleep(10_000);
        continue;
      }

      // Success: reset error counter
      if (pollErrors > 0) {
        log("telegram", `Poll recovered after ${pollErrors} error(s)`);
        // Drain any notifications queued while telegram was down. Fire-and-forget
        // so we don't block the poll loop.
        flushNotificationQueue({
          notifyClose,
          notifyDeploy,
          notifySwap,
        }).catch((e) => log("notify_warn", `Queue flush on recovery failed: ${e.message}`));
      }
      pollErrors = 0;
      lastErrorStatus = 0;

      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        pollErrors++;
        const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, pollErrors));
        log("telegram_error", `Poll error: ${e.message} — backoff ${(backoffMs / 1000).toFixed(0)}s`);
        await sleep(backoffMs);
      }
    }
  }
}

const BOT_COMMANDS = [
  { command: "help",       description: "Show commands" },
  { command: "status",     description: "Wallet + positions snapshot" },
  { command: "wallet",     description: "Wallet, deploy amount, HiveMind status" },
  { command: "positions",  description: "List open positions" },
  { command: "pool",       description: "Detailed info for one open position" },
  { command: "close",      description: "Close one position by index" },
  { command: "closeall",   description: "Close all open positions" },
  { command: "set",        description: "Set note/instruction on position" },
  { command: "config",     description: "Show important runtime config" },
  { command: "settings",   description: "Button menu for common config" },
  { command: "setcfg",     description: "Update persisted config key" },
  { command: "screen",     description: "Refresh deterministic candidate list" },
  { command: "candidates", description: "Show latest cached candidates" },
  { command: "deploy",     description: "Deploy candidate by cached index" },
  { command: "briefing",   description: "Morning briefing" },
  { command: "hive",       description: "HiveMind sync status" },
  { command: "pause",      description: "Stop cron cycles" },
  { command: "resume",     description: "Start cron cycles again" },
  { command: "stop",       description: "Shut down agent" },
];

async function registerCommands() {
  if (!BASE) return;
  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  loadChatId();
  if (!chatId) {
    log("telegram_warn", "TELEGRAM_CHAT_ID not set in .env or user-config.telegramChatId — outbound notifications and inbound control disabled until configured.");
  }
  _polling = true;
  poll(onMessage); // fire-and-forget
  registerCommands();
  log("telegram", "Bot polling started");

  // Periodic queue drain (2026-06-29). Flushes any pending notifications
  // every 60s even if no poll-recovery event fires. Idempotent.
  // Also: log queue stats on startup so user knows if anything piled up.
  const startupStats = getQueueStats();
  if (startupStats.pending > 0) {
    log(
      "notify_warn",
      `notification-queue: hydrating ${startupStats.pending} pending items ` +
      `(types: ${JSON.stringify(startupStats.types)})`
    );
    flushNotificationQueue({ notifyClose, notifyDeploy, notifySwap })
      .catch((e) => log("notify_warn", `Startup queue flush failed: ${e.message}`));
  }
  _queueDrainInterval = setInterval(() => {
    flushNotificationQueue({ notifyClose, notifyDeploy, notifySwap })
      .catch((e) => log("notify_warn", `Periodic queue flush failed: ${e.message}`));
  }, 60_000);
  // Don't keep the event loop alive just for the ticker — bot can exit cleanly.
  if (_queueDrainInterval.unref) _queueDrainInterval.unref();
}

export function stopPolling() {
  _polling = false;
  if (_queueDrainInterval) {
    clearInterval(_queueDrainInterval);
    _queueDrainInterval = null;
  }
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy(args, opts = {}) {
  const { pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee, strategy, activeBin, shape } = args;
  // Defer up to 60s if a live message is active — the LLM finalizes within seconds
  // in normal operation, so this rarely blocks. After the live message closes,
  // send the structured deploy block. Matches notifyClose behavior.
  if (!opts.fromQueue && hasActiveLiveMessage()) {
    let attempts = 0;
    while (hasActiveLiveMessage() && attempts < 60) {
      await new Promise((r) => setTimeout(r, 1000));
      attempts += 1;
    }
    if (hasActiveLiveMessage()) {
      log("telegram_error", "notifyDeploy timed out waiting for live message to finish — queuing for retry");
      await enqueueNotification({ type: "deploy", payload: args });
      return;
    }
  }
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  const stratStr = strategy || shape
    ? `Strategy: ${strategy || shape}${activeBin != null ? `  |  Active bin: ${activeBin}` : ""}\n`
    : "";
  const msg =
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    stratStr +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendHTML(msg);
      return;
    } catch (e) {
      log("notify_warn", `notifyDeploy attempt ${attempt + 1}/3 failed for ${pair}: ${e.message}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  log("notify_error", `notifyDeploy failed after 3 attempts for ${pair}`);
  if (!opts.fromQueue) {
    await enqueueNotification({ type: "deploy", payload: args });
  } else {
    throw new Error("sendHTML failed after 3 attempts (from queue)");
  }
}

export async function notifyClose(args, opts = {}) {
  const { pair, pnl_sol, pnl_usd, sol_price, pnl_pct, fees_sol, fees_usd, minutes_held, minutes_oor, in_range_pct, close_reason, bin_step, volatility, fee_tvl_ratio } = args;

  // When called from the queue (flush), skip the live-message wait — we already
  // missed the original live window, no point deferring again. Just send.
  if (!opts.fromQueue && hasActiveLiveMessage()) {
    let attempts = 0;
    while (hasActiveLiveMessage() && attempts < 60) {
      await new Promise((r) => setTimeout(r, 1000));
      attempts += 1;
    }
    if (hasActiveLiveMessage()) {
      log("telegram_error", "notifyClose timed out waiting for live message to finish — queuing for retry");
      // Instead of silently dropping, enqueue so a later recovery flush can send it.
      await enqueueNotification({ type: "close", payload: args });
      return;
    }
  }
  const pnlSign = (pnl_sol ?? 0) >= 0 ? "+" : "";
  const emoji = (pnl_sol ?? 0) >= 0 ? "✅" : "❌";
  const volStr = volatility != null ? `${volatility}` : "?";
  const stepStr = bin_step != null ? `${bin_step}` : "?";
  const feeTvlStr = fee_tvl_ratio != null ? `${fee_tvl_ratio}%` : "?";
  const solPriceStr = sol_price > 0 ? `@ $${sol_price.toFixed(2)}` : "(no sol price)";
  const feesUsdStr = fees_usd > 0 ? ` ($${fees_usd.toFixed(3)})` : "";
  const pnlUsdStr = pnl_usd != null ? ` ($${Math.abs(pnl_usd).toFixed(3)})` : "";
  const msg =
    `🟢 <b>CLOSED</b> | ${pair}\n` +
    `💰 PnL : ◎${(pnl_sol ?? 0).toFixed(4)}${pnlUsdStr} (${pnlSign}${(pnl_pct ?? 0).toFixed(2)}%) ${emoji}\n` +
    `💸 Fees : ◎${(fees_sol ?? 0).toFixed(4)}${feesUsdStr}\n` +
    `🤖 Exit : ${close_reason || "agent decision"}\n` +
    `⏱️ Duration : ${minutes_held ?? 0}m | ${in_range_pct ?? 100}% In-Range 🎯\n` +
    `📊 Meta : vol=${volStr} | step=${stepStr} | fee/TVL=${feeTvlStr} | SOL ${solPriceStr}`;
  // sendHTML auto-escapes stray `<` / `>` (e.g. close_reason like "...12.54% < min 35%")
  // and falls back to plain text when no valid HTML tags are present.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendHTML(msg);
      return;
    } catch (e) {
      log("notify_warn", `notifyClose attempt ${attempt + 1}/3 failed for ${pair}: ${e.message}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  log("notify_error", `notifyClose failed after 3 attempts for ${pair}`);
  // Final fallback: enqueue so a recovery flush can deliver the message later.
  if (!opts.fromQueue) {
    await enqueueNotification({ type: "close", payload: args });
  } else {
    // Already from queue — surface failure to caller so flushQueue can re-queue or drop.
    throw new Error("sendHTML failed after 3 attempts (from queue)");
  }
}

export async function notifySwap(args, opts = {}) {
  const { inputSymbol, outputSymbol, amountIn, amountOut, tx } = args;
  if (!opts.fromQueue && hasActiveLiveMessage()) {
    await enqueueNotification({ type: "swap", payload: args });
    return;
  }
  try {
    await sendHTML(
      `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
      `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
      `Tx: <code>${tx?.slice(0, 16)}...</code>`
    );
  } catch (e) {
    if (!opts.fromQueue) {
      log("notify_warn", `notifySwap failed for ${inputSymbol}->${outputSymbol}, queuing: ${e.message}`);
      await enqueueNotification({ type: "swap", payload: args });
    } else {
      throw e;
    }
  }
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
