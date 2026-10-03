"use strict";

if (typeof chrome === "undefined" || !chrome.storage) {
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        if (msg && msg.type === "SYNC_DATA") {
          setTimeout(() => cb({ ok: true, prunedCount: 0 }), 100);
        }
      },
    },
    storage: {
      local: {
        get: (keys) => {
          return Promise.resolve({
            currentAccountId: "acc_1",
            accounts: {
              acc_1: {
                accountId: "acc_1",
                email: "work@company.com",
                displayName: "Work Profile",
                color: "#4A90D9",
                isManual: false,
              },
              acc_2: {
                accountId: "acc_2",
                email: "personal@gmail.com",
                displayName: "Personal Profile",
                color: "#D9784A",
                isManual: false,
              },
              acc_3: {
                accountId: "acc_3",
                email: "hobby@gmail.com",
                displayName: "Hobby Projects",
                color: "#45A878",
                isManual: false,
              },
            },
            chats: {
              chat_1: {
                storageId: "chat_1",
                chatId: "1",
                accountId: "acc_1",
                title: "React Performance Optimization Tips",
                url: "https://claude.ai/chat/1",
                serverUpdatedAt: Date.now() - 5000,
              },
              chat_2: {
                storageId: "chat_2",
                chatId: "2",
                accountId: "acc_1",
                title: "Rust Web Server Implementation using Axum",
                url: "https://claude.ai/chat/2",
                serverUpdatedAt: Date.now() - 3600000 * 2,
              },
              chat_3: {
                storageId: "chat_3",
                chatId: "3",
                accountId: "acc_2",
                title: "Premium Dark Theme Design System Audit",
                url: "https://claude.ai/chat/3",
                serverUpdatedAt: Date.now() - 3600000 * 25,
              },
              chat_4: {
                storageId: "chat_4",
                chatId: "4",
                accountId: "acc_3",
                title: "Weekly Groceries List & Meal Planner",
                url: "https://claude.ai/chat/4",
                serverUpdatedAt: Date.now() - 3600000 * 24 * 5,
              },
              chat_5: {
                storageId: "chat_5",
                chatId: "5",
                accountId: "acc_1",
                title:
                  "Very Long Title that should be truncated to a single line using text-overflow ellipsis otherwise it breaks the rhythm of the list",
                url: "https://claude.ai/chat/5",
                serverUpdatedAt: Date.now() - 100,
              },
            },
            starredChatIds: ["chat_2"],
          });
        },
        set: (vals) => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      sync: {
        get: (keys) => {
          return Promise.resolve({
            syncMeta: { chatChunkCount: 0 },
          });
        },
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      onChanged: {
        addListener: () => {},
      },
    },
  };
}

const STORAGE_KEYS = {
  accounts: "accounts",
  chats: "chats",
  currentAccountId: "currentAccountId",
  syncStatus: "syncStatus",
  pendingOpen: "pendingOpen",
  searchMode: "searchMode",
};

const SYNC_KEYS = {
  accounts: "syncAccounts",
  meta: "syncMeta",
  chatPrefix: "syncChats_",
  deletedAccounts: "syncDeletedAccounts",
};

const ACCOUNT_COLORS = [
  "#4A90D9",
  "#D9784A",
  "#45A878",
  "#8D66CC",
  "#C9A227",
  "#2D9BA3",
  "#C85C7A",
  "#789A45",
];

let searchIndexHandle = null;
let indexProgressPollTimer = null;

// Phase B: debounce timer for API key saves
let _semanticKeySaveTimer = null;

let state = {
  accounts: {},
  chats: {},
  activeAccountId: "all",
  currentAccountId: "",
  viewMode: "all",
  syncStatus: null,
  query: "",
  deletedAccountIds: [], // BUG-03: tombstone IDs for accounts deleted locally but not yet confirmed in sync
  starredChatIds: new Set(), // storageId strings — starred chats always sort to top
  profileLocalId: "",
  allowedIndexingAccounts: [], // list of accountIds that have indexing enabled
  allAccountsIndexingEnabled: false, // global auto-index toggle
  // Phase B
  semanticSettings: null, // { enabled, apiKey } or null
  searchMode: "hybrid", // Default search mode: 'text' | 'semantic' | 'hybrid'
  vaultMeta: {}, // Account session vault metadata
};

// BUG-01 fix: re-entrancy guard — set to true while we are writing to chrome.storage.sync
// so the onChanged listener does not trigger another reloadData() during our own sync write.
let isSyncing = false;

// IMP-05: module-level flag updated by updateQuotaDisplay() and read by renderStatus().
// Using a flag (not DOM mutation) prevents the quota warning from being appended
// multiple times when render() calls both renderStatus() and updateQuotaDisplay().
let syncQuotaWarning = false;

