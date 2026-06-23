// shared/search-storage.js
// Storage layer for chat search using chrome.storage.local.
// Loaded in both content-script and popup contexts.

const SEARCH_INDEX_KEY = 'searchIndex';

// Wraps chrome.storage.local.get to handle potential invalidation gracefully
async function _getSearchIndex() {
  try {
    const data = await chrome.storage.local.get([SEARCH_INDEX_KEY]);
    return data[SEARCH_INDEX_KEY] || {};
  } catch (err) {
    if (err.message && err.message.includes('Extension context invalidated')) {
      return {};
    }
    throw err;
  }
}

// Wraps chrome.storage.local.set
async function _setSearchIndex(indexData) {
  try {
    await chrome.storage.local.set({ [SEARCH_INDEX_KEY]: indexData });
  } catch (err) {
    if (err.message && err.message.includes('Extension context invalidated')) {
      return;
    }
    throw err;
  }
}

/**
 * Returns the full map of indexed entries.
 * @returns {Promise<Record<string, Object>>} Map of storageId -> record
 */
async function getAllIndexedEntries() {
  return await _getSearchIndex();
}

/**
 * Writes one record to the search index, overwriting if storageId already exists.
 * @param {Object} record - The chat content record.
 */
async function putChatContent(record) {
  if (!record || !record.storageId) return;
  const index = await _getSearchIndex();
  index[record.storageId] = record;
  await _setSearchIndex(index);
}

/**
 * Reads one record by key. Returns null if not found.
 * @param {string} storageId
 * @returns {Promise<Object|null>}
 */
async function getChatContent(storageId) {
  const index = await _getSearchIndex();
  return index[storageId] || null;
}

/**
 * Returns all records for a given account.
 * @param {string} accountId 
 * @returns {Promise<Object[]>}
 */
async function getAllChatContentForAccount(accountId) {
  const index = await _getSearchIndex();
  return Object.values(index).filter(record => record.accountId === accountId);
}

/**
 * Deletes all records matching the accountId.
 * @param {string} accountId 
 * @returns {Promise<number>} Count of records deleted.
 */
async function deleteChatContentForAccount(accountId) {
  const index = await _getSearchIndex();
  let count = 0;
  for (const [storageId, record] of Object.entries(index)) {
    if (record.accountId === accountId) {
      delete index[storageId];
      count++;
    }
  }
  if (count > 0) {
    await _setSearchIndex(index);
  }
  return count;
}

/**
 * Returns every storageId currently indexed, across all accounts.
 * @returns {Promise<string[]>}
 */
async function getAllStorageIds() {
  const index = await _getSearchIndex();
  return Object.keys(index);
}

// Ensure these functions are available globally in whichever context this script is loaded.
if (typeof window !== 'undefined') {
  window.putChatContent = putChatContent;
  window.getChatContent = getChatContent;
  window.getAllChatContentForAccount = getAllChatContentForAccount;
  window.deleteChatContentForAccount = deleteChatContentForAccount;
  window.getAllIndexedEntries = getAllIndexedEntries;
  window.getAllStorageIds = getAllStorageIds;
}
