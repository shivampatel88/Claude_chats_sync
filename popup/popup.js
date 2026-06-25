'use strict';

if (typeof chrome === 'undefined' || !chrome.storage) {
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'SYNC_DATA') {
          setTimeout(() => cb({ ok: true, prunedCount: 0 }), 100);
        }
      }
    },
    storage: {
      local: {
        get: (keys) => {
          return Promise.resolve({
            currentAccountId: 'acc_1',
            accounts: {
              'acc_1': { accountId: 'acc_1', email: 'work@company.com', displayName: 'Work Profile', color: '#4A90D9', isManual: false },
              'acc_2': { accountId: 'acc_2', email: 'personal@gmail.com', displayName: 'Personal Profile', color: '#D9784A', isManual: false },
              'acc_3': { accountId: 'acc_3', email: 'hobby@gmail.com', displayName: 'Hobby Projects', color: '#45A878', isManual: false }
            },
            chats: {
              'chat_1': { storageId: 'chat_1', chatId: '1', accountId: 'acc_1', title: 'React Performance Optimization Tips', url: 'https://claude.ai/chat/1', serverUpdatedAt: Date.now() - 5000 },
              'chat_2': { storageId: 'chat_2', chatId: '2', accountId: 'acc_1', title: 'Rust Web Server Implementation using Axum', url: 'https://claude.ai/chat/2', serverUpdatedAt: Date.now() - 3600000 * 2 },
              'chat_3': { storageId: 'chat_3', chatId: '3', accountId: 'acc_2', title: 'Premium Dark Theme Design System Audit', url: 'https://claude.ai/chat/3', serverUpdatedAt: Date.now() - 3600000 * 25 },
              'chat_4': { storageId: 'chat_4', chatId: '4', accountId: 'acc_3', title: 'Weekly Groceries List & Meal Planner', url: 'https://claude.ai/chat/4', serverUpdatedAt: Date.now() - 3600000 * 24 * 5 },
              'chat_5': { storageId: 'chat_5', chatId: '5', accountId: 'acc_1', title: 'Very Long Title that should be truncated to a single line using text-overflow ellipsis otherwise it breaks the rhythm of the list', url: 'https://claude.ai/chat/5', serverUpdatedAt: Date.now() - 100 }
            },
            starredChatIds: ['chat_2']
          });
        },
        set: (vals) => Promise.resolve(),
        remove: () => Promise.resolve()
      },
      sync: {
        get: (keys) => {
          return Promise.resolve({
            syncMeta: { chatChunkCount: 0 }
          });
        },
        set: () => Promise.resolve(),
        remove: () => Promise.resolve()
      },
      onChanged: {
        addListener: () => {}
      }
    }
  };
}

const STORAGE_KEYS = {
  accounts: 'accounts',
  chats: 'chats',
  currentAccountId: 'currentAccountId',
  syncStatus: 'syncStatus',
  pendingOpen: 'pendingOpen'
};

const SYNC_KEYS = {
  accounts: 'syncAccounts',
  meta: 'syncMeta',
  chatPrefix: 'syncChats_',
  deletedAccounts: 'syncDeletedAccounts'
};

const ACCOUNT_COLORS = [
  '#4A90D9',
  '#D9784A',
  '#45A878',
  '#8D66CC',
  '#C9A227',
  '#2D9BA3',
  '#C85C7A',
  '#789A45'
];



let searchIndexHandle = null;
let indexProgressPollTimer = null;