function hasSyncApi() {
  return chrome.storage && chrome.storage.sync;
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function syncGet(keys) {
  if (!hasSyncApi()) return Promise.resolve({});
  return chrome.storage.sync.get(keys);
}

function syncSet(values) {
  if (!hasSyncApi()) return Promise.resolve();
  return chrome.storage.sync.set(values);
}

function syncRemove(keys) {
  if (!hasSyncApi()) return Promise.resolve();
  return chrome.storage.sync.remove(keys);
}

// Render a chat timestamp in Claude's own display style:
//   < 1 hour  : "11 minutes ago"
//   < 24 hours: "3 hours ago"
//   1–2 days  : "Yesterday"
//   < 7 days  : "4 days ago"
//   this year : "Jun 5"
//   older     : "Jun 5, 2024"
function formatChatDate(timestamp) {
  if (!timestamp) return "unknown";

  const diff = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;

  const now = new Date();
  const todayMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const yesterdayMidnight = todayMidnight - 24 * hour;

  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)} minutes ago`;
  if (diff < 2 * hour) return "1 hour ago";
  if (diff < 24 * hour) return `${Math.floor(diff / hour)} hours ago`;

  if (timestamp >= yesterdayMidnight) {
    return "Yesterday";
  }

  const day = 24 * hour;
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;

  const d = new Date(timestamp);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${months[d.getMonth()]} ${d.getDate()}`
    : `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function shortAccountName(account) {
  if (!account) return "Unknown account";
  if (account.autoDetectedName === false && account.displayName) {
    return account.displayName;
  }
  const email =
    account.email ||
    (state &&
      state.vaultMeta &&
      state.vaultMeta[account.accountId] &&
      state.vaultMeta[account.accountId].email);
  if (email) {
    return email.split("@")[0] || email;
  }
  return account.displayName || "Unknown account";
}

function currentAccountDisplay(account) {
  if (!account) return "Open Claude to detect automatically";
  return shortAccountName(account);
}

function colorForAccount(accounts) {
  return ACCOUNT_COLORS[
    Object.keys(accounts || {}).length % ACCOUNT_COLORS.length
  ];
}

function normalizeSearch(value) {
  return (value || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function chatSearchText(chat) {
  const account = state.accounts[chat.accountId] || {};
  return normalizeSearch(
    [chat.title, shortAccountName(account), account.email, chat.url]
      .filter(Boolean)
      .join(" "),
  );
}

// FLAW-03 fix: sort object keys before stringifying to get a stable representation.
// Two semantically identical objects with different key insertion order would otherwise
// produce different JSON strings, causing unnecessary storageSet() calls on every reloadData().

function hasSidebarOrder(chat) {
  return Number.isFinite(chat.sidebarOrder);
}

// FLAW-04 fix: sidebarOrder older than 6 hours is considered stale.
const SIDEBAR_ORDER_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

// Improved compareChats using serverUpdatedAt as the primary date signal when available.
// Priority:
//   1. Starred chats always sort above non-starred
//   2. Same account + both have fresh sidebarOrder → trust Claude's sidebar position exactly
//   3. serverUpdatedAt (real conversation date from Claude API) when present
//   4. sectionTimestamp (sidebar bucket) as fallback
//   5. lastSeen (extension scrape time) as last resort
//   6. Alphabetical title tiebreaker
function compareChats(a, b) {
  const aStarred = state.starredChatIds.has(a.storageId);
  const bStarred = state.starredChatIds.has(b.storageId);
  if (aStarred !== bStarred) return aStarred ? -1 : 1;

  const now = Date.now();
  const aFresh =
    hasSidebarOrder(a) && now - (a.orderSeenAt || 0) < SIDEBAR_ORDER_MAX_AGE_MS;
  const bFresh =
    hasSidebarOrder(b) && now - (b.orderSeenAt || 0) < SIDEBAR_ORDER_MAX_AGE_MS;

  // Same account + both fresh → trust Claude's own sidebar ordering exactly
  if (a.accountId === b.accountId && aFresh && bFresh) {
    return a.sidebarOrder - b.sidebarOrder;
  }

  // Best available date signal: serverUpdatedAt > sectionTimestamp > lastSeen
  const aTime = a.serverUpdatedAt || a.sectionTimestamp || a.lastSeen || 0;
  const bTime = b.serverUpdatedAt || b.sectionTimestamp || b.lastSeen || 0;
  if (aTime !== bTime) return bTime - aTime;

  // Tiebreakers when dates are identical:
  if (a.accountId === b.accountId && aFresh && bFresh)
    return a.sidebarOrder - b.sidebarOrder;
  const aLast = a.lastSeen || 0;
  const bLast = b.lastSeen || 0;
  if (aLast !== bLast) return bLast - aLast;
  return (a.title || "").localeCompare(b.title || "");
}

async function readSyncedData() {
  const header = await syncGet([
    SYNC_KEYS.accounts,
    SYNC_KEYS.meta,
    SYNC_KEYS.deletedAccounts,
  ]);
  const meta = header[SYNC_KEYS.meta] || {};
  const chunkCount = Number(meta.chatChunkCount || 0);
  const chunkKeys = [];
  for (let i = 0; i < chunkCount; i++) {
    chunkKeys.push(`${SYNC_KEYS.chatPrefix}${i}`);
    chunkKeys.push(`${SYNC_KEYS.chatPrefix}${i}_a`);
    chunkKeys.push(`${SYNC_KEYS.chatPrefix}${i}_b`);
  }
  const chunkData = chunkKeys.length > 0 ? await syncGet(chunkKeys) : {};
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

async function writeSyncedData(
  accounts,
  chats,
  deletedAccounts = {},
  previousChunkCount = 0,
) {
  void previousChunkCount;
  return await sendSyncToBackground(accounts, chats, deletedAccounts);
}

async function persistData({
  accounts = state.accounts,
  chats = state.chats,
  currentAccountId = state.currentAccountId,
} = {}) {
  while (isSyncing) await new Promise(r => setTimeout(r, 50));
  state.accounts = accounts;
  state.chats = chats;
  state.currentAccountId = currentAccountId;

  // Phase 3 — Re-entrancy guard:
  // Set isSyncing BEFORE the local storageSet so the onChanged listener
  // does not fire reloadData() while this function is still executing.
  isSyncing = true;
  try {
    await storageSet({
      accounts,
      chats,
      currentAccountId,
      allowedIndexingAccounts: state.allowedIndexingAccounts,
      allAccountsIndexingEnabled: state.allAccountsIndexingEnabled,
    });

    const synced = await readSyncedData();
    const deletedAccounts = synced.deletedAccounts || {};
    const mergedAccounts = mergeAccounts(
      synced.accounts,
      accounts,
      deletedAccounts,
      state.deletedAccountIds,
    );
    const mergedChats = mergeChats(
      synced.chats,
      chats,
      deletedAccounts,
      state.deletedAccountIds,
    );
    const response = await writeSyncedData(
      mergedAccounts,
      mergedChats,
      deletedAccounts,
      Number(synced.meta.chatChunkCount || 0),
    );
    state.accounts = mergedAccounts;
    state.chats = mergedChats;
    const msg =
      response && response.prunedCount > 0
        ? `Synced; ${response.prunedCount} older chats skipped from sync`
        : "Synced";
    state.syncStatus = {
      ok: true,
      updatedAt: Date.now(),
      message: msg,
    };
    await storageSet({
      accounts: mergedAccounts,
      chats: mergedChats,
      syncStatus: state.syncStatus,
      allowedIndexingAccounts: state.allowedIndexingAccounts,
    });
  } catch (error) {
    state.syncStatus = {
      ok: false,
      updatedAt: Date.now(),
      message: error && error.message ? error.message : String(error),
    };
    await storageSet({ syncStatus: state.syncStatus });
  } finally {
    // Always release the lock — even if sync threw — so the UI is never permanently frozen.
    isSyncing = false;
  }
}

function visibleChats() {
  let chats = Object.values(state.chats || {});

  if (state.activeAccountId !== "all") {
    chats = chats.filter((chat) => chat.accountId === state.activeAccountId);
  }

  const query = normalizeSearch(state.query);
  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);
    chats = chats.filter((chat) => {
      const haystack = chatSearchText(chat);
      return terms.every((term) => haystack.includes(term));
    });
  }

  // Cleanup filter: prefer modern acc_org_ entries over legacy non-org entries for the
  // same chatId. When both entries are under real modern accounts, keep both (valid cross-org data).
  const isLegacyAccount = (id) =>
    typeof id !== "string" || !id.startsWith("acc_org_");
  const seenChatIds = new Map(); // chatId → first winning chat object
  return chats.sort(compareChats).filter((chat) => {
    const prior = seenChatIds.get(chat.chatId);
    if (!prior) {
      seenChatIds.set(chat.chatId, chat);
      return true;
    }
    // If one of the two is legacy, modern acc_org_ wins!
    if (isLegacyAccount(prior.accountId) || isLegacyAccount(chat.accountId)) {
      if (!isLegacyAccount(chat.accountId) && isLegacyAccount(prior.accountId)) {
        seenChatIds.set(chat.chatId, chat);
        return true;
      }
      return false;
    }
    return true;
  });
}

function renderStatus() {
  const accountCount = Object.keys(state.accounts || {}).length;
  const chatCount = Object.keys(state.chats || {}).length;
  const accountWord = accountCount === 1 ? "account" : "accounts";

  const statsEl = document.getElementById("statsText");
  if (statsEl) {
    statsEl.textContent = `${chatCount} chats · ${accountCount} ${accountWord}`;
  }

  const container = document.getElementById("syncStatusContainer");
  const syncTextEl = document.getElementById("syncText");

  if (container && syncTextEl) {
    if (state.syncStatus && state.syncStatus.ok === false) {
      container.classList.add("has-issue");
      syncTextEl.textContent = "Sync issue";

      let fixLink = document.getElementById("syncFixLink");
      if (!fixLink) {
        fixLink = document.createElement("a");
        fixLink.id = "syncFixLink";
        fixLink.textContent = "Fix";
        fixLink.href = "#";
        fixLink.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const errMessage =
            state.syncStatus && state.syncStatus.message
              ? state.syncStatus.message
              : "Unknown sync error";
          if (
            confirm(
              `Sync failed: "${errMessage}". Would you like to retry now?`,
            )
          ) {
            reloadData();
          }
        });
        container.appendChild(fixLink);
      }
    } else {
      container.classList.remove("has-issue");
      let text = "Synced";
      if (syncQuotaWarning) text = "Synced (near limit)";
      syncTextEl.textContent = text;

      const fixLink = document.getElementById("syncFixLink");
      if (fixLink) {
        fixLink.remove();
      }
    }
  }

  const actionArea = document.getElementById("accountActionArea");
  const globalArea = document.getElementById("globalActionArea");

  if (state.activeAccountId === "all") {
    if (actionArea) actionArea.style.display = "none";
    if (globalArea) {
      globalArea.style.display = "flex";
      const statusText = document.getElementById("globalIndexStatusText");
      const toggleBtn = document.getElementById("globalIndexToggleBtn");
      const isGlobalEnabled = !!state.allAccountsIndexingEnabled;
      if (statusText) statusText.textContent = isGlobalEnabled ? "On" : "Off";
      if (toggleBtn) {
        toggleBtn.textContent = isGlobalEnabled ? "Turn Off" : "Turn On";
        toggleBtn.setAttribute(
          "data-tooltip",
          isGlobalEnabled
            ? "Turn off auto-indexing for all accounts"
            : "Automatically enable indexing for all accounts when selected"
        );
      }
    }
    if (indexProgressPollTimer) {
      clearInterval(indexProgressPollTimer);
      indexProgressPollTimer = null;
    }
  } else {
    if (globalArea) globalArea.style.display = "none";
    if (actionArea) actionArea.style.display = "flex";
    const account = selectedAccountForActions();
    if (account) {
      updateIndexStatusUI(account);
    } else if (indexProgressPollTimer) {
      clearInterval(indexProgressPollTimer);
      indexProgressPollTimer = null;
    }
  }
}

async function updateVaultStatusUI(account) {
  const vaultContainer = document.getElementById("vaultStatusContainer");
  if (!vaultContainer || !account) return;
  vaultContainer.replaceChildren();

  const isCurrent = account.accountId === state.currentAccountId;
  let hasSaved = false;
  let isExpired = false;

  if (window.CctVault) {
    hasSaved = await window.CctVault.hasSavedSession(account.accountId);
    const meta = (await window.CctVault.getAllSessionMetadata()) || {};
    const accMeta = meta[account.accountId];
    if (accMeta) {
      isExpired = Boolean(accMeta.expired);
    }
  }

  // Left status label
  const statusLabel = document.createElement("div");
  statusLabel.style.display = "flex";
  statusLabel.style.alignItems = "center";
  statusLabel.style.gap = "6px";
  statusLabel.style.minWidth = "0";

  if (isCurrent) {
    const text = document.createElement("span");
    text.textContent = "Active in browser";
    const badge = document.createElement("span");
    badge.className = "acct-item-badge active";
    badge.textContent = "Current";
    statusLabel.append(text, badge);
  } else if (hasSaved) {
    const text = document.createElement("span");
    text.textContent = "Ready in Vault";
    const badge = document.createElement("span");
    badge.className = "acct-item-badge vault";
    badge.textContent = "⚡ Ready";
    statusLabel.append(text, badge);
  } else if (isExpired) {
    const text = document.createElement("span");
    text.textContent = "Session Expired";
    const badge = document.createElement("span");
    badge.className = "acct-item-badge expired";
    badge.textContent = "⚠️ Re-login";
    statusLabel.append(text, badge);
  } else {
    const text = document.createElement("span");
    text.textContent = "No saved session";
    const badge = document.createElement("span");
    badge.className = "acct-item-badge";
    badge.style.background = "rgba(255,255,255,0.06)";
    badge.style.color = "var(--muted)";
    badge.textContent = "Needs Login";
    statusLabel.append(text, badge);
  }

  // Right actions row
  const actionsRow = document.createElement("div");
  actionsRow.style.display = "flex";
  actionsRow.style.alignItems = "center";
  actionsRow.style.gap = "6px";

  // 1. Sync Chats button (available if hasSaved or isCurrent)
  const syncBtn = document.createElement("button");
  syncBtn.className = "index-btn primary has-tooltip";
  syncBtn.textContent = "Sync Chats";
  syncBtn.setAttribute(
    "data-tooltip",
    "Sync latest chats headlessly in background without switching accounts"
  );
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "Syncing...";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "VAULT_SYNC_ACCOUNT",
        targetAccountId: account.accountId,
      });
      if (res && res.ok) {
        syncBtn.textContent = `✓ Synced ${res.syncedCount || 0}`;
        await reloadData();
        setTimeout(() => {
          render();
        }, 1800);
      } else if (res && res.expired) {
        syncBtn.textContent = "Expired";
        alert("Session for this account has expired. Please switch or log in once to re-authenticate.");
        await reloadData();
        render();
      } else if (res && res.needsLogin) {
        syncBtn.textContent = "Needs Login";
        alert("No saved session found in vault. Please switch or log in to this account once to enable background sync.");
        render();
      } else {
        syncBtn.textContent = "Failed";
        alert(res?.error || "Sync failed. Please check your internet connection.");
        setTimeout(() => {
          render();
        }, 1800);
      }
    } catch (err) {
      syncBtn.textContent = "Error";
      setTimeout(() => {
        render();
      }, 1800);
    }
  };
  actionsRow.appendChild(syncBtn);

  // 2. Switch button (only if not current)
  if (!isCurrent) {
    const switchBtn = document.createElement("button");
    switchBtn.className = "index-btn has-tooltip";
    switchBtn.textContent = "Switch";
    switchBtn.setAttribute(
      "data-tooltip",
      hasSaved
        ? "Instantly switch browser session to this account"
        : "Log in to this account to save it into the vault"
    );
    switchBtn.onclick = async () => {
      if (hasSaved) {
        if (state.currentAccountId) {
          const curAcct = state.accounts[state.currentAccountId] || {};
          await window.CctVault.captureSession(state.currentAccountId, curAcct.email);
        }
        const restoreRes = await window.CctVault.restoreSession(account.accountId);
        if (restoreRes && restoreRes.ok) {
          state.currentAccountId = account.accountId;
          await storageSet({
            currentAccountId: account.accountId,
            pendingOpen: null,
          });
          chrome.runtime.sendMessage({ type: "CLEAR_LOGIN_HINT" }).catch(() => {});
          chrome.tabs.create({ url: "https://claude.ai/chats" });
          window.close();
          return;
        }
      }

      // Standard OAuth login flow fallback
      state.currentAccountId = account.accountId;
      await storageSet({
        currentAccountId: account.accountId,
        pendingOpen: {
          accountId: account.accountId,
          accountEmail: account.email || null,
          accountName: shortAccountName(account),
          previousAccountName: shortAccountName(state.accounts[state.currentAccountId] || {}),
          chatTitle: "Chats",
          chatUrl: "https://claude.ai/chats",
          createdAt: Date.now(),
          googleStarted: false,
          loginStartedAt: null,
        },
      });
      await clearClaudeSession();
      if (account.email) {
        chrome.runtime.sendMessage({ type: "SET_LOGIN_HINT", email: account.email }).catch(() => {});
      }
      chrome.tabs.create({ url: "https://claude.ai/login" });
      window.close();
    };
    actionsRow.appendChild(switchBtn);
  }

  vaultContainer.append(statusLabel, actionsRow);
}

async function updateIndexStatusUI(account) {
  const drawerAccountNameEl = document.getElementById("drawerAccountName");
  if (drawerAccountNameEl && account) {
    drawerAccountNameEl.textContent = shortAccountName(account);
  }
  await updateVaultStatusUI(account);

  const drawerAccountStats = document.getElementById("drawerAccountStats");
  const statTotalChats = document.getElementById("statTotalChats");
  const statScannedChats = document.getElementById("statScannedChats");
  const statEmbeddings = document.getElementById("statEmbeddings");
  
  if (drawerAccountStats && account) {
    const totalChats = Object.values(state.chats || {}).filter(c => c.accountId === account.accountId).length;
    if (statTotalChats) statTotalChats.textContent = totalChats;
    // Only show the stats panel in developer mode (not visible to regular users).
    drawerAccountStats.style.display = window.CCT_DEV_MODE ? "flex" : "none";
    
    if (window.CCT_DEV_MODE) {
      if (statScannedChats && window.getAllChatContentForAccount) {
        window.getAllChatContentForAccount(account.accountId).then(records => {
          statScannedChats.textContent = records.length;
        }).catch(() => {});
      }
      
      if (statEmbeddings && window.getAllEmbeddings) {
        window.getAllEmbeddings().then(allEmbeddings => {
          const prefix = account.accountId + ":";
          const count = Object.keys(allEmbeddings || {}).filter(k => k.startsWith(prefix)).length;
          statEmbeddings.textContent = count;
        }).catch(() => {});
      }
    }
  }

  let statusContainer = document.getElementById("indexStatusContainer");
  if (!statusContainer) return;

  if (indexProgressPollTimer) {
    clearInterval(indexProgressPollTimer);
    indexProgressPollTimer = null;
  }

  const renderIndexStatus = async () => {
    statusContainer.replaceChildren();

    const isEnabled = !!(state.allAccountsIndexingEnabled || state.allowedIndexingAccounts.includes(account.accountId));

    const local = await storageGet(["indexingQueue"]);
    const q = local.indexingQueue;

    // Auto-trigger scanning if enabled, idle/unstarted, and currently logged in on the Claude tab
    if (
      isEnabled &&
      account.accountId === state.currentAccountId &&
      (!q || q.accountId !== account.accountId || q.status === "idle")
    ) {
      triggerIndexing(account, true);
    }

    if (!isEnabled) {
      const label = document.createElement("span");
      label.textContent = "Search inside messages: Off";

      const enableBtn = document.createElement("button");
      enableBtn.className = "index-btn has-tooltip";
      enableBtn.textContent = "Turn On";
      enableBtn.setAttribute("data-tooltip", "Enable indexing for this account");
      enableBtn.onclick = async () => {
        state.allowedIndexingAccounts.push(account.accountId);
        await persistData();
        triggerIndexing(account);
        render();
      };

      statusContainer.append(label, enableBtn);
      return;
    }

    const statusLabel = document.createElement("span");

    const disableBtn = document.createElement("button");
    disableBtn.className = "index-btn has-tooltip";
    disableBtn.textContent = "Turn Off";
    disableBtn.setAttribute("data-tooltip", "Turn off indexing & delete local database");
    disableBtn.onclick = async () => {
      if (state.allAccountsIndexingEnabled) {
        alert("All-account indexing is currently enabled. Turn off 'Auto-index all accounts' under 'All Accounts Settings' first to manage individual accounts.");
        return;
      }

      if (
        confirm(
          "Turn off message search for this account? This will delete the local search database for this account.",
        )
      ) {
        state.allowedIndexingAccounts = state.allowedIndexingAccounts.filter(
          (id) => id !== account.accountId,
        );
        await persistData();
        if (window.deleteChatContentForAccount) {
          await window.deleteChatContentForAccount(account.accountId);
        }
        // Phase B: also clear embeddings for this account
        if (window.deleteEmbeddingsForAccount) {
          await window.deleteEmbeddingsForAccount(account.accountId);
        }
        if (q && q.accountId === account.accountId) {
          await chrome.storage.local.remove(["indexingQueue"]);
        }
        if (window.buildSearchIndex) {
          searchIndexHandle = await window.buildSearchIndex();
        }
        render();
      }
    };

    if (!q || q.accountId !== account.accountId || q.status === "idle") {
      // Try to find the most recently indexed record for this account to show a real timestamp
      let lastIndexedAt = 0;
      if (window.getAllChatContentForAccount) {
        const records = await window.getAllChatContentForAccount(account.accountId);
        for (const rec of records) {
          if ((rec.indexedAt || 0) > lastIndexedAt) lastIndexedAt = rec.indexedAt;
        }
      }

      if (lastIndexedAt > 0) {
        statusLabel.textContent = `Scanned ${formatChatDate(lastIndexedAt)}`;
      } else {
        statusLabel.textContent = "Search inside messages: Ready";
      }

      const indexBtn = document.createElement("button");
      indexBtn.className = "index-btn has-tooltip";
      indexBtn.textContent = "Scan Chats";
      indexBtn.setAttribute("data-tooltip", "Download chat history locally so it can be searched");
      indexBtn.onclick = () => triggerIndexing(account);

      const actionsRow = document.createElement("div");
      actionsRow.style.display = "flex";
      actionsRow.style.gap = "6px";
      actionsRow.append(indexBtn, disableBtn);

      statusContainer.append(statusLabel, actionsRow);
    } else if (q.status === "running" || q.status === "paused-tab-hidden") {
      const total =
        q.doneChatIds.length + q.pendingChatIds.length + q.failedChatIds.length;
      statusLabel.textContent = `Scanning: ${q.doneChatIds.length} of ${total} chats`;

      statusContainer.append(statusLabel, disableBtn);

      if (!indexProgressPollTimer) {
        indexProgressPollTimer = setInterval(renderIndexStatus, 1500);
      }
    } else if (q.status === "paused-ratelimited") {
      statusLabel.textContent = "Paused (Claude rate limit)";
      statusContainer.append(statusLabel, disableBtn);
    } else if (q.status === "complete") {
      const d = new Date(q.startedAt || Date.now());
      statusLabel.textContent = `Scanned ${formatChatDate(d.getTime())}`;

      const reindexBtn = document.createElement("button");
      reindexBtn.className = "index-btn has-tooltip";
      reindexBtn.textContent = "Rescan";
      reindexBtn.setAttribute("data-tooltip", "Rescan chat history to update search database");
      reindexBtn.onclick = () => triggerIndexing(account);

      const actionsRow = document.createElement("div");
      actionsRow.style.display = "flex";
      actionsRow.style.gap = "6px";
      actionsRow.append(reindexBtn, disableBtn);

      statusContainer.append(statusLabel, actionsRow);
    }
  };

  await renderIndexStatus();

  // ── Embedding Actions Row ─────────────────────────────────────────
  const embeddingActionsRow = document.getElementById("embeddingActionsRow");
  const embeddingCountLabel = document.getElementById("embeddingCountLabel");
  const deleteEmbeddingsBtn = document.getElementById("deleteEmbeddingsBtn");

  if (embeddingActionsRow && account && window.getAllEmbeddings) {
    const allEmbeddings = await window.getAllEmbeddings();
    const prefix = account.accountId + ":";
    const count = Object.keys(allEmbeddings).filter((k) => k.startsWith(prefix)).length;

    if (count > 0) {
      embeddingActionsRow.style.display = "flex";
      if (embeddingCountLabel) {
        embeddingCountLabel.textContent = `${count} embedding${count === 1 ? "" : "s"} stored`;
      }
      if (deleteEmbeddingsBtn) {
        // Remove any previous listener by cloning the button
        const fresh = deleteEmbeddingsBtn.cloneNode(true);
        deleteEmbeddingsBtn.replaceWith(fresh);
        fresh.addEventListener("click", async () => {
          if (!confirm(`Delete all ${count} stored embeddings for ${shortAccountName(account)}? Semantic search will fall back to keyword-only until you rescan.`)) return;
          if (window.deleteEmbeddingsForAccount) {
            await window.deleteEmbeddingsForAccount(account.accountId);
          }
          embeddingActionsRow.style.display = "none";
          if (embeddingCountLabel) embeddingCountLabel.textContent = "";
        });
      }
    } else {
      embeddingActionsRow.style.display = "none";
    }
  }
}

async function triggerIndexing(account, isAuto = false) {
  let tabs = await chrome.tabs.query({
    url: "https://claude.ai/*",
    active: true,
    currentWindow: true,
  });
  if (tabs.length === 0) {
    tabs = await chrome.tabs.query({
      url: "https://claude.ai/*",
    });
  }
  if (tabs.length === 0) {
    if (!isAuto) {
      const statusContainer = document.getElementById("indexStatusContainer");
      if (statusContainer) {
        statusContainer.textContent = "Please open claude.ai first to start indexing.";
      }
    }
    return;
  }

  const statusContainer = document.getElementById("indexStatusContainer");
  if (statusContainer) statusContainer.textContent = "Starting...";

  // The content script will fetch the orgId if we don't have it.
  // Only pass the API key if the user has semantic or hybrid mode enabled.
  // In pure text mode, skip embedding entirely.
  const wantsEmbedding = state.searchMode !== "text";
  const embeddingApiKey = wantsEmbedding
    ? ((state.semanticSettings && state.semanticSettings.apiKey) || null)
    : null;

  chrome.tabs
    .sendMessage(tabs[0].id, {
      type: "CCT_INDEX_ACCOUNT",
      accountId: account.accountId,
      orgId: null,
      apiKey: embeddingApiKey,
    })
    .catch((err) => {
      if (!isAuto) {
        if (statusContainer) {
          statusContainer.textContent = "Could not reach Claude tab. Please refresh claude.ai and try again.";
        }
      } else {
        console.warn("[CCT] Auto-indexing call failed: could not reach Claude tab.", err);
      }
    });

  if (!indexProgressPollTimer) {
    indexProgressPollTimer = setInterval(
      () => updateIndexStatusUI(account),
      1500,
    );
  }
}

function renderFilters() {
  const menu = document.getElementById("acctFilterMenu");
  if (!menu) return;
  menu.replaceChildren();

  // Helper to add list item
  const addMenuItem = (label, accountId, color) => {
    const li = document.createElement("li");
    li.role = "option";
    li.dataset.value = accountId;
    if (state.activeAccountId === accountId) {
      li.className = "active";
    }

    const dot = document.createElement("span");
    dot.className = "acct-dot";
    dot.style.backgroundColor = color || "#a0a0a5";

    const text = document.createElement("span");
    text.textContent = label;
    text.className = "acct-item-text";

    li.append(dot, text);

    if (accountId !== "all") {
      const isCur = accountId === state.currentAccountId;
      const vMeta = state.vaultMeta && state.vaultMeta[accountId];
      const hasVault = vMeta && !vMeta.expired;

      if (isCur) {
        const badge = document.createElement("span");
        badge.className = "acct-item-badge active";
        badge.textContent = "Active";
        badge.title = "Currently active session in browser";
        li.appendChild(badge);
      } else if (hasVault) {
        const badge = document.createElement("span");
        badge.className = "acct-item-badge vault";
        badge.textContent = "⚡";
        badge.title = "Session saved in vault: switch & sync ready";
        li.appendChild(badge);
      } else if (vMeta && vMeta.expired) {
        const badge = document.createElement("span");
        badge.className = "acct-item-badge expired";
        badge.textContent = "Expired";
        badge.title = "Session expired; re-authenticate to restore vault";
        li.appendChild(badge);
      }

      // Actions container for hover icon buttons (Option 1)
      const actions = document.createElement("div");
      actions.className = "acct-item-actions";

      // 1-Click Session Switch icon button (for vaulted non-active accounts)
      if (!isCur && hasVault) {
        const switchBtn = document.createElement("button");
        switchBtn.className = "acct-action-btn switch";
        switchBtn.type = "button";
        switchBtn.title = `Switch active session to ${label}`;
        switchBtn.setAttribute("aria-label", `Switch active session to ${label}`);
        switchBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4m10 4v12m0 0l4-4m-4 4l-4-4"/></svg>`;
        switchBtn.onclick = async (e) => {
          e.stopPropagation();
          switchBtn.disabled = true;
          try {
            if (window.CctVault && window.CctVault.restoreSession) {
              const res = await window.CctVault.restoreSession(accountId);
              if (res && res.ok) {
                state.currentAccountId = accountId;
                await storageSet({ currentAccountId: accountId, pendingOpen: null });
                const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
                for (const tab of tabs) {
                  chrome.tabs.reload(tab.id);
                }
                await reloadData();
                render();
              } else {
                alert("Could not switch session: " + (res?.error || "Unknown error"));
              }
            }
          } catch (switchErr) {
            alert("Switch error: " + (switchErr && switchErr.message ? switchErr.message : String(switchErr)));
          } finally {
            switchBtn.disabled = false;
          }
        };
        actions.appendChild(switchBtn);
      }

      // Background sync icon button (for active or vaulted accounts)
      if (hasVault || isCur) {
        const syncBtn = document.createElement("button");
        syncBtn.className = "acct-action-btn sync";
        syncBtn.type = "button";
        syncBtn.title = `Sync chats from ${label} in background`;
        syncBtn.setAttribute("aria-label", `Sync chats from ${label} in background`);
        syncBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-4.6a6 6 0 0 0-10 2M4 17h4.6a6 6 0 0 0 10-2M20 7l-3-3M20 7l-3 3M4 17l3 3M4 17l3-3"/></svg>`;
        syncBtn.onclick = async (e) => {
          e.stopPropagation();
          syncBtn.disabled = true;
          try {
            const res = await chrome.runtime.sendMessage({
              type: "VAULT_SYNC_ACCOUNT",
              targetAccountId: accountId,
            });
            if (res && res.ok) {
              await reloadData();
            } else if (res && res.expired) {
              alert("Session expired for this account. Please re-authenticate.");
            } else {
              alert("Sync failed: " + (res?.error || "Unknown error"));
            }
          } catch (syncErr) {
            alert("Sync error: " + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
          } finally {
            syncBtn.disabled = false;
          }
        };
        actions.appendChild(syncBtn);
      }

      if (actions.hasChildNodes()) {
        li.appendChild(actions);
      }
    }

    li.addEventListener("click", (e) => {
      e.stopPropagation();
      state.activeAccountId = accountId;
      menu.style.display = "none";
      const container = document.getElementById("acctFilterContainer");
      if (container) container.classList.remove("open");
      render();
    });

    menu.appendChild(li);
  };

  // Add "All accounts" option
  addMenuItem("All accounts", "all", "#a0a0a5");

  // Add individual accounts
  Object.values(state.accounts || {})
    .sort((a, b) => shortAccountName(a).localeCompare(shortAccountName(b)))
    .forEach((account) => {
      addMenuItem(
        shortAccountName(account),
        account.accountId,
        account.color,
      );
    });

  // Check if activeAccountId is still valid, fallback to "all"
  if (state.activeAccountId !== "all" && !state.accounts[state.activeAccountId]) {
    state.activeAccountId = "all";
  }

  // Update Trigger Button UI
  const triggerLabel = document.getElementById("acctTriggerLabel");
  const triggerDot = document.getElementById("acctTriggerDot");

  if (state.activeAccountId === "all") {
    if (triggerLabel) triggerLabel.textContent = "All Accounts";
    if (triggerDot) triggerDot.style.backgroundColor = "#a0a0a5";
  } else {
    const activeAcct = state.accounts[state.activeAccountId];
    if (activeAcct) {
      if (triggerLabel) triggerLabel.textContent = shortAccountName(activeAcct);
      if (triggerDot) triggerDot.style.backgroundColor = activeAcct.color;
    }
  }
}

