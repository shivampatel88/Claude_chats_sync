'use strict';

importScripts('../shared/shared.js');

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
  accounts: 'syncAccounts',
  meta: 'syncMeta',
  chatPrefix: 'syncChats_',
  deletedAccounts: 'syncDeletedAccounts'
};



function mergeDeletedAccounts(base = {}, incoming = {}) {
  return { ...base, ...incoming };
}

const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// Fix A: decode a base64url-encoded JWT payload and return the email claim, or null.
function tryDecodeJwtEmail(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    // Restore standard base64 padding that base64url strips
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
    const payload = JSON.parse(atob(padded));
    if (payload.email && typeof payload.email === 'string') return payload.email.toLowerCase();
    // Some providers put the email in 'sub'
    if (payload.sub && typeof payload.sub === 'string' && payload.sub.includes('@')) {
      return payload.sub.toLowerCase();
    }
  } catch (_) {}
  return null;
}

// Fix A: scan auth cookies across all Claude / Anthropic domains for any JWT containing an email.
async function extractEmailFromCookies() {
  const domains = ['claude.ai', 'anthropic.com', 'auth.anthropic.com'];
  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const cookie of cookies) {
        const email = tryDecodeJwtEmail(cookie.value);
        if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
      }
    } catch (_) {}
  }
  return null;
}

function gcTombstones(deletedAccounts = {}, accounts = {}, chats = {}) {
  const now = Date.now();
  const cleaned = { ...deletedAccounts };

  for (const [accId, tombstone] of Object.entries(deletedAccounts)) {
    const age = now - (tombstone.deletedAt || 0);
    if (age > TOMBSTONE_RETENTION_MS) {
      const hasAccount = Boolean(accounts[accId]);
      const hasChat = Object.values(chats).some(chat => chat.accountId === accId);
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
    header = await chrome.storage.sync.get([SYNC_KEYS.accounts, SYNC_KEYS.meta, SYNC_KEYS.deletedAccounts]);
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
    deletedAccounts: header[SYNC_KEYS.deletedAccounts] || {}
  };
}

let syncInProgress = false;
const syncQueue = [];

// Structured logging for the background service worker (visible in chrome://extensions → service worker)
const BGT = '[CCT-BG]';
const bgLog  = (...a) => console.log  (BGT, ...a);
const bgWarn = (...a) => console.warn (BGT, ...a);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Fix A: GET_ACCOUNT_EMAIL — scan auth-cookie JWTs and return the user's email.
  if (message.type === 'GET_ACCOUNT_EMAIL') {
    bgLog('🍪 GET_ACCOUNT_EMAIL: scanning cookies…');
    extractEmailFromCookies().then(
      email => {
        bgLog(email ? `🍪 Email found: ${email}` : '🍪 No JWT email in cookies');
        sendResponse({ ok: true, email });
      },
      (err) => {
        bgWarn('🍪 Cookie scan error:', err);
        sendResponse({ ok: false, email: null });
      }
    );
    return true;
  }

  // Fix B: TOMBSTONE_ACCOUNT
  if (message.type === 'TOMBSTONE_ACCOUNT') {
    const { accountId } = message;
    bgLog('🪦 TOMBSTONE_ACCOUNT:', accountId);
    (async () => {
      try {
        const data = await chrome.storage.sync.get([SYNC_KEYS.deletedAccounts]);
        const deletedAccounts = data[SYNC_KEYS.deletedAccounts] || {};
        if (!deletedAccounts[accountId]) {
          deletedAccounts[accountId] = { accountId, deletedAt: Date.now(), auto: true };
          await chrome.storage.sync.set({ [SYNC_KEYS.deletedAccounts]: deletedAccounts });
          bgLog('🪦 Tombstone written to sync for', accountId);
        } else {
          bgLog('🪦 Tombstone already exists for', accountId);
        }
        sendResponse({ ok: true });
      } catch (err) {
        bgWarn('🪦 TOMBSTONE_ACCOUNT error:', err);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  // Phase 1: Tombstone resurrection
  if (message.type === 'RESURRECT_ACCOUNT') {
    const { accountId } = message;
    bgLog('🌱 RESURRECT_ACCOUNT:', accountId);
    (async () => {
      try {
        const data = await chrome.storage.sync.get([SYNC_KEYS.deletedAccounts]);
        const deletedAccounts = data[SYNC_KEYS.deletedAccounts] || {};
        if (deletedAccounts[accountId]) {
          delete deletedAccounts[accountId];
          await chrome.storage.sync.set({ [SYNC_KEYS.deletedAccounts]: deletedAccounts });
          bgLog('🌱 Tombstone removed from sync for', accountId);
        } else {
          bgLog('🌱 No tombstone found for', accountId, '— nothing to remove');
        }
        sendResponse({ ok: true });
      } catch (err) {
        bgWarn('🌱 RESURRECT_ACCOUNT error:', err);
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message.type !== 'SYNC_DATA') return false;
  bgLog(`🔄 SYNC_DATA queued (queue depth: ${syncQueue.length + 1})`);
  syncQueue.push({
    accounts: message.accounts,
    chats: message.chats,
    deletedAccounts: message.deletedAccounts,
    resolve: sendResponse
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
    let currentChats    = { ...synced.chats };
    let currentDeleted  = { ...synced.deletedAccounts };

    for (const item of batch) {
      currentDeleted  = mergeDeletedAccounts(currentDeleted, item.deletedAccounts);
      currentAccounts = mergeAccounts(currentAccounts, item.accounts, currentDeleted);
      currentChats    = mergeChats(currentChats, item.chats, currentDeleted);
    }

    currentDeleted = gcTombstones(currentDeleted, currentAccounts, currentChats);

    const prunedCount = await doSyncWrite(currentAccounts, currentChats, currentDeleted);
    bgLog(`🔄 processQueue done — accounts: ${Object.keys(currentAccounts).length}, chats: ${Object.keys(currentChats).length}, pruned: ${prunedCount}`);

    for (const item of batch) {
      if (typeof item.resolve === 'function') {
        item.resolve({ ok: true, prunedCount, cutoffDays: 90 });
      }
    }
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    bgWarn('🔄 processQueue error:', errMsg);
    for (const item of batch) {
      if (typeof item.resolve === 'function') {
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
    previousChunkCount = Number((header[SYNC_KEYS.meta] || {}).chatChunkCount || 0);
  } catch (_) { /* if read fails, proceed with 0 */ }

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

  const chunks = makeChatChunks(filteredChats);
  const payload = {
    [SYNC_KEYS.accounts]: filteredAccounts,
    [SYNC_KEYS.deletedAccounts]: deletedAccounts,
    [SYNC_KEYS.meta]: {
      chatChunkCount: chunks.length,
      updatedAt: Date.now(),
      version: 2
    }
  };

  chunks.forEach((chunk, index) => {
    payload[`${SYNC_KEYS.chatPrefix}${index}`] = chunk;
  });

  await chrome.storage.sync.set(payload);

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