let state = {
  accounts: {},
  chats: {},
  activeAccountId: 'all',
  currentAccountId: '',
  viewMode: 'all',
  syncStatus: null,
  query: '',
  deletedAccountIds: [], // BUG-03: tombstone IDs for accounts deleted locally but not yet confirmed in sync
  starredChatIds: new Set(), // storageId strings — starred chats always sort to top
  profileLocalId: ''
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
  if (!timestamp) return 'unknown';

  const diff = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour   = 60 * minute;

  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayMidnight = todayMidnight - 24 * hour;

  if (diff < minute)      return 'just now';
  if (diff < hour)        return `${Math.floor(diff / minute)} minutes ago`;
  if (diff < 2 * hour)    return '1 hour ago';
  if (diff < 24 * hour)   return `${Math.floor(diff / hour)} hours ago`;

  if (timestamp >= yesterdayMidnight) {
    return 'Yesterday';
  }

  const day = 24 * hour;
  if (diff < 7 * day)     return `${Math.floor(diff / day)} days ago`;

  const d = new Date(timestamp);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${months[d.getMonth()]} ${d.getDate()}`
    : `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function shortAccountName(account) {
  return account.displayName || account.email || 'Unknown account';
}

function currentAccountDisplay(account) {
  if (!account) return 'Open Claude to detect automatically';
  return shortAccountName(account);
}

function colorForAccount(accounts) {
  return ACCOUNT_COLORS[Object.keys(accounts || {}).length % ACCOUNT_COLORS.length];
}

function normalizeSearch(value) {
  return (value || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function chatSearchText(chat) {
  const account = state.accounts[chat.accountId] || {};
  return normalizeSearch([
    chat.title,
    shortAccountName(account),
    account.email,
    chat.url
  ].filter(Boolean).join(' '));
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
  const aFresh = hasSidebarOrder(a) && (now - (a.orderSeenAt || 0)) < SIDEBAR_ORDER_MAX_AGE_MS;
  const bFresh = hasSidebarOrder(b) && (now - (b.orderSeenAt || 0)) < SIDEBAR_ORDER_MAX_AGE_MS;

  // Same account + both fresh → trust Claude's own sidebar ordering exactly
  if (a.accountId === b.accountId && aFresh && bFresh) {
    return a.sidebarOrder - b.sidebarOrder;
  }

  // Best available date signal: serverUpdatedAt > sectionTimestamp > lastSeen
  const aTime = a.serverUpdatedAt || a.sectionTimestamp || a.lastSeen || 0;
  const bTime = b.serverUpdatedAt || b.sectionTimestamp || b.lastSeen || 0;
  if (aTime !== bTime) return bTime - aTime;

  // Tiebreakers when dates are identical:
  if (a.accountId === b.accountId && aFresh && bFresh) return a.sidebarOrder - b.sidebarOrder;
  const aLast = a.lastSeen || 0;
  const bLast = b.lastSeen || 0;
  if (aLast !== bLast) return bLast - aLast;
  return (a.title || '').localeCompare(b.title || '');
}



async function readSyncedData() {
  const header = await syncGet([SYNC_KEYS.accounts, SYNC_KEYS.meta, SYNC_KEYS.deletedAccounts]);
  const meta = header[SYNC_KEYS.meta] || {};
  const chunkCount = Number(meta.chatChunkCount || 0);
  const chunkKeys = Array.from({ length: chunkCount }, (_value, index) => `${SYNC_KEYS.chatPrefix}${index}`);
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
    deletedAccounts: header[SYNC_KEYS.deletedAccounts] || {}
  };
}



async function writeSyncedData(accounts, chats, deletedAccounts = {}, previousChunkCount = 0) {
  void previousChunkCount;
  return await sendSyncToBackground(accounts, chats, deletedAccounts);
}


async function persistData({ accounts = state.accounts, chats = state.chats, currentAccountId = state.currentAccountId } = {}) {
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
      currentAccountId
    });

    const synced = await readSyncedData();
    const deletedAccounts = synced.deletedAccounts || {};
    const mergedAccounts = mergeAccounts(synced.accounts, accounts, deletedAccounts, state.deletedAccountIds);
    const mergedChats = mergeChats(synced.chats, chats, deletedAccounts, state.deletedAccountIds);
    const response = await writeSyncedData(mergedAccounts, mergedChats, deletedAccounts, Number(synced.meta.chatChunkCount || 0));
    state.accounts = mergedAccounts;
    state.chats = mergedChats;
    const msg = (response && response.prunedCount > 0)
      ? `Synced; ${response.prunedCount} older chats skipped from sync`
      : 'Synced';
    state.syncStatus = {
      ok: true,
      updatedAt: Date.now(),
      message: msg
    };
    await storageSet({
      accounts: mergedAccounts,
      chats: mergedChats,
      syncStatus: state.syncStatus
    });
  } catch (error) {
    state.syncStatus = {
      ok: false,
      updatedAt: Date.now(),
      message: error && error.message ? error.message : String(error)
    };
    await storageSet({ syncStatus: state.syncStatus });
  } finally {
    // Always release the lock — even if sync threw — so the UI is never permanently frozen.
    isSyncing = false;
  }
}

