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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Phase 1: Tombstone resurrection — remove a previously deleted account from sync
  // so the background worker no longer garbage-collects it on the next SYNC_DATA pass.
  if (message.type === 'RESURRECT_ACCOUNT') {
    const { accountId } = message;
    (async () => {
      try {
        const data = await chrome.storage.sync.get([SYNC_KEYS.deletedAccounts]);
        const deletedAccounts = data[SYNC_KEYS.deletedAccounts] || {};
        if (deletedAccounts[accountId]) {
          delete deletedAccounts[accountId];
          await chrome.storage.sync.set({ [SYNC_KEYS.deletedAccounts]: deletedAccounts });
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true; // keep sendResponse alive
  }

  if (message.type !== 'SYNC_DATA') return false;
  // Push onto queue — processQueue() will run the latest and discard the rest
  syncQueue.push({
    accounts: message.accounts,
    chats: message.chats,
    deletedAccounts: message.deletedAccounts,
    resolve: sendResponse
  });
  processQueue();
  return true; // keep sendResponse alive (async)
});

async function processQueue() {
  if (syncInProgress || syncQueue.length === 0) return;
  syncInProgress = true;

  // Copy all queued items into batch
  const batch = [...syncQueue];
  // Clear syncQueue
  syncQueue.length = 0;

  try {
    // Read existing synced data
    const synced = await readSyncedData();
    let currentAccounts = { ...synced.accounts };
    let currentChats = { ...synced.chats };
    let currentDeleted = { ...synced.deletedAccounts };

    // Merge existing synced accounts/chats/deleted with every batch item
    for (const item of batch) {
      currentDeleted = mergeDeletedAccounts(currentDeleted, item.deletedAccounts);
      currentAccounts = mergeAccounts(currentAccounts, item.accounts, currentDeleted);
      currentChats = mergeChats(currentChats, item.chats, currentDeleted);
    }

    // Run tombstone retention garbage collection
    currentDeleted = gcTombstones(currentDeleted, currentAccounts, currentChats);

    // Write the merged result
    const prunedCount = await doSyncWrite(currentAccounts, currentChats, currentDeleted);

    // Send response to every queued request
    for (const item of batch) {
      if (typeof item.resolve === 'function') {
        item.resolve({ ok: true, prunedCount, cutoffDays: 90 });
      }
    }
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    // If any error happens, send { ok: false, error } to every queued request
    for (const item of batch) {
      if (typeof item.resolve === 'function') {
        item.resolve({ ok: false, error: errMsg });
      }
    }
  } finally {
    syncInProgress = false;
    // Process any request that arrived while we were writing
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
