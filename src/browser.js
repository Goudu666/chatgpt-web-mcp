import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { chromium } from "playwright-core";

import {
  ACTION_TIMEOUT_MS,
  AUTH_CACHE_MS,
  CHATGPT_URL,
  CHROME_EXECUTABLE,
  CONVERSATION_CHANGE_INTERVAL_MS,
  DEFAULT_ANSWER_TIER,
  HEADLESS,
  HISTORY_QUIET_PERIOD_MS,
  MAX_HISTORY_RESULTS,
  BROWSER_STATE_FILE,
  NETWORK_LOG_FILE,
  OPERATION_LOCK_FILE,
  PAGE_INTERACTION_INTERVAL_MS,
  POST_BREAKER_COOLDOWN_MS,
  POST_RESPONSE_CONVERSATION_COOLDOWN_MS,
  PROBE_ACCEPT_CLASSIFICATION,
  PROBE_ACCEPT_PATTERN,
  PROBE_FALLBACK_CLASSIFICATION,
  PROBE_FALLBACK_PATTERN,
  PROBE_POLICY_KEY,
  PROBE_PROMPT,
  PRO_ANSWER_TIER,
  PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
  RECONNECT_DELAY_MS,
  RESPONSE_TIMEOUT_MS,
  RUNTIME_LOCK_FILE,
  RUNTIME_STATE_FILE,
  SEND_INTERVAL_MS,
  SITE_ACTION_INTERVAL_MS,
  USER_DATA_DIR,
} from "./config.js";
import { ChatGPTWebError } from "./errors.js";
import { SELECTORS, TEXT } from "./selectors.js";

