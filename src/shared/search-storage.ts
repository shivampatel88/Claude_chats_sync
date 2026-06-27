export interface ChatContentRecord {
  storageId: string;       // format: "accountId:chatId"
  accountId: string;
  chatId: string;
  firstMessage: string;   // max 2000 chars
  lastMessage: string;    // max 2000 chars
  indexedAt: number;      // Date.now() when indexed
  serverUpdatedAt: number; // from Claude API, used to detect staleness
}

const STORAGE_KEY = 'searchIndex';

export async function getAllIndexedEntries(): Promise<Record<string, ChatContentRecord>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      const index = result[STORAGE_KEY];
      resolve((index && typeof index === 'object' ? index : {}) as Record<string, ChatContentRecord>);
    });
  });
}

export async function putChatContent(record: ChatContentRecord): Promise<void> {
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

export async function getChatContent(storageId: string): Promise<ChatContentRecord | null> {
  try {
    const index = await getAllIndexedEntries();
    return index[storageId] ?? null;
  } catch {
    return null;
  }
}

export async function getAllChatContentForAccount(accountId: string): Promise<ChatContentRecord[]> {
  const index = await getAllIndexedEntries();
  return Object.values(index).filter((record) => record.accountId === accountId);
}

export async function deleteChatContentForAccount(accountId: string): Promise<number> {
  const index = await getAllIndexedEntries();
  const keysToDelete = Object.keys(index).filter((key) => index[key].accountId === accountId);
  for (const key of keysToDelete) {
    delete index[key];
  }
  if (keysToDelete.length > 0) {
    await new Promise<void>((resolve, reject) => {
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

// Expose on window so popup.js (plain JS) can call these functions
(window as any).putChatContent = putChatContent;
(window as any).getChatContent = getChatContent;
(window as any).getAllChatContentForAccount = getAllChatContentForAccount;
(window as any).getAllIndexedEntries = getAllIndexedEntries;
(window as any).deleteChatContentForAccount = deleteChatContentForAccount;
