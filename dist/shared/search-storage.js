"use strict";
const STORAGE_KEY = "searchIndex";
export async function getAllIndexedEntries() {
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
export async function putChatContent(record) {
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
export async function getChatContent(storageId) {
  try {
    const index = await getAllIndexedEntries();
    return index[storageId] ?? null;
  } catch {
    return null;
  }
}
export async function getAllChatContentForAccount(accountId) {
  const index = await getAllIndexedEntries();
  return Object.values(index).filter((record) => record.accountId === accountId);
}
export async function deleteChatContentForAccount(accountId) {
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
