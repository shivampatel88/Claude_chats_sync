"use strict";
(() => {
  const STORAGE_KEY = "searchIndex";
  const EMBEDDING_KEY = "embeddingIndex";
  const SEMANTIC_SETTINGS_KEY = "semanticSettings";
  async function getAllIndexedEntries() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        if (chrome.runtime.lastError) {
          resolve({});
          return;
        }
        const index = result[STORAGE_KEY];
        resolve(index && typeof index === "object" ? index : {});
      });
    });
  }
  async function putChatContent(record) {
    const index = await getAllIndexedEntries();
    index[record.storageId] = record;
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: index }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
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
    const index = await getAllIndexedEntries();
    return Object.values(index).filter((record) => record.accountId === accountId);
  }
  async function deleteChatContentForAccount(accountId) {
    const index = await getAllIndexedEntries();
    const keysToDelete = Object.keys(index).filter((key) => index[key].accountId === accountId);
    for (const key of keysToDelete) {
      delete index[key];
    }
    if (keysToDelete.length > 0) {
      await new Promise((resolve, reject) => {
        chrome.storage.local.set({ [STORAGE_KEY]: index }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    }
    return keysToDelete.length;
  }
  window.putChatContent = putChatContent;
  window.getChatContent = getChatContent;
  window.getAllChatContentForAccount = getAllChatContentForAccount;
  window.getAllIndexedEntries = getAllIndexedEntries;
  window.deleteChatContentForAccount = deleteChatContentForAccount;
  window.getAllEmbeddings = getAllEmbeddings;
  async function putEmbedding(storageId, vector) {
    const data = await chrome.storage.local.get(EMBEDDING_KEY);
    const index = data[EMBEDDING_KEY] && typeof data[EMBEDDING_KEY] === "object" ? data[EMBEDDING_KEY] : {};
    index[storageId] = vector;
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [EMBEDDING_KEY]: index }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }
  async function getAllEmbeddings() {
    const data = await chrome.storage.local.get(EMBEDDING_KEY);
    return data[EMBEDDING_KEY] && typeof data[EMBEDDING_KEY] === "object" ? data[EMBEDDING_KEY] : {};
  }
  async function deleteEmbeddingsForAccount(accountId) {
    const data = await chrome.storage.local.get(EMBEDDING_KEY);
    const all = data[EMBEDDING_KEY] && typeof data[EMBEDDING_KEY] === "object" ? data[EMBEDDING_KEY] : {};
    const prefix = `${accountId}:`;
    const filtered = {};
    for (const [key, vec] of Object.entries(all)) {
      if (!key.startsWith(prefix)) filtered[key] = vec;
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [EMBEDDING_KEY]: filtered }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
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
  window.putEmbedding = putEmbedding;
  window.getAllEmbeddings = getAllEmbeddings;
  window.deleteEmbeddingsForAccount = deleteEmbeddingsForAccount;
  window.getSemanticSettings = getSemanticSettings;
  window.saveSemanticSettings = saveSemanticSettings;
})();
