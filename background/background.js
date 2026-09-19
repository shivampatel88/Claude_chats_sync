"use strict";

importScripts("../shared/shared.js");
importScripts("../shared/session-vault.js");

// IMP-01: Background service worker that owns all chrome.storage.sync writes.
// This prevents the content script and popup from racing on chunk writes when both
// are active simultaneously (e.g. popup open while a scrape fires).
//
// Both the content script and popup send:
//   chrome.runtime.sendMessage({ type: 'SYNC_DATA', accounts: {...}, chats: {...} })
// and await the response { ok: true } / { ok: false, error: '...' }.
//
// The queue keeps only the latest write request — stale ones are discarded
// so that rapid scrapes don't pile up and we always converge to the latest state.

const SYNC_KEYS = {
  accounts: "syncAccounts",
  meta: "syncMeta",
  chatPrefix: "syncChats_",
  deletedAccounts: "syncDeletedAccounts",
};

function mergeDeletedAccounts(base = {}, incoming = {}) {
  return { ...base, ...incoming };
}

const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function gcTombstones(deletedAccounts = {}, accounts = {}, chats = {}) {
  const now = Date.now();
  const cleaned = { ...deletedAccounts };

  for (const [accId, tombstone] of Object.entries(deletedAccounts)) {
    const age = now - (tombstone.deletedAt || 0);
    if (age > TOMBSTONE_RETENTION_MS) {
      const hasAccount = Boolean(accounts[accId]);
      const hasChat = Object.values(chats).some(
        (chat) => chat.accountId === accId,
      );
      if (!hasAccount && !hasChat) {
        delete cleaned[accId];
      }
    }
  }

  return cleaned;
}

async function readSyncedData() {
  let header = {};
  try {
    header = await chrome.storage.sync.get([
      SYNC_KEYS.accounts,
      SYNC_KEYS.meta,
      SYNC_KEYS.deletedAccounts,
    ]);
  } catch (_) {}
  const meta = header[SYNC_KEYS.meta] || {};
  const chunkCount = Number(meta.chatChunkCount || 0);
  const chunkKeys = [];
  for (let i = 0; i < chunkCount; i++) {
    chunkKeys.push(`${SYNC_KEYS.chatPrefix}${i}`);
  }
  let chunkData = {};
  if (chunkKeys.length > 0) {
    try {
      chunkData = await chrome.storage.sync.get(chunkKeys);
    } catch (_) {}
  }
  const chats = {};

  for (const key of chunkKeys) {
    const rows = Array.isArray(chunkData[key]) ? chunkData[key] : [];
    for (const row of rows) {
      const chat = expandChat(row);
      if (chat.storageId) chats[chat.storageId] = chat;
    }
  }

  return {
    accounts: header[SYNC_KEYS.accounts] || {},
    chats,
    meta,
    deletedAccounts: header[SYNC_KEYS.deletedAccounts] || {},
  };
}

// Phase 2: tryDecodeJwtEmail() and extractEmailFromCookies() deleted.
// accountId is now derived from the API-confirmed orgId, not from email at all.
// Email is fetched via /api/account in content-script.js for display metadata only.
// The GET_ACCOUNT_EMAIL message handler has also been removed.

let syncInProgress = false;
const syncQueue = [];

// Structured logging for the background service worker (visible in chrome://extensions → service worker)
// bgLog/bgWarn are silenced when developer mode is OFF (devMode key not set in chrome.storage.local).
// Toggle dev mode by clicking the popup title 5 times.
const BGT = "[CCT-BG]";
let bgLog  = (...a) => console.log(BGT, ...a);
let bgWarn = (...a) => console.warn(BGT, ...a);

// Read devMode from storage once on startup; silence logging if not set.
(async () => {
  try {
    const result = await chrome.storage.local.get(["devMode"]);
    if (!result.devMode) {
      const noop = () => {};
      bgLog  = noop;
      bgWarn = noop;
    }
  } catch (_) {
    // Storage unavailable — default to silent.
    const noop = () => {};
    bgLog  = noop;
    bgWarn = noop;
  }
})();