function visibleChats() {
  let chats = Object.values(state.chats || {});

  if (state.activeAccountId !== 'all') {
    chats = chats.filter(chat => chat.accountId === state.activeAccountId);
  }

  const query = normalizeSearch(state.query);
  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);
    chats = chats.filter(chat => {
      const haystack = chatSearchText(chat);
      return terms.every(term => haystack.includes(term));
    });
  }

  // Narrowed Fix 3 — display-layer backstop for the transient fallback→real migration window.
  // During the ~2-4 s window between page load and email resolution, a scrape may write chats
  // under profileFallbackAccountId (acc_pfl_*). Once the real identity resolves, saveScrape()
  // migrates those entries to the real accountId. Until that migration completes, both
  // acc_pfl_xxx:chatId and acc_real:chatId can coexist. We suppress the fallback copy here
  // so the user sees one clean entry, not two.
  //
  // We deliberately do NOT dedup when BOTH entries are under real accounts (no acc_pfl_ prefix):
  // two genuine accounts can legitimately share a chatId (UUIDs are only namespace-unique).
  const isFallbackAccount = id => typeof id === 'string' && id.startsWith('acc_pfl_');
  const seenChatIds = new Map(); // chatId → first winning chat object
  return chats.sort(compareChats).filter(chat => {
    const prior = seenChatIds.get(chat.chatId);
    if (!prior) {
      seenChatIds.set(chat.chatId, chat);
      return true;
    }
    // Only suppress when one of the two is a fallback — this is the transient race state.
    // If both are real accounts, show both entries; it is valid cross-account data.
    if (isFallbackAccount(prior.accountId) || isFallbackAccount(chat.accountId)) return false;
    return true;
  });
}

function renderStatus() {
  const accountCount = Object.keys(state.accounts || {}).length;
  const chatCount = Object.keys(state.chats || {}).length;
  const accountWord = accountCount === 1 ? 'account' : 'accounts';

  const statsEl = document.getElementById('statsText');
  if (statsEl) {
    statsEl.textContent = `${chatCount} chats · ${accountCount} ${accountWord}`;
  }

  const container = document.getElementById('syncStatusContainer');
  const syncTextEl = document.getElementById('syncText');

  if (container && syncTextEl) {
    if (state.syncStatus && state.syncStatus.ok === false) {
      container.classList.add('has-issue');
      syncTextEl.textContent = 'Sync issue';

      let fixLink = document.getElementById('syncFixLink');
      if (!fixLink) {
        fixLink = document.createElement('a');
        fixLink.id = 'syncFixLink';
        fixLink.textContent = 'Fix';
        fixLink.href = '#';
        fixLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const errMessage = state.syncStatus && state.syncStatus.message ? state.syncStatus.message : 'Unknown sync error';
          if (confirm(`Sync failed: "${errMessage}". Would you like to retry now?`)) {
            reloadData();
          }
        });
        container.appendChild(fixLink);
      }
    } else {
      container.classList.remove('has-issue');
      let text = 'Synced';
      if (syncQuotaWarning) text = 'Synced (near limit)';
      syncTextEl.textContent = text;

      const fixLink = document.getElementById('syncFixLink');
      if (fixLink) {
        fixLink.remove();
      }
    }
  }

  const actionArea = document.getElementById('accountActionArea');
  if (actionArea) {
    actionArea.style.display = state.activeAccountId === 'all' ? 'none' : 'flex';
  }
  
  const account = selectedAccountForActions();
  if (account && state.activeAccountId !== 'all') {
    updateIndexStatusUI(account);
  } else if (indexProgressPollTimer) {
    clearInterval(indexProgressPollTimer);
    indexProgressPollTimer = null;
  }
}

async function updateIndexStatusUI(account) {
  let statusContainer = document.getElementById('indexStatusContainer');
  if (!statusContainer) {
    const actionArea = document.getElementById('accountActionArea');
    if (!actionArea) return;
    statusContainer = document.createElement('div');
    statusContainer.id = 'indexStatusContainer';
    statusContainer.className = 'index-status';
    const icons = document.getElementById('accountIcons');
    if (icons) {
      actionArea.insertBefore(statusContainer, icons);
    } else {
      actionArea.appendChild(statusContainer);
    }
  }

  if (indexProgressPollTimer) {
    clearInterval(indexProgressPollTimer);
    indexProgressPollTimer = null;
  }

  const renderIndexStatus = async () => {
    const local = await storageGet(['indexingQueue']);
    const q = local.indexingQueue;
    statusContainer.replaceChildren();

    if (!q || q.accountId !== account.accountId || q.status === 'idle') {
      const btn = document.createElement('button');
      btn.className = 'index-btn';
      btn.textContent = 'Index';
      btn.onclick = () => triggerIndexing(account);
      statusContainer.appendChild(btn);
    } else if (q.status === 'running' || q.status === 'paused-tab-hidden') {
      const total = q.doneChatIds.length + q.pendingChatIds.length + q.failedChatIds.length;
      statusContainer.textContent = `Indexing: ${q.doneChatIds.length}/${total}`;
      if (!indexProgressPollTimer) {
        indexProgressPollTimer = setInterval(renderIndexStatus, 1500);
      }
    } else if (q.status === 'paused-ratelimited') {
      statusContainer.textContent = 'Paused (Rate limit)';
    } else if (q.status === 'complete') {
      const d = new Date(q.startedAt || Date.now());
      statusContainer.textContent = `Indexed ${formatChatDate(d.getTime())}`;
      const btn = document.createElement('button');
      btn.className = 'index-btn';
      btn.style.marginLeft = '5px';
      btn.textContent = 'Re-index';
      btn.onclick = () => triggerIndexing(account);
      statusContainer.appendChild(btn);
    }
  };
  
  await renderIndexStatus();
}