function renderCurrentAccount() {
  const currentAccount = state.accounts[state.currentAccountId];
  document.getElementById("currentAccountName").textContent =
    currentAccountDisplay(currentAccount);
}

function canOpenWithoutMismatchWarning(chat) {
  return !state.currentAccountId || chat.accountId === state.currentAccountId;
}

function selectedAccountForActions() {
  const selectedId =
    state.activeAccountId !== "all"
      ? state.activeAccountId
      : state.currentAccountId;
  return selectedId ? state.accounts[selectedId] : null;
}

// BUG-02 fix: made async and await storageSet before opening tab.
// Previously .then() was non-blocking so the tab could open before storage finished writing,
// causing the content script to read null pendingOpen and miss the navigation entirely.
async function openChat(chat) {
  const chatAccount = state.accounts[chat.accountId] || {};
  const currentAccount = state.accounts[state.currentAccountId] || {};

  if (!canOpenWithoutMismatchWarning(chat)) {
    // 1. Instant Account Switch via Session Vault (no confirm dialog, no Google redirect)
    if (window.CctVault && (await window.CctVault.hasSavedSession(chat.accountId))) {
      // Snapshot current session before swapping so we never lose it
      if (state.currentAccountId) {
        const curAcct = state.accounts[state.currentAccountId] || {};
        await window.CctVault.captureSession(state.currentAccountId, curAcct.email);
      }
      // Restore target account's session
      const restoreRes = await window.CctVault.restoreSession(chat.accountId);
      if (restoreRes && restoreRes.ok) {
        state.currentAccountId = chat.accountId;
        await storageSet({
          currentAccountId: chat.accountId,
          pendingOpen: null,
        });
        chrome.runtime.sendMessage({ type: "CLEAR_LOGIN_HINT" }).catch(() => {});
        chrome.tabs.create({ url: chat.url });
        return;
      }
    }

    const accountName = shortAccountName(chatAccount);
    const currentName = shortAccountName(currentAccount);
    const message =
      `Switching from "${currentName}" to "${accountName}".\n\n` +
      `Warning: This will clear your Claude and Anthropic session cookies, which may log out other active Claude tabs.\n\n` +
      `Do you want to continue?`;
    if (!confirm(message)) {
      return;
    }
    state.currentAccountId = chat.accountId;
    // MUST await — content script reads pendingOpen as soon as the new tab fires
    await storageSet({
      currentAccountId: chat.accountId,
      pendingOpen: {
        accountId: chat.accountId,
        accountEmail: chatAccount.email || null,
        accountName,
        previousAccountName: currentName,
        chatTitle: chat.title || "Untitled Chat",
        chatUrl: chat.url,
        createdAt: Date.now(),
        googleStarted: false,
        loginStartedAt: null,
      },
    });
    // Delete ALL session cookies for Claude/Anthropic before opening the tab.
    // This is the only reliable logout — URL parameters like ?from=logout are
    // ignored by Claude's server; it just redirects the still-logged-in user back.
    await clearClaudeSession();
    // Layer 2: install the login_hint DNR rule so Google pre-selects the target
    // account when the OAuth redirect fires. Rule is removed after login completes.
    if (chatAccount.email) {
      chrome.runtime
        .sendMessage({ type: "SET_LOGIN_HINT", email: chatAccount.email })
        .catch(() => {}); // background SW may be waking up; non-critical
    }
    // Clean login page: no active session → shows "Continue with Google" immediately.
    // The content script on that page auto-clicks the Google button and shows the toast.
    chrome.tabs.create({ url: "https://claude.ai/login" });
    return;
  }

  // No account switch needed. Clear any stale login_hint rule from a cancelled flow.
  chrome.runtime.sendMessage({ type: "CLEAR_LOGIN_HINT" }).catch(() => {});
  await storageSet({ pendingOpen: null });
  chrome.tabs.create({ url: chat.url });
}

