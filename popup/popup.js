'use strict';

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

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'unknown';

  const diff = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

function shortAccountName(account) {
  return account.displayName || account.email || 'Unknown account';
}

function currentAccountDisplay(account) {
  if (!account) return 'Open Claude to detect automatically';
  if (account.email) return `${shortAccountName(account)} (${account.email})`;
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

// Improved compareChats using sectionTimestamp as the primary date signal.
// Priority:
//   1. Starred chats always sort above non-starred (regardless of date or account)
//   2. Same account + both have fresh sidebarOrder → use sidebar position (mirrors Claude exactly)
//   3. sectionTimestamp (date bucket scraped from sidebar headers) or lastSeen as proxy
//   4. Alphabetical title tiebreaker
// This fixes the stale-vs-fresh bias where a 2-day-old chat with sidebarOrder:0 sorted
// above a 1-minute-old chat whose orderSeenAt had expired.
function compareChats(a, b) {
  // Starred chats always sort to top; starred vs starred falls through to date logic below
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

  // Use sectionTimestamp when available. Fall back to lastSeen.
  const aTime = a.sectionTimestamp || a.lastSeen || 0;
  const bTime = b.sectionTimestamp || b.lastSeen || 0;
  if (aTime !== bTime) return bTime - aTime;

  // Same bucket/time tie-breakers:
  // 1. If same account and both have fresh sidebar order, use sidebar order.
  if (a.accountId === b.accountId && aFresh && bFresh) {
    return a.sidebarOrder - b.sidebarOrder;
  }
  // 2. Then compare lastSeen descending.
  const aLastSeen = a.lastSeen || 0;
  const bLastSeen = b.lastSeen || 0;
  if (aLastSeen !== bLastSeen) return bLastSeen - aLastSeen;

  // 3. Then title ascending.
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

  return chats.sort(compareChats);
}

function renderStatus() {
  const accountCount = Object.keys(state.accounts || {}).length;
  const chatCount = Object.keys(state.chats || {}).length;
  const accountWord = accountCount === 1 ? 'account' : 'accounts';
  const syncText = state.syncStatus && state.syncStatus.ok === false
    ? 'sync issue'
    : 'sync on';
  // IMP-05 fix: quota warning is read from a module-level flag, never appended to existing text.
  // This prevents "— ⚠ sync near limit" from being duplicated on every render() call.
  let text = `${chatCount} chats - ${accountCount} ${accountWord} - ${syncText}`;
  if (syncQuotaWarning) text += ' — \u26a0 sync near limit';
  document.getElementById('statusText').textContent = text;
  const selectedAccount = selectedAccountForActions();
  document.getElementById('renameBtn').disabled = !selectedAccount;
  document.getElementById('deleteAccountBtn').disabled = !selectedAccount;
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

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'chat-item';
  item.classList.toggle('account-mismatch', !canOpenWithoutMismatchWarning(chat));
  item.classList.toggle('is-starred', isStarred);

  const dot = document.createElement('span');
  dot.className = 'account-dot';
  dot.style.background = account.color || '#888';

  const info = document.createElement('span');
  info.className = 'chat-info';

  const title = document.createElement('span');
  title.className = 'chat-title';
  title.textContent = chat.title || 'Untitled Chat';

  const meta = document.createElement('span');
  meta.className = 'chat-meta';

  const accountName = document.createElement('span');
  accountName.className = 'account-name';
  accountName.textContent = `${shortAccountName(account)} - ${formatRelativeTime(chat.lastSeen)}`;

  const badge = document.createElement('span');
  badge.className = 'status-badge';
  badge.textContent = canOpenWithoutMismatchWarning(chat) ? 'Ready' : 'Switch';

  meta.append(accountName, badge);

  const mark = document.createElement('span');
  mark.className = 'open-mark';
  mark.appendChild(createOpenIcon());
  mark.setAttribute('aria-hidden', 'true');

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

  info.append(title, meta);
  item.append(dot, info, starBtn, mark);
  item.title = !canOpenWithoutMismatchWarning(chat)
    ? `${chat.title || 'Untitled Chat'} - requires ${shortAccountName(account)}`
    : chat.title || '';
  item.addEventListener('click', () => {
    openChat(chat);
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

function renderChats() {
  const list = document.getElementById('chatList');
  const allChats = visibleChats(); // already sorted by compareChats (starred first)
  const summary = document.getElementById('searchSummary');

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
    appendSectionHeader('\u2605 Starred');
    starredChats.forEach(chat => list.appendChild(makeChatItem(chat)));

    if (normalChats.length > 0) {
      appendSectionHeader('All chats');
    }
  }

  normalChats.forEach(chat => list.appendChild(makeChatItem(chat)));
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

  render();
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

  document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
    const account = selectedAccountForActions();
    if (!account) return;

    const accountName = shortAccountName(account);
    const accountChats = Object.values(state.chats || {})
      .filter(chat => chat.accountId === account.accountId);

    if (!confirm(`Delete "${accountName}" and ${accountChats.length} tracked chat${accountChats.length === 1 ? '' : 's'}?`)) {
      return;
    }

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

    render();
  });

  // IMP-02: show an inline edit panel instead of window.prompt()
  // This avoids browser prompt() which can be blocked in extension contexts.
  function showInlineEdit(currentValue, onConfirm) {
    const panel = document.getElementById('inlineEditPanel');
    const input = document.getElementById('inlineEditInput');
    if (!panel || !input) { // safety fallback to prompt() if DOM not ready
      const val = prompt('Account name', currentValue || '');
      if (val && val.trim()) onConfirm(val.trim());
      return;
    }
    input.value = currentValue || '';
    panel.style.display = 'flex';
    input.focus();
    input.select();

    const cleanup = () => { panel.style.display = 'none'; };

    document.getElementById('inlineEditConfirm').onclick = () => {
      const val = input.value.trim();
      cleanup();
      if (val) onConfirm(val);
    };
    document.getElementById('inlineEditCancel').onclick = cleanup;

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const val = input.value.trim();
        cleanup();
        if (val) onConfirm(val);
      } else if (e.key === 'Escape') {
        cleanup();
      }
    };
  }

  // Expose showInlineEdit so createAccount() can route through the inline panel (IMP-02)
  _showInlineEdit = showInlineEdit;

  document.getElementById('renameBtn').addEventListener('click', () => {
    const account = selectedAccountForActions();
    if (!account) {
      alert('Select an account button first.');
      return;
    }
    showInlineEdit(shortAccountName(account), async (nextName) => {
      state.accounts[account.accountId] = {
        ...account,
        displayName: nextName
      };
      await persistData();
      render();
    });
  });

  document.getElementById('clearBtn').addEventListener('click', async () => {
    if (!confirm('Clear local and synced Claude chat index?')) return;
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

    // Signal all open Claude tabs that storage was cleared so they reset their
    // lastSnapshot and immediately re-scrape the sidebar. Without this, the
    // content script's DOM snapshot still matches and it skips the save entirely.
    await storageSet({ rescrapeRequested: Date.now() });

    state.accounts = {};
    state.chats = {};
    state.currentAccountId = '';
    state.activeAccountId = 'all';
    state.syncStatus = null;
    render();
  });

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
