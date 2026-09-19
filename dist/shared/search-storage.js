"use strict";
(() => {
  const STORAGE_KEY_PREFIX = "searchIndex_";
  const EMBEDDING_KEY_PREFIX = "embeddingIndex_";
  const LEGACY_STORAGE_KEY = "searchIndex";
  const LEGACY_EMBEDDING_KEY = "embeddingIndex";
  const SEMANTIC_SETTINGS_KEY = "semanticSettings";
  async function getAllIndexedEntries() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        if (chrome.runtime.lastError) {
          resolve({});
          return;
        }
        const all = {};
        if (items[LEGACY_STORAGE_KEY] && typeof items[LEGACY_STORAGE_KEY] === "object") {
          Object.assign(all, items[LEGACY_STORAGE_KEY]);
        }
        for (const [key, value] of Object.entries(items)) {
          if (key.startsWith(STORAGE_KEY_PREFIX) && typeof value === "object") {
            Object.assign(all, value);
          }
        }
        resolve(all);
      });
    });
  }
  async function getAllEmbeddings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        const all = {};
        if (items[LEGACY_EMBEDDING_KEY] && typeof items[LEGACY_EMBEDDING_KEY] === "object") {
          Object.assign(all, items[LEGACY_EMBEDDING_KEY]);
        }
        for (const [key, value] of Object.entries(items)) {
          if (key.startsWith(EMBEDDING_KEY_PREFIX) && typeof value === "object") {
            Object.assign(all, value);
          }
        }
        resolve(all);
      });
    });
  }
  async function getAllEmbeddingsForAccount(accountId) {
    if (!accountId || accountId === "all") {
      return getAllEmbeddings();
    }
    const accountKey = `${EMBEDDING_KEY_PREFIX}${accountId}`;
    return new Promise((resolve) => {
      chrome.storage.local.get([accountKey, LEGACY_EMBEDDING_KEY], (items) => {
        const all = {};
        if (items[LEGACY_EMBEDDING_KEY] && typeof items[LEGACY_EMBEDDING_KEY] === "object") {
          const prefix = `${accountId}:`;
          for (const [k, v] of Object.entries(items[LEGACY_EMBEDDING_KEY])) {
            if (k.startsWith(prefix)) all[k] = v;
          }
        }
        if (items[accountKey] && typeof items[accountKey] === "object") {
          Object.assign(all, items[accountKey]);
        }
        resolve(all);
      });
    });
  }
  async function putChatContent(record) {
    const accountKey = `${STORAGE_KEY_PREFIX}${record.accountId}`;
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(accountKey, (result) => {
        const index = result[accountKey] && typeof result[accountKey] === "object" ? result[accountKey] : {};
        index[record.storageId] = record;
        chrome.storage.local.set({ [accountKey]: index }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    });
  }
  async function getChatContent(storageId) {
    try {
      const index = await getAllIndexedEntries();
      return index[storageId] ?? null;
    } catch {
      return null;
    }
  }
  async function getAllChatContentForAccount(accountId) {
    if (!accountId || accountId === "all") {
      const all = await getAllIndexedEntries();
      return Object.values(all);
    }
    const accountKey = `${STORAGE_KEY_PREFIX}${accountId}`;
    return new Promise((resolve) => {
      chrome.storage.local.get([accountKey, LEGACY_STORAGE_KEY], (result) => {
        const index = result[accountKey] && typeof result[accountKey] === "object" ? result[accountKey] : {};
        const legacyIndex = result[LEGACY_STORAGE_KEY] && typeof result[LEGACY_STORAGE_KEY] === "object" ? result[LEGACY_STORAGE_KEY] : {};
        const combined = { ...legacyIndex, ...index };
        const records = Object.values(combined);
        resolve(records.filter((record) => record.accountId === accountId));
      });
    });
  }
  async function deleteChatContentForAccount(accountId) {
    const records = await getAllChatContentForAccount(accountId);
    let totalDeleted = records.length;
    const accountKey = `${STORAGE_KEY_PREFIX}${accountId}`;
    await new Promise((resolve, reject) => {
      chrome.storage.local.remove(accountKey, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    const legacy = await new Promise((resolve) => {
      chrome.storage.local.get(LEGACY_STORAGE_KEY, (res) => resolve(res));
    });
    const legacyIndex = legacy[LEGACY_STORAGE_KEY];
    if (legacyIndex && typeof legacyIndex === "object") {
      let legacyChanged = false;
      for (const k of Object.keys(legacyIndex)) {
        if (legacyIndex[k] && legacyIndex[k].accountId === accountId) {
          delete legacyIndex[k];
          legacyChanged = true;
        }
      }
      if (legacyChanged) {
        if (Object.keys(legacyIndex).length === 0) {
          await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
        } else {
          await chrome.storage.local.set({ [LEGACY_STORAGE_KEY]: legacyIndex });
        }
      }
    }
    return totalDeleted;
  }
  async function deleteEmbeddingsForAccount(accountId) {
    const accountKey = `${EMBEDDING_KEY_PREFIX}${accountId}`;
    await new Promise((resolve, reject) => {
      chrome.storage.local.remove(accountKey, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    const legacy = await new Promise((resolve) => {
      chrome.storage.local.get(LEGACY_EMBEDDING_KEY, (res) => resolve(res));
    });
    const legacyIndex = legacy[LEGACY_EMBEDDING_KEY];
    if (legacyIndex && typeof legacyIndex === "object") {
      const prefix = `${accountId}:`;
      let legacyChanged = false;
      for (const k of Object.keys(legacyIndex)) {
        if (k.startsWith(prefix)) {
          delete legacyIndex[k];
          legacyChanged = true;
        }
      }
      if (legacyChanged) {
        if (Object.keys(legacyIndex).length === 0) {
          await chrome.storage.local.remove(LEGACY_EMBEDDING_KEY);
        } else {
          await chrome.storage.local.set({ [LEGACY_EMBEDDING_KEY]: legacyIndex });
        }
      }
    }
  }
  async function pruneOrphanedIndexEntries(validStorageIds) {
    let prunedText = 0;
    let prunedEmbeddings = 0;
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(null, (items) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const updates = {};
        const chatIdToValidStorageId = /* @__PURE__ */ new Map();
        for (const sid of validStorageIds) {
          const parts = sid.split(":");
          if (parts.length > 1) {
            chatIdToValidStorageId.set(parts[1], sid);
          }
        }
        for (const [key, value] of Object.entries(items)) {
          if ((key.startsWith(STORAGE_KEY_PREFIX) || key === LEGACY_STORAGE_KEY) && typeof value === "object") {
            const index = value;
            let changed = false;
            const newIndex = { ...index };
            for (const [k, record] of Object.entries(index)) {
              if (validStorageIds.has(k)) {
                continue;
              }
              const chatId = k.includes(":") ? k.split(":")[1] : record?.chatId || k;
              const canonicalSid = chatIdToValidStorageId.get(chatId);
              if (canonicalSid) {
                const newAcctId = canonicalSid.split(":")[0];
                const targetKey = `${STORAGE_KEY_PREFIX}${newAcctId}`;
                if (!updates[targetKey]) {
                  updates[targetKey] = { ...items[targetKey] || {} };
                }
                updates[targetKey][canonicalSid] = {
                  ...record,
                  storageId: canonicalSid,
                  accountId: newAcctId
                };
                delete newIndex[k];
                changed = true;
              } else {
                delete newIndex[k];
                changed = true;
                prunedText++;
              }
            }
            if (changed) {
              updates[key] = newIndex;
            }
          }
        }
        for (const [key, value] of Object.entries(items)) {
          if ((key.startsWith(EMBEDDING_KEY_PREFIX) || key === LEGACY_EMBEDDING_KEY) && typeof value === "object") {
            const index = value;
            let changed = false;
            const newIndex = { ...index };
            for (const [k, vector] of Object.entries(index)) {
              if (validStorageIds.has(k)) {
                continue;
              }
              const chatId = k.includes(":") ? k.split(":")[1] : k;
              const canonicalSid = chatIdToValidStorageId.get(chatId);
              if (canonicalSid) {
                const newAcctId = canonicalSid.split(":")[0];
                const targetKey = `${EMBEDDING_KEY_PREFIX}${newAcctId}`;
                if (!updates[targetKey]) {
                  updates[targetKey] = { ...items[targetKey] || {} };
                }
                updates[targetKey][canonicalSid] = vector;
                delete newIndex[k];
                changed = true;
              } else {
                delete newIndex[k];
                changed = true;
                prunedEmbeddings++;
              }
            }
            if (changed) {
              updates[key] = newIndex;
            }
          }
        }
        if (Object.keys(updates).length > 0) {
          chrome.storage.local.set(updates, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve({ prunedText, prunedEmbeddings });
          });
        } else {
          resolve({ prunedText, prunedEmbeddings });
        }
      });
    });
  }
  async function migrateLegacyIndexToPerAccount() {
    return new Promise((resolve) => {
      chrome.storage.local.get([LEGACY_STORAGE_KEY, LEGACY_EMBEDDING_KEY], (items) => {
        const updates = {};
        const removals = [];
        const legacyText = items[LEGACY_STORAGE_KEY];
        if (legacyText && typeof legacyText === "object") {
          const byAccount = {};
          for (const [storageId, record] of Object.entries(legacyText)) {
            const acctId = record.accountId;
            if (!acctId) continue;
            if (!byAccount[acctId]) byAccount[acctId] = {};
            byAccount[acctId][storageId] = record;
          }
          for (const [acctId, entries] of Object.entries(byAccount)) {
            const key = `${STORAGE_KEY_PREFIX}${acctId}`;
            updates[key] = { ...entries, ...updates[key] ?? {} };
          }
          removals.push(LEGACY_STORAGE_KEY);
        }
        const legacyEmbed = items[LEGACY_EMBEDDING_KEY];
        if (legacyEmbed && typeof legacyEmbed === "object") {
          const byAccount = {};
          for (const [storageId, vector] of Object.entries(legacyEmbed)) {
            const acctId = storageId.split(":")[0];
            if (!acctId) continue;
            if (!byAccount[acctId]) byAccount[acctId] = {};
            byAccount[acctId][storageId] = vector;
          }
          for (const [acctId, entries] of Object.entries(byAccount)) {
            const key = `${EMBEDDING_KEY_PREFIX}${acctId}`;
            updates[key] = { ...entries, ...updates[key] ?? {} };
          }
          removals.push(LEGACY_EMBEDDING_KEY);
        }
        if (Object.keys(updates).length === 0 && removals.length === 0) {
          resolve();
          return;
        }
        chrome.storage.local.set(updates, () => {
          if (chrome.runtime.lastError) {
            resolve();
            return;
          }
          if (removals.length > 0) {
            chrome.storage.local.remove(removals, () => resolve());
          } else {
            resolve();
          }
        });
      });
    });
  }
  async function putEmbedding(storageId, vector) {
    const accountId = storageId.split(":")[0];
    const accountKey = `${EMBEDDING_KEY_PREFIX}${accountId}`;
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(accountKey, (result) => {
        const index = result[accountKey] && typeof result[accountKey] === "object" ? result[accountKey] : {};
        index[storageId] = vector;
        chrome.storage.local.set({ [accountKey]: index }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    });
  }
  async function getSemanticSettings() {
    const data = await chrome.storage.local.get(SEMANTIC_SETTINGS_KEY);
    return data[SEMANTIC_SETTINGS_KEY] ?? null;
  }
  async function saveSemanticSettings(settings) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [SEMANTIC_SETTINGS_KEY]: settings }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }
  window.putChatContent = putChatContent;
  window.getChatContent = getChatContent;
  window.getAllChatContentForAccount = getAllChatContentForAccount;
  window.getAllIndexedEntries = getAllIndexedEntries;
  window.deleteChatContentForAccount = deleteChatContentForAccount;
  window.getAllEmbeddings = getAllEmbeddings;
  window.getAllEmbeddingsForAccount = getAllEmbeddingsForAccount;
  window.putEmbedding = putEmbedding;
  window.deleteEmbeddingsForAccount = deleteEmbeddingsForAccount;
  window.pruneOrphanedIndexEntries = pruneOrphanedIndexEntries;
  window.migrateLegacyIndexToPerAccount = migrateLegacyIndexToPerAccount;
  window.getSemanticSettings = getSemanticSettings;
  window.saveSemanticSettings = saveSemanticSettings;
})();