// Deletes every cookie set by Claude.ai and Anthropic's auth service so the
// browser has no active session.  Requires "cookies" permission in manifest.json.
//
// Phase 4 fix: construct multiple URL variants per cookie to handle strict subdomain
// bindings (e.g. session.claude.ai vs claude.ai vs www.claude.ai).
// Chrome's cookies.remove() silently ignores a URL that doesn't match the cookie's
// origin — so we try all plausible origins and swallow individual failures.
async function clearClaudeSession() {
  if (!chrome.cookies) return;
  const domains = ["claude.ai", "anthropic.com", "auth.anthropic.com"];
  try {
    for (const domain of domains) {
      const cookies = await chrome.cookies.getAll({ domain });
      await Promise.all(
        cookies.map((cookie) => {
          // Strip leading dot that Chrome prepends for domain cookies.
          const host = cookie.domain.startsWith(".")
            ? cookie.domain.slice(1)
            : cookie.domain;
          // Derive root domain (last two labels: e.g. "session.claude.ai" → "claude.ai")
          const parts = host.split(".");
          const rootDomain =
            parts.length >= 2 ? parts.slice(-2).join(".") : host;
          const path = cookie.path || "/";

          // Build an exhaustive set of URL variants:
          // • exact host with both protocols
          // • www. prefix of root domain with both protocols
          // This covers strict-subdomain bindings that a single URL would miss.
          const urlVariants = [
            `https://${host}${path}`,
            `http://${host}${path}`,
            `https://www.${rootDomain}${path}`,
            `http://www.${rootDomain}${path}`,
          ];

          return Promise.all(
            urlVariants.map((url) =>
              chrome.cookies.remove({ url, name: cookie.name }).catch(() => {}),
            ),
          );
        }),
      );
    }
  } catch (err) {
    console.warn("[Claude Chat Tracker] Could not clear session cookies:", err);
  }
}

function createOpenIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M7 17 17 7M9 7h8v8");
  svg.appendChild(path);
  return svg;
}

function createStarIcon(isStarred) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("aria-hidden", "true");
  if (isStarred) {
    svg.setAttribute("fill", "#E5A93C");
    svg.setAttribute("stroke", "#E5A93C");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
  }
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  poly.setAttribute("points", "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2");
  svg.appendChild(poly);
  return svg;
}

function makeChatItem(chat) {
  const account = state.accounts[chat.accountId] || {};
  const isStarred = state.starredChatIds.has(chat.storageId);

  const item = document.createElement("div");
  item.className = "chat-item";
  item.setAttribute("role", "button");
  item.setAttribute("tabindex", "0");
  item.classList.toggle(
    "account-mismatch",
    !canOpenWithoutMismatchWarning(chat),
  );
  item.classList.toggle("is-starred", isStarred);

  const dot = document.createElement("span");
  dot.className = "account-dot";
  dot.style.background = account.color || "#888";
  dot.title = account.email || shortAccountName(account) || "Unknown account";

  const info = document.createElement("span");
  info.className = "chat-info";

  const title = document.createElement("span");
  title.className = "chat-title";
  title.textContent = chat.title || "Untitled Chat";

  const meta = document.createElement("span");
  meta.className = "chat-meta";

  const dateSpan = document.createElement("span");
  dateSpan.className = "chat-date";
  const displayTs =
    chat.serverUpdatedAt || chat.sectionTimestamp || chat.lastSeen;
  dateSpan.textContent = formatChatDate(displayTs);

  const acctName = shortAccountName(account);
  const isMatch = canOpenWithoutMismatchWarning(chat);
  const badge = document.createElement("span");
  badge.className = "chat-account-tag";
  badge.textContent = acctName;
  if (isMatch) {
    badge.classList.add("current-account");
    badge.title = `Account: ${acctName} (Active session)`;
  } else {
    badge.classList.add("other-account");
    badge.title = `Switch to ${acctName} to open`;
  }

  meta.append(dateSpan, badge);

  const mark = document.createElement("span");
  mark.className = "open-mark";
  mark.appendChild(createOpenIcon());
  mark.setAttribute("aria-hidden", "true");

  if (chat._snippet) {
    const snippetEl = document.createElement("div");
    snippetEl.className = "chat-snippet";
    const escapedSnippet = chat._snippet
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const qTokens = state.query.trim().split(/\s+/).filter((t) => t.length >= 2);
    if (qTokens.length > 0) {
      const pattern = qTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const regex = new RegExp(`(${pattern})`, "gi");
      snippetEl.innerHTML = escapedSnippet.replace(regex, "<mark>$1</mark>");
    } else {
      snippetEl.textContent = chat._snippet;
    }
    info.append(title, meta, snippetEl);
  } else {
    info.append(title, meta);
  }

  // Star button — sits between info and open-mark
  const starBtn = document.createElement("button");
  starBtn.type = "button";
  starBtn.className = "star-btn";
  starBtn.setAttribute("aria-label", isStarred ? "Unstar chat" : "Star chat");
  starBtn.appendChild(createStarIcon(isStarred));
  starBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't open the chat when clicking the star
    toggleStar(chat.storageId);
  });

  item.append(dot, info, starBtn, mark);
  item.title = !canOpenWithoutMismatchWarning(chat)
    ? `${chat.title || "Untitled Chat"} - requires ${acctName}`
    : chat.title || "";

  item.addEventListener("click", () => {
    openChat(chat);
  });

  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openChat(chat);
    }
  });

  return item;
}

// Toggles the star on a chat and re-renders only the chat list (not the whole popup).
// Stored as a plain array in chrome.storage.local (per-profile — stars are intentionally
// not synced so each Chrome profile can have independent pins).
async function toggleStar(storageId) {
  const starred = new Set(state.starredChatIds);
  if (starred.has(storageId)) {
    starred.delete(storageId);
  } else {
    starred.add(storageId);
  }
  state.starredChatIds = starred;
  await storageSet({ starredChatIds: [...starred] });
  renderChats(); // only re-render the list, not the full popup
}

function getDayGroup(timestamp) {
  if (!timestamp) return "Earlier";
  const now = new Date();
  const todayMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const yesterdayMidnight = todayMidnight - 24 * 60 * 60 * 1000;

  if (timestamp >= todayMidnight) {
    return "Today";
  } else if (timestamp >= yesterdayMidnight) {
    return "Yesterday";
  } else {
    return "Earlier";
  }
}

function renderChats() {
  const list = document.getElementById("chatList");
  let allChats = visibleChats(); // already sorted by compareChats (starred first)
  const summary = document.getElementById("searchSummary");

  const queryRaw = state.query.trim();
  let isSemanticPossible = false;
  if (queryRaw && searchIndexHandle && window.searchContent) {
    const apiKey = state.semanticSettings && state.semanticSettings.apiKey;
    isSemanticPossible = !!(
      state.semanticSettings &&
      state.semanticSettings.enabled &&
      apiKey &&
      window.searchContentHybrid &&
      window.generateEmbedding
    );

    if (state.searchMode !== "text" && isSemanticPossible) {
      const activeAccountAtTrigger = state.activeAccountId;
      const searchModeAtTrigger = state.searchMode;
      // Snapshot the pure title-only matches NOW (before keyword baseline mutates allChats).
      // The async callback must not rely on the allChats reference because the
      // keyword baseline path below pushes content results into it, which would
      // cause the hybrid callback to include those content hits in titleMatchIds
      // and skip adding proper snippets/scores to them from the semantic results.
      const titleOnlyChats = [...allChats];

      const findChat = (sid) => {
        if (state.chats[sid]) return state.chats[sid];
        const chatId = sid.includes(':') ? sid.split(':')[1] : sid;
        return Object.values(state.chats || {}).find((c) => c.chatId === chatId);
      };

      // Run semantic or hybrid search asynchronously
      window
        .generateEmbedding(queryRaw, apiKey)
        .then((queryEmbedding) => {
          return window.searchContentHybrid(
            searchIndexHandle,
            queryRaw,
            queryEmbedding,
            state.searchMode,
            state.activeAccountId,
          );
        })
        .then((results) => {
          if (state.query.trim() !== queryRaw || state.activeAccountId !== activeAccountAtTrigger || state.searchMode !== searchModeAtTrigger) return;
          const finalChats = [];
          if (state.searchMode === "semantic") {
            // Pure semantic: only show semantic matches, sorted by score
            for (const res of results) {
              const chatObj = findChat(res.storageId);
              if (chatObj) {
                if (state.activeAccountId !== "all" && chatObj.accountId !== state.activeAccountId) continue;
                finalChats.push({ ...chatObj, _snippet: res.snippet, _score: res.score });
              }
            }
            // Sort by semantic relevance score descending
            finalChats.sort((a, b) => (b._score || 0) - (a._score || 0));
          } else {
            // Hybrid: merge title matches with scored semantic+keyword results.
            // Use the frozen titleOnlyChats snapshot (NOT the mutated allChats) so
            // that content keyword hits from the baseline render don't bleed into
            // the titleMatchIds set and suppress proper hybrid scoring.
            const titleMatchIds = new Set(titleOnlyChats.map((c) => c.storageId));
            // Build a score-lookup for hybrid results so we can sort by relevance
            const scoreMap = new Map();
            for (const r of results) {
              const chatObj = findChat(r.storageId);
              const sid = chatObj ? chatObj.storageId : r.storageId;
              scoreMap.set(sid, { score: r.score, snippet: r.snippet });
            }

            // Start from title matches, inject hybrid snippet+score where available
            for (const chat of titleOnlyChats) {
              const hybridData = scoreMap.get(chat.storageId);
              finalChats.push(hybridData
                ? { ...chat, _snippet: hybridData.snippet, _score: hybridData.score }
                : { ...chat, _score: 0 }
              );
            }
            // Add content-only matches (not in title list) from hybrid results
            for (const res of results) {
              const chatObj = findChat(res.storageId);
              if (chatObj) {
                if (state.activeAccountId !== "all" && chatObj.accountId !== state.activeAccountId) continue;
                if (!titleMatchIds.has(chatObj.storageId)) {
                  titleMatchIds.add(chatObj.storageId);
                  finalChats.push({ ...chatObj, _snippet: res.snippet, _score: res.score });
                }
              }
            }
            // Sort by hybrid relevance score descending (most relevant first)
            finalChats.sort((a, b) => (b._score || 0) - (a._score || 0));
          }
          _renderChatListItems(list, summary, finalChats);
        })
        .catch((err) => {
          console.warn("Semantic search failed:", err);
          const isRateLimit = String(err).includes('RATE_LIMITED') || String(err).includes('429');
          summary.textContent = isRateLimit
            ? "Semantic search paused (Rate Limited). Showing keyword results."
            : "Semantic search failed. Showing keyword results.";
          summary.classList.add("rate-limit-warning");
          if (state.searchMode === "semantic") {
            const contentResults = (window.searchContent && searchIndexHandle)
              ? window.searchContent(searchIndexHandle, queryRaw, state.activeAccountId)
              : [];
            const fallbackChats = [...allChats];
            const titleMatchIds = new Set(fallbackChats.map((c) => c.storageId));
            for (const res of contentResults) {
              const chatObj = findChat(res.storageId);
              if (!chatObj) continue;
              if (state.activeAccountId !== "all" && chatObj.accountId !== state.activeAccountId) continue;
              if (!titleMatchIds.has(chatObj.storageId)) {
                titleMatchIds.add(chatObj.storageId);
                fallbackChats.push({ ...chatObj, _snippet: res.snippet, _score: res.score });
              }
            }
            fallbackChats.sort((a, b) => (b._score || 0) - (a._score || 0));
            _renderChatListItems(list, summary, fallbackChats);
          }
        });
    }

    if (state.searchMode !== "semantic") {
      const findChat = (sid) => {
        if (state.chats[sid]) return state.chats[sid];
        const chatId = sid.includes(':') ? sid.split(':')[1] : sid;
        return Object.values(state.chats || {}).find((c) => c.chatId === chatId);
      };

      // Keyword baseline (run synchronously, sorted by BM25 score)
      const contentResults = window.searchContent(searchIndexHandle, queryRaw, state.activeAccountId);
      const titleMatchIds = new Set(allChats.map((c) => c.storageId));

      for (const res of contentResults) {
        const chatObj = findChat(res.storageId);
        if (!chatObj) continue;
        if (state.activeAccountId !== "all" && chatObj.accountId !== state.activeAccountId) continue;

        if (!titleMatchIds.has(chatObj.storageId)) {
          titleMatchIds.add(chatObj.storageId);
          // _score is used for relevance sorting in the initial keyword render
          const cloned = { ...chatObj, _snippet: res.snippet, _score: res.score };
          allChats.push(cloned);
        } else {
          const idx = allChats.findIndex((c) => c.storageId === chatObj.storageId);
          if (idx !== -1) {
            allChats[idx] = { ...allChats[idx], _snippet: res.snippet, _score: res.score };
          }
        }
      }
      // Sort the merged list by relevance score so highest-scoring results appear first.
      // Title-matched entries that had no content score get _score=undefined, treated as 0.
      allChats.sort((a, b) => (b._score || 0) - (a._score || 0));
    } else {
       list.replaceChildren();
       const loading = document.createElement("div");
       loading.className = "empty-state";
       loading.textContent = "Searching semantically...";
       list.appendChild(loading);
       return;
    }
  }

  _renderChatListItems(list, summary, allChats);
  if (queryRaw && searchIndexHandle && window.searchContent && state.searchMode === "hybrid" && isSemanticPossible) {
    summary.textContent = summary.textContent.replace(" (Hybrid ⚡)", " (Searching semantically...)");
  }
}