async function triggerIndexing(account) {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*', active: true, currentWindow: true });
  if (tabs.length === 0) {
    alert("Please open a claude.ai tab first to start indexing.");
    return;
  }
  
  const statusContainer = document.getElementById('indexStatusContainer');
  if (statusContainer) statusContainer.textContent = 'Starting...';

  // The content script will fetch the orgId if we don't have it
  chrome.tabs.sendMessage(tabs[0].id, { 
    type: 'CCT_INDEX_ACCOUNT', 
    accountId: account.accountId,
    orgId: null 
  }).catch(() => {
    alert("Could not reach Claude tab. Please refresh the claude.ai page and try again.");
  });
  
  if (!indexProgressPollTimer) {
    indexProgressPollTimer = setInterval(() => updateIndexStatusUI(account), 1500);
  }
}

function makeFilterButton(label, accountId, color) {
  const option = document.createElement('option');
  option.value = accountId;
  option.textContent = label;
  if (color) option.dataset.color = color;
  return option;
}

function renderFilters() {
  const filters = document.getElementById('accountFilterSelect');
  filters.replaceChildren();
  filters.appendChild(makeFilterButton('All accounts', 'all'));

  Object.values(state.accounts || {})
    .sort((a, b) => shortAccountName(a).localeCompare(shortAccountName(b)))
    .forEach(account => {
      filters.appendChild(makeFilterButton(shortAccountName(account), account.accountId, account.color));
    });

  filters.value = state.activeAccountId;
  if (filters.value !== state.activeAccountId) {
    state.activeAccountId = 'all';
    filters.value = 'all';
  }
}

function renderCurrentAccount() {
  const currentAccount = state.accounts[state.currentAccountId];
  document.getElementById('currentAccountName').textContent = currentAccountDisplay(currentAccount);
}

function canOpenWithoutMismatchWarning(chat) {
  return !state.currentAccountId || chat.accountId === state.currentAccountId;
}

function selectedAccountForActions() {
  const selectedId = state.activeAccountId !== 'all'
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
    const accountName = shortAccountName(chatAccount);
    const currentName = shortAccountName(currentAccount);
    const message = `Switching from "${currentName}" to "${accountName}".\n\n` +
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
        chatTitle: chat.title || 'Untitled Chat',
        chatUrl: chat.url,
        createdAt: Date.now(),
        googleStarted: false,
        loginStartedAt: null
      }
    });
    // Delete ALL session cookies for Claude/Anthropic before opening the tab.
    // This is the only reliable logout — URL parameters like ?from=logout are
    // ignored by Claude's server; it just redirects the still-logged-in user back.
    await clearClaudeSession();
    // Clean login page: no active session → shows "Continue with Google" immediately.
    // The content script on that page auto-clicks the Google button and shows the toast.
    chrome.tabs.create({ url: 'https://claude.ai/login' });
    return;
  }

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
  const domains = ['claude.ai', 'anthropic.com', 'auth.anthropic.com'];
  try {
    for (const domain of domains) {
      const cookies = await chrome.cookies.getAll({ domain });
      await Promise.all(cookies.map(cookie => {
        // Strip leading dot that Chrome prepends for domain cookies.
        const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        // Derive root domain (last two labels: e.g. "session.claude.ai" → "claude.ai")
        const parts = host.split('.');
        const rootDomain = parts.length >= 2 ? parts.slice(-2).join('.') : host;
        const path = cookie.path || '/';

        // Build an exhaustive set of URL variants:
        // • exact host with both protocols
        // • www. prefix of root domain with both protocols
        // This covers strict-subdomain bindings that a single URL would miss.
        const urlVariants = [
          `https://${host}${path}`,
          `http://${host}${path}`,
          `https://www.${rootDomain}${path}`,
          `http://www.${rootDomain}${path}`
        ];

        return Promise.all(
          urlVariants.map(url =>
            chrome.cookies.remove({ url, name: cookie.name }).catch(() => {})
          )
        );
      }));
    }
  } catch (err) {
    console.warn('[Claude Chat Tracker] Could not clear session cookies:', err);
  }
}


function createOpenIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7 17 17 7M9 7h8v8');
  svg.appendChild(path);
  return svg;
}

function makeChatItem(chat) {
  const account = state.accounts[chat.accountId] || {};
  const isStarred = state.starredChatIds.has(chat.storageId);

  const item = document.createElement('div');
  item.className = 'chat-item';
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');
  item.classList.toggle('account-mismatch', !canOpenWithoutMismatchWarning(chat));
  item.classList.toggle('is-starred', isStarred);

  const dot = document.createElement('span');
  dot.className = 'account-dot';
  dot.style.background = account.color || '#888';
  dot.title = account.email || shortAccountName(account) || 'Unknown account';

  const info = document.createElement('span');
  info.className = 'chat-info';

  const title = document.createElement('span');
  title.className = 'chat-title';
  title.textContent = chat.title || 'Untitled Chat';

  const meta = document.createElement('span');
  meta.className = 'chat-meta';

  const dateSpan = document.createElement('span');
  dateSpan.className = 'chat-date';
  const displayTs = chat.serverUpdatedAt || chat.sectionTimestamp || chat.lastSeen;
  dateSpan.textContent = formatChatDate(displayTs);

  const badge = document.createElement('span');
  badge.className = 'status-badge';
  if (canOpenWithoutMismatchWarning(chat)) {
    badge.classList.add('ready');
    badge.textContent = 'Ready';
    badge.title = 'Ready in current session';
  } else {
    badge.classList.add('switch');
    badge.textContent = shortAccountName(account);
    badge.title = `Switch to ${shortAccountName(account)} to open`;
  }

  meta.append(dateSpan, badge);

  const mark = document.createElement('span');
  mark.className = 'open-mark';
  mark.appendChild(createOpenIcon());
  mark.setAttribute('aria-hidden', 'true');

  if (chat._snippet) {
    const snippetEl = document.createElement('div');
    snippetEl.className = 'chat-snippet';
    const escapedSnippet = chat._snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const qToken = state.query.trim().split(/\s+/)[0]; 
    if (qToken && qToken.length >= 2) {
      const regex = new RegExp(`(${qToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      snippetEl.innerHTML = escapedSnippet.replace(regex, '<mark>$1</mark>');
    } else {
      snippetEl.textContent = chat._snippet;
    }
    info.append(title, meta, snippetEl);
  } else {
    info.append(title, meta);
  }

  // Star button — sits between info and open-mark
  const starBtn = document.createElement('button');
  starBtn.type = 'button';
  starBtn.className = 'star-btn';
  starBtn.setAttribute('aria-label', isStarred ? 'Unstar chat' : 'Star chat');
  starBtn.textContent = isStarred ? '\u2605' : '\u2606'; // ★ / ☆
  starBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't open the chat when clicking the star
    toggleStar(chat.storageId);
  });

  item.append(dot, info, starBtn, mark);
  item.title = !canOpenWithoutMismatchWarning(chat)
    ? `${chat.title || 'Untitled Chat'} - requires ${shortAccountName(account)}`
    : chat.title || '';
  
  item.addEventListener('click', () => {
    openChat(chat);
  });

  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
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
  if (!timestamp) return 'Earlier';
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayMidnight = todayMidnight - 24 * 60 * 60 * 1000;
  
  if (timestamp >= todayMidnight) {
    return 'Today';
  } else if (timestamp >= yesterdayMidnight) {
    return 'Yesterday';
  } else {
    return 'Earlier';
  }
}

function renderChats() {
  const list = document.getElementById('chatList');
  let allChats = visibleChats(); // already sorted by compareChats (starred first)
  const summary = document.getElementById('searchSummary');

  const queryRaw = state.query.trim();
  if (queryRaw && searchIndexHandle && window.searchContent) {
    const contentResults = window.searchContent(searchIndexHandle, queryRaw);
    const titleMatchIds = new Set(allChats.map(c => c.storageId));
    
    // Merge: content matches that weren't already found by title
    for (const res of contentResults) {
      if (!titleMatchIds.has(res.storageId)) {
        const chatObj = state.chats[res.storageId];
        if (chatObj) {
          // Clone it so we don't mutate the state object with the snippet
          const cloned = { ...chatObj, _snippet: res.snippet };
          allChats.push(cloned);
        }
      } else {
        // If it WAS matched by title, also add the snippet if we have one
        const idx = allChats.findIndex(c => c.storageId === res.storageId);
        if (idx !== -1) {
          allChats[idx] = { ...allChats[idx], _snippet: res.snippet };
        }
      }
    }
  }

  const starredChats = allChats.filter(c => state.starredChatIds.has(c.storageId));
  const normalChats  = allChats.filter(c => !state.starredChatIds.has(c.storageId));

  list.replaceChildren();
  summary.textContent = state.query.trim()
    ? `${allChats.length} match${allChats.length === 1 ? '' : 'es'}`
    : 'Newest first, matching Claude Recents';

  if (allChats.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = Object.keys(state.chats || {}).length === 0
      ? 'Open Claude.ai to start tracking visible chats.'
      : 'No chats match this view.';
    list.appendChild(empty);
    return;
  }

  function appendSectionHeader(label) {
    const header = document.createElement('div');
    header.className = 'section-header';
    header.textContent = label;
    list.appendChild(header);
  }

  if (starredChats.length > 0) {
    appendSectionHeader('Starred');
    starredChats.forEach(chat => list.appendChild(makeChatItem(chat)));
  }

  let currentGroup = null;
  normalChats.forEach(chat => {
    const displayTs = chat.serverUpdatedAt || chat.sectionTimestamp || chat.lastSeen;
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
    const pct = Math.min(100, Math.round(used / total * 100));
    const bar = document.getElementById('quotaBar');
    const fill = document.getElementById('quotaFill');
    if (!bar || !fill) return;
    bar.style.display = 'block';
    fill.style.width = `${pct}%`;
    fill.style.background = pct > 85 ? '#D9784A' : pct > 60 ? '#C9A227' : '#45A878';
    bar.title = `Sync storage: ${pct}% used (${Math.round(used / 1024)}KB / ${Math.round(total / 1024)}KB)`;

    // Set module-level flag; renderStatus() will include it on the NEXT render cycle
    const wasWarning = syncQuotaWarning;
    syncQuotaWarning = pct > 85;
    // If quota state changed, trigger a status re-render so the text updates immediately
    if (wasWarning !== syncQuotaWarning) renderStatus();
  } catch (_) { /* getBytesInUse may not be available in all environments */ }
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
    'deletedAccountIds', // BUG-03: load tombstones so mergeAccounts can filter them
    'starredChatIds',     // restore per-profile starred chat pins
    'profileLocalId'
  ]);
  const synced = await readSyncedData();
  const deletedAccounts = synced.deletedAccounts || {};

  let profileLocalId = local.profileLocalId;
  if (!profileLocalId) {
    profileLocalId = `profile_${crypto.randomUUID()}`;
    await storageSet({ profileLocalId });
  }
  state.profileLocalId = profileLocalId;

  const accounts = mergeAccounts(synced.accounts, local.accounts || {}, deletedAccounts, state.deletedAccountIds);
  const chats = mergeChats(synced.chats, local.chats || {}, deletedAccounts, state.deletedAccountIds);

  state.accounts = accounts;
  state.chats = chats;
  state.currentAccountId = local.currentAccountId || '';
  state.syncStatus = local.syncStatus || null;
  // BUG-03: restore tombstones so mergeAccounts() can filter deleted accounts even after popup reopens
  state.deletedAccountIds = local.deletedAccountIds || [];
  // Restore starred IDs as a Set so has() lookups in compareChats and makeChatItem are O(1)
  state.starredChatIds = new Set(Array.isArray(local.starredChatIds) ? local.starredChatIds : []);

  if (state.activeAccountId !== 'all' && !state.accounts[state.activeAccountId]) {
    state.activeAccountId = 'all';
  }

  // FLAW-03 fix: use stableStringify so key order differences don't cause spurious writes
  const shouldUpdateLocal =
    stableStringify(local.accounts || {}) !== stableStringify(accounts)
    || stableStringify(local.chats || {}) !== stableStringify(chats)
    || (local.currentAccountId || '') !== state.currentAccountId;

  if (shouldUpdateLocal) {
    // BUG-01 fix: guard the sync write so the onChanged listener (which also fires on sync area)
    // does not re-enter reloadData() while we are writing syncMeta.
    isSyncing = true;
    try {
      await storageSet({
        accounts,
        chats,
        currentAccountId: state.currentAccountId
      });
    } finally {
      isSyncing = false;
    }
  }

  // Phase A Search Engine: build index
  if (window.buildSearchIndex) {
    searchIndexHandle = await window.buildSearchIndex();
  }

  maybeResumeQueue();

  render();
}

async function maybeResumeQueue() {
  const local = await storageGet(['indexingQueue']);
  const q = local.indexingQueue;
  if (!q || (q.status !== 'running' && q.status !== 'paused-tab-hidden')) return;
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*', active: true, currentWindow: true });
  if (tabs.length > 0) chrome.tabs.sendMessage(tabs[0].id, { type: 'CCT_RESUME_INDEXING' }).catch(() => {});
}

// IMP-01: send sync data to the background service worker rather than writing directly.
// Returns a promise that resolves when the service worker confirms the write.
function sendSyncToBackground(accounts, chats, deletedAccounts = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'SYNC_DATA', accounts, chats, deletedAccounts }, response => {
        if (chrome.runtime.lastError) {
          // Service worker not available (e.g. extension just reloaded) — caller will fall back
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.ok) resolve(response);
        else reject(new Error(response && response.error ? response.error : 'Sync write failed'));
      });
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
    console.warn('Account editor is unavailable');
    state.syncStatus = {
      ok: false,
      updatedAt: Date.now(),
      message: 'Account editor is unavailable'
    };
    render();
    return;
  }

  // Route through the inline edit UI (IMP-02)
  _showInlineEdit('', async (name) => {
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
      isFallback: false
    };
    state.accounts[accountId] = account;
    state.currentAccountId = accountId;
    await persistData();
    render();
  });
}

function bindEvents() {
  document.getElementById('searchInput').addEventListener('input', event => {
    state.query = event.target.value;
    renderChats();
  });

  document.getElementById('accountFilterSelect').addEventListener('change', event => {
    state.activeAccountId = event.target.value;
    render();
  });

  const startDeleteBtn = document.getElementById('startDeleteBtn');
  const deleteConfirmActions = document.getElementById('deleteConfirmActions');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  let deleteTimeout = null;

  function resetDeleteState() {
    if (startDeleteBtn) startDeleteBtn.style.display = '';
    if (deleteConfirmActions) deleteConfirmActions.style.display = 'none';
    if (deleteTimeout) {
      clearTimeout(deleteTimeout);
      deleteTimeout = null;
    }
  }

  if (startDeleteBtn) {
    startDeleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startDeleteBtn.style.display = 'none';
      deleteConfirmActions.style.display = 'flex';
      deleteTimeout = setTimeout(() => {
        resetDeleteState();
      }, 3000);
    });
  }

  if (cancelDeleteBtn) {
    cancelDeleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetDeleteState();
    });
  }

  if (confirmDeleteBtn) {
    confirmDeleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      resetDeleteState();

      const account = selectedAccountForActions();
      if (!account) return;

      const accountChats = Object.values(state.chats || {})
        .filter(chat => chat.accountId === account.accountId);

      // Fix 3.3: create tombstone for deleted account
      const tombstone = {
        accountId: account.accountId,
        deletedAt: Date.now(),
        deletedByProfileId: state.profileLocalId || 'unknown'
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
          [account.accountId]: tombstone
        };

        delete syncedAccounts[account.accountId];
        for (const chat of Object.values(syncedChats)) {
          if (chat.accountId === account.accountId) delete syncedChats[chat.storageId];
        }

        await writeSyncedData(syncedAccounts, syncedChats, updatedDeletedAccounts, Number(synced.meta.chatChunkCount || 0));
        syncSuccess = true;
      } catch (error) {
        syncError = error;
      }

      // Store local compatibility cache for deletedAccountIds
      state.deletedAccountIds = [...(state.deletedAccountIds || []), account.accountId];
      await storageSet({ deletedAccountIds: state.deletedAccountIds });

      if (!syncSuccess) {
        state.syncStatus = {
          ok: false,
          updatedAt: Date.now(),
          message: syncError && syncError.message ? syncError.message : String(syncError)
        };
        await storageSet({ syncStatus: state.syncStatus });
        alert('Delete completed locally. Cross-profile deletion will not be guaranteed until sync succeeds.');
      }

      // Step 2: delete from local after sync attempt
      const accounts = { ...state.accounts };
      const chats = { ...state.chats };
      delete accounts[account.accountId];

      for (const chat of accountChats) {
        delete chats[chat.storageId];
      }

      const nextAccountId = Object.keys(accounts)[0] || '';
      if (state.currentAccountId === account.accountId) {
        state.currentAccountId = nextAccountId;
      }
      if (state.activeAccountId === account.accountId) {
        state.activeAccountId = 'all';
      }

      state.accounts = accounts;
      state.chats = chats;
      await storageSet({
        accounts,
        chats,
        currentAccountId: state.currentAccountId
      });
      
      if (window.deleteChatContentForAccount) {
        await window.deleteChatContentForAccount(account.accountId);
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
    const panel = document.getElementById('inlineEditPanel');
    const input = document.getElementById('inlineEditInput');
    const icons = document.getElementById('accountIcons');

    if (!panel || !input) { // safety fallback to prompt() if DOM not ready
      const val = prompt('Account name', currentValue || '');
      if (val && val.trim()) onConfirm(val.trim());
      return;
    }
    input.value = currentValue || '';
    if (icons) icons.style.display = 'none';
    panel.style.display = 'flex';
    input.focus();
    input.select();

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      panel.style.display = 'none';
      if (icons) icons.style.display = '';
    };

    input.onblur = () => {
      setTimeout(() => { cleanup(); }, 100);
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const val = input.value.trim();
        cleanup();
        if (val && val !== currentValue) onConfirm(val);
      } else if (e.key === 'Escape') {
        cleanup();
      }
    };
  }

  // Expose showInlineEdit so createAccount() can route through the inline panel (IMP-02)
  _showInlineEdit = showInlineEdit;

  const renameAccountBtn = document.getElementById('renameAccountBtn');
  if (renameAccountBtn) {
    renameAccountBtn.addEventListener('click', () => {
      const account = selectedAccountForActions();
      if (!account) return;
      showInlineEdit(shortAccountName(account), async (nextName) => {
        state.accounts[account.accountId] = { ...account, displayName: nextName };
        await persistData();
        render();
      });
    });
  }

  const closePopupBtn = document.getElementById('closePopupBtn');
  if (closePopupBtn) {
    closePopupBtn.addEventListener('click', () => {
      window.close();
    });
  }

  const startClearBtn = document.getElementById('startClearBtn');
  const clearConfirmModal = document.getElementById('clearConfirmModal');
  const cancelClearBtn = document.getElementById('cancelClearBtn');
  const confirmClearBtn = document.getElementById('confirmClearBtn');
  
  if (startClearBtn && clearConfirmModal && cancelClearBtn) {
    startClearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearConfirmModal.style.display = 'grid';
    });
    cancelClearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearConfirmModal.style.display = 'none';
    });
  }

  // Export diagnostic log — downloads cct-diag-<ts>.json with all recorded
  // identity decisions and chatId collision events.  Button is hidden by default
  // and revealed only when the diag buffer contains at least one entry, keeping
  // the UI uncluttered for normal sessions.
  const exportDiagBtn = document.getElementById('exportDiagBtn');
  if (exportDiagBtn && window.cctDiag) {
    // Reveal button if there are existing entries in storage.
    window.cctDiag.export().then((log) => {
      if (log && log.length > 0) {
        exportDiagBtn.style.display = '';
      }
    }).catch(() => {});

    exportDiagBtn.addEventListener('click', async () => {
      try {
        const log = await window.cctDiag.export();
        const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cct-diag-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        alert('Failed to export diagnostic log: ' + (err && err.message ? err.message : String(err)));
      }
    });
  }


  if (confirmClearBtn && clearConfirmModal) {
    confirmClearBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      clearConfirmModal.style.display = 'none';
      
      const synced = await readSyncedData();
      const staleKeys = Array.from(
        { length: Number(synced.meta.chatChunkCount || 0) },
        (_value, index) => `${SYNC_KEYS.chatPrefix}${index}`
      );
      await chrome.storage.local.remove([
        STORAGE_KEYS.accounts,
        STORAGE_KEYS.chats,
        STORAGE_KEYS.currentAccountId,
        STORAGE_KEYS.syncStatus
      ]);
      await syncRemove([SYNC_KEYS.accounts, SYNC_KEYS.meta, ...staleKeys]);
  
      await storageSet({ rescrapeRequested: Date.now() });
  
      state.accounts = {};
      state.chats = {};
      state.currentAccountId = '';
      state.activeAccountId = 'all';
      state.syncStatus = null;
      render();
    });
  }

  // BUG-01 fix: only react to 'local' storage changes (from the content script).
  // The old listener also reacted to 'sync' area changes, but reloadData() writes syncMeta
  // to chrome.storage.sync which then fired this listener again — an infinite loop.
  // The popup does not need to react to sync area changes; the content script owns sync writes.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (isSyncing) return; // block re-entrant reloads triggered by our own sync write
    if (areaName !== 'local') return; // only react to local writes from the content script
    if (changes.accounts || changes.chats || changes.currentAccountId || changes.syncStatus) {
      reloadData();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  reloadData();
});
