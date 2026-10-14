// src/shared/search-storage.ts

export interface ChatContentRecord {
  storageId: string;       // format: "accountId:chatId"
  accountId: string;
  chatId: string;
  firstMessage: string;   // max 2000 chars
  lastMessage: string;    // max 2000 chars
  indexedAt: number;      // Date.now() when indexed
  serverUpdatedAt: number; // from Claude API, used to detect staleness
}

export interface SemanticSettings {
  enabled: boolean;
  apiKey: string;           // Google AI API key (AIza...) — local only
  lastEmbeddedAt?: number;  // Date.now() after last successful embedding scan
}

const STORAGE_KEY_PREFIX = 'searchIndex_';
const EMBEDDING_KEY_PREFIX = 'embeddingIndex_';
const LEGACY_STORAGE_KEY = 'searchIndex';
const LEGACY_EMBEDDING_KEY = 'embeddingIndex';
const SEMANTIC_SETTINGS_KEY = 'semanticSettings';

// ─── READ helpers ──────────────────────────────────────────────────

export async function getAllIndexedEntries(): Promise<Record<string, ChatContentRecord>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      const all: Record<string, ChatContentRecord> = {};

      // Step 1: legacy data (fallback) – loaded first so per‑account can override
      if (items[LEGACY_STORAGE_KEY] && typeof items[LEGACY_STORAGE_KEY] === 'object') {
        Object.assign(all, items[LEGACY_STORAGE_KEY]);
      }

      // Step 2: per‑account data – takes precedence over legacy
      for (const [key, value] of Object.entries(items)) {
        if (key.startsWith(STORAGE_KEY_PREFIX) && typeof value === 'object') {
          Object.assign(all, value);
        }
      }

      resolve(all);
    });
  });
}

export async function getAllEmbeddings(): Promise<Record<string, number[]>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const all: Record<string, number[]> = {};

      // Step 1: legacy
      if (items[LEGACY_EMBEDDING_KEY] && typeof items[LEGACY_EMBEDDING_KEY] === 'object') {
        Object.assign(all, items[LEGACY_EMBEDDING_KEY]);
      }

      // Step 2: per‑account
      for (const [key, value] of Object.entries(items)) {
        if (key.startsWith(EMBEDDING_KEY_PREFIX) && typeof value === 'object') {
          Object.assign(all, value);
        }
      }

      resolve(all);
    });
  });
}

/**
 * Load embeddings for a single account only.
 * Reads only the per‑account key plus any matching legacy entries, so cosine
 * similarity in hybrid search cannot return results from other accounts.
 */
export async function getAllEmbeddingsForAccount(accountId: string): Promise<Record<string, number[]>> {
  if (!accountId || accountId === 'all') {
    return getAllEmbeddings();
  }
  const accountKey = `${EMBEDDING_KEY_PREFIX}${accountId}`;
  return new Promise((resolve) => {
    chrome.storage.local.get([accountKey, LEGACY_EMBEDDING_KEY], (items) => {
      const all: Record<string, number[]> = {};

      // Legacy entries that belong to this account (identified by storageId prefix)
      if (items[LEGACY_EMBEDDING_KEY] && typeof items[LEGACY_EMBEDDING_KEY] === 'object') {
        const prefix = `${accountId}:`;
        for (const [k, v] of Object.entries(items[LEGACY_EMBEDDING_KEY] as Record<string, number[]>)) {
          if (k.startsWith(prefix)) all[k] = v;
        }
      }

      // Per‑account key takes precedence
      if (items[accountKey] && typeof items[accountKey] === 'object') {
        Object.assign(all, items[accountKey]);
      }

      resolve(all);
    });
  });
}

// ─── WRITE helpers ─────────────────────────────────────────────────

/**
 * Write a single chat content record to its per‑account search index key.
 *
 * CONCURRENCY NOTE: callers must serialize writes for the same account.
 * The IndexingQueue.isProcessing flag does this for the background indexer.
 * If called from outside the queue, the caller is responsible for preventing
 * concurrent read-modify-write races on the same accountKey.
 */