// ─── declarativeNetRequest: login_hint injection ──────────────────────────────
// When the user switches accounts, we register a dynamic DNR rule that appends
// login_hint=<email> to the Google OAuth URL. This causes Google to pre-select
// the right account on the chooser screen (or skip the chooser entirely).
// The rule is removed immediately after login completes or is cancelled.
const LOGIN_HINT_RULE_ID = 1001; // arbitrary stable ID for our single dynamic rule

async function setLoginHintRule(email) {
  if (!email || typeof chrome.declarativeNetRequest === "undefined") return;
  try {
    // Remove any existing rule first (idempotent).
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [LOGIN_HINT_RULE_ID],
    });
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id: LOGIN_HINT_RULE_ID,
          priority: 1,
          action: {
            type: "redirect",
            redirect: {
              transform: {
                queryTransform: {
                  addOrReplaceParams: [{ key: "login_hint", value: email }],
                },
              },
            },
          },
          condition: {
            // Matches both the v2 and legacy Google OAuth endpoints.
            urlFilter: "||accounts.google.com/o/oauth2/",
            resourceTypes: ["main_frame", "sub_frame"],
          },
        },
      ],
    });
    bgLog("🔑 login_hint rule set for:", email);
  } catch (err) {
    bgWarn("⚠️ setLoginHintRule error:", err && err.message);
  }
}

async function clearLoginHintRule() {
  if (typeof chrome.declarativeNetRequest === "undefined") return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [LOGIN_HINT_RULE_ID],
    });
    bgLog("🔑 login_hint rule cleared.");
  } catch (err) {
    bgWarn("⚠️ clearLoginHintRule error:", err && err.message);
  }
}