// Extracted renderer so the hybrid-search async re-render path can reuse it.
function _renderChatListItems(list, summary, allChats) {
  list.replaceChildren();
  summary.classList.remove("rate-limit-warning");

  let modeSuffix = "";
  if (state.query.trim()) {
    if (state.searchMode === "text") {
      modeSuffix = " (Text)";
    } else if (state.searchMode === "semantic") {
      modeSuffix = " (Semantic \u26a1)";
    } else {
      modeSuffix = " (Hybrid \u26a1)";
    }
  }

  if (state.query.trim()) {
    summary.style.display = "block";
    summary.textContent = `${allChats.length} match${allChats.length === 1 ? "" : "es"}${modeSuffix}`;
  } else {
    summary.style.display = "none";
    summary.textContent = "";
  }

  if (allChats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent =
      Object.keys(state.chats || {}).length === 0
        ? "Open Claude.ai to start tracking visible chats."
        : "No chats match this view.";
    list.appendChild(empty);
    return;
  }

  function appendSectionHeader(label) {
    const header = document.createElement("div");
    header.className = "section-header";
    header.textContent = label;
    list.appendChild(header);
  }

  const starredChats = allChats.filter((c) => state.starredChatIds.has(c.storageId));
  const normalChats = allChats.filter((c) => !state.starredChatIds.has(c.storageId));

  if (starredChats.length > 0) {
    appendSectionHeader("Starred");
    starredChats.forEach((chat) => list.appendChild(makeChatItem(chat)));
  }

  let currentGroup = null;
  normalChats.forEach((chat) => {
    const displayTs =
      chat.serverUpdatedAt || chat.sectionTimestamp || chat.lastSeen;
    const groupLabel = getDayGroup(displayTs);
    if (groupLabel !== currentGroup) {
      currentGroup = groupLabel;
      appendSectionHeader(currentGroup);
    }
    list.appendChild(makeChatItem(chat));
  });
}

// IMP-05: update the quota bar in the header to show sync storage usage.
// Sets the syncQuotaWarning flag read by renderStatus() — does NOT mutate statusText directly.
async function updateQuotaDisplay() {
  if (!hasSyncApi() || !chrome.storage.sync.getBytesInUse) return;
  try {
    const used = await chrome.storage.sync.getBytesInUse(null);
    const total = chrome.storage.sync.QUOTA_BYTES || 102400;
    const pct = Math.min(100, Math.round((used / total) * 100));
    const bar = document.getElementById("quotaBar");
    const fill = document.getElementById("quotaFill");
    if (!bar || !fill) return;
    bar.style.display = "block";
    fill.style.width = `${pct}%`;
    fill.style.background =
      pct > 85 ? "#D9784A" : pct > 60 ? "#C9A227" : "#45A878";
    const pctText = document.getElementById("quotaPercentText");
    if (pctText) {
      pctText.textContent = `${pct}% (${Math.round(used / 1024)}KB / ${Math.round(total / 1024)}KB)`;
    }
    bar.title = `Sync storage: ${pct}% used (${Math.round(used / 1024)}KB / ${Math.round(total / 1024)}KB)`;

    // Set module-level flag; renderStatus() will include it on the NEXT render cycle
    const wasWarning = syncQuotaWarning;
    syncQuotaWarning = pct > 85;
    // If quota state changed, trigger a status re-render so the text updates immediately
    if (wasWarning !== syncQuotaWarning) renderStatus();
  } catch (_) {
    /* getBytesInUse may not be available in all environments */
  }
}

function render() {
  renderStatus();
  renderCurrentAccount();
  renderFilters();
  renderChats();
  updateQuotaDisplay(); // IMP-05: refresh quota bar on every render
}