function normalize(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function isProModel(value) {
  return /(^|[\s._-])pro($|[\s._-])/i.test(String(value || "").trim());
}

export function isProTier(value) {
  return (
    normalize(value) === normalize(PRO_ANSWER_TIER) ||
    isProModel(value)
  );
}

export function parseAnswerTier(valueText) {
  const text = String(valueText || "").replace(/\s+/g, " ").trim();
  return text ? text.split(/[,，]/, 1)[0]?.trim() || null : null;
}

function matchesConfiguredPattern(text, pattern) {
  try {
    return new RegExp(pattern, "iu").test(text);
  } catch (error) {
    throw new ChatGPTWebError("身份探针的匹配表达式无效。", {
      pattern,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function classifyProbeModel(
  response,
  {
    acceptPattern = PROBE_ACCEPT_PATTERN,
    fallbackPattern = PROBE_FALLBACK_PATTERN,
    acceptClassification = PROBE_ACCEPT_CLASSIFICATION,
    fallbackClassification = PROBE_FALLBACK_CLASSIFICATION,
  } = {},
) {
  const text = String(response || "");
  if (matchesConfiguredPattern(text, acceptPattern)) return acceptClassification;
  if (matchesConfiguredPattern(text, fallbackPattern)) return fallbackClassification;
  return "unknown";
}

export function classifyRateLimitText(text) {
  const body = normalize(text);
  const limited =
    /请求过于频繁|too many requests|request.*too frequent/.test(body) &&
    /稍等|分钟|try again|wait/.test(body);
  if (!limited) return { limited: false, scope: null };

  if (
    /访问对话记录|对话记录|聊天记录|conversation history|chat history|conversation list/.test(
      body,
    )
  ) {
    return { limited: true, scope: "history" };
  }
  if (/发送|消息|生成|回答|prompt|message|generation|response/.test(body)) {
    return { limited: true, scope: "generation" };
  }
  return { limited: true, scope: "unknown" };
}

export function siteActionDelayMs(
  lastActionAt,
  now = Date.now(),
  intervalMs = SITE_ACTION_INTERVAL_MS,
) {
  const elapsed = now - Number(lastActionAt || 0);
  return Math.max(0, Number(intervalMs || 0) - elapsed);
}

export function networkRateLimitScope(pathname) {
  const value = String(pathname || "");
  if (/^\/backend-api\/conversations(?:\/|$)/i.test(value)) return "history";
  if (/^\/backend-api\/conversation(?:\/|$)/i.test(value)) return "generation";
  return "http-429";
}

const CONVERSATION_CHANGE_ACTIONS = new Set([
  "new-chat",
  "enable-temporary-chat",
  "disable-temporary-chat",
  "select-history",
]);

const HISTORY_QUIET_ACTIONS = new Set([
  "new-chat",
  "disable-temporary-chat",
  "open-history-sidebar",
  "open-history-search",
  "search-history",
  "select-history",
]);

function isConversationChangeAction(action) {
  return CONVERSATION_CHANGE_ACTIONS.has(action);
}

function isHistoryQuietAction(action) {
  return HISTORY_QUIET_ACTIONS.has(action);
}

export function siteActionWaitMs(
  state,
  action,
  now = Date.now(),
  {
    siteActionIntervalMs = SITE_ACTION_INTERVAL_MS,
    sendIntervalMs = SEND_INTERVAL_MS,
    conversationChangeIntervalMs = CONVERSATION_CHANGE_INTERVAL_MS,
    postResponseConversationCooldownMs = POST_RESPONSE_CONVERSATION_COOLDOWN_MS,
    postBreakerCooldownMs = POST_BREAKER_COOLDOWN_MS,
  } = {},
) {
  const lastPageActionAt = Math.max(
    Number(state?.lastSiteActionAt || 0),
    Number(state?.lastPageInteractionAt || 0),
  );
  const siteWaitMs = siteActionDelayMs(lastPageActionAt, now, siteActionIntervalMs);
  const sendWaitMs =
    action === "send-prompt"
      ? siteActionDelayMs(state?.lastSendAt, now, sendIntervalMs)
      : 0;
  const conversationChangeWaitMs = isConversationChangeAction(action)
    ? siteActionDelayMs(
        state?.lastConversationChangeAt,
        now,
        conversationChangeIntervalMs,
      )
    : 0;
  const postResponseWaitMs = isConversationChangeAction(action)
    ? siteActionDelayMs(
        state?.lastGenerationCompletedAt,
        now,
        postResponseConversationCooldownMs,
      )
    : 0;
  const historyQuietWaitMs = isHistoryQuietAction(action)
    ? Math.max(0, Number(state?.historyQuietUntil || 0) - now)
    : 0;
  const cooldownWaitMs = state?.postBreakerCooldownPending
    ? siteActionDelayMs(
        state?.circuitBreakerClearedAt,
        now,
        postBreakerCooldownMs,
      )
    : 0;
  return Math.max(
    siteWaitMs,
    sendWaitMs,
    conversationChangeWaitMs,
    postResponseWaitMs,
    historyQuietWaitMs,
    cooldownWaitMs,
  );
}

export function validProbeCache(
  value,
  {
    mode,
    session = {},
    now = Date.now(),
    recheckAfterCloseMs = PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
  } = {},
) {
  if (!value) return null;
  if (value.policyKey !== PROBE_POLICY_KEY) return null;
  if (
    ![PROBE_ACCEPT_CLASSIFICATION, PROBE_FALLBACK_CLASSIFICATION].includes(
      value.classification,
    )
  ) {
    return null;
  }
  if (normalize(value.mode) !== normalize(mode)) return null;

  const browserSessionId = String(session.browserSessionId || "");
  const chatgptPageId = String(session.chatgptPageId || "");
  const legacySessionCanBind =
    !value.browserSessionId &&
    Number(session.browserStartedAt || 0) > 0 &&
    Number(session.browserStartedAt) <= Number(value.checkedAt || 0);
  const sameBrowserSession = value.browserSessionId
    ? value.browserSessionId === browserSessionId
    : legacySessionCanBind;
  const sameChatGPTPage = value.chatgptPageId
    ? value.chatgptPageId === chatgptPageId
    : legacySessionCanBind;

  if (
    session.browserRunning &&
    session.chatgptPageOpen &&
    sameBrowserSession &&
    sameChatGPTPage
  ) {
    if (
      value.browserSessionId === browserSessionId &&
      value.chatgptPageId === chatgptPageId &&
      !value.sessionInterruptedAt &&
      !value.recheckAfter &&
      value.expiresAt == null
    ) {
      return value;
    }
    return {
      ...value,
      browserSessionId,
      chatgptPageId,
      sessionInterruptedAt: null,
      recheckAfter: null,
      expiresAt: null,
    };
  }

  const sessionInterruptedAt = Number(value.sessionInterruptedAt) || now;
  const recheckAfter =
    Number(value.recheckAfter) ||
    sessionInterruptedAt + Number(recheckAfterCloseMs || 0);
  if (now >= recheckAfter) return null;
  if (
    Number(value.sessionInterruptedAt) === sessionInterruptedAt &&
    Number(value.recheckAfter) === recheckAfter
  ) {
    return value;
  }
  return {
    ...value,
    sessionInterruptedAt,
    recheckAfter,
    expiresAt: recheckAfter,
  };
}

export function redactDiagnosticPath(value) {
  return String(value || "")
    .replace(/\/(c|conversation|share)\/[^/?#]+/gi, "/$1/:id")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\b[a-zA-Z0-9_-]{24,}\b/g, ":id");
}

function abortReason(signal) {
  return new ChatGPTWebError("MCP 调用已取消，后台操作已经停止。", {
    cancelled: true,
    cause: signal?.reason instanceof Error ? signal.reason.message : undefined,
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

async function waitWithAbort(ms, signal) {
  throwIfAborted(signal);
  if (!(ms > 0)) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => done(abortReason(signal));
    function done(error) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function raceWithAbort(promise, signal, onAbort) {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      callback(value);
    };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      Promise.resolve(onAbort?.())
        .catch(() => {})
        .finally(() => reject(abortReason(signal)));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function conversationIdFromUrl(value) {
  const match = String(value || "").match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1] || null;
}

function absoluteChatUrl(href) {
  return new URL(href, CHATGPT_URL).toString();
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("无法分配本机调试端口。");
  return port;
}

async function waitForChromeEndpoint(port, process, stderrLines) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (process.exitCode != null) {
      throw new Error(
        `Chrome 在控制通道就绪前退出（${process.exitCode}）：${stderrLines.join("").slice(-1200)}`,
      );
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return endpoint;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`等待 Chrome 本机控制通道超时：${endpoint}`);
}

async function navigate(page, url, options, signal) {
  await waitForPageInteraction("navigate", signal);
  return page.goto(url, options);
}

async function chromeEndpoint(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${endpoint}/json/version`);
    return response.ok ? endpoint : null;
  } catch {
    return null;
  }
}

function browserSessionId(state) {
  const startedAt = Number(state?.startedAt || 0);
  if (!startedAt) return null;
  return [startedAt, Number(state?.pid || 0), Number(state?.port || 0)].join(":");
}

async function browserSessionSnapshot() {
  const state = await readBrowserState();
  const port = Number(state?.port);
  const snapshot = {
    browserRunning: false,
    browserStartedAt: Number(state?.startedAt || 0) || null,
    browserSessionId: browserSessionId(state),
    chatgptPageOpen: false,
    chatgptPageId: null,
  };
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return snapshot;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return snapshot;
    const targets = await response.json();
    const chatgptPage = Array.isArray(targets)
      ? targets.find((target) => {
          if (target?.type !== "page") return false;
          try {
            return /(^|\.)chatgpt\.com$/i.test(new URL(target.url).hostname);
          } catch {
            return false;
          }
        })
      : null;
    return {
      ...snapshot,
      browserRunning: true,
      chatgptPageOpen: Boolean(chatgptPage),
      chatgptPageId: chatgptPage?.id || null,
    };
  } catch {
    return snapshot;
  }
}

async function readBrowserState() {
  try {
    return JSON.parse(await fs.readFile(BROWSER_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeBrowserState(value) {
  await fs.mkdir(path.dirname(BROWSER_STATE_FILE), { recursive: true });
  await fs.writeFile(BROWSER_STATE_FILE, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function readRuntimeState() {
  try {
    return JSON.parse(await fs.readFile(RUNTIME_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function withRuntimeState(update, { signal } = {}) {
  await fs.mkdir(path.dirname(RUNTIME_STATE_FILE), { recursive: true });
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let lock = null;
  while (!lock && Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      lock = await fs.open(RUNTIME_LOCK_FILE, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(RUNTIME_LOCK_FILE).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > ACTION_TIMEOUT_MS) {
        await fs.unlink(RUNTIME_LOCK_FILE).catch(() => {});
        continue;
      }
      await waitWithAbort(50, signal);
    }
  }
  if (!lock) {
    throw new ChatGPTWebError("等待 ChatGPT MCP 的全局节流锁超时。", {
      lock: RUNTIME_LOCK_FILE,
    });
  }

  try {
    const state = await readRuntimeState();
    const { state: nextState = state, result } = await update(state);
    await fs.writeFile(RUNTIME_STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`, {
      mode: 0o600,
    });
    return result;
  } finally {
    await lock.close().catch(() => {});
    await fs.unlink(RUNTIME_LOCK_FILE).catch(() => {});
  }
}

async function waitForSiteAction(action, signal) {
  const initial = await readRuntimeState();
  if (initial.circuitBreaker?.active) {
    throw new ChatGPTWebError(
      "ChatGPT 安全熔断已开启。不会执行新的网页操作；请先人工确认限流提示已经消失。",
      { circuitBreaker: initial.circuitBreaker, action },
    );
  }
  if (initial.activeGeneration?.active) {
    throw new ChatGPTWebError(
      "当前 ChatGPT 页面仍有一条生成任务或尚未确认完成的回答。为避免并发请求，已拒绝新的网页操作。",
      {
        activeGeneration: initial.activeGeneration,
        action,
        nextStep: "只调用 chatgpt_get_latest_response 检查一次；不要重新发送。",
      },
    );
  }
  const now = Date.now();
  const cooldownWaitMs = initial.postBreakerCooldownPending
    ? siteActionDelayMs(
        initial.circuitBreakerClearedAt,
        now,
        POST_BREAKER_COOLDOWN_MS,
      )
    : 0;
  const waitMs = siteActionWaitMs(initial, action, now);
  if (waitMs > 0) await waitWithAbort(waitMs, signal);

  return withRuntimeState(async (state) => {
    if (state.circuitBreaker?.active) {
      throw new ChatGPTWebError(
        "等待期间 ChatGPT 安全熔断已开启，当前网页操作已取消。",
        { circuitBreaker: state.circuitBreaker, action },
      );
    }
    if (state.activeGeneration?.active) {
      throw new ChatGPTWebError(
        "等待期间检测到未完成的生成任务，当前网页操作已取消。",
        { activeGeneration: state.activeGeneration, action },
      );
    }
    const performedAt = Date.now();
    return {
      state: {
        ...state,
        lastSiteActionAt: performedAt,
        lastSiteAction: action,
        lastPageInteractionAt: performedAt,
        lastPageInteraction: `site-action:${action}`,
        ...(isConversationChangeAction(action)
          ? {
              lastConversationChangeAt: performedAt,
              lastConversationChange: action,
            }
          : {}),
        ...(state.postBreakerCooldownPending
          ? { postBreakerCooldownPending: false }
          : {}),
      },
      result: {
        action,
        waitMs,
        siteActionIntervalMs: SITE_ACTION_INTERVAL_MS,
        sendIntervalMs: action === "send-prompt" ? SEND_INTERVAL_MS : null,
        conversationChangeIntervalMs: isConversationChangeAction(action)
          ? CONVERSATION_CHANGE_INTERVAL_MS
          : null,
        postResponseConversationCooldownMs: isConversationChangeAction(action)
          ? POST_RESPONSE_CONVERSATION_COOLDOWN_MS
          : null,
        historyQuietUntil: isHistoryQuietAction(action)
          ? initial.historyQuietUntil || null
          : null,
        postBreakerCooldownApplied: cooldownWaitMs > 0,
        performedAt,
      },
    };
  }, { signal });
}

async function waitForPageInteraction(interaction, signal) {
  const initial = await readRuntimeState();
  if (initial.circuitBreaker?.active) {
    throw new ChatGPTWebError(
      "ChatGPT 安全熔断已开启。不会执行新的页面交互。",
      { circuitBreaker: initial.circuitBreaker, interaction },
    );
  }
  const now = Date.now();
  const regularWaitMs = siteActionDelayMs(
    Math.max(
      Number(initial.lastPageInteractionAt || 0),
      Number(initial.lastSiteActionAt || 0),
    ),
    now,
    PAGE_INTERACTION_INTERVAL_MS,
  );
  const cooldownWaitMs = initial.postBreakerCooldownPending
    ? siteActionDelayMs(
        initial.circuitBreakerClearedAt,
        now,
        POST_BREAKER_COOLDOWN_MS,
      )
    : 0;
  const waitMs = Math.max(regularWaitMs, cooldownWaitMs);
  if (waitMs > 0) await waitWithAbort(waitMs, signal);

  return withRuntimeState(async (state) => {
    if (state.circuitBreaker?.active) {
      throw new ChatGPTWebError(
        "等待期间 ChatGPT 安全熔断已开启，当前页面交互已取消。",
        { circuitBreaker: state.circuitBreaker, interaction },
      );
    }
    const performedAt = Date.now();
    return {
      state: {
        ...state,
        lastPageInteractionAt: performedAt,
        lastPageInteraction: interaction,
        ...(state.postBreakerCooldownPending
          ? { postBreakerCooldownPending: false }
          : {}),
      },
      result: {
        interaction,
        waitMs,
        postBreakerCooldownApplied: cooldownWaitMs > 0,
        performedAt,
      },
    };
  }, { signal });
}

async function updateRuntimeState(fields) {
  return withRuntimeState(async (state) => ({
    state: { ...state, ...fields },
    result: { ...state, ...fields },
  }));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireOperationLock(operation, signal) {
  await fs.mkdir(path.dirname(OPERATION_LOCK_FILE), { recursive: true });
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  const token = `${process.pid}-${Date.now()}`;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let handle;
    try {
      handle = await fs.open(OPERATION_LOCK_FILE, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, operation, startedAt: Date.now(), token })}\n`,
      );
      return async () => {
        await handle.close().catch(() => {});
        const current = await fs
          .readFile(OPERATION_LOCK_FILE, "utf8")
          .then((value) => JSON.parse(value))
          .catch(() => null);
        if (current?.token === token) await fs.unlink(OPERATION_LOCK_FILE).catch(() => {});
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const owner = await fs
        .readFile(OPERATION_LOCK_FILE, "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => null);
      if (!processIsAlive(Number(owner?.pid))) {
        await fs.unlink(OPERATION_LOCK_FILE).catch(() => {});
        continue;
      }
      await waitWithAbort(100, signal);
    }
  }
  const owner = await fs
    .readFile(OPERATION_LOCK_FILE, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => null);
  throw new ChatGPTWebError("另一个 ChatGPT MCP 操作仍在进行，已拒绝并发控制网页。", {
    requestedOperation: operation,
    activeOperation: owner?.operation || null,
    activeSince: owner?.startedAt || null,
  });
}

export function rankTextMatch(items, query, getText = (item) => item) {
  const wanted = normalize(query);
  return items
    .map((item) => {
      const text = normalize(getText(item));
      let score = -1;
      if (text === wanted) score = 100;
      else if (text.startsWith(wanted)) score = 80;
      else if (text.includes(wanted)) score = 60;
      else if (wanted.includes(text)) score = 40;
      return { item, score, text };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
}

export function parseAdvancedRowValue(text, labels) {
  let value = String(text || "").replace(/\s+/g, " ").trim();
  for (const label of labels) {
    value = value.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "");
  }
  return value.replace(/[›>⌄⌃∨∧]+$/g, "").trim() || null;
}

export class ChatGPTBrowser {
  #browser = null;
  #chromeProcess = null;
  #context = null;
  #page = null;
  #queue = Promise.resolve();
  #signedInUntil = 0;
  #settingsCache = null;
  #answerTier = null;
  #requestSignal = null;
  #networkLoggingPages = new WeakSet();

  async close({ terminateBrowser = false } = {}) {
    const chromeProcess = this.#chromeProcess;
    if (this.#browser) {
      await this.#browser.close().catch(() => {});
    }
    if (terminateBrowser) {
      const state = await readBrowserState();
      const pid = chromeProcess?.pid || state?.pid;
      if (chromeProcess && chromeProcess.exitCode == null) chromeProcess.kill("SIGTERM");
      else if (Number.isInteger(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The persistent browser may already be gone.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.unlink(BROWSER_STATE_FILE).catch(() => {});
    }
    this.#browser = null;
    this.#chromeProcess = null;
    this.#context = null;
    this.#page = null;
    this.#signedInUntil = 0;
    this.#settingsCache = null;
    this.#answerTier = null;
  }

  async runExclusive(operation, { signal, name = "tool-call" } = {}) {
    const execute = async () => {
      throwIfAborted(signal);
      const release = await acquireOperationLock(name, signal);
      this.#requestSignal = signal || null;
      try {
        return await raceWithAbort(operation(), signal, () => this.close());
      } finally {
        this.#requestSignal = null;
        // Only disconnect the local CDP controller. The dedicated Chrome
        // process and its ChatGPT tabs remain open for the next call.
        await this.close();
        await release();
      }
    };
    const run = this.#queue.then(execute, execute);
    this.#queue = run.catch(() => {});
    return run;
  }

  signal() {
    return this.#requestSignal;
  }

  async siteAction(action) {
    return waitForSiteAction(action, this.signal());
  }

  async pageInteraction(interaction) {
    return waitForPageInteraction(interaction, this.signal());
  }

  async markSendPerformed() {
    const lastSendAt = Date.now();
    await updateRuntimeState({ lastSendAt });
    return lastSendAt;
  }

  async click(target, interaction, options) {
    await this.pageInteraction(interaction);
    return options === undefined ? target.click() : target.click(options);
  }

  async press(target, key, interaction, options) {
    await this.pageInteraction(interaction);
    return options === undefined ? target.press(key) : target.press(key, options);
  }

  async fill(target, value, interaction, options) {
    await this.pageInteraction(interaction);
    return options === undefined ? target.fill(value) : target.fill(value, options);
  }

  async type(target, value, interaction, options) {
    await this.pageInteraction(interaction);
    return options === undefined ? target.type(value) : target.type(value, options);
  }

  async keyboardPress(page, key, interaction) {
    await this.pageInteraction(interaction);
    return page.keyboard.press(key);
  }

  async domClick(locator, interaction) {
    await this.pageInteraction(interaction);
    return locator.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error("目标控件不是 HTML 元素。");
      element.click();
    });
  }

  async assertActionsAllowed(action = "tool-call") {
    const state = await readRuntimeState();
    if (state.circuitBreaker?.active) {
      throw new ChatGPTWebError(
        "ChatGPT 安全熔断已开启。不会执行新的网页操作；请先人工确认限流提示已经消失。",
        { circuitBreaker: state.circuitBreaker, action },
      );
    }
    if (state.activeGeneration?.active) {
      throw new ChatGPTWebError(
        "当前页面仍有一条生成任务或尚未确认完成的回答，已拒绝新的网页操作。",
        {
          activeGeneration: state.activeGeneration,
          action,
          nextStep: "只调用 chatgpt_get_latest_response 检查一次；不要重新发送。",
        },
      );
    }
    return { allowed: true };
  }

  async circuitBreakerStatus() {
    const state = await readRuntimeState();
    return {
      active: Boolean(state.circuitBreaker?.active),
      circuitBreaker: state.circuitBreaker || null,
      activeGeneration: state.activeGeneration || null,
      historyQuietUntil: state.historyQuietUntil || null,
      historyQuietRemainingMs: Math.max(
        0,
        Number(state.historyQuietUntil || 0) - Date.now(),
      ),
      networkLog: NETWORK_LOG_FILE,
    };
  }

  async clearCircuitBreaker({ confirmed = false } = {}) {
    if (!confirmed) {
      throw new ChatGPTWebError(
        "只有人工确认 ChatGPT 限流提示已经消失后才能清除熔断。",
        { required: { confirmed: true } },
      );
    }
    const clearedAt = Date.now();
    const state = await updateRuntimeState({
      circuitBreaker: null,
      circuitBreakerClearedAt: clearedAt,
      postBreakerCooldownPending: true,
    });
    return {
      active: false,
      clearedAt,
      firstActionCooldownMs: POST_BREAKER_COOLDOWN_MS,
      historyQuietUntil: state.historyQuietUntil || null,
      historyQuietRemainingMs: Math.max(
        0,
        Number(state.historyQuietUntil || 0) - clearedAt,
      ),
    };
  }

  async tripCircuitBreaker(scope, source = "page") {
    return withRuntimeState(async (state) => {
      const nextScope = scope || "unknown";
      const trippedAt = Date.now();
      const genericScopes = new Set(["unknown", "http-429"]);
      const existing = state.circuitBreaker;
      const keepExisting =
        existing?.active &&
        !genericScopes.has(existing.scope) &&
        genericScopes.has(nextScope);
      const circuitBreaker = keepExisting
        ? existing
        : {
            active: true,
            scope: nextScope,
            source,
            trippedAt,
            manualClearRequired: true,
          };
      const historyQuietUntil =
        nextScope === "history"
          ? Math.max(
              Number(state.historyQuietUntil || 0),
              trippedAt + HISTORY_QUIET_PERIOD_MS,
            )
          : state.historyQuietUntil;
      return {
        state: { ...state, circuitBreaker, historyQuietUntil },
        result: circuitBreaker,
      };
    });
  }

  async networkDiagnostics({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const raw = await fs.readFile(NETWORK_LOG_FILE, "utf8").catch(() => "");
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .slice(-safeLimit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { log: NETWORK_LOG_FILE, entries, returned: entries.length };
  }

  async appendNetworkDiagnostic(entry) {
    await fs.mkdir(path.dirname(NETWORK_LOG_FILE), { recursive: true });
    await fs.appendFile(NETWORK_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  attachNetworkDiagnostics(page) {
    if (this.#networkLoggingPages.has(page)) return;
    this.#networkLoggingPages.add(page);
    page.on("response", (response) => {
      const status = response.status();
      if (status !== 403 && status !== 429 && status < 500) return;
      let diagnosticPath;
      try {
        const parsed = new URL(response.url());
        if (!/chatgpt\.com$/i.test(parsed.hostname)) return;
        diagnosticPath = redactDiagnosticPath(parsed.pathname);
      } catch {
        return;
      }
      const entry = {
        timestamp: Date.now(),
        method: response.request().method(),
        path: diagnosticPath,
        status,
        resourceType: response.request().resourceType(),
      };
      this.appendNetworkDiagnostic(entry).catch(() => {});
      if (status === 429) {
        const scope = networkRateLimitScope(diagnosticPath);
        this.tripCircuitBreaker(scope, `network-response:${diagnosticPath}`).catch(() => {});
        page
          .evaluate(
            ({ networkScope, networkPath }) =>
              window.dispatchEvent(
                new CustomEvent("__chatgpt_mcp_network_rate_limit__", {
                  detail: { scope: networkScope, path: networkPath },
                }),
              ),
            { networkScope: scope, networkPath: diagnosticPath },
          )
          .catch(() => {});
      }
    });
  }

  async launch() {
    if (this.#context && this.#page && !this.#page.isClosed()) {
      return this.#page;
    }

    await fs.mkdir(USER_DATA_DIR, { recursive: true });

    if (!CHROME_EXECUTABLE) {
      throw new ChatGPTWebError(
        "没有检测到 Chrome、Chromium 或 Edge。请安装浏览器，或设置 CHATGPT_WEB_CHROME。",
        { platform: process.platform, environmentVariable: "CHATGPT_WEB_CHROME" },
      );
    }

    try {
      const prior = await readBrowserState();
      const priorEndpoint = await chromeEndpoint(Number(prior?.port));
      if (priorEndpoint) {
        this.#browser = await chromium.connectOverCDP(priorEndpoint);
        this.#context = this.#browser.contexts()[0];
        if (!this.#context) throw new Error("常驻 Chrome 没有返回默认浏览器上下文。");
      }

      if (!this.#context && prior?.lastFailureAt) {
        const remaining = RECONNECT_DELAY_MS - (Date.now() - Number(prior.lastFailureAt));
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      }

      if (!this.#context) {
        await this.siteAction("launch-chatgpt");
        const port = await freeLoopbackPort();
        const stderrLines = [];
        const args = [
          `--user-data-dir=${USER_DATA_DIR}`,
          "--profile-directory=Default",
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-mode",
          "--start-maximized",
          "--new-window",
        ];
        if (HEADLESS) args.push("--headless=new");
        args.push(CHATGPT_URL);

        this.#chromeProcess = spawn(CHROME_EXECUTABLE, args, {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        this.#chromeProcess.unref();

        const endpoint = await waitForChromeEndpoint(port, this.#chromeProcess, stderrLines);
        this.#browser = await chromium.connectOverCDP(endpoint);
        this.#context = this.#browser.contexts()[0];
        if (!this.#context) throw new Error("Chrome 没有返回默认浏览器上下文。");
        await writeBrowserState({
          port,
          pid: this.#chromeProcess.pid,
          startedAt: Date.now(),
          profile: USER_DATA_DIR,
        });
        await updateRuntimeState({ authenticatedUntil: 0 });
      }
    } catch (error) {
      await writeBrowserState({
        ...(await readBrowserState()),
        lastFailureAt: Date.now(),
        profile: USER_DATA_DIR,
      }).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (/SingletonLock|profile.*in use|ProcessSingleton|already running/i.test(message)) {
        throw new ChatGPTWebError(
          "ChatGPT MCP 的专用浏览器配置正在被另一个进程使用。请关闭登录窗口或另一个 MCP 实例后重试。",
          { profile: USER_DATA_DIR },
        );
      }
      throw new ChatGPTWebError("无法启动 ChatGPT MCP 的专用浏览器。", {
        cause: message,
        chrome: CHROME_EXECUTABLE,
        profile: USER_DATA_DIR,
      });
    }

    this.#context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    this.#page =
      this.#context.pages().find((page) => /chatgpt\.com/i.test(page.url())) ||
      this.#context.pages()[0] ||
      (await this.#context.newPage());
    const trackPage = (page) => {
      if (/chatgpt\.com/i.test(page.url())) this.#page = page;
      this.attachNetworkDiagnostics(page);
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && /chatgpt\.com/i.test(frame.url())) this.#page = page;
      });
    };
    this.#context.pages().forEach(trackPage);
    this.#context.on("page", trackPage);

    if (!/chatgpt\.com/i.test(this.#page.url())) {
      await this.siteAction("open-chatgpt");
      await navigate(
        this.#page,
        CHATGPT_URL,
        { waitUntil: "domcontentloaded" },
        this.signal(),
      );
    }

    return this.#page;
  }

  async browserLifecycle() {
    const state = await readBrowserState();
    const runtime = await readRuntimeState();
    const browserRunning = processIsAlive(Number(state?.pid));
    return {
      persistent: true,
      browserRunning,
      reconnectDelayMs: RECONNECT_DELAY_MS,
      siteActionIntervalMs: SITE_ACTION_INTERVAL_MS,
      pageInteractionIntervalMs: PAGE_INTERACTION_INTERVAL_MS,
      sendIntervalMs: SEND_INTERVAL_MS,
      conversationChangeIntervalMs: CONVERSATION_CHANGE_INTERVAL_MS,
      postResponseConversationCooldownMs: POST_RESPONSE_CONVERSATION_COOLDOWN_MS,
      postBreakerCooldownMs: POST_BREAKER_COOLDOWN_MS,
      historyQuietPeriodMs: HISTORY_QUIET_PERIOD_MS,
      proProbeRecheckAfterCloseMs: PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
      pid: state?.pid || null,
      port: state?.port || null,
      lastSiteAction: runtime.lastSiteAction || null,
      lastSiteActionAt: runtime.lastSiteActionAt || null,
      circuitBreaker: runtime.circuitBreaker || null,
      activeGeneration: runtime.activeGeneration || null,
      lastGenerationCompletedAt: runtime.lastGenerationCompletedAt || null,
      lastConversationChangeAt: runtime.lastConversationChangeAt || null,
      historyQuietUntil: runtime.historyQuietUntil || null,
      historyQuietRemainingMs: Math.max(
        0,
        Number(runtime.historyQuietUntil || 0) - Date.now(),
      ),
      postBreakerCooldownPending: Boolean(runtime.postBreakerCooldownPending),
    };
  }

  async terminateBrowser() {
    const state = await readBrowserState();
    const runtime = await readRuntimeState();
    const closedAt = Date.now();
    const reliableProbe =
      runtime.proProbe?.policyKey === PROBE_POLICY_KEY &&
      [PROBE_ACCEPT_CLASSIFICATION, PROBE_FALLBACK_CLASSIFICATION].includes(
        runtime.proProbe?.classification,
      )
        ? {
            ...runtime.proProbe,
            sessionInterruptedAt: closedAt,
            recheckAfter: closedAt + PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
            expiresAt: closedAt + PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
          }
        : null;
    await this.close({ terminateBrowser: true });
    await updateRuntimeState({ authenticatedUntil: 0, proProbe: reliableProbe });
    return {
      closed: true,
      pid: state?.pid || null,
      proProbeRecheckAfter: reliableProbe?.recheckAfter || null,
    };
  }

  async page() {
    await this.launch();
    const liveChatGPTPage = this.#context
      .pages()
      .find((page) => !page.isClosed() && /chatgpt\.com/i.test(page.url()));
    if (liveChatGPTPage) this.#page = liveChatGPTPage;
    return this.#page;
  }

  async openLogin() {
    const page = await this.page();
    await this.siteAction("open-login");
    await navigate(
      page,
      new URL("/auth/login", CHATGPT_URL).toString(),
      { waitUntil: "domcontentloaded" },
      this.signal(),
    );
    this.#signedInUntil = 0;
    await updateRuntimeState({ authenticatedUntil: 0 });
    return {
      url: page.url(),
      automationFlag: await page.evaluate(() => navigator.webdriver),
      profile: USER_DATA_DIR,
    };
  }

  async firstVisible(selectors, { timeout = 1_000 } = {}) {
    const page = await this.page();
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout })) return locator;
      } catch {
        // Try the next semantic fallback.
      }
    }
    return null;
  }

  async composer() {
    const page = await this.page();
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const locator = await this.firstVisible(SELECTORS.composer, { timeout: 400 });
      if (locator) return locator;
      await page.waitForTimeout(250);
    }
    return null;
  }

  async signedIn() {
    if (Date.now() < this.#signedInUntil) return true;
    const page = await this.page();
    const loginControls = page.locator(
      "button[data-testid='login-button']:visible, button[data-testid='signup-button']:visible",
    );
    if ((await loginControls.count()) > 0) {
      this.#signedInUntil = 0;
      await updateRuntimeState({ authenticatedUntil: 0 });
      return false;
    }

    const runtime = await readRuntimeState();
    if (Number(runtime.authenticatedUntil) > Date.now()) {
      this.#signedInUntil = Number(runtime.authenticatedUntil);
      return true;
    }

    const profile = page.locator("[data-testid='accounts-profile-button']:visible").first();
    const history = page.locator("a[href^='/c/']:visible").first();
    const workspaceControls = page.locator(
      "button[aria-label*='profile' i]:visible, button[aria-label*='个人资料']:visible",
    ).first();
    if (
      (await profile.count()) > 0 ||
      (await history.count()) > 0 ||
      (await workspaceControls.count()) > 0
    ) {
      const authenticatedUntil = Date.now() + AUTH_CACHE_MS;
      this.#signedInUntil = authenticatedUntil;
      await updateRuntimeState({ authenticatedUntil });
      return true;
    }

    const composer = await this.composer();
    if (!composer) return false;
    const authenticatedUntil = Date.now() + AUTH_CACHE_MS;
    this.#signedInUntil = authenticatedUntil;
    await updateRuntimeState({ authenticatedUntil });
    return true;
  }

  async ensureSignedIn() {
    const page = await this.page();
    const body = normalize(await page.locator("body").innerText().catch(() => ""));
    const rateLimit = classifyRateLimitText(body);
    if (rateLimit.limited) {
      const circuitBreaker = await this.tripCircuitBreaker(rateLimit.scope, "page-text");
      throw new ChatGPTWebError(
        "ChatGPT 网页出现请求频率限制，安全熔断已开启。不会继续或自动重试。",
        {
          url: page.url(),
          retryManually: false,
          scope: rateLimit.scope,
          circuitBreaker,
        },
      );
    }
    if (await this.signedIn()) return;

    const loginVisible = TEXT.login.some((label) => body.includes(normalize(label)));
    const cloudflare = /just a moment|checking your browser|verify you are human|安全验证/.test(body);

    throw new ChatGPTWebError(
      cloudflare
        ? "ChatGPT 网页正在等待人工安全验证。请运行 npm run login 并在浏览器中完成验证。"
        : "ChatGPT MCP 的专用浏览器尚未登录。请在项目目录运行 npm run login，完成登录后再调用。",
      {
        url: page.url(),
        loginVisible,
        profile: USER_DATA_DIR,
      },
    );
  }

  isRateLimitedText(text) {
    return classifyRateLimitText(text).limited;
  }

  async throwIfRateLimited() {
    const page = await this.page();
    const body = await page.locator("body").innerText().catch(() => "");
    const rateLimit = classifyRateLimitText(body);
    if (rateLimit.limited) {
      const circuitBreaker = await this.tripCircuitBreaker(rateLimit.scope, "page-text");
      throw new ChatGPTWebError(
        "ChatGPT 网页出现请求频率限制，已停止当前操作并开启安全熔断。",
        {
          url: page.url(),
          retryManually: false,
          scope: rateLimit.scope,
          circuitBreaker,
        },
      );
    }
    return rateLimit;
  }

  cachedSettings() {
    return this.#settingsCache?.expiresAt > Date.now()
      ? this.#settingsCache.value
      : { model: null, thinkingLevel: null };
  }

  async status({ includeSettings = false } = {}) {
    const page = await this.page();
    const signedIn = await this.signedIn();
    const settings =
      signedIn && includeSettings ? await this.advancedSettings() : this.cachedSettings();
    return {
      browserRunning: true,
      signedIn,
      url: page.url(),
      title: await page.title(),
      conversationId: conversationIdFromUrl(page.url()),
      model: signedIn ? settings.model : null,
      mode: signedIn ? await this.currentMode() : null,
      thinkingLevel: signedIn ? settings.thinkingLevel : null,
      temporary: signedIn ? await this.temporaryState() : null,
      profile: USER_DATA_DIR,
    };
  }

  async openRoot({ temporary = false } = {}) {
    const page = await this.page();
    await this.ensureSignedIn();
    const currentTemporary = await this.temporaryState();
    const userCount = await this.userLocator().count();
    const assistantCount = await this.assistantLocator().count();
    const currentUrl = new URL(page.url());
    const blank =
      currentUrl.pathname === "/" &&
      userCount === 0 &&
      assistantCount === 0 &&
      Boolean(await this.composer());
    let navigation = "reused-blank-page";

    if (!(blank && currentTemporary === temporary)) {
      if (!blank) {
        const newChat = await this.firstVisible(SELECTORS.newChatLinks, { timeout: 1_500 });
        if (newChat) {
          await this.siteAction("new-chat");
          // ChatGPT can animate two overlapping sidebar layers. A regular
          // Playwright click then waits on an inner SVG that intercepts the
          // pointer even though the semantic new-chat link is visible.
          await this.domClick(newChat, "new-chat-click");
          await page
            .waitForFunction(
              ({ userSelectors, assistantSelectors }) =>
                location.pathname === "/" &&
                document.querySelectorAll(userSelectors).length === 0 &&
                document.querySelectorAll(assistantSelectors).length === 0,
              {
                userSelectors: SELECTORS.userMessages.join(", "),
                assistantSelectors: SELECTORS.assistantMessages.join(", "),
              },
              { timeout: ACTION_TIMEOUT_MS },
            )
            .catch(() => {});
          navigation = "in-page-new-chat";
        }
      }

      const afterNewChatUrl = new URL(page.url());
      const afterNewChatBlank =
        afterNewChatUrl.pathname === "/" &&
        (await this.userLocator().count()) === 0 &&
        (await this.assistantLocator().count()) === 0;
      if (afterNewChatBlank && (await this.temporaryState()) !== temporary) {
        await this.setTemporary(temporary, { includeStatus: false });
        navigation =
          navigation === "in-page-new-chat"
            ? "in-page-new-chat-and-temporary-toggle"
            : "temporary-toggle";
      }

      const afterClickUserCount = await this.userLocator().count();
      const afterClickAssistantCount = await this.assistantLocator().count();
      const afterClickUrl = new URL(page.url());
      const needsFallback =
        afterClickUrl.pathname !== "/" ||
        afterClickUserCount > 0 ||
        afterClickAssistantCount > 0 ||
        (await this.temporaryState()) !== temporary;
      if (needsFallback) {
        throw new ChatGPTWebError(
          "站内新建或临时对话切换后未通过校验。为避免重新加载整个 ChatGPT，操作已停止。",
          {
            requestedTemporary: temporary,
            observedUrl: page.url(),
            userMessageCount: afterClickUserCount,
            assistantMessageCount: afterClickAssistantCount,
          },
        );
      }
    }

    await this.ensureSignedIn();
    const composer = await this.composer();
    if (!composer) throw new ChatGPTWebError("新对话页面未出现输入框。", { url: page.url() });
    this.#settingsCache = null;
    this.#answerTier = null;
    return {
      url: page.url(),
      conversationId: conversationIdFromUrl(page.url()),
      temporary: await this.temporaryState(),
      navigation,
    };
  }

  async newChat(
    { temporary = false, model, mode, thinkingLevel, answerTier } = {},
    { includeStatus = true } = {},
  ) {
    const root = await this.openRoot({ temporary });
    if (mode) await this.selectMode(mode);
    if (model) await this.selectModel(model);
    if (thinkingLevel) await this.selectThinkingLevel(thinkingLevel);
    if (answerTier) await this.selectAnswerTier(answerTier);
    if (temporary && !root.temporary) await this.setTemporary(true, { includeStatus: false });
    if (includeStatus) return this.status();
    return {
      ...root,
      configured: {
        mode: mode || null,
        model: model || null,
        thinkingLevel: thinkingLevel || null,
        answerTier: answerTier || null,
      },
    };
  }

  async temporaryState() {
    const page = await this.page();
    const url = new URL(page.url());
    if (url.searchParams.get("temporary-chat") === "true") return true;

    const button = await this.firstVisible(SELECTORS.temporaryChatButtons, { timeout: 300 });
    if (button) {
      const pressed = await button.getAttribute("aria-pressed");
      const checked = await button.getAttribute("aria-checked");
      const state = await button.getAttribute("data-state");
      if (pressed != null) return pressed === "true";
      if (checked != null) return checked === "true";
      if (state) return /on|checked|active/i.test(state);
      const label = normalize(
        `${await button.getAttribute("aria-label")} ${await button.innerText().catch(() => "")}`,
      );
      if (/turn off|关闭临时|退出临时/.test(label)) return true;
      if (/turn on|开启临时|临时对话|临时聊天/.test(label)) return false;
    }

    const body = normalize(await page.locator("body").innerText().catch(() => ""));
    if (
      /won't appear in your history|不会出现在历史记录|temporary chat is on|临时聊天已开启|这是临时聊天/.test(
        body,
      )
    ) {
      return true;
    }
    return false;
  }

  async setTemporary(enabled, { includeStatus = true } = {}) {
    await this.ensureSignedIn();
    const page = await this.page();
    const current = await this.temporaryState();
    if (current === enabled) {
      return includeStatus
        ? this.status()
        : { enabled: current, changed: false, url: page.url() };
    }

    const button = await this.firstVisible(SELECTORS.temporaryChatButtons, { timeout: 1_500 });
    if (button) {
      await this.siteAction(enabled ? "enable-temporary-chat" : "disable-temporary-chat");
      await this.click(button, enabled ? "enable-temporary-chat-click" : "disable-temporary-chat-click");
      await page.waitForTimeout(500);
    } else {
      throw new ChatGPTWebError(
        "没有找到临时对话开关。为避免重新加载整个 ChatGPT，操作已停止。",
        { requested: enabled, url: page.url() },
      );
    }

    const verified = await this.temporaryState();
    if (verified !== enabled) {
      throw new ChatGPTWebError("临时对话状态切换后未通过页面校验。", {
        requested: enabled,
        observed: verified,
        url: page.url(),
      });
    }
    return includeStatus
      ? this.status()
      : { enabled: verified, changed: true, url: page.url() };
  }

  async modelButton() {
    return this.firstVisible(SELECTORS.modelButtons, { timeout: 500 });
  }

  async modeOptions() {
    const page = await this.page();
    const controls = page.locator(SELECTORS.modeButtons.join(", "));
    const raw = await controls.evaluateAll((elements) =>
      elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
        })
        .map((element) => ({
          name: (element.innerText || element.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim(),
          selected:
            element.getAttribute("aria-checked") === "true" ||
            element.getAttribute("aria-pressed") === "true",
        })),
    );
    return uniqueBy(raw.filter((item) => item.name), (item) => normalize(item.name));
  }

  async currentMode() {
    const modes = await this.modeOptions();
    return modes.find((item) => item.selected)?.name || null;
  }

  async listModes() {
    await this.ensureSignedIn();
    const modes = await this.modeOptions();
    return { current: modes.find((item) => item.selected)?.name || null, modes };
  }

  async capabilities({ historyLimit = 5 } = {}) {
    await this.ensureSignedIn();
    const page = await this.page();
    const modes = await this.modeOptions();
    const settings = await this.advancedSettings();
    const conversations = (await this.historyLinks()).slice(
      0,
      Math.max(0, Math.min(Number(historyLimit) || 0, MAX_HISTORY_RESULTS)),
    );
    return {
      url: page.url(),
      conversationId: conversationIdFromUrl(page.url()),
      mode: modes.find((item) => item.selected)?.name || null,
      modes,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      temporary: await this.temporaryState(),
      visibleHistory: conversations,
    };
  }

  async selectMode(mode) {
    await this.ensureSignedIn();
    const page = await this.page();
    const modes = await this.modeOptions();
    const matches = rankTextMatch(modes, mode, (item) => item.name);
    if (!matches.length) {
      throw new ChatGPTWebError("请求的工作模式不在当前页面显示的选项中。", {
        requested: mode,
        available: modes.map((item) => item.name),
      });
    }
    const best = matches[0];
    const tied = matches.filter((entry) => entry.score === best.score);
    if (best.score < 100 && tied.length > 1) {
      throw new ChatGPTWebError("工作模式名称匹配到多个选项，请使用完整名称。", {
        requested: mode,
        matches: tied.map((entry) => entry.item.name),
      });
    }

    if (best.item.selected) {
      return { requested: mode, selected: best.item.name, changed: false };
    }

    const option = page.getByRole("radio", { name: best.item.name, exact: true }).last();
    await this.click(option, "select-mode");
    await page.waitForTimeout(250);
    const selected = await this.currentMode();
    if (normalize(selected) !== normalize(best.item.name)) {
      throw new ChatGPTWebError("工作模式切换后未通过页面校验。", {
        requested: mode,
        observed: selected,
      });
    }
    this.#settingsCache = null;
    return { requested: mode, selected };
  }

  async advancedControlButton() {
    const page = await this.page();
    const composer = await this.composer();
    const composerBox = await composer?.boundingBox();
    if (!composerBox) return null;

    // This class is on the answer-tier pill itself in the current ChatGPT UI.
    // It is unique to the composer and therefore safer than inferring a parent
    // <main> when temporary-chat layouts render multiple main regions.
    const semanticTierButton = page.locator("button.__composer-pill:visible").last();
    if (await semanticTierButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      return semanticTierButton;
    }

    // The current ChatGPT UI no longer consistently exposes aria-haspopup on
    // the answer-tier button (for example, the visible button may only say
    // “极高”). Use its position beside the composer plus semantic exclusions.
    // Resolve the exact <main> that owns this composer. ChatGPT can render
    // another <main> earlier in the DOM, so page.locator("main").first()
    // can silently search the wrong subtree.
    const composerMain = composer.locator("xpath=ancestor::main[1]");
    const scope = (await composerMain.count()) > 0 ? composerMain : page.locator("main").last();
    const candidates = scope.locator("button:visible, [role='button']:visible");
    const count = await candidates.count();
    let best = null;
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const text = (
        (await candidate.innerText().catch(() => "")) ||
        (await candidate.getAttribute("aria-label")) ||
        (await candidate.getAttribute("title")) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      const box = await candidate.boundingBox();
      if (!text || text.length > 40 || !box) continue;
      if (
        /聊天|工作|chat|work|语音|听写|voice|dictation|添加|文件|attach|upload|发送|停止|send|stop|麦克风|microphone/i.test(
          text,
        )
      ) {
        continue;
      }

      const centerY = box.y + box.height / 2;
      const centerX = box.x + box.width / 2;
      const composerCenterY = composerBox.y + composerBox.height / 2;
      const distance = Math.abs(centerY - composerCenterY);
      if (distance > Math.max(90, composerBox.height * 2)) continue;
      const answerTierBonus = /^(快速|标准|较高|高|极高|pro|fast|standard|high|very high)$/i.test(
        text,
      )
        ? -100
        : 0;
      const horizontalDistance = Math.abs(centerX - (composerBox.x + composerBox.width));
      const score = distance + horizontalDistance * 0.02 + answerTierBonus;
      if (!best || score < best.score) best = { locator: candidate, score };
    }
    return best?.locator || null;
  }

  async answerTierSliderState(slider) {
    if (!slider) return null;
    return slider.evaluate((element) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const number = (name, fallback) => {
        const raw = element.getAttribute(name) ?? fallback;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
      };
      const valueText =
        element.getAttribute("aria-valuetext") ||
        element.getAttribute("aria-label") ||
        input?.value ||
        (element.textContent || "").replace(/\s+/g, " ").trim() ||
        null;
      return {
        valueText,
        current: valueText ? valueText.split(/[,，]/, 1)[0].trim() : null,
        now: number("aria-valuenow", input?.value),
        min: number("aria-valuemin", input?.min),
        max: number("aria-valuemax", input?.max),
      };
    });
  }

  async answerTierControlLabel() {
    const trigger = await this.advancedControlButton();
    if (!trigger) return null;
    const values = await trigger.evaluate((element) => ({
      text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
      ariaLabel: element.getAttribute("aria-label") || "",
      title: element.getAttribute("title") || "",
    }));
    const explicitPro = [values.text, values.ariaLabel, values.title].find((value) =>
      /(^|[\s._-])pro($|[\s._-])/i.test(value),
    );
    return explicitPro ? "Pro" : parseAnswerTier(values.text || values.ariaLabel || values.title);
  }

  async openAnswerTierControl() {
    await this.ensureSignedIn();
    const page = await this.page();
    const trigger = await this.advancedControlButton();
    if (!trigger) {
      throw new ChatGPTWebError("没有找到输入框右侧的能力档位控件。", { url: page.url() });
    }
    await this.click(trigger, "open-answer-tier-control");
    await page.waitForTimeout(180);
    const slider = await this.firstVisible(SELECTORS.answerTierSliders, { timeout: 1_500 });
    return { trigger, slider };
  }

  async openAnswerTierSlider() {
    const { slider } = await this.openAnswerTierControl();
    if (slider) return slider;
    const page = await this.page();
    await this.closeAdvancedMenus();
    throw new ChatGPTWebError("能力档位菜单已打开，但没有找到其滑杆。", { url: page.url() });
  }

  async selectVisibleAnswerTierOption(answerTier) {
    const page = await this.page();
    const matches = page.getByText(answerTier, { exact: true });
    for (let index = (await matches.count()) - 1; index >= 0; index -= 1) {
      const text = matches.nth(index);
      if (!(await text.isVisible().catch(() => false))) continue;
      const interactive = text.locator(
        "xpath=ancestor-or-self::*[self::button or @role='button' or @role='menuitem' or @role='menuitemradio' or @role='option' or @tabindex][1]",
      );
      const target = (await interactive.count()) > 0 ? interactive : text;
      await this.domClick(target, "select-answer-tier-option");
      await page.waitForTimeout(250);
      await this.closeAdvancedMenus();
      const displayed = await this.answerTierControlLabel();
      if (normalize(displayed) === normalize(answerTier)) {
        return { selected: displayed, verifiedBy: "visible-menu-option" };
      }
      return null;
    }
    return null;
  }

  async answerTierStatus() {
    const displayed = await this.answerTierControlLabel();
    const { slider } = await this.openAnswerTierControl();
    if (!slider) {
      const options = await this.visibleMenuOptions({ exclude: [displayed] });
      await this.closeAdvancedMenus();
      if (displayed) this.#answerTier = displayed;
      return {
        current: displayed,
        type: "menu",
        options: options.map((item) => item.name),
      };
    }
    const state = await this.answerTierSliderState(slider);
    await this.closeAdvancedMenus();
    if (state?.current) this.#answerTier = state.current;
    return { ...state, type: "slider" };
  }

  async selectAnswerTier(answerTier) {
    const wanted = normalize(answerTier);
    const displayedBefore = await this.answerTierControlLabel();
    if (normalize(displayedBefore) === wanted) {
      this.#answerTier = displayedBefore;
      return {
        requested: answerTier,
        selected: displayedBefore,
        changed: false,
        verifiedBy: "displayed-tier-control",
      };
    }
    const { slider } = await this.openAnswerTierControl();
    const menuSelection = slider
      ? null
      : await this.selectVisibleAnswerTierOption(answerTier);
    if (menuSelection) {
      this.#answerTier = menuSelection.selected;
      return {
        requested: answerTier,
        selected: menuSelection.selected,
        changed: true,
        verifiedBy: menuSelection.verifiedBy,
      };
    }
    if (!slider) {
      await this.closeAdvancedMenus();
      throw new ChatGPTWebError("能力档位菜单中没有找到目标档位，也没有可访问滑杆。", {
        requested: answerTier,
        displayedBefore,
        url: (await this.page()).url(),
      });
    }
    const before = await this.answerTierSliderState(slider);
    if (normalize(before?.current) === wanted) {
      this.#answerTier = before.current;
      await this.closeAdvancedMenus();
      return { requested: answerTier, selected: before.current, changed: false, control: before };
    }

    if (!isProTier(answerTier)) {
      await this.closeAdvancedMenus();
      throw new ChatGPTWebError(
        "能力滑杆目前只支持按可访问名称直接选择 Pro；其他档位请传模型和思考强度。",
        { requested: answerTier, current: before },
      );
    }

    await slider.focus();
    await this.press(slider, "End", "answer-tier-end");
    await (await this.page()).waitForTimeout(250);
    let selected = await this.answerTierSliderState(slider);
    if (!isProTier(selected?.current)) {
      for (let step = 0; step < 8 && !isProTier(selected?.current); step += 1) {
        const previous = selected?.valueText;
        await this.press(slider, "ArrowRight", "answer-tier-increment");
        await (await this.page()).waitForTimeout(120);
        selected = await this.answerTierSliderState(slider);
        if (selected?.valueText === previous && selected?.max === selected?.now) break;
      }
    }
    await this.closeAdvancedMenus();
    const displayed = await this.answerTierControlLabel();
    const verifiedTier = isProTier(selected?.current)
      ? selected.current
      : isProTier(displayed)
        ? displayed
        : null;
    if (!verifiedTier) {
      throw new ChatGPTWebError("能力档位没有切换到 Pro，因此未发送提示词。", {
        requested: answerTier,
        before,
        observed: selected,
        displayed,
      });
    }
    this.#answerTier = verifiedTier;
    return {
      requested: answerTier,
      selected: verifiedTier,
      changed: normalize(before?.current) !== normalize(verifiedTier),
      before,
      control: selected,
      verifiedBy: isProTier(selected?.current) ? "slider-text" : "displayed-tier-control",
    };
  }

  async selectExtremeTier(answerTier = DEFAULT_ANSWER_TIER) {
    const displayedBefore = await this.answerTierControlLabel();
    if (normalize(displayedBefore) === normalize(answerTier)) {
      this.#answerTier = answerTier;
      return {
        requested: answerTier,
        selected: answerTier,
        changed: false,
        verifiedBy: "displayed-tier-control",
      };
    }

    const { slider } = await this.openAnswerTierControl();
    const menuSelection = slider
      ? null
      : await this.selectVisibleAnswerTierOption(answerTier);
    if (menuSelection) {
      this.#answerTier = answerTier;
      return {
        requested: answerTier,
        selected: answerTier,
        changed: true,
        verifiedBy: menuSelection.verifiedBy,
      };
    }
    if (!slider) {
      await this.closeAdvancedMenus();
      throw new ChatGPTWebError("能力档位菜单中没有找到默认档位，也没有可访问滑杆。", {
        requested: answerTier,
        displayedBefore,
        url: (await this.page()).url(),
      });
    }
    const before = await this.answerTierSliderState(slider);
    await slider.focus();
    await this.press(slider, "End", "extreme-tier-end");
    await (await this.page()).waitForTimeout(120);
    await this.press(slider, "ArrowLeft", "extreme-tier-decrement");
    await (await this.page()).waitForTimeout(250);
    const observed = await this.answerTierSliderState(slider);
    await this.closeAdvancedMenus();
    const displayed = await this.answerTierControlLabel();
    if (normalize(displayed) !== normalize(answerTier)) {
      throw new ChatGPTWebError("能力档位没有切换到配置的默认档位，因此未发送提示词。", {
        requested: answerTier,
        before,
        observed,
        displayed,
      });
    }
    this.#answerTier = answerTier;
    return {
      requested: answerTier,
      selected: answerTier,
      changed: true,
      before,
      control: observed,
      verifiedBy: "displayed-tier-control",
    };
  }

  async advancedRow(labels) {
    const page = await this.page();
    for (const label of labels) {
      const matches = page.getByText(label, { exact: true });
      for (let index = (await matches.count()) - 1; index >= 0; index -= 1) {
        const locator = matches.nth(index);
        if (!(await locator.isVisible().catch(() => false))) continue;
        const rowText = await locator.evaluate((element, exactLabel) => {
          let node = element;
          for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
            const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
            const rect = node.getBoundingClientRect();
            if (text !== exactLabel && text.length <= 180 && rect.height > 20 && rect.height <= 120) {
              return text;
            }
          }
          return exactLabel;
        }, label);
        const interactive = locator.locator(
          "xpath=ancestor-or-self::*[self::button or @role='button' or @role='menuitem' or @role='menuitemradio' or @role='option' or @tabindex][1]",
        );
        return {
          label,
          locator: (await interactive.count()) > 0 ? interactive : locator,
          text: rowText,
          value: parseAdvancedRowValue(rowText, labels),
        };
      }
    }
    return null;
  }

  async clickAdvancedRow(row) {
    if (!row?.locator) throw new ChatGPTWebError("高级菜单行缺少可点击元素。");
    await this.domClick(row.locator, "advanced-menu-row");
    await (await this.page()).waitForTimeout(180);
  }

  async closeAdvancedMenus() {
    const page = await this.page();
    await this.keyboardPress(page, "Escape", "close-advanced-menu").catch(() => {});
    await this.keyboardPress(page, "Escape", "close-advanced-menu-fallback").catch(() => {});
  }

  async clickMenuOption(option) {
    const page = await this.page();
    const text = page.getByText(option.name, { exact: true }).last();
    const byTestId = option.testId
      ? page.locator(`[data-testid=${JSON.stringify(option.testId)}]`).last()
      : null;
    const base = byTestId && (await byTestId.count()) > 0 ? byTestId : text;
    const interactive = base.locator(
      "xpath=ancestor-or-self::*[self::button or @role='button' or @role='menuitem' or @role='menuitemradio' or @role='option' or @tabindex][1]",
    );
    const target = (await interactive.count()) > 0 ? interactive : base;
    await this.domClick(target, "select-menu-option");
    await page.waitForTimeout(250);
  }

  async openAdvancedSettings() {
    await this.ensureSignedIn();
    const page = await this.page();
    let modelRow = await this.advancedRow(SELECTORS.modelRowLabels);
    let thinkingRow = await this.advancedRow(SELECTORS.thinkingRowLabels);
    if (modelRow && thinkingRow) {
      this.rememberSettings(modelRow.value, thinkingRow.value);
      return { modelRow, thinkingRow };
    }

    const trigger = await this.advancedControlButton();
    if (!trigger) {
      throw new ChatGPTWebError(
        "没有找到输入框右侧的回答档位控件，无法打开高级模型设置。",
        { url: page.url() },
      );
    }
    await this.click(trigger, "open-advanced-settings");
    await page.waitForTimeout(180);

    modelRow = await this.advancedRow(SELECTORS.modelRowLabels);
    thinkingRow = await this.advancedRow(SELECTORS.thinkingRowLabels);
    if (!modelRow || !thinkingRow) {
      const advanced = await this.advancedRow(SELECTORS.advancedLabels);
      if (!advanced) {
        await this.closeAdvancedMenus();
        throw new ChatGPTWebError("回答档位菜单已打开，但没有找到“高级”入口。", {
          url: page.url(),
        });
      }
      await this.clickAdvancedRow(advanced);
      modelRow = await this.advancedRow(SELECTORS.modelRowLabels);
      thinkingRow = await this.advancedRow(SELECTORS.thinkingRowLabels);
    }

    if (!modelRow || !thinkingRow) {
      await this.closeAdvancedMenus();
      throw new ChatGPTWebError("高级菜单已展开，但没有同时找到“模型”和“思考强度”。", {
        modelRowFound: Boolean(modelRow),
        thinkingRowFound: Boolean(thinkingRow),
        url: page.url(),
      });
    }
    this.rememberSettings(modelRow.value, thinkingRow.value);
    return { modelRow, thinkingRow };
  }

  rememberSettings(model, thinkingLevel) {
    this.#settingsCache = {
      value: { model: model || null, thinkingLevel: thinkingLevel || null },
      expiresAt: Date.now() + 5 * 60_000,
    };
  }

  async advancedSettings({ force = false } = {}) {
    if (!force && this.#settingsCache?.expiresAt > Date.now()) {
      return this.#settingsCache.value;
    }
    const page = await this.page();
    const { modelRow, thinkingRow } = await this.openAdvancedSettings();
    const value = {
      model: modelRow.value,
      thinkingLevel: thinkingRow.value,
    };
    await this.closeAdvancedMenus();
    this.rememberSettings(value.model, value.thinkingLevel);
    return value;
  }

  async currentModel() {
    const button = await this.modelButton();
    if (button) {
      const text = await button.innerText().catch(() => "");
      const label = await button.getAttribute("aria-label");
      return (text || label || "").replace(/\s+/g, " ").trim() || null;
    }
    return (await this.advancedSettings()).model;
  }

  async currentThinkingLevel() {
    return (await this.advancedSettings()).thinkingLevel;
  }

  async openLegacyModelMenu() {
    await this.ensureSignedIn();
    const page = await this.page();
    const button = await this.modelButton();
    if (!button) {
      throw new ChatGPTWebError("没有找到模型选择器。当前账号、工作区或页面版本可能未显示该控件。", {
        url: page.url(),
      });
    }
    await this.click(button, "open-model-menu");
    await page.waitForTimeout(300);
    return button;
  }

  async visibleMenuOptions({ exclude = [] } = {}) {
    const page = await this.page();
    const candidates = page.locator(
      [
        "[role='menuitem']:visible",
        "[role='menuitemradio']:visible",
        "[role='menuitemcheckbox']:visible",
        "[role='option']:visible",
        "[role='menu']:visible button:visible",
        "[role='listbox']:visible button:visible",
        "[data-testid*='model']:visible",
        "[data-radix-popper-content-wrapper]:visible button:visible",
        "[data-radix-popper-content-wrapper]:visible [role='button']:visible",
      ].join(", "),
    );
    const raw = await candidates.evaluateAll((elements) =>
      elements.map((element) => ({
        text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
        ariaLabel: element.getAttribute("aria-label") || "",
        testId: element.getAttribute("data-testid") || "",
        role: element.getAttribute("role") || "",
      })),
    );
    return uniqueBy(
      raw
        .map((item) => ({
          ...item,
          name: item.text || item.ariaLabel,
        }))
        .filter((item) => {
          if (!item.name || item.name.length >= 220) return false;
          if (item.testId === "model-switcher-dropdown-button") return false;
          if (exclude.some((value) => normalize(value) === normalize(item.name))) return false;
          if (
            [...SELECTORS.advancedLabels, ...SELECTORS.modelRowLabels, ...SELECTORS.thinkingRowLabels]
              .some((value) => normalize(value) === normalize(item.name))
          ) return false;
          return !/^(log in|sign up|登录|免费注册)$/i.test(item.name);
        }),
      (item) => normalize(item.name),
    );
  }

  async listModels() {
    const page = await this.page();
    const legacy = await this.modelButton();
    let current;
    let models;
    if (legacy) {
      await this.openLegacyModelMenu();
      models = await this.visibleMenuOptions();
      current = await this.currentModel();
    } else {
      const { modelRow, thinkingRow } = await this.openAdvancedSettings();
      current = modelRow.value;
      await this.clickAdvancedRow(modelRow);
      models = await this.visibleMenuOptions({
        exclude: [modelRow.text, thinkingRow.text],
      });
    }
    await this.closeAdvancedMenus();
    return { current, models };
  }

  async selectModel(model) {
    const page = await this.page();
    const legacy = await this.modelButton();
    let options;
    let observedThinkingLevel = null;
    if (legacy) {
      await this.openLegacyModelMenu();
      options = await this.visibleMenuOptions();
    } else {
      const { modelRow, thinkingRow } = await this.openAdvancedSettings();
      observedThinkingLevel = thinkingRow.value;
      if (normalize(modelRow.value) === normalize(model)) {
        await this.closeAdvancedMenus();
        return { requested: model, selected: modelRow.value, changed: false };
      }
      await this.clickAdvancedRow(modelRow);
      options = await this.visibleMenuOptions({
        exclude: [modelRow.text, thinkingRow.text],
      });
    }
    const matches = rankTextMatch(options, model, (item) => item.name);

    if (!matches.length) {
      const exactText = page.getByText(model, { exact: true }).last();
      if (await exactText.isVisible().catch(() => false)) {
        await this.clickMenuOption({ name: model, testId: "" });
        if (!legacy) this.rememberSettings(model, observedThinkingLevel);
        return { selected: model, requested: model, verifiedBy: "exact-menu-option" };
      }
    }

    if (!matches.length) {
      await this.closeAdvancedMenus();
      throw new ChatGPTWebError("请求的模型不在当前账号显示的模型菜单中。", {
        requested: model,
        available: options.map((item) => item.name),
      });
    }

    const best = matches[0];
    const tied = matches.filter((entry) => entry.score === best.score);
    if (best.score < 100 && tied.length > 1) {
      await this.closeAdvancedMenus();
      throw new ChatGPTWebError("模型名称匹配到多个选项，请使用更完整的名称。", {
        requested: model,
        matches: tied.map((entry) => entry.item.name),
      });
    }

    const option = options.find((item) => item === best.item);
    await this.clickMenuOption(option);
    if (!legacy) this.rememberSettings(option.name, observedThinkingLevel);
    const selected = legacy ? await this.currentModel() : option.name;
    if (selected && best.score === 100 && !normalize(selected).includes(normalize(model))) {
      // Some UI versions display a family name rather than the selected mode. Return both signals.
      return { requested: model, clicked: option.name, selected, verifiedBy: "menu-click" };
    }
    return { requested: model, clicked: option.name, selected, verifiedBy: "switcher" };
  }

  async listThinkingLevels() {
    const page = await this.page();
    const { modelRow, thinkingRow } = await this.openAdvancedSettings();
    const current = thinkingRow.value;
    await this.clickAdvancedRow(thinkingRow);
    const levels = await this.visibleMenuOptions({
      exclude: [modelRow.text, thinkingRow.text],
    });
    const slider = await this.thinkingSliderState();
    await this.closeAdvancedMenus();
    return {
      current,
      levels,
      control: slider ? { type: "slider", ...slider } : { type: "menu" },
      note:
        levels.length === 0 && slider
          ? "网页仅公开滑块当前语义和值域；选择时会按滑块可访问状态校验，不会按坐标盲点。"
          : undefined,
    };
  }

  async thinkingSliderState() {
    const slider = await this.firstVisible(SELECTORS.thinkingSliders, { timeout: 250 });
    if (!slider) return null;
    return slider.evaluate((element) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const number = (name, fallback) => {
        const raw = element.getAttribute(name) ?? fallback;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
      };
      return {
        valueText:
          element.getAttribute("aria-valuetext") ||
          element.getAttribute("aria-label") ||
          input?.value ||
          null,
        now: number("aria-valuenow", input?.value),
        min: number("aria-valuemin", input?.min),
        max: number("aria-valuemax", input?.max),
        step: number("aria-valuestep", input?.step) || 1,
      };
    });
  }

  async selectThinkingSliderValue(slider, value) {
    const state = await this.thinkingSliderState();
    if (!state || state.min == null || state.max == null || state.min === state.max) {
      throw new ChatGPTWebError("思考强度滑块没有公开可校验的数值范围。", {
        requested: value,
        slider: state,
      });
    }
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested < state.min || requested > state.max) {
      throw new ChatGPTWebError("请求的思考强度滑块值超出网页公开范围。", {
        requested: value,
        slider: state,
      });
    }

    const orientation = (await slider.getAttribute("aria-orientation")) || "horizontal";
    const step = state.step || 1;
    const stepCount = Math.round((requested - state.min) / step);
    const snapped = state.min + stepCount * step;
    if (Math.abs(snapped - requested) > 1e-9 || stepCount > 100) {
      throw new ChatGPTWebError("请求值不符合思考强度滑块公开的步长。", {
        requested,
        slider: state,
      });
    }

    await slider.focus();
    await this.press(slider, "Home", "thinking-slider-home");
    const incrementKey = orientation === "vertical" ? "ArrowUp" : "ArrowRight";
    for (let index = 0; index < stepCount; index += 1) {
      await this.press(slider, incrementKey, "thinking-slider-increment");
    }
    await (await this.page()).waitForTimeout(180);
    const observed = await this.thinkingSliderState();
    if (!observed || Math.abs(Number(observed.now) - requested) > 1e-9) {
      throw new ChatGPTWebError("思考强度滑块操作后未通过数值校验。", {
        requested,
        observed,
      });
    }
    return observed;
  }

  async selectThinkingLevel(thinkingLevel) {
    const page = await this.page();
    const { modelRow, thinkingRow } = await this.openAdvancedSettings();
    if (normalize(thinkingRow.value) === normalize(thinkingLevel)) {
      await this.closeAdvancedMenus();
      return { requested: thinkingLevel, selected: thinkingRow.value, changed: false };
    }
    await this.clickAdvancedRow(thinkingRow);
    const options = await this.visibleMenuOptions({
      exclude: [modelRow.text, thinkingRow.text],
    });
    const matches = rankTextMatch(options, thinkingLevel, (item) => item.name);
    if (!matches.length) {
      const slider = await this.firstVisible(SELECTORS.thinkingSliders, { timeout: 300 });
      const sliderState = slider ? await this.thinkingSliderState() : null;
      const requestedSliderValue = Number(thinkingLevel);
      if (slider && Number.isFinite(requestedSliderValue)) {
        const selectedSlider = await this.selectThinkingSliderValue(slider, requestedSliderValue);
        await this.closeAdvancedMenus();
        this.rememberSettings(
          modelRow.value,
          selectedSlider.valueText || String(selectedSlider.now),
        );
        return {
          requested: thinkingLevel,
          selected: selectedSlider.valueText,
          slider: selectedSlider,
        };
      }
      await this.closeAdvancedMenus();
      throw new ChatGPTWebError(
        slider
          ? "当前网页只显示思考强度滑块，但没有公开目标档位的可访问名称；为避免盲选，未更改设置。"
          : "请求的思考强度不在当前账号显示的选项中。",
        {
          requested: thinkingLevel,
          available: options.map((item) => item.name),
          slider: sliderState,
        },
      );
    }
    const best = matches[0];
    const tied = matches.filter((entry) => entry.score === best.score);
    if (best.score < 100 && tied.length > 1) {
      await this.closeAdvancedMenus();
      throw new ChatGPTWebError("思考强度匹配到多个选项，请使用完整名称。", {
        requested: thinkingLevel,
        matches: tied.map((entry) => entry.item.name),
      });
    }

    const option = best.item;
    await this.clickMenuOption(option);
    this.rememberSettings(modelRow.value, option.name);
    const selected = option.name;
    if (normalize(selected) !== normalize(option.name)) {
      throw new ChatGPTWebError("思考强度切换后未通过页面校验。", {
        requested: thinkingLevel,
        clicked: option.name,
        observed: selected,
      });
    }
    return { requested: thinkingLevel, clicked: option.name, selected };
  }

  async writePrompt(prompt, { append = false } = {}) {
    await this.ensureSignedIn();
    const composer = await this.composer();
    if (!composer) throw new ChatGPTWebError("没有找到提示词输入框。");

    if (append) await this.type(composer, prompt, "append-prompt");
    else await this.fill(composer, prompt, "write-prompt");

    const value = await composer.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        return element.value;
      }
      return element.innerText || element.textContent || "";
    });

    if (!normalize(value).includes(normalize(prompt))) {
      throw new ChatGPTWebError("提示词已写入，但输入框内容校验失败。", {
        observedLength: value.length,
        requestedLength: prompt.length,
      });
    }
    return { written: true, characters: value.length, preview: value.slice(0, 300) };
  }

  async validateFiles(files) {
    if (!files?.length) return [];
    const result = [];
    for (const file of files) {
      const resolved = path.resolve(file);
      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch {
        throw new ChatGPTWebError("待上传文件不存在。", { file: resolved });
      }
      if (!stat.isFile()) {
        throw new ChatGPTWebError("只能上传普通文件，不能上传目录。", { file: resolved });
      }
      result.push({ path: resolved, name: path.basename(resolved), size: stat.size });
    }
    return result;
  }

  async uploadFiles(files) {
    await this.ensureSignedIn();
    const page = await this.page();
    const validated = await this.validateFiles(files);
    if (!validated.length) return { uploaded: [] };
    const paths = validated.map((file) => file.path);
    await this.siteAction("upload-files");

    let input = null;
    for (const selector of SELECTORS.fileInput) {
      const locator = page.locator(selector).last();
      if ((await locator.count()) > 0) {
        input = locator;
        break;
      }
    }

    if (input) {
      await this.pageInteraction("set-upload-files");
      await input.setInputFiles(paths);
    } else {
      const attach = await this.firstVisible(SELECTORS.attachmentButton, { timeout: 800 });
      if (!attach) throw new ChatGPTWebError("没有找到 ChatGPT 的文件上传控件。");
      let chooserPromise = page.waitForEvent("filechooser", { timeout: 1_200 }).catch(() => null);
      await this.click(attach, "open-attachment-menu");
      let chooser = await chooserPromise;
      if (!chooser) {
        const uploadItem = await this.firstVisible(SELECTORS.uploadMenuItems, { timeout: 1_500 });
        if (!uploadItem) {
          throw new ChatGPTWebError("附件菜单已打开，但没有找到“添加照片和文件”选项。");
        }
        chooserPromise = page
          .waitForEvent("filechooser", { timeout: ACTION_TIMEOUT_MS })
          .catch(() => null);
        await this.click(uploadItem, "select-upload-files");
        chooser = await chooserPromise;
      }
      if (!chooser) throw new ChatGPTWebError("已点击上传入口，但网页没有打开文件选择器。");
      await this.pageInteraction("confirm-upload-files");
      await chooser.setFiles(paths);
    }

    for (const file of validated) {
      const filename = page.getByText(file.name, { exact: false }).last();
      await filename.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    }

    const send = await this.firstVisible(SELECTORS.sendButton, { timeout: 500 });
    return {
      uploaded: validated,
      composerReady: Boolean(await this.composer()),
      sendEnabled: send ? await send.isEnabled().catch(() => null) : null,
    };
  }

  assistantLocator() {
    return this.#page.locator(SELECTORS.assistantMessages.join(", "));
  }

  userLocator() {
    return this.#page.locator(SELECTORS.userMessages.join(", "));
  }

  async submitPrompt({ wait = true, timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
    await this.ensureSignedIn();
    const page = await this.page();
    const composer = await this.composer();
    if (!composer) throw new ChatGPTWebError("没有找到提示词输入框。");
    const promptText = await composer.evaluate((element) =>
      element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : element.innerText || element.textContent || "",
    );
    if (!normalize(promptText)) throw new ChatGPTWebError("输入框为空，无法发送。");

    const assistantBefore = await this.assistantLocator().count();
    const userBefore = await this.userLocator().count();
    await this.siteAction("send-prompt");
    const send = await this.firstVisible(SELECTORS.sendButton, { timeout: 1_000 });
    if (send && (await send.isEnabled().catch(() => true))) {
      await this.click(send, "send-prompt-click");
    } else {
      await this.press(composer, "Enter", "send-prompt-enter");
    }
    await this.markSendPerformed();

    const generationStartedAt = Date.now();
    await updateRuntimeState({
      activeGeneration: {
        active: true,
        startedAt: generationStartedAt,
        url: page.url(),
        ownerPid: process.pid,
        assistantBefore,
        status: wait ? "waiting" : "unobserved",
      },
    });

    await page.waitForFunction(
      ({ selectors, count }) => {
        const elements = document.querySelectorAll(selectors);
        return elements.length > count;
      },
      { selectors: SELECTORS.userMessages.join(", "), count: userBefore },
      { timeout: ACTION_TIMEOUT_MS },
    ).catch(() => {});

    if (!wait) {
      return {
        sent: true,
        waiting: false,
        url: page.url(),
        conversationId: conversationIdFromUrl(page.url()),
      };
    }
    const effectiveTimeoutMs =
      isProModel(this.cachedSettings().model) || isProTier(this.#answerTier)
        ? null
        : timeoutMs;
    try {
      const result = await this.waitForResponse({
        assistantBefore,
        timeoutMs: effectiveTimeoutMs,
      });
      await updateRuntimeState({ activeGeneration: null, lastGenerationCompletedAt: Date.now() });
      return result;
    } catch (error) {
      if (this.signal()?.aborted) {
        await updateRuntimeState({
          activeGeneration: {
            active: true,
            startedAt: generationStartedAt,
            url: page.url(),
            ownerPid: null,
            assistantBefore,
            status: "client-cancelled-generation-may-continue",
          },
        });
      }
      throw error;
    }
  }

  async waitForResponse({ assistantBefore, timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
    const page = await this.page();
    const signal = this.signal();
    throwIfAborted(signal);
    const baseline =
      assistantBefore ?? Math.max(0, (await this.assistantLocator().count()) - 1);
    const unlimited = timeoutMs == null;
    const observerPromise = page.evaluate(
      ({ assistantSelectors, stopSelectors, baselineCount, timeout }) =>
        new Promise((resolve) => {
          const visible = (element) => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
          };
          const read = () => {
            const body = document.body?.innerText || "";
            const rateLimited =
              /请求过于频繁|too many requests|request.*too frequent/i.test(body) &&
              /稍等|分钟|try again|wait/i.test(body);
            const assistant = [...document.querySelectorAll(assistantSelectors)];
            const last = assistant.at(-1);
            const response = (last?.innerText || last?.textContent || "").trim();
            const stop = [...document.querySelectorAll(stopSelectors)].some(visible);
            const streaming = Boolean(
              last?.querySelector("[data-is-streaming='true'], .result-streaming"),
            );
            return { count: assistant.length, response, stop, streaming, rateLimited };
          };
          let stableText = "";
          let stableSince = Date.now();
          let stableTimer = null;
          let timeoutTimer = null;
          let observer = null;
          let done = false;
          const cleanup = () => {
            observer?.disconnect();
            clearTimeout(stableTimer);
            clearTimeout(timeoutTimer);
            window.removeEventListener("__chatgpt_mcp_network_rate_limit__", onNetworkLimit);
            window.removeEventListener("__chatgpt_mcp_cancel_wait__", onCancel);
          };
          const finish = (value) => {
            if (done) return;
            done = true;
            cleanup();
            resolve(value);
          };
          const inspect = () => {
            const state = read();
            if (state.rateLimited) return finish({ status: "rate-limited", ...state });
            if (state.response !== stableText) {
              stableText = state.response;
              stableSince = Date.now();
            }
            clearTimeout(stableTimer);
            if (
              state.count > baselineCount &&
              state.response &&
              !state.stop &&
              !state.streaming
            ) {
              const remaining = Math.max(0, 2_000 - (Date.now() - stableSince));
              stableTimer = setTimeout(() => {
                const verified = read();
                if (
                  verified.count > baselineCount &&
                  verified.response === stableText &&
                  !verified.stop &&
                  !verified.streaming
                ) {
                  finish({ status: "completed", ...verified });
                }
              }, remaining);
            }
          };
          const onNetworkLimit = (event) =>
            finish({
              status: "network-rate-limited",
              networkScope: event?.detail?.scope || "http-429",
              networkPath: event?.detail?.path || null,
              ...read(),
            });
          const onCancel = () => finish({ status: "cancelled" });
          window.addEventListener("__chatgpt_mcp_network_rate_limit__", onNetworkLimit);
          window.addEventListener("__chatgpt_mcp_cancel_wait__", onCancel);
          observer = new MutationObserver(inspect);
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["data-is-streaming", "aria-label", "disabled"],
          });
          if (timeout != null) {
            timeoutTimer = setTimeout(() => finish({ status: "timeout", ...read() }), timeout);
          }
          inspect();
        }),
      {
        assistantSelectors: SELECTORS.assistantMessages.join(", "),
        stopSelectors: SELECTORS.stopButton.join(", "),
        baselineCount: baseline,
        timeout: unlimited ? null : timeoutMs,
      },
    );
    const observed = await raceWithAbort(observerPromise, signal, () =>
      page.evaluate(() => {
        window.dispatchEvent(new Event("__chatgpt_mcp_cancel_wait__"));
      }),
    );

    if (observed.status === "rate-limited" || observed.status === "network-rate-limited") {
      const scope =
        observed.status === "network-rate-limited"
          ? observed.networkScope || "http-429"
          : "unknown";
      const circuitBreaker = await this.tripCircuitBreaker(scope, observed.status);
      throw new ChatGPTWebError("检测到 ChatGPT 请求频率限制，已开启安全熔断。", {
        scope,
        path: observed.networkPath || null,
        circuitBreaker,
        url: page.url(),
      });
    }
    if (observed.status === "timeout") {
      throw new ChatGPTWebError("等待 ChatGPT 完成回答超时。", {
        timeoutMs,
        partialResponse: observed.response,
        url: page.url(),
      });
    }
    return {
      sent: true,
      completed: true,
      response: observed.response,
      url: page.url(),
      conversationId: conversationIdFromUrl(page.url()),
      model: this.cachedSettings().model,
      thinkingLevel: this.cachedSettings().thinkingLevel,
      answerTier: this.#answerTier,
      mode: await this.currentMode(),
      temporary: await this.temporaryState(),
      waitPolicy: unlimited ? "unlimited-for-pro" : `timeout-${timeoutMs}ms`,
      waitMechanism: "mutation-observer",
      rateLimited: false,
      rateLimitScope: null,
    };
  }

  async sendMessage({
    prompt,
    files = [],
    model,
    mode,
    thinkingLevel,
    answerTier,
    newChat = false,
    temporary = false,
    wait = true,
    timeoutMs = RESPONSE_TIMEOUT_MS,
  }) {
    if (newChat || temporary) {
      await this.newChat(
        { temporary, model, mode, thinkingLevel, answerTier },
        { includeStatus: false },
      );
    } else {
      if (mode) await this.selectMode(mode);
      if (model) await this.selectModel(model);
      if (thinkingLevel) await this.selectThinkingLevel(thinkingLevel);
      if (answerTier) await this.selectAnswerTier(answerTier);
    }
    if (files.length) await this.uploadFiles(files);
    await this.writePrompt(prompt);
    const effectiveTimeoutMs =
      isProModel(model) || isProTier(answerTier) || isProTier(this.#answerTier)
        ? null
        : timeoutMs;
    return this.submitPrompt({ wait, timeoutMs: effectiveTimeoutMs });
  }

  async probeProIdentity({ mode, force = false } = {}) {
    if (!force) {
      const runtime = await readRuntimeState();
      const session = await browserSessionSnapshot();
      const cached = validProbeCache(runtime.proProbe, { mode, session });
      if (cached) {
        if (cached !== runtime.proProbe) {
          await updateRuntimeState({ proProbe: cached });
        }
        return {
          prompt: PROBE_PROMPT,
          response: cached.response,
          classification: cached.classification,
          temporary: true,
          answerTier: PRO_ANSWER_TIER,
          url: cached.url || null,
          waitPolicy: "cached-probe",
          cachePolicy: cached.sessionInterruptedAt
            ? "closed-page-grace"
            : "same-page-session",
          cached: true,
          checkedAt: cached.checkedAt,
          expiresAt: cached.expiresAt || null,
          recheckAfter: cached.recheckAfter || null,
          rateLimited: false,
          rateLimitScope: null,
        };
      }
    }

    await this.newChat(
      { temporary: true, mode, answerTier: PRO_ANSWER_TIER },
      { includeStatus: false },
    );
    await this.writePrompt(PROBE_PROMPT);
    const result = await this.submitPrompt({ wait: true, timeoutMs: null });
    const probe = {
      prompt: PROBE_PROMPT,
      response: result.response,
      classification: classifyProbeModel(result.response),
      temporary: result.temporary,
      answerTier: result.answerTier,
      url: result.url,
      waitPolicy: result.waitPolicy,
      cached: false,
      rateLimited: result.rateLimited,
      rateLimitScope: result.rateLimitScope,
    };
    if (probe.classification !== "unknown") {
      const checkedAt = Date.now();
      const session = await browserSessionSnapshot();
      const continuousPageSession =
        session.browserRunning && session.chatgptPageOpen;
      const cachedProbe = {
        response: probe.response,
        classification: probe.classification,
        policyKey: PROBE_POLICY_KEY,
        mode: mode || null,
        url: probe.url,
        checkedAt,
        browserSessionId: continuousPageSession
          ? session.browserSessionId
          : null,
        chatgptPageId: continuousPageSession ? session.chatgptPageId : null,
        sessionInterruptedAt: continuousPageSession ? null : checkedAt,
        recheckAfter: continuousPageSession
          ? null
          : checkedAt + PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
        expiresAt: continuousPageSession
          ? null
          : checkedAt + PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
      };
      await updateRuntimeState({ proProbe: cachedProbe });
      probe.checkedAt = cachedProbe.checkedAt;
      probe.expiresAt = cachedProbe.expiresAt;
      probe.recheckAfter = cachedProbe.recheckAfter;
      probe.cachePolicy = continuousPageSession
        ? "same-page-session"
        : "closed-page-grace";
    }
    return probe;
  }

  async routeNewChat({
    prompt,
    files = [],
    requestPro = false,
    forceProbe = false,
    mode,
    wait = true,
    timeoutMs = RESPONSE_TIMEOUT_MS,
  }) {
    if (!requestPro) {
      await this.newChat({ temporary: false, mode }, { includeStatus: false });
      const tier = await this.selectExtremeTier(DEFAULT_ANSWER_TIER);
      if (files.length) await this.uploadFiles(files);
      await this.writePrompt(prompt);
      const result = await this.submitPrompt({ wait, timeoutMs });
      return {
        route: "default-extreme",
        probe: null,
        finalConversation: { tier: DEFAULT_ANSWER_TIER, temporary: false },
        tier,
        result,
      };
    }

    const probe = await this.probeProIdentity({ mode, force: forceProbe });
    const classification = probe.classification;

    if (classification === "unknown") {
      throw new ChatGPTWebError(
        "Pro 临时探针的回答不符合已配置的接受或回退规则；未创建正常对话。",
        {
          probeResponse: probe.response,
          acceptedClassification: PROBE_ACCEPT_CLASSIFICATION,
          fallbackClassification: PROBE_FALLBACK_CLASSIFICATION,
          temporary: true,
        },
      );
    }

    await this.newChat({ temporary: false, mode }, { includeStatus: false });
    let finalTier;
    let route;
    if (classification === PROBE_ACCEPT_CLASSIFICATION) {
      finalTier = await this.selectAnswerTier(PRO_ANSWER_TIER);
      route = `verified-${classification}`;
    } else {
      finalTier = await this.selectExtremeTier(DEFAULT_ANSWER_TIER);
      route = `fallback-${classification}-to-default`;
    }
    if (files.length) await this.uploadFiles(files);
    await this.writePrompt(prompt);
    const result = await this.submitPrompt({
      wait,
      timeoutMs: classification === PROBE_ACCEPT_CLASSIFICATION ? null : timeoutMs,
    });
    return {
      route,
      probe: {
        prompt: probe.prompt,
        response: probe.response,
        classification,
        temporary: probe.temporary,
        cached: probe.cached,
        checkedAt: probe.checkedAt,
        expiresAt: probe.expiresAt,
        recheckAfter: probe.recheckAfter,
        cachePolicy: probe.cachePolicy,
        rateLimited: probe.rateLimited,
        rateLimitScope: probe.rateLimitScope,
      },
      finalConversation: {
        tier:
          classification === PROBE_ACCEPT_CLASSIFICATION
            ? PRO_ANSWER_TIER
            : DEFAULT_ANSWER_TIER,
        temporary: false,
      },
      tier: finalTier,
      result,
    };
  }

  async historyLinks() {
    const page = await this.page();
    const locator = page.locator(SELECTORS.historyLinks.join(", "));
    const items = await locator.evaluateAll((elements) =>
      elements.map((element) => ({
        href: element.getAttribute("href") || "",
        title:
          (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim() ||
          element.getAttribute("title") ||
          element.getAttribute("aria-label") ||
          "",
      })),
    );
    return uniqueBy(
      items
        .filter((item) => /^\/c\//.test(item.href))
        .map((item) => ({
          id: conversationIdFromUrl(item.href),
          title: item.title,
          url: absoluteChatUrl(item.href),
        })),
      (item) => item.id,
    );
  }

  async listHistory({ query, limit = 20 } = {}) {
    await this.ensureSignedIn();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, MAX_HISTORY_RESULTS));
    let conversations = await this.historyLinks();

    if (query) {
      const matches = rankTextMatch(conversations, query, (item) => item.title);
      conversations = matches.map((entry) => entry.item);
    }
    return {
      conversations: conversations.slice(0, safeLimit),
      returned: Math.min(conversations.length, safeLimit),
      note:
        conversations.length === 0
          ? "当前侧栏没有匹配项。可以使用 conversationId 或完整 /c/... URL 精确打开历史对话。"
          : undefined,
    };
  }

  async searchHistory({ query, limit = 20 } = {}) {
    await this.ensureSignedIn();
    const page = await this.page();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, MAX_HISTORY_RESULTS));
    const searchButton = await this.firstVisible(SELECTORS.historySearchButtons, {
      timeout: 1_000,
    });

    if (!searchButton) {
      // Some layouts hide search until the sidebar is expanded.
      const openSidebar = page.locator("button[aria-label='Open sidebar'], button[aria-label='打开边栏']").first();
      if (await openSidebar.isVisible().catch(() => false)) {
        await this.siteAction("open-history-sidebar");
        await this.click(openSidebar, "open-history-sidebar-click");
        await page.waitForTimeout(300);
      }
    }

    const resolvedButton =
      searchButton ||
      (await this.firstVisible(SELECTORS.historySearchButtons, { timeout: 1_000 }));
    if (!resolvedButton) {
      throw new ChatGPTWebError("没有找到 ChatGPT 的“搜索聊天”控件。", { url: page.url() });
    }
    await this.siteAction("open-history-search");
    await this.click(resolvedButton, "open-history-search-click");

    const input = await this.firstVisible(SELECTORS.historySearchInputs, { timeout: 2_000 });
    if (!input) throw new ChatGPTWebError("搜索聊天窗口已打开，但没有找到搜索输入框。");
    await this.siteAction("search-history");
    await this.fill(input, query, "fill-history-search");
    await page.waitForTimeout(800);

    const links = page.locator(
      "[role='dialog'] a[href^='/c/'], [role='dialog'] [data-href^='/c/'], a[href^='/c/']:visible",
    );
    const raw = await links.evaluateAll((elements) =>
      elements.map((element) => ({
        href: element.getAttribute("href") || element.getAttribute("data-href") || "",
        title:
          (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim() ||
          element.getAttribute("title") ||
          element.getAttribute("aria-label") ||
          "",
      })),
    );
    const conversations = uniqueBy(
      raw
        .filter((item) => /^\/c\//.test(item.href))
        .map((item) => ({
          id: conversationIdFromUrl(item.href),
          title: item.title,
          url: absoluteChatUrl(item.href),
        })),
      (item) => item.id,
    ).slice(0, safeLimit);

    await this.keyboardPress(page, "Escape", "close-history-search").catch(() => {});
    return { query, conversations, returned: conversations.length };
  }

  async selectHistory({ conversationId, url, title } = {}) {
    await this.ensureSignedIn();
    const page = await this.page();
    let destination = null;
    let matched = null;

    if (url) {
      const parsed = new URL(url, CHATGPT_URL);
      if (parsed.hostname !== new URL(CHATGPT_URL).hostname || !/^\/c\//.test(parsed.pathname)) {
        throw new ChatGPTWebError("历史对话 URL 必须是 chatgpt.com/c/... 地址。", { url });
      }
      destination = parsed.toString();
    } else if (conversationId) {
      if (!/^[a-zA-Z0-9-]+$/.test(conversationId)) {
        throw new ChatGPTWebError("conversationId 格式无效。", { conversationId });
      }
      destination = new URL(`/c/${conversationId}`, CHATGPT_URL).toString();
    } else if (title) {
      let conversations = await this.historyLinks();
      const matches = rankTextMatch(conversations, title, (item) => item.title);
      let ranked = matches;
      if (!ranked.length) {
        const searched = await this.searchHistory({ query: title, limit: 30 });
        conversations = searched.conversations;
        ranked = rankTextMatch(conversations, title, (item) => item.title);
      }
      if (!ranked.length) {
        throw new ChatGPTWebError("侧栏中没有找到匹配的历史对话。", {
          requested: title,
          visibleTitles: conversations.slice(0, 30).map((item) => item.title),
        });
      }
      const best = ranked[0];
      const tied = ranked.filter((entry) => entry.score === best.score);
      if (best.score < 100 && tied.length > 1) {
        throw new ChatGPTWebError("历史对话标题匹配到多个结果，请改用 conversationId。", {
          matches: tied.map((entry) => entry.item),
        });
      }
      matched = best.item;
      destination = best.item.url;
    } else {
      throw new ChatGPTWebError("请选择 conversationId、url 或 title 中的一项。");
    }

    await this.siteAction("select-history");
    await navigate(page, destination, { waitUntil: "domcontentloaded" }, this.signal());
    const composer = await this.composer();
    if (!composer || !conversationIdFromUrl(page.url())) {
      throw new ChatGPTWebError("历史对话打开后未通过页面校验，可能已删除或无权访问。", {
        requested: destination,
        observed: page.url(),
      });
    }

    this.#settingsCache = null;
    const latest = await this.getLatestResponse();
    return {
      selected: true,
      matched,
      ...latest,
    };
  }

  async getLatestResponse({ includeSettings = false } = {}) {
    const page = await this.page();
    const body = await page.locator("body").innerText().catch(() => "");
    const rateLimit = classifyRateLimitText(body);
    if (rateLimit.limited) await this.tripCircuitBreaker(rateLimit.scope, "page-text-read");
    const assistant = this.assistantLocator();
    const user = this.userLocator();
    const count = await assistant.count();
    const userCount = await user.count();
    const runtime = await readRuntimeState();
    const stop = await this.firstVisible(SELECTORS.stopButton, { timeout: 100 });
    const lastAssistant = count ? assistant.last() : null;
    const streaming = lastAssistant
      ? await lastAssistant
          .locator("[data-is-streaming='true'], .result-streaming")
          .count()
          .then((value) => value > 0)
          .catch(() => false)
      : false;
    const generationComplete = Boolean(
      runtime.activeGeneration?.active &&
        (runtime.activeGeneration.assistantBefore == null
          ? count > 0
          : count > Number(runtime.activeGeneration.assistantBefore)) &&
        !stop &&
        !streaming,
    );
    if (generationComplete) {
      await updateRuntimeState({
        activeGeneration: null,
        lastGenerationCompletedAt: Date.now(),
      });
    }
    const settings =
      includeSettings &&
      !runtime.circuitBreaker?.active &&
      !(runtime.activeGeneration?.active && !generationComplete)
        ? await this.advancedSettings()
        : this.cachedSettings();
    return {
      url: page.url(),
      conversationId: conversationIdFromUrl(page.url()),
      lastUserMessage: userCount ? (await user.last().innerText()).trim() : null,
      userMessageCount: userCount,
      response: count ? (await assistant.last().innerText()).trim() : null,
      assistantMessageCount: count,
      generating: Boolean(stop || streaming),
      activeGeneration: generationComplete ? null : runtime.activeGeneration || null,
      rateLimited: rateLimit.limited,
      rateLimitScope: rateLimit.scope,
      circuitBreaker: rateLimit.limited
        ? (await readRuntimeState()).circuitBreaker || null
        : runtime.circuitBreaker || null,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      mode: await this.currentMode(),
      temporary: await this.temporaryState(),
    };
  }
}