// Clear any stale login_hint rule left from a previous session.
clearLoginHintRule();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // TOMBSTONE_ACCOUNT
  if (message.type === "TOMBSTONE_ACCOUNT") {
    const { accountId } = message;
    bgLog("🪦 TOMBSTONE_ACCOUNT:", accountId);
    (async () => {
      try {
        const data = await chrome.storage.sync.get([SYNC_KEYS.deletedAccounts]);
        const deletedAccounts = data[SYNC_KEYS.deletedAccounts] || {};
        if (!deletedAccounts[accountId]) {
          deletedAccounts[accountId] = {
            accountId,
            deletedAt: Date.now(),
            auto: true,
          };
          await chrome.storage.sync.set({
            [SYNC_KEYS.deletedAccounts]: deletedAccounts,
          });
          bgLog("🪦 Tombstone written to sync for", accountId);
        } else {
          bgLog("🪦 Tombstone already exists for", accountId);
        }
        sendResponse({ ok: true });
      } catch (err) {
        bgWarn("🪦 TOMBSTONE_ACCOUNT error:", err);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  // Phase 1: Tombstone resurrection
  if (message.type === "RESURRECT_ACCOUNT") {
    const { accountId } = message;
    bgLog("🌱 RESURRECT_ACCOUNT:", accountId);
    (async () => {
      try {
        const data = await chrome.storage.sync.get([SYNC_KEYS.deletedAccounts]);
        const deletedAccounts = data[SYNC_KEYS.deletedAccounts] || {};
        if (deletedAccounts[accountId]) {
          delete deletedAccounts[accountId];
          await chrome.storage.sync.set({
            [SYNC_KEYS.deletedAccounts]: deletedAccounts,
          });
          bgLog("🌱 Tombstone removed from sync for", accountId);
        } else {
          bgLog("🌱 No tombstone found for", accountId, "— nothing to remove");
        }
        sendResponse({ ok: true });
      } catch (err) {
        bgWarn("🌱 RESURRECT_ACCOUNT error:", err);
        sendResponse({
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  // SET_LOGIN_HINT: install a declarativeNetRequest rule to inject login_hint
  // into the Google OAuth redirect URL before the browser navigates to accounts.google.com.
  if (message.type === "SET_LOGIN_HINT") {
    const { email } = message;
    bgLog("🔑 SET_LOGIN_HINT:", email);
    (async () => {
      await setLoginHintRule(email);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // CLEAR_LOGIN_HINT: remove the declarativeNetRequest rule (login complete or cancelled).
  if (message.type === "CLEAR_LOGIN_HINT") {
    bgLog("🔑 CLEAR_LOGIN_HINT");
    (async () => {
      await clearLoginHintRule();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // VAULT_CAPTURE_SESSION: captures active session into vault
  if (message.type === "VAULT_CAPTURE_SESSION") {
    const { accountId, email, orgId } = message;
    (async () => {
      try {
        if (self.CctVault && accountId) {
          const res = await self.CctVault.captureSession(accountId, email, orgId);
          sendResponse({ ok: Boolean(res), count: res?.cookies?.length || 0 });
          return;
        }
        sendResponse({ ok: false, error: "Vault not available or missing accountId" });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // VAULT_RESTORE_SESSION: restores saved session into browser cookie jar
  if (message.type === "VAULT_RESTORE_SESSION") {
    const { accountId } = message;
    (async () => {
      try {
        if (self.CctVault && accountId) {
          const res = await self.CctVault.restoreSession(accountId);
          sendResponse(res);
          return;
        }
        sendResponse({ ok: false, error: "Vault not available or missing accountId" });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // VAULT_SYNC_ACCOUNT: performs transient background swap, fetches conversations from Claude API,
  // syncs them to storage, and immediately restores original active session cookies!
  if (message.type === "VAULT_SYNC_ACCOUNT") {
    const { targetAccountId } = message;
    bgLog(`⚡ VAULT_SYNC_ACCOUNT requested for: ${targetAccountId}`);
    (async () => {
      if (!self.CctVault) {
        sendResponse({ ok: false, error: "Session vault not loaded" });
        return;
      }
      const data = await chrome.storage.local.get(["sessionVault", "currentAccountId", "accounts", "chats"]);
      const vault = data.sessionVault || {};
      const targetSession = vault[targetAccountId];

      if (!targetSession || !Array.isArray(targetSession.cookies) || targetSession.cookies.length === 0) {
        sendResponse({
          ok: false,
          needsLogin: true,
          error: "No active session in vault for this account. Please open this account once to initialize the session vault.",
        });
        return;
      }

      const activeAccountId = data.currentAccountId;
      // Snapshot current browser cookies before swapping
      const activeCookies = await self.CctVault.getActiveClaudeCookies();

      let targetOrgId = targetSession.orgId;
      let newChatsCount = 0;

      try {
        // 1. Transient Swap: inject target account's cookies into the cookie jar
        await self.CctVault.clearClaudeCookies();
        await self.CctVault.injectCookies(targetSession.cookies);

        // 2. Resolve organization UUID if missing
        if (!targetOrgId) {
          try {
            const orgRes = await fetch("https://claude.ai/api/organizations", {
              credentials: "include",
              headers: { Accept: "application/json" },
            });
            if (orgRes.status === 401 || orgRes.status === 403) {
              await self.CctVault.markSessionExpired(targetAccountId);
              sendResponse({
                ok: false,
                expired: true,
                error: "Session expired for target account. Please re-authenticate.",
              });
              return;
            }
            if (orgRes.ok) {
              const orgData = await orgRes.json();
              const orgs = Array.isArray(orgData) ? orgData : orgData.organizations || [];
              const org = orgs.find((o) => !o.is_default_org) || orgs[0];
              if (org && (org.uuid || org.id)) {
                targetOrgId = org.uuid || org.id;
                targetSession.orgId = targetOrgId;
                await chrome.storage.local.set({ sessionVault: vault });
              }
            }
          } catch (orgErr) {
            bgWarn("Failed to resolve orgId during vault sync:", orgErr);
          }
        }

        if (!targetOrgId) {
          sendResponse({ ok: false, error: "Could not resolve organization ID for account." });
          return;
        }

        // 3. Fetch conversations from Claude REST API
        const convRes = await fetch(
          `https://claude.ai/api/organizations/${targetOrgId}/chat_conversations?limit=100`,
          { credentials: "include", headers: { Accept: "application/json" } }
        );

        if (convRes.status === 401 || convRes.status === 403) {
          await self.CctVault.markSessionExpired(targetAccountId);
          sendResponse({
            ok: false,
            expired: true,
            error: "Session expired for target account. Please re-authenticate.",
          });
          return;
        }

        if (!convRes.ok) {
          sendResponse({ ok: false, error: `Claude API returned status ${convRes.status}` });
          return;
        }

        const convData = await convRes.json();
        const rawConvs = Array.isArray(convData)
          ? convData
          : convData.conversations || convData.chat_conversations || [];

        const incomingChats = {};
        const now = Date.now();
        for (const c of rawConvs) {
          const chatId = c.uuid || c.id;
          if (!chatId) continue;
          const storageId = `${targetAccountId}:${chatId}`;
          const title = (c.name || c.title || "Untitled Chat").trim();
          const updatedAt = c.updated_at ? new Date(c.updated_at).getTime() : now;
          incomingChats[storageId] = {
            storageId,
            chatId,
            accountId: targetAccountId,
            title,
            url: `https://claude.ai/chat/${chatId}`,
            firstSeen: updatedAt || now,
            lastSeen: now,
            serverUpdatedAt: updatedAt || null,
            sectionTimestamp: null,
            sidebarOrder: 0,
            orderSeenAt: now,
          };
        }

        // 4. Merge new chats into storage and sync
        const accounts = data.accounts || {};
        const targetAccount = accounts[targetAccountId] || {
          accountId: targetAccountId,
          email: targetSession.email || null,
          displayName: targetSession.email ? targetSession.email.split("@")[0] : "Claude Account",
          firstSeen: now,
          lastSeen: now,
        };
        targetAccount.lastSeen = now;
        accounts[targetAccountId] = targetAccount;

        // Queue write via existing sync pipeline
        syncQueue.push({
          accounts: { [targetAccountId]: targetAccount },
          chats: incomingChats,
          deletedAccounts: {},
          deletedChatIds: [],
          resolve: () => {},
        });
        processQueue();

        newChatsCount = Object.keys(incomingChats).length;
        bgLog(`✅ VAULT_SYNC_ACCOUNT completed: synced ${newChatsCount} chats for ${targetAccountId}`);
        sendResponse({ ok: true, syncedCount: newChatsCount, targetAccountId });
      } catch (syncErr) {
        bgWarn("VAULT_SYNC_ACCOUNT error:", syncErr);
        sendResponse({ ok: false, error: syncErr && syncErr.message ? syncErr.message : String(syncErr) });
      } finally {
        // 5. Unconditional Restoration: ALWAYS restore the original active account's cookies!
        try {
          await self.CctVault.clearClaudeCookies();
          if (activeCookies.length > 0) {
            await self.CctVault.injectCookies(activeCookies);
          }
          if (activeAccountId) {
            await chrome.storage.local.set({ currentAccountId: activeAccountId });
          }
          bgLog("🔄 Restored original active session cookies.");
        } catch (restoreErr) {
          bgWarn("Error restoring active session cookies in finally block:", restoreErr);
        }
      }
    })();
    return true;
  }

  // GENERATE_EMBEDDING: execute Gemini embedding fetch in privileged background context (bypasses content-script CORS)
  if (message.type === "GENERATE_EMBEDDING") {
    const { text, apiKey } = message;
    (async () => {
      if (!text || !text.trim()) {
        sendResponse({ ok: true, values: [] });
        return;
      }
      if (!apiKey) {
        sendResponse({ ok: false, error: "INVALID_KEY" });
        return;
      }
      try {
        const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
        const res = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify({
              model: "models/gemini-embedding-001",
              content: { parts: [{ text: truncated }] },
              outputDimensionality: 768,
            }),
          }
        );

        if (res.status === 401 || res.status === 403) {
          sendResponse({ ok: false, error: "INVALID_KEY" });
          return;
        }
        if (res.status === 429) {
          sendResponse({ ok: false, error: "RATE_LIMITED" });
          return;
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          bgWarn("Gemini API error:", res.status, errBody);
          if (res.status === 400 && (errBody.includes("API_KEY_INVALID") || errBody.includes("API key not valid"))) {
            sendResponse({ ok: false, error: "INVALID_KEY" });
            return;
          }
          sendResponse({ ok: false, error: `Gemini API error: ${res.status}${errBody ? ' - ' + errBody.slice(0, 200) : ''}` });
          return;
        }

        const data = await res.json();
        const values = data && data.embedding && data.embedding.values ? data.embedding.values : [];
        sendResponse({ ok: true, values });
      } catch (fetchErr) {
        bgWarn("GENERATE_EMBEDDING fetch exception:", fetchErr);
        sendResponse({ ok: false, error: fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr) });
      }
    })();
    return true;
  }

  if (message.type !== "SYNC_DATA") return false;
  bgLog(`🔄 SYNC_DATA queued (queue depth: ${syncQueue.length + 1})`);
  syncQueue.push({
    accounts: message.accounts,
    chats: message.chats,
    deletedAccounts: message.deletedAccounts,
    deletedChatIds: message.deletedChatIds,
    resolve: sendResponse,
  });
  processQueue();
  return true;
});

async function processQueue() {
  if (syncInProgress || syncQueue.length === 0) return;
  syncInProgress = true;

  const batch = [...syncQueue];
  syncQueue.length = 0;
  bgLog(`🔄 processQueue: processing ${batch.length} item(s)`);

  try {
    const synced = await readSyncedData();
    let currentAccounts = { ...synced.accounts };
    let currentChats = { ...synced.chats };
    let currentDeleted = { ...synced.deletedAccounts };

    for (const item of batch) {
      currentDeleted = mergeDeletedAccounts(
        currentDeleted,
        item.deletedAccounts,
      );
      currentAccounts = mergeAccounts(
        currentAccounts,
        item.accounts,
        currentDeleted,
      );
      currentChats = mergeChats(currentChats, item.chats, currentDeleted);
      if (item.deletedChatIds) {
        for (const id of item.deletedChatIds) {
          delete currentChats[id];
        }
      }
    }

    currentDeleted = gcTombstones(
      currentDeleted,
      currentAccounts,
      currentChats,
    );

    const prunedCount = await doSyncWrite(
      currentAccounts,
      currentChats,
      currentDeleted,
    );
    bgLog(
      `🔄 processQueue done — accounts: ${Object.keys(currentAccounts).length}, chats: ${Object.keys(currentChats).length}, pruned: ${prunedCount}`,
    );

    for (const item of batch) {
      if (typeof item.resolve === "function") {
        item.resolve({ ok: true, prunedCount, cutoffDays: 90 });
      }
    }
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    bgWarn("🔄 processQueue error:", errMsg);
    for (const item of batch) {
      if (typeof item.resolve === "function") {
        item.resolve({ ok: false, error: errMsg });
      }
    }
  } finally {
    syncInProgress = false;
    processQueue();
  }
}

async function doSyncWrite(accounts, chats, deletedAccounts) {
  // Read the current meta to know how many chunks to clean up
  let previousChunkCount = 0;
  try {
    const header = await chrome.storage.sync.get([SYNC_KEYS.meta]);
    previousChunkCount = Number(
      (header[SYNC_KEYS.meta] || {}).chatChunkCount || 0,
    );
  } catch (_) {
    /* if read fails, proceed with 0 */
  }

  // 3. Before writing sync, remove accounts and chats whose account ID is tombstoned.
  const filteredAccounts = {};
  for (const [accId, acc] of Object.entries(accounts || {})) {
    if (!isAccountDeleted(accId, deletedAccounts)) {
      filteredAccounts[accId] = acc;
    }
  }
  let filteredChats = {};
  for (const [storageId, chat] of Object.entries(chats || {})) {
    if (!isAccountDeleted(chat.accountId, deletedAccounts)) {
      filteredChats[storageId] = chat;
    }
  }

  // Check sync bytes in use
  let prunedCount = 0;
  try {
    const bytesInUse = await chrome.storage.sync.getBytesInUse(null);
    const total = chrome.storage.sync.QUOTA_BYTES || 102400;
    if (bytesInUse > total * 0.85) {
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const prunedChats = {};
      for (const [storageId, chat] of Object.entries(filteredChats)) {
        if ((chat.lastSeen || 0) > cutoff) {
          prunedChats[storageId] = chat;
        } else {
          prunedCount++;
        }
      }
      filteredChats = prunedChats;
    }
  } catch (_) {}

  // Sanitise accounts: keep only the known fields to prevent old-version field bloat
  // from accumulating across sync cycles and eventually overflowing the 8192-byte key limit.
  const sanitisedAccounts = {};
  for (const [accId, acc] of Object.entries(filteredAccounts)) {
    sanitisedAccounts[accId] = {
      accountId: acc.accountId,
      email: acc.email || null,
      displayName: acc.displayName || "",
      color: acc.color || "#4A90D9",
      firstSeen: acc.firstSeen || Date.now(),
      lastSeen: acc.lastSeen || Date.now(),
    };
  }

  const chunks = makeChatChunks(filteredChats);
  const payload = {
    [SYNC_KEYS.accounts]: sanitisedAccounts,
    [SYNC_KEYS.deletedAccounts]: deletedAccounts,
    [SYNC_KEYS.meta]: {
      chatChunkCount: chunks.length,
      updatedAt: Date.now(),
      version: 2,
    },
  };

  chunks.forEach((chunk, index) => {
    payload[`${SYNC_KEYS.chatPrefix}${index}`] = chunk;
  });

  // Pre-write guard: validate no single key exceeds Chrome's 8192-byte per-item limit.
  // If a value is too large, we split chat chunks further or skip the oversized key.
  const CHROME_ITEM_LIMIT = 8100; // 8192 with 92-byte safety margin
  const safePayload = {};
  const overflowKeys = [];
  for (const [key, value] of Object.entries(payload)) {
    const len = JSON.stringify(value).length;
    if (len > CHROME_ITEM_LIMIT) {
      overflowKeys.push({ key, len });
    } else {
      safePayload[key] = value;
    }
  }

  if (overflowKeys.length > 0) {
    bgWarn(
      "⚠️  Pre-write overflow detected — keys too large for sync:",
      overflowKeys.map((k) => k.key + "(" + k.len + "B)").join(", "),
    );
    // For chat chunk overflows: re-chunk the offending chunks at half size
    for (const { key } of overflowKeys) {
      if (!key.startsWith(SYNC_KEYS.chatPrefix)) {
        bgWarn("⚠️  Non-chat key overflow, skipping:", key);
        continue;
      }
      const idx = parseInt(key.replace(SYNC_KEYS.chatPrefix, ""), 10);
      const oversizedChunk = chunks[idx] || [];
      const half = Math.ceil(oversizedChunk.length / 2);
      // Write as two smaller keys using a sub-index suffix
      const subA = oversizedChunk.slice(0, half);
      const subB = oversizedChunk.slice(half);
      safePayload[key + "_a"] = subA;
      if (subB.length > 0) safePayload[key + "_b"] = subB;
      bgWarn(
        "⚠️  Re-split chunk",
        key,
        "into",
        key + "_a",
        "(" + subA.length + ") and",
        key + "_b",
        "(" + subB.length + ")",
      );
    }
  }

  await chrome.storage.sync.set(safePayload);

  // Remove stale chunk keys from a previous write that had more chunks
  if (previousChunkCount > chunks.length) {
    const staleKeys = [];
    for (let i = chunks.length; i < previousChunkCount; i++) {
      staleKeys.push(`${SYNC_KEYS.chatPrefix}${i}`);
    }
    await chrome.storage.sync.remove(staleKeys);
  }

  return prunedCount;
}