async function reloadData() {
  const local = await storageGet([
    STORAGE_KEYS.accounts,
    STORAGE_KEYS.chats,
    STORAGE_KEYS.currentAccountId,
    STORAGE_KEYS.syncStatus,
    "deletedAccountIds", // BUG-03: load tombstones so mergeAccounts can filter them
    "starredChatIds", // restore per-profile starred chat pins
    "profileLocalId",
    "allowedIndexingAccounts",
    "allAccountsIndexingEnabled",
    "searchMode",
  ]);
  state.allowedIndexingAccounts = local.allowedIndexingAccounts || [];
  state.allAccountsIndexingEnabled = !!local.allAccountsIndexingEnabled;
  const synced = await readSyncedData();
  const deletedAccounts = synced.deletedAccounts || {};

  let profileLocalId = local.profileLocalId;
  if (!profileLocalId) {
    profileLocalId = `profile_${crypto.randomUUID()}`;
    await storageSet({ profileLocalId });
  }
  state.profileLocalId = profileLocalId;

  // Load tombstones and starred IDs before merging so they filter correctly
  state.deletedAccountIds = local.deletedAccountIds || [];
  state.starredChatIds = new Set(
    Array.isArray(local.starredChatIds) ? local.starredChatIds : [],
  );

  const accounts = mergeAccounts(
    synced.accounts,
    local.accounts || {},
    deletedAccounts,
    state.deletedAccountIds,
  );
  const chats = mergeChats(
    synced.chats,
    local.chats || {},
    deletedAccounts,
    state.deletedAccountIds,
  );

  state.accounts = accounts;
  state.chats = chats;
  const previousCurrentAccountId = state.currentAccountId;
  state.currentAccountId = local.currentAccountId || "";

  // Reconcile currentAccountId with actual active browser cookies
  if (chrome.cookies) {
    try {
      const orgCookie = await chrome.cookies.get({ url: "https://claude.ai", name: "lastActiveOrg" });
      if (orgCookie && orgCookie.value) {
        const canonicalActiveId = `acc_org_${orgCookie.value.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
        if (state.accounts[canonicalActiveId] && state.currentAccountId !== canonicalActiveId) {
          state.currentAccountId = canonicalActiveId;
          await storageSet({ currentAccountId: canonicalActiveId });
        }
      }
    } catch (_) {}
  }

  state.syncStatus = local.syncStatus || null;

  // Pivot active filter to the new current account if it was previously tracking the old current account
  if (
    state.activeAccountId === previousCurrentAccountId &&
    previousCurrentAccountId !== state.currentAccountId
  ) {
    state.activeAccountId = state.currentAccountId || "all";
  }

  if (
    state.activeAccountId !== "all" &&
    !state.accounts[state.activeAccountId]
  ) {
    state.activeAccountId = "all";
  }

  // FLAW-03 fix: use stableStringify so key order differences don't cause spurious writes
  const shouldUpdateLocal =
    stableStringify(local.accounts || {}) !== stableStringify(accounts) ||
    stableStringify(local.chats || {}) !== stableStringify(chats) ||
    (local.currentAccountId || "") !== state.currentAccountId ||
    stableStringify(local.allowedIndexingAccounts || []) !==
      stableStringify(state.allowedIndexingAccounts);

  if (shouldUpdateLocal) {
    // BUG-01 fix: guard the sync write so the onChanged listener (which also fires on sync area)
    // does not re-enter reloadData() while we are writing syncMeta.
    isSyncing = true;
    try {
      await storageSet({
        accounts,
        chats,
        currentAccountId: state.currentAccountId,
        allowedIndexingAccounts: state.allowedIndexingAccounts,
      });
    } finally {
      isSyncing = false;
    }
  }

  // Phase A Search Engine: build index
  if (window.buildSearchIndex) {
    searchIndexHandle = await window.buildSearchIndex();
  }

  // Garbage-collect stale searchIndex/embeddingIndex entries whose chatId no
  // longer exists in sync storage (deleted chats, removed accounts, etc.)
  if (window.pruneOrphanedIndexEntries && Object.keys(state.chats).length > 0) {
    const validIds = new Set(Object.keys(state.chats));
    const { prunedText, prunedEmbeddings } = await window.pruneOrphanedIndexEntries(validIds);
    if (prunedText > 0 || prunedEmbeddings > 0) {
      console.log(`[CCT] Pruned ${prunedText} stale text entries, ${prunedEmbeddings} stale embeddings`);
      // Rebuild the search index now that stale entries are gone
      if (window.buildSearchIndex) {
        searchIndexHandle = await window.buildSearchIndex();
      }
    }
  }

  state.searchMode = local.searchMode || "hybrid";

  // Phase B: load semantic settings so search and badge UI are current
  if (window.getSemanticSettings) {
    state.semanticSettings = await window.getSemanticSettings();
  }

  // Session Vault: load session metadata for all accounts
  if (window.CctVault && window.CctVault.getAllSessionMetadata) {
    state.vaultMeta = (await window.CctVault.getAllSessionMetadata()) || {};
  } else {
    state.vaultMeta = {};
  }

  maybeResumeQueue();

  render();
}

async function maybeResumeQueue() {
  const local = await storageGet(["indexingQueue"]);
  const q = local.indexingQueue;
  if (!q || (q.status !== "running" && q.status !== "paused-tab-hidden"))
    return;
  const tabs = await chrome.tabs.query({
    url: "https://claude.ai/*",
    active: true,
    currentWindow: true,
  });
  if (tabs.length > 0)
    chrome.tabs
      .sendMessage(tabs[0].id, { type: "CCT_RESUME_INDEXING" })
      .catch(() => {});
}

// IMP-01: send sync data to the background service worker rather than writing directly.
// Returns a promise that resolves when the service worker confirms the write.
function sendSyncToBackground(accounts, chats, deletedAccounts = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        { type: "SYNC_DATA", accounts, chats, deletedAccounts },
        (response) => {
          if (chrome.runtime.lastError) {
            // Service worker not available (e.g. extension just reloaded) — caller will fall back
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.ok) resolve(response);
          else
            reject(
              new Error(
                response && response.error
                  ? response.error
                  : "Sync write failed",
              ),
            );
        },
      );
    } catch (e) {
      reject(e);
    }
  });
}

// createAccount: uses showInlineEdit instead of prompt() for consistency with rename.
// showInlineEdit is defined inside bindEvents, so we store a reference here.
let _showInlineEdit = null;

async function createAccount() {
  if (!_showInlineEdit) {
    console.warn("Account editor is unavailable");
    state.syncStatus = {
      ok: false,
      updatedAt: Date.now(),
      message: "Account editor is unavailable",
    };
    render();
    return;
  }

  // Route through the inline edit UI (IMP-02)
  _showInlineEdit("", async (name) => {
    const now = Date.now();
    const accountId = `manual_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const account = {
      accountId,
      email: null,
      displayName: name,
      color: colorForAccount(state.accounts),
      firstSeen: now,
      lastSeen: now,
      isManual: true,
      isFallback: false,
    };
    state.accounts[accountId] = account;
    state.currentAccountId = accountId;
    await persistData();
    render();
  });
}

// ─── Developer Mode ──────────────────────────────────────────────────────────
// Applies all dev-mode UI effects after cctDevModeReady has resolved.
// Safe to call multiple times; each call re-reads window.CCT_DEV_MODE.
function applyDevMode() {
  const isDev = !!window.CCT_DEV_MODE;

  // ── [DEV] badge in header ──
  const badge = document.getElementById("devModeBadge");
  if (badge) badge.style.display = isDev ? "" : "none";

  // ── Popup width: 20% wider in dev mode (416 → ~499px) ──
  document.body.style.width = isDev ? "499px" : "";

  // ── Export diagnostic log button ──
  const exportDiagBtn = document.getElementById("exportDiagBtn");
  if (exportDiagBtn) {
    if (isDev && window.cctDiag) {
      // Reveal the button if the diag buffer has any entries.
      window.cctDiag.export().then((log) => {
        if (log && log.length > 0) exportDiagBtn.style.display = "";
      }).catch(() => {});

      // Bind the download handler (clone node first to remove any previous listener).
      const fresh = exportDiagBtn.cloneNode(true);
      exportDiagBtn.replaceWith(fresh);
      fresh.addEventListener("click", async () => {
        try {
          const log = await window.cctDiag.export();
          let logString = JSON.stringify(log, null, 2);
          logString = logString.replace(/AIza[a-zA-Z0-9_-]{35}/g, "[REDACTED_API_KEY]");
          const blob = new Blob([logString], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `cct-diag-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          alert("Failed to export diagnostic log: " + (err && err.message ? err.message : String(err)));
        }
      });
    } else {
      exportDiagBtn.style.display = "none";
    }
  }
}

function bindEvents() {
  // ── Dev Mode: secret 5-tap gesture on the title ─────────────────────────
  // Click the "Claude Chats" h1 five times to toggle developer mode.
  // Invisible and meaningless to regular users.
  let _devTapCount = 0;
  let _devTapTimer = null;
  const titleEl = document.querySelector(".brand h1");
  if (titleEl) {
    titleEl.addEventListener("click", () => {
      _devTapCount++;
      clearTimeout(_devTapTimer);
      _devTapTimer = setTimeout(() => { _devTapCount = 0; }, 1500);
      if (_devTapCount >= 5) {
        _devTapCount = 0;
        clearTimeout(_devTapTimer);
        if (window.cctDevToggle) {
          window.cctDevToggle().then((next) => {
            window.CCT_DEV_MODE = next;
            applyDevMode();
            const msg = next ? "🛠 Developer Mode ENABLED" : "✅ Developer Mode DISABLED";
            // Use a brief visual toast rather than alert() to avoid blocking.
            const toast = document.createElement("div");
            toast.textContent = msg;
            toast.style.cssText = [
              "position:fixed", "bottom:12px", "left:50%", "transform:translateX(-50%)",
              "background:rgba(30,31,33,0.95)", "color:#f6f2ea", "padding:8px 16px",
              "border-radius:8px", "font-size:12px", "font-weight:600",
              "border:1px solid rgba(255,255,255,0.15)", "z-index:9999",
              "pointer-events:none", "box-shadow:0 4px 20px rgba(0,0,0,0.5)"
            ].join(";");
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2000);
          });
        }
      }
    });
  }

  let searchDebounceTimeout = null;
  document.getElementById("searchInput").addEventListener("input", (event) => {
    state.query = event.target.value;
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => {
      renderChats();
    }, 300);
  });

  // Custom account selector trigger dropdown toggle
  const triggerBtn = document.getElementById("acctFilterTrigger");
  const acctContainer = document.getElementById("acctFilterContainer");
  const filterMenu = document.getElementById("acctFilterMenu");

  if (triggerBtn && filterMenu) {
    triggerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = acctContainer.classList.contains("open");
      if (isOpen) {
        acctContainer.classList.remove("open");
        filterMenu.style.display = "none";
      } else {
        acctContainer.classList.add("open");
        filterMenu.style.display = "";
      }
    });

    // Close menu when clicking outside
    document.addEventListener("click", () => {
      if (acctContainer) acctContainer.classList.remove("open");
      if (filterMenu) filterMenu.style.display = "none";
    });
  }

  const globalIndexToggleBtn = document.getElementById("globalIndexToggleBtn");
  if (globalIndexToggleBtn) {
    globalIndexToggleBtn.addEventListener("click", async () => {
      state.allAccountsIndexingEnabled = !state.allAccountsIndexingEnabled;
      await persistData();

      // If enabled globally, auto-trigger for the currently active tab account (if matches)
      if (state.allAccountsIndexingEnabled) {
        const activeAcct = state.accounts[state.currentAccountId];
        if (activeAcct) {
          triggerIndexing(activeAcct, true);
        }
      }
      render();
    });
  }

  const startDeleteBtn = document.getElementById("startDeleteBtn");
  const deleteConfirmActions = document.getElementById("deleteConfirmActions");
  const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
  const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
  let deleteTimeout = null;

  function resetDeleteState() {
    const renameBtn = document.getElementById("renameAccountBtn");
    const quickSyncBtn = document.getElementById("quickSyncAccountBtn");
    if (renameBtn) renameBtn.style.display = "";
    if (quickSyncBtn) quickSyncBtn.style.display = "";
    if (startDeleteBtn) startDeleteBtn.style.display = "";
    if (deleteConfirmActions) deleteConfirmActions.style.display = "none";
    if (deleteTimeout) {
      clearTimeout(deleteTimeout);
      deleteTimeout = null;
    }
  }

  if (startDeleteBtn) {
    startDeleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const renameBtn = document.getElementById("renameAccountBtn");
      const quickSyncBtn = document.getElementById("quickSyncAccountBtn");
      if (renameBtn) renameBtn.style.display = "none";
      if (quickSyncBtn) quickSyncBtn.style.display = "none";
      startDeleteBtn.style.display = "none";
      deleteConfirmActions.style.display = "flex";
      deleteTimeout = setTimeout(() => {
        resetDeleteState();
      }, 3000);
    });
  }

  if (cancelDeleteBtn) {
    cancelDeleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      resetDeleteState();
    });
  }

  if (confirmDeleteBtn) {
    confirmDeleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      resetDeleteState();

      const account = selectedAccountForActions();
      if (!account) return;

      const accountChats = Object.values(state.chats || {}).filter(
        (chat) => chat.accountId === account.accountId,
      );

      // Fix 3.3: create tombstone for deleted account
      const tombstone = {
        accountId: account.accountId,
        deletedAt: Date.now(),
        deletedByProfileId: state.profileLocalId || "unknown",
      };

      let syncSuccess = false;
      let syncError = null;
      let updatedDeletedAccounts = {};

      try {
        const synced = await readSyncedData();
        const syncedAccounts = { ...synced.accounts };
        const syncedChats = { ...synced.chats };

        updatedDeletedAccounts = {
          ...(synced.deletedAccounts || {}),
          [account.accountId]: tombstone,
        };

        delete syncedAccounts[account.accountId];
        for (const chat of Object.values(syncedChats)) {
          if (chat.accountId === account.accountId)
            delete syncedChats[chat.storageId];
        }

        await writeSyncedData(
          syncedAccounts,
          syncedChats,
          updatedDeletedAccounts,
          Number(synced.meta.chatChunkCount || 0),
        );
        syncSuccess = true;
      } catch (error) {
        syncError = error;
      }

      // Store local compatibility cache for deletedAccountIds
      state.deletedAccountIds = [
        ...(state.deletedAccountIds || []),
        account.accountId,
      ];
      await storageSet({ deletedAccountIds: state.deletedAccountIds });

      if (!syncSuccess) {
        state.syncStatus = {
          ok: false,
          updatedAt: Date.now(),
          message:
            syncError && syncError.message
              ? syncError.message
              : String(syncError),
        };
        await storageSet({ syncStatus: state.syncStatus });
        alert(
          "Delete completed locally. Cross-profile deletion will not be guaranteed until sync succeeds.",
        );
      }

      // Step 2: delete from local after sync attempt
      const accounts = { ...state.accounts };
      const chats = { ...state.chats };
      delete accounts[account.accountId];

      for (const chat of accountChats) {
        delete chats[chat.storageId];
      }

      const nextAccountId = Object.keys(accounts)[0] || "";
      if (state.currentAccountId === account.accountId) {
        state.currentAccountId = nextAccountId;
      }
      if (state.activeAccountId === account.accountId) {
        state.activeAccountId = "all";
      }

      state.accounts = accounts;
      state.chats = chats;
      await storageSet({
        accounts,
        chats,
        currentAccountId: state.currentAccountId,
      });

      if (window.deleteChatContentForAccount) {
        await window.deleteChatContentForAccount(account.accountId);
      }
      if (window.CctVault && window.CctVault.removeSavedSession) {
        await window.CctVault.removeSavedSession(account.accountId);
      }

      // Rebuild search index after deletion
      if (window.buildSearchIndex) {
        searchIndexHandle = await window.buildSearchIndex();
      }

      render();
    });
  }

  // IMP-02: show an inline edit panel instead of window.prompt()
  // This avoids browser prompt() which can be blocked in extension contexts.
  function showInlineEdit(currentValue, onConfirm) {
    const panel = document.getElementById("inlineEditPanel");
    const input = document.getElementById("inlineEditInput");
    const icons = document.getElementById("accountIcons");
    const metaInfo = document.querySelector(".account-meta-info");

    if (!panel || !input) {
      // safety fallback to prompt() if DOM not ready
      const val = prompt("Account name", currentValue || "");
      if (val && val.trim()) onConfirm(val.trim());
      return;
    }
    input.value = currentValue || "";
    if (icons) icons.style.display = "none";
    if (metaInfo) metaInfo.style.display = "none";
    panel.style.display = "flex";
    input.focus();
    input.select();

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      panel.style.display = "none";
      if (icons) icons.style.display = "";
      if (metaInfo) metaInfo.style.display = "";
    };

    input.onblur = () => {
      setTimeout(() => {
        cleanup();
      }, 100);
    };

    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        const val = input.value.trim();
        cleanup();
        if (val && val !== currentValue) onConfirm(val);
      } else if (e.key === "Escape") {
        cleanup();
      }
    };
  }

  // Expose showInlineEdit so createAccount() can route through the inline panel (IMP-02)
  _showInlineEdit = showInlineEdit;

  const renameAccountBtn = document.getElementById("renameAccountBtn");
  if (renameAccountBtn) {
    renameAccountBtn.addEventListener("click", () => {
      const account = selectedAccountForActions();
      if (!account) return;
      showInlineEdit(shortAccountName(account), async (nextName) => {
        state.accounts[account.accountId] = {
          ...account,
          displayName: nextName,
          autoDetectedName: false,
        };
        await persistData();
        render();
      });
    });
  }

  const quickSyncAccountBtn = document.getElementById("quickSyncAccountBtn");
  if (quickSyncAccountBtn) {
    quickSyncAccountBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const account = selectedAccountForActions();
      if (!account) return;

      const span = quickSyncAccountBtn.querySelector("span");
      const origText = span ? span.textContent : "Sync";
      if (span) span.textContent = "...";
      quickSyncAccountBtn.disabled = true;

      try {
        const res = await chrome.runtime.sendMessage({
          type: "VAULT_SYNC_ACCOUNT",
          targetAccountId: account.accountId,
        });
        if (res && res.ok) {
          if (span) span.textContent = `✓ ${res.syncedCount || 0}`;
          await reloadData();
          setTimeout(() => {
            if (span) span.textContent = origText;
            quickSyncAccountBtn.disabled = false;
          }, 2000);
        } else if (res && res.expired) {
          if (span) span.textContent = "Expired";
          alert("Session expired for this account. Please switch to this account to log in again.");
          await reloadData();
          render();
          quickSyncAccountBtn.disabled = false;
        } else if (res && res.needsLogin) {
          if (span) span.textContent = "Login";
          alert("This account has not been opened in this browser yet. Switch to it once to enable background sync.");
          quickSyncAccountBtn.disabled = false;
        } else {
          if (span) span.textContent = "Err";
          alert(res?.error || "Sync failed.");
          quickSyncAccountBtn.disabled = false;
        }
      } catch (err) {
        if (span) span.textContent = "Err";
        quickSyncAccountBtn.disabled = false;
      }
    });
  }

  const closePopupBtn = document.getElementById("closePopupBtn");
  if (closePopupBtn) {
    closePopupBtn.addEventListener("click", () => {
      window.close();
    });
  }

  const startClearBtn = document.getElementById("startClearBtn");
  const clearConfirmModal = document.getElementById("clearConfirmModal");
  const cancelClearBtn = document.getElementById("cancelClearBtn");
  const confirmClearBtn = document.getElementById("confirmClearBtn");

  if (startClearBtn && clearConfirmModal && cancelClearBtn) {
    startClearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearConfirmModal.style.display = "grid";
    });
    cancelClearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearConfirmModal.style.display = "none";
    });
  }


  if (confirmClearBtn && clearConfirmModal) {
    confirmClearBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      clearConfirmModal.style.display = "none";

      const synced = await readSyncedData();
      const staleKeys = Array.from(
        { length: Number(synced.meta.chatChunkCount || 0) },
        (_value, index) => `${SYNC_KEYS.chatPrefix}${index}`,
      );
      await chrome.storage.local.remove([
        STORAGE_KEYS.accounts,
        STORAGE_KEYS.chats,
        STORAGE_KEYS.currentAccountId,
        STORAGE_KEYS.syncStatus,
        "lastKnownEmail",
        "lastKnownOrgId",
        "deletedAccountIds",
        "deletedChatIds",
        "starredChatIds",
      ]);
      await syncRemove([SYNC_KEYS.accounts, SYNC_KEYS.meta, ...staleKeys]);

      await storageSet({ rescrapeRequested: Date.now() });

      state.accounts = {};
      state.chats = {};
      state.currentAccountId = "";
      state.activeAccountId = "all";
      state.syncStatus = null;
      state.deletedAccountIds = [];
      state.starredChatIds = new Set();
      render();
    });
  }

  // BUG-01 fix: only react to 'local' storage changes (from the content script).
  // The old listener also reacted to 'sync' area changes, but reloadData() writes syncMeta
  // to chrome.storage.sync which then fired this listener again — an infinite loop.
  // The popup does not need to react to sync area changes; the content script owns sync writes.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (isSyncing) return; // block re-entrant reloads triggered by our own sync write
    if (areaName !== "local") return; // only react to local writes from the content script
    if (
      changes.accounts ||
      changes.chats ||
      changes.currentAccountId ||
      changes.syncStatus
    ) {
      reloadData();
    }
  });

  // ─── Phase B: Semantic Search Drawer Binding ──────────────────────────

  const gearBtn = document.getElementById("semanticGearBtn");
  if (gearBtn) {
    gearBtn.addEventListener("click", () => {
      const drawer = document.getElementById("semanticDrawer");
      if (drawer) {
        drawer.style.display = drawer.style.display === "none" ? "" : "none";
        if (drawer.style.display !== "none") _syncSemanticDrawerState();
      }
    });
  }

  const semanticCollapseBtn = document.getElementById("semanticCollapseBtn");
  if (semanticCollapseBtn) {
    semanticCollapseBtn.addEventListener("click", () => {
      const drawer = document.getElementById("semanticDrawer");
      if (drawer) drawer.style.display = "none";
    });
  }

  /** Sync the drawer UI elements to match current state.semanticSettings */
  function _syncSemanticDrawerState() {
    const badge = document.getElementById("semanticBadge");
    const searchMode = state.searchMode || "hybrid";

    const radio = document.querySelector(`input[name="searchMode"][value="${searchMode}"]`);
    if (radio) radio.checked = true;

    if (badge) {
      const isEnabled = (searchMode !== "text");
      badge.style.display = isEnabled ? "" : "none";
      badge.textContent = searchMode === "semantic" ? "⚡ Semantic" : "⚡ Hybrid";
    }

    // ── API Key Config Section display ──
    // Key lives exclusively in chrome.storage.local — no compiled default.
    // Show collapsed status row if a key is already saved, otherwise show input form.
    const apiSection = document.getElementById("apiKeyConfigSection");
    if (apiSection) {
      apiSection.style.display = "flex";
      const activeRow = document.getElementById("apiKeyActiveRow");
      const inputForm = document.getElementById("apiKeyInputForm");
      const apiKeyInput = document.getElementById("apiKeyInput");
      const status = document.getElementById("apiKeyValidationStatus");

      if (status) status.textContent = "";

      const savedKey = state.semanticSettings && state.semanticSettings.apiKey;
      if (savedKey) {
        if (activeRow) activeRow.style.display = "flex";
        if (inputForm) inputForm.style.display = "none";
        if (apiKeyInput) apiKeyInput.value = savedKey;
      } else {
        if (activeRow) activeRow.style.display = "none";
        if (inputForm) inputForm.style.display = "flex";
        if (apiKeyInput) apiKeyInput.value = "";
      }
    }
  }

  // Bind search mode radio changes
  document.querySelectorAll('input[name="searchMode"]').forEach((radio) => {
    radio.addEventListener("change", async (e) => {
      const mode = e.target.value;
      if (state.searchMode === mode) return;
      state.searchMode = mode;

      const enabled = (mode !== "text");
      const apiKey = state.semanticSettings && state.semanticSettings.apiKey;
      state.semanticSettings = { ...state.semanticSettings, enabled, apiKey };

      await storageSet({
        searchMode: mode,
        semanticSettings: state.semanticSettings,
      });

      // Update badge
      const badge = document.getElementById("semanticBadge");
      if (badge) {
        badge.style.display = enabled ? "" : "none";
        badge.textContent = mode === "semantic" ? "⚡ Semantic" : "⚡ Hybrid";
      }

      // Trigger scanning if we just enabled it and have an active account
      if (e.isTrusted && enabled && apiKey) {
        const account = selectedAccountForActions() ||
          (state.currentAccountId ? state.accounts[state.currentAccountId] : null);
        if (account) triggerIndexing(account);
      }

      // Refresh search results immediately
      renderChats();
    });
  });

  // Bind Gemini API key Save button (Option A)
  const saveApiKeyBtn = document.getElementById("saveApiKeyBtn");
  if (saveApiKeyBtn) {
    saveApiKeyBtn.addEventListener("click", async () => {
      const apiKeyInput = document.getElementById("apiKeyInput");
      const status = document.getElementById("apiKeyValidationStatus");
      const activeRow = document.getElementById("apiKeyActiveRow");
      const inputForm = document.getElementById("apiKeyInputForm");

      if (!apiKeyInput) return;
      const enteredKey = apiKeyInput.value.trim();

      if (!enteredKey) {
        if (status) {
          status.textContent = "Please enter a key";
          status.style.color = "var(--danger)";
        }
        return;
      }

      if (status) {
        status.textContent = "Validating...";
        status.style.color = "var(--muted)";
      }

      if (window.generateEmbedding) {
        try {
          // Validate the key via a dummy request to Gemini
          await window.generateEmbedding("test", enteredKey);

          const searchMode = state.searchMode || "hybrid";
          const enabled = (searchMode !== "text");
          state.semanticSettings = { enabled, apiKey: enteredKey };
          await storageSet({ semanticSettings: state.semanticSettings });

          if (status) {
            status.textContent = "✓ Active";
            status.style.color = "var(--green)";
          }

          // Collapse input box into a single low-profile status row to save space
          setTimeout(() => {
            if (activeRow) activeRow.style.display = "flex";
            if (inputForm) inputForm.style.display = "none";
          }, 800);

          // Auto-trigger scanning if search mode is active
          if (enabled) {
            const account = selectedAccountForActions() ||
              (state.currentAccountId ? state.accounts[state.currentAccountId] : null);
            if (account) triggerIndexing(account);
          }
        } catch (err) {
          console.warn("Gemini API key validation failed:", err);
          if (status) {
            status.textContent = "✗ Invalid key";
            status.style.color = "var(--danger)";
          }
        }
      }
    });
  }

  // Bind Gemini API key Edit button (Option A)
  const editApiKeyBtn = document.getElementById("editApiKeyBtn");
  if (editApiKeyBtn) {
    editApiKeyBtn.addEventListener("click", () => {
      const activeRow = document.getElementById("apiKeyActiveRow");
      const inputForm = document.getElementById("apiKeyInputForm");
      const status = document.getElementById("apiKeyValidationStatus");

      if (activeRow) activeRow.style.display = "none";
      if (inputForm) inputForm.style.display = "flex";
      if (status) status.textContent = "";
    });
  }

}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  // Wait for dev mode to be read from storage before rendering,
  // so CCT_DEV_MODE is accurate when applyDevMode() and render() run.
  if (window.cctDevModeReady) {
    await window.cctDevModeReady;
  }
  applyDevMode();
  if (window.migrateLegacyData) {
    try {
      await window.migrateLegacyData();
    } catch (e) {
      console.error("Migration failed:", e);
    }
  }
  reloadData();
});