export async function putChatContent(record: ChatContentRecord): Promise<void> {
  const accountKey = `${STORAGE_KEY_PREFIX}${record.accountId}`;
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(accountKey, (result) => {
      const index: Record<string, ChatContentRecord> =
        (result[accountKey] && typeof result[accountKey] === 'object')
          ? (result[accountKey] as Record<string, ChatContentRecord>)
          : {};
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

export async function getChatContent(storageId: string): Promise<ChatContentRecord | null> {
  try {
    const index = await getAllIndexedEntries();
    return index[storageId] ?? null;
  } catch {
    return null;
  }
}

export async function getAllChatContentForAccount(accountId: string): Promise<ChatContentRecord[]> {
  if (!accountId || accountId === 'all') {
    const all = await getAllIndexedEntries();
    return Object.values(all);
  }
  const accountKey = `${STORAGE_KEY_PREFIX}${accountId}`;
  return new Promise((resolve) => {
    chrome.storage.local.get([accountKey, LEGACY_STORAGE_KEY], (result) => {
      const index = (result[accountKey] && typeof result[accountKey] === 'object') ? result[accountKey] : {};
      const legacyIndex = (result[LEGACY_STORAGE_KEY] && typeof result[LEGACY_STORAGE_KEY] === 'object') ? result[LEGACY_STORAGE_KEY] : {};
      
      const combined = { ...legacyIndex, ...index }; // per‑account overrides legacy (same key)
      const records = Object.values(combined) as ChatContentRecord[];
      resolve(records.filter((record) => record.accountId === accountId));
    });
  });
}

// ─── DELETE helpers (with legacy cleanup) ───────────────────────────

export async function deleteChatContentForAccount(accountId: string): Promise<number> {
  // 1. Count total records (legacy + per‑account)
  const records = await getAllChatContentForAccount(accountId);
  let totalDeleted = records.length;

  // 2. Remove the per‑account key entirely
  const accountKey = `${STORAGE_KEY_PREFIX}${accountId}`;
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.remove(accountKey, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });

  // 3. Prune the account’s entries from the legacy key (if any)
  const legacy = await new Promise<Record<string, any>>((resolve) => {
    chrome.storage.local.get(LEGACY_STORAGE_KEY, (res) => resolve(res));
  });
  const legacyIndex = legacy[LEGACY_STORAGE_KEY];
  if (legacyIndex && typeof legacyIndex === 'object') {
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

export async function deleteEmbeddingsForAccount(accountId: string): Promise<void> {
  // 1. Remove the per‑account embedding key
  const accountKey = `${EMBEDDING_KEY_PREFIX}${accountId}`;
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.remove(accountKey, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });

  // 2. Prune the account’s embeddings from the legacy key
  const legacy = await new Promise<Record<string, any>>((resolve) => {
    chrome.storage.local.get(LEGACY_EMBEDDING_KEY, (res) => resolve(res));
  });
  const legacyIndex = legacy[LEGACY_EMBEDDING_KEY];
  if (legacyIndex && typeof legacyIndex === 'object') {
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

// ─── ORPHAN PRUNING ─────────────────────────────────────────────────

/**
 * Remove searchIndex and embeddingIndex entries whose storageId is not in the
 * provided set of valid storageIds (i.e. chats still tracked in sync storage).
 * If an entry has a legacy account prefix but its chatId matches an existing chat,
 * the entry is migrated to the canonical modern storageId rather than destroyed.
 */
export async function pruneOrphanedIndexEntries(
  validStorageIds: Set<string>,
): Promise<{ prunedText: number; prunedEmbeddings: number }> {
  let prunedText = 0;
  let prunedEmbeddings = 0;

  return new Promise((resolve, reject) => {
    chrome.storage.local.get(null, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const updates: Record<string, any> = {};

      // Reverse lookup: chatId -> canonical valid storageId
      const chatIdToValidStorageId = new Map<string, string>();
      for (const sid of validStorageIds) {
        const parts = sid.split(':');
        if (parts.length > 1) {
          chatIdToValidStorageId.set(parts[1], sid);
        }
      }

      // Text indexes
      for (const [key, value] of Object.entries(items)) {
        if ((key.startsWith(STORAGE_KEY_PREFIX) || key === LEGACY_STORAGE_KEY) && typeof value === 'object') {
          const index = value as Record<string, ChatContentRecord>;
          let changed = false;
          const newIndex: Record<string, ChatContentRecord> = { ...(updates[key] || index) };

          for (const [k, record] of Object.entries(index)) {
            if (validStorageIds.has(k)) {
              continue;
            }
            const chatId = k.includes(':') ? k.split(':')[1] : (record as any)?.chatId || k;
            const canonicalSid = chatIdToValidStorageId.get(chatId);

            if (canonicalSid) {
              // Re-key and migrate to canonical account
              const newAcctId = canonicalSid.split(':')[0];
              const targetKey = `${STORAGE_KEY_PREFIX}${newAcctId}`;
              const targetMap = targetKey === key ? newIndex : (updates[targetKey] || { ...((items[targetKey] as Record<string, ChatContentRecord>) || {}) });
              targetMap[canonicalSid] = {
                ...record,
                storageId: canonicalSid,
                accountId: newAcctId,
              };
              if (targetKey !== key) updates[targetKey] = targetMap;
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

      // Embedding indexes
      for (const [key, value] of Object.entries(items)) {
        if ((key.startsWith(EMBEDDING_KEY_PREFIX) || key === LEGACY_EMBEDDING_KEY) && typeof value === 'object') {
          const index = value as Record<string, number[]>;
          let changed = false;
          const newIndex: Record<string, number[]> = { ...(updates[key] || index) };

          for (const [k, vector] of Object.entries(index)) {
            if (validStorageIds.has(k)) {
              continue;
            }
            const chatId = k.includes(':') ? k.split(':')[1] : k;
            const canonicalSid = chatIdToValidStorageId.get(chatId);

            if (canonicalSid) {
              // Re-key and migrate to canonical account
              const newAcctId = canonicalSid.split(':')[0];
              const targetKey = `${EMBEDDING_KEY_PREFIX}${newAcctId}`;
              const targetMap = targetKey === key ? newIndex : (updates[targetKey] || { ...((items[targetKey] as Record<string, number[]>) || {}) });
              targetMap[canonicalSid] = vector;
              if (targetKey !== key) updates[targetKey] = targetMap;
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

// ─── LEGACY MIGRATION ───────────────────────────────────────────────

/**
 * One-shot startup migration: moves entries from the flat legacy storage keys
 * (`searchIndex`, `embeddingIndex`) into their per‑account equivalents
 * (`searchIndex_<accountId>`, `embeddingIndex_<accountId>`), then deletes the
 * legacy key when it is empty.
 *
 * Idempotent: safe to call even if legacy keys are already empty or already
 * partially migrated. Per‑account data always wins on collision.
 */
export async function migrateLegacyIndexToPerAccount(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const updates: Record<string, any> = {};
      const removals: string[] = [];

      // ── Text index migration ──────────────────────────────────────
      const legacyText = items[LEGACY_STORAGE_KEY];
      if (legacyText && typeof legacyText === 'object') {
        const byAccount: Record<string, Record<string, ChatContentRecord>> = {};
        for (const [storageId, record] of Object.entries(legacyText as Record<string, ChatContentRecord>)) {
          const acctId = (record as ChatContentRecord).accountId;
          if (!acctId) continue;
          if (!byAccount[acctId]) byAccount[acctId] = {};
          byAccount[acctId][storageId] = record as ChatContentRecord;
        }
        for (const [acctId, entries] of Object.entries(byAccount)) {
          const key = `${STORAGE_KEY_PREFIX}${acctId}`;
          // Merge with existing per‑account data; existing entries win on collision
          const existing = (items[key] && typeof items[key] === 'object') ? items[key] : {};
          updates[key] = { ...entries, ...existing };
        }
        removals.push(LEGACY_STORAGE_KEY);
      }

      // ── Embedding index migration ─────────────────────────────────
      const legacyEmbed = items[LEGACY_EMBEDDING_KEY];
      if (legacyEmbed && typeof legacyEmbed === 'object') {
        const byAccount: Record<string, Record<string, number[]>> = {};
        for (const [storageId, vector] of Object.entries(legacyEmbed as Record<string, number[]>)) {
          const acctId = storageId.split(':')[0];
          if (!acctId) continue;
          if (!byAccount[acctId]) byAccount[acctId] = {};
          byAccount[acctId][storageId] = vector as number[];
        }
        for (const [acctId, entries] of Object.entries(byAccount)) {
          const key = `${EMBEDDING_KEY_PREFIX}${acctId}`;
          const existing = (items[key] && typeof items[key] === 'object') ? items[key] : {};
          updates[key] = { ...entries, ...existing };
        }
        removals.push(LEGACY_EMBEDDING_KEY);
      }

      if (Object.keys(updates).length === 0 && removals.length === 0) {
        resolve();
        return;
      }

      // Write per‑account keys first, then remove legacy keys
      chrome.storage.local.set(updates, () => {
        if (chrome.runtime.lastError) {
          // Non-fatal: migration will retry on next startup
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

// ─── EMBEDDING WRITE ────────────────────────────────────────────────

export async function putEmbedding(storageId: string, vector: number[]): Promise<void> {
  const accountId = storageId.split(':')[0];
  const accountKey = `${EMBEDDING_KEY_PREFIX}${accountId}`;
  
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(accountKey, (result) => {
      const index: Record<string, number[]> =
        (result[accountKey] && typeof result[accountKey] === 'object')
          ? (result[accountKey] as Record<string, number[]>)
          : {};
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

// ─── SEMANTIC SETTINGS ──────────────────────────────────────────────

export async function getSemanticSettings(): Promise<SemanticSettings | null> {
  const data = await chrome.storage.local.get(SEMANTIC_SETTINGS_KEY);
  return (data[SEMANTIC_SETTINGS_KEY] as SemanticSettings) ?? null;
}

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

// ─── WINDOW EXPOSURES (keep existing) ───────────────────────────────
(window as any).putChatContent = putChatContent;
(window as any).getChatContent = getChatContent;
(window as any).getAllChatContentForAccount = getAllChatContentForAccount;
(window as any).getAllIndexedEntries = getAllIndexedEntries;
(window as any).deleteChatContentForAccount = deleteChatContentForAccount;
(window as any).getAllEmbeddings = getAllEmbeddings;
(window as any).getAllEmbeddingsForAccount = getAllEmbeddingsForAccount;
(window as any).putEmbedding = putEmbedding;
(window as any).deleteEmbeddingsForAccount = deleteEmbeddingsForAccount;
(window as any).pruneOrphanedIndexEntries = pruneOrphanedIndexEntries;
(window as any).migrateLegacyIndexToPerAccount = migrateLegacyIndexToPerAccount;
(window as any).getSemanticSettings = getSemanticSettings;
(window as any).saveSemanticSettings = saveSemanticSettings;