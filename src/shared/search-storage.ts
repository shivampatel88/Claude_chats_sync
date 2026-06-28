export interface ChatContentRecord {
  storageId: string;       // format: "accountId:chatId"
  accountId: string;
  chatId: string;
  firstMessage: string;   // max 2000 chars
  lastMessage: string;    // max 2000 chars
  indexedAt: number;      // Date.now() when indexed
  serverUpdatedAt: number; // from Claude API, used to detect staleness
}

// ─── Phase B: Semantic Settings ──────────────────────────────────────
// Stored only in chrome.storage.local (never sync) so API keys don't roam
// across Chrome profiles / devices.

export interface SemanticSettings {
  enabled: boolean;
  apiKey: string;           // Google AI API key (AIza...) — local only
  lastEmbeddedAt?: number;  // Date.now() after last successful embedding scan
}

const STORAGE_KEY = 'searchIndex';

// Separate key for embeddings — never mixed into the content index so
// getAllIndexedEntries() stays fast and lean even with many chats embedded.
const EMBEDDING_KEY = 'embeddingIndex';

const SEMANTIC_SETTINGS_KEY = 'semanticSettings';

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
(window as any).getAllEmbeddings = getAllEmbeddings;

// ─── Phase B: Embedding Storage ──────────────────────────────────────

/** Write (or overwrite) a single 768-dim embedding vector for the given storageId. */
export async function putEmbedding(storageId: string, vector: number[]): Promise<void> {
  const data = await chrome.storage.local.get(EMBEDDING_KEY);
  const index = (data[EMBEDDING_KEY] && typeof data[EMBEDDING_KEY] === 'object' 
    ? data[EMBEDDING_KEY] 
    : {}) as Record<string, number[]>;
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

/** Load all stored embeddings. Only called when semantic search is active. */
export async function getAllEmbeddings(): Promise<Record<string, number[]>> {
  const data = await chrome.storage.local.get(EMBEDDING_KEY);
  return data[EMBEDDING_KEY] && typeof data[EMBEDDING_KEY] === 'object'
    ? (data[EMBEDDING_KEY] as Record<string, number[]>)
    : {};
}

/**
 * Delete all embeddings for a given accountId.
 * Uses the storageId prefix ("accountId:chatId") so no cross-key lookup is needed.
 */
export async function deleteEmbeddingsForAccount(accountId: string): Promise<void> {
  const data = await chrome.storage.local.get(EMBEDDING_KEY);
  const all = (data[EMBEDDING_KEY] && typeof data[EMBEDDING_KEY] === 'object' 
    ? data[EMBEDDING_KEY] 
    : {}) as Record<string, number[]>;
  const prefix = `${accountId}:`;
  const filtered: Record<string, number[]> = {};
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

// ─── Phase B: Semantic Settings Storage ──────────────────────────────

/** Read the semantic search settings (null if never saved). */
export async function getSemanticSettings(): Promise<SemanticSettings | null> {
  const data = await chrome.storage.local.get(SEMANTIC_SETTINGS_KEY);
  return (data[SEMANTIC_SETTINGS_KEY] as SemanticSettings) ?? null;
}

/** Persist semantic search settings. Always to local, never sync. */
export async function saveSemanticSettings(settings: SemanticSettings): Promise<void> {
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

// Phase B window exposures
(window as any).putEmbedding = putEmbedding;
(window as any).getAllEmbeddings = getAllEmbeddings;
(window as any).deleteEmbeddingsForAccount = deleteEmbeddingsForAccount;
(window as any).getSemanticSettings = getSemanticSettings;
(window as any).saveSemanticSettings = saveSemanticSettings;
