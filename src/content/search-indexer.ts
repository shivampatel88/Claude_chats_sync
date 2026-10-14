import type { ChatContentRecord } from '../shared/search-storage';

// ─── Structured debug logging ──────────────────────────────────────
const PREFIX = '[CCT-Search]';
const cctLog = (...args: unknown[]): void => console.log(PREFIX, ...args);
const cctWarn = (...args: unknown[]): void => console.warn(PREFIX, ...args);

// ─── Types ──────────────────────────────────────────────────────────

interface RecentChat {
  chatId: string;
  apiTitle: string | null;
  updatedAt: number | null;
}

interface QueueState {
  accountId: string;
  orgId: string;
  pendingChatIds: string[];
  doneChatIds: string[];
  failedChatIds: string[];
  status: 'idle' | 'running' | 'paused-ratelimited' | 'paused-tab-hidden' | 'complete';
  pausedAt: number | null;
  startedAt: number;
  // chatId → serverUpdatedAt, fetched once in indexAccount() and stored here
  // so processNext() never needs to call fetchRecentChats() per chat.
  updatedAtMap: Record<string, number>;
  // Phase B: embedding error flag (no API key stored in persisted state)
  embeddingError: 'invalid-key' | 'rate-limited' | null;
  rateLimitCooldownMs?: number;
  retryCounts?: Record<string, number>;
}

interface CctInternal {
  fetchRecentChats?: () => Promise<RecentChat[] | null>;
  fetchOrganizationId?: () => Promise<string | null>;
  queue?: IndexingQueue;
  indexAccount?: (accountId: string, orgId: string, apiKey?: string | null) => Promise<void>;
}

declare global {
  interface Window {
    __cctInternal?: CctInternal;
    putChatContent?: (record: ChatContentRecord) => Promise<void>;
    getChatContent?: (storageId: string) => Promise<ChatContentRecord | null>;
    getAllIndexedEntries?: () => Promise<Record<string, ChatContentRecord>>;
    getAllChatContentForAccount?: (accountId: string) => Promise<ChatContentRecord[]>;
    deleteChatContentForAccount?: (accountId: string) => Promise<number>;
    // Phase B
    putEmbedding?: (storageId: string, vector: number[]) => Promise<void>;
    generateEmbedding?: (text: string, apiKey: string) => Promise<number[]>;
    getSemanticSettings?: () => Promise<{ enabled: boolean; apiKey: string; lastEmbeddedAt?: number } | null>;
    saveSemanticSettings?: (settings: { enabled: boolean; apiKey: string; lastEmbeddedAt?: number }) => Promise<void>;
    getAllEmbeddings?: () => Promise<Record<string, number[]>>;
  }
}

// ─── 1. RateLimitError ───────────────────────────────────────────────

export class RateLimitError extends Error {
  status: number;
  constructor(status: number) {
    super(`Rate limit or forbidden: ${status}`);
    this.name = 'RateLimitError';
    this.status = status;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

interface ChatMessage {
  sender: string;
  content?: ContentBlock[];
  text?: string;
}

function extractTextFromMessage(message: ChatMessage): string {
  if (typeof (message as any).text === 'string' && (message as any).text) {
    return (message as any).text;
  }
  if (typeof (message as any).content === 'string' && (message as any).content) {
    return (message as any).content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block.type === 'text' || typeof block.text === 'string')
      .map((block) => block.text || '')
      .join('\n');
  }
  return '';
}

// ─── 2. fetchChatContent ─────────────────────────────────────────────

export async function fetchChatContent(
  orgId: string,
  chatId: string,
): Promise<{ firstMessage: string; lastMessage: string } | null> {
  cctLog(`Fetching chat content for ${chatId}...`);
  try {
    const res = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations/${chatId}?tree=true&rendering_mode=messages&render_all_tools=true`,
      { credentials: 'include', headers: { Accept: 'application/json' } },
    );

    if (res.status === 403 || res.status === 429) {
      throw new RateLimitError(res.status);
    }
    if (res.status === 404) {
      cctWarn(`Chat ${chatId} not found (404)`);
      return null;
    }
    if (!res.ok) {
      cctWarn(`Chat ${chatId} returned status ${res.status}`);
      return null;
    }

    const data = await res.json() as { chat_messages?: ChatMessage[] };
    const messages = data.chat_messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }

    const firstHumanMsg = messages.find((m) => m.sender === 'human');
    const firstMsg = firstHumanMsg ?? messages[0];
    const lastMsg = messages[messages.length - 1];

    let firstText = extractTextFromMessage(firstMsg).trim();
    let lastText = extractTextFromMessage(lastMsg).trim();

    if (firstText.length > 2000) firstText = firstText.slice(0, 2000);
    if (lastText.length > 2000) lastText = lastText.slice(0, 2000);

    cctLog(`Successfully fetched chat content for ${chatId}`);
    return { firstMessage: firstText, lastMessage: lastText };
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    cctWarn(`Error fetching chat ${chatId}:`, err);
    return null;
  }
}

// ─── 3. IndexingQueue ────────────────────────────────────────────────

export class IndexingQueue {
  private readonly key = 'indexingQueue';
  private readonly delayMs = 2500;
  private readonly rateLimitPauseMs = 5 * 60 * 1000; // 5 minutes
  private processNextTimeout: ReturnType<typeof setTimeout> | null = null;
  private isProcessing = false;

  // Phase B: semantic embedding settings (loaded once at start(), never persisted)
  private semanticEnabled = false;
  private semanticApiKey: string | null = null;
  private embeddingError: 'invalid-key' | 'rate-limited' | null = null;

  private hasStorage(): boolean {
    try {
      return (
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        !!chrome.runtime.id &&
        chrome.storage &&
        !!chrome.storage.local
      );
    } catch (_) {
      return false;
    }
  }

  async loadState(): Promise<QueueState | null> {
    if (!this.hasStorage()) return null;
    try {
      const data = await chrome.storage.local.get([this.key]);
      return (data[this.key] as QueueState) ?? null;
    } catch (_) {
      return null;
    }
  }

  async saveState(state: QueueState): Promise<void> {
    if (!this.hasStorage()) return;
    try {
      await chrome.storage.local.set({ [this.key]: state });
    } catch (_) {}
  }

  async start(
    accountId: string,
    orgId: string,
    chatIds: string[],
    updatedAtMap: Record<string, number> = {},
    apiKey?: string | null,
  ): Promise<void> {
    cctLog(`Starting queue for account ${accountId} with ${chatIds.length} chats`);

    // Phase B: use the API key passed directly from the popup (avoids storage race condition).
    // If not passed, fall back to reading from storage as a safety net.
    this.semanticEnabled = false;
    this.semanticApiKey = null;
    this.embeddingError = null;

    const resolvedKey = apiKey || null;
    if (resolvedKey) {
      this.semanticEnabled = true;
      this.semanticApiKey = resolvedKey;
      cctLog(`Semantic embedding enabled for this queue run (key provided directly)`);
    } else if (window.getSemanticSettings) {
      const settings = await window.getSemanticSettings();
      if (settings && settings.enabled && settings.apiKey) {
        this.semanticEnabled = true;
        this.semanticApiKey = settings.apiKey;
        cctLog(`Semantic embedding enabled for this queue run (key from storage)`);
      }
    }

    const state: QueueState = {
      accountId,
      orgId,
      pendingChatIds: [...chatIds],
      doneChatIds: [],
      failedChatIds: [],
      status: chatIds.length > 0 ? 'running' : 'complete',
      pausedAt: null,
      startedAt: Date.now(),
      updatedAtMap,
      embeddingError: null,
    };
    await this.saveState(state);

    if (chatIds.length > 0) {
      this.resume();
    }
  }

  resume(): void {
    if (this.isProcessing) return;
    // Async check then schedule — fire-and-forget intentionally
    this._resumeAsync().catch((err) => cctWarn('resume error:', err));
  }

  private async _resumeAsync(): Promise<void> {
    const state = await this.loadState();
    if (!state) return;

    if (state.status === 'paused-ratelimited') {
      const cooldown = state.rateLimitCooldownMs ?? this.rateLimitPauseMs;
      const elapsed = Date.now() - (state.pausedAt ?? 0);
      if (elapsed < cooldown) {
        cctLog(
          `Queue is ratelimited, still in cooldown for ${Math.round((cooldown - elapsed) / 1000)}s`,
        );
        return;
      }
      cctLog(`Rate limit cooldown elapsed, resuming...`);
    }

    if (
      state.status !== 'running' &&
      state.status !== 'paused-tab-hidden' &&
      state.status !== 'paused-ratelimited'
    ) {
      return;
    }

    // Phase B: actively restore semantic settings on resume if not yet in memory
    if (!this.semanticApiKey && window.getSemanticSettings) {
      try {
        const settings = await window.getSemanticSettings();
        if (settings && settings.enabled && settings.apiKey) {
          this.semanticEnabled = true;
          this.semanticApiKey = settings.apiKey;
          this.embeddingError = null;
        }
      } catch (_) {}
    }

    state.status = 'running';
    delete state.rateLimitCooldownMs;
    await this.saveState(state);
    this._scheduleNext(0);
  }

  private _scheduleNext(delay: number): void {
    if (this.processNextTimeout !== null) {
      clearTimeout(this.processNextTimeout);
    }
    this.processNextTimeout = setTimeout(() => this.processNext(), delay);
  }

  async processNext(): Promise<void> {
    this.isProcessing = true;
    try {
      const state = await this.loadState();
      if (!state) return;

      // If the queue was paused due to rate limiting, check if the cooldown has elapsed
      if (state.status === 'paused-ratelimited') {
        const cooldown = state.rateLimitCooldownMs ?? this.rateLimitPauseMs;
        const elapsed = Date.now() - (state.pausedAt ?? 0);
        if (elapsed >= cooldown) {
          cctLog(`Rate limit cooldown of ${cooldown}ms elapsed. Resuming queue...`);
          state.status = 'running';
          delete state.rateLimitCooldownMs;
          await this.saveState(state);
        } else {
          // Still in cooldown; reschedule for remaining time
          const remaining = cooldown - elapsed;
          this._scheduleNext(remaining);
          return;
        }
      }

      if (state.status !== 'running') return;

      // Phantom-scrape & account-switch guard: abort if the active account changed mid-indexing
      const currentStorage = await chrome.storage.local.get(['currentAccountId']);
      if (currentStorage.currentAccountId && currentStorage.currentAccountId !== state.accountId) {
        cctWarn(`Active account switched (${state.accountId} -> ${currentStorage.currentAccountId}); aborting indexing queue.`);
        state.status = 'idle';
        state.pendingChatIds = [];
        await this.saveState(state);
        return;
      }

      if (document.hidden) {
        cctLog(`Tab is hidden, pausing queue...`);
        state.status = 'paused-tab-hidden';
        await this.saveState(state);
        return;
      }

      // Ensure semantic settings are active if available
      if (!this.semanticApiKey && window.getSemanticSettings) {
        try {
          const settings = await window.getSemanticSettings();
          if (settings && settings.enabled && settings.apiKey) {
            this.semanticEnabled = true;
            this.semanticApiKey = settings.apiKey;
            this.embeddingError = null;
          }
        } catch (_) {}
      }

      if (state.pendingChatIds.length === 0) {
        cctLog(`Queue complete!`);
        state.status = 'complete';
        await this.saveState(state);

        // Phase B: record completion timestamp so the popup can display
        // "last embedded N days ago" in the settings panel.
        if (this.semanticEnabled && window.getSemanticSettings && window.saveSemanticSettings) {
          try {
            const settings = await window.getSemanticSettings();
            if (settings) {
              await window.saveSemanticSettings({ ...settings, lastEmbeddedAt: Date.now() });
            }
          } catch (_) {
            // Non-fatal: missing lastEmbeddedAt is cosmetic.
          }
        }

        return;
      }

      const chatId = state.pendingChatIds.shift()!;
      const storageId = `${state.accountId}:${chatId}`;

      try {
        const content = await fetchChatContent(state.orgId, chatId);
        if (content) {
          // Look up serverUpdatedAt from the map built once in indexAccount().
          // This avoids calling fetchRecentChats() on every chat fetch cycle.
          const serverUpdatedAt = state.updatedAtMap[chatId] ?? 0;

          const { putChatContent, generateEmbedding, putEmbedding } = window;

          if (putChatContent) {
            await putChatContent({
              storageId,
              accountId: state.accountId,
              chatId,
              firstMessage: content.firstMessage,
              lastMessage: content.lastMessage,
              indexedAt: Date.now(),
              serverUpdatedAt,
            });
          } else {
            cctWarn('putChatContent not available on window');
          }
          state.doneChatIds.push(chatId);

          // ── Phase B: generate and store embedding ──────────────────
          if (
            this.semanticEnabled &&
            this.semanticApiKey &&
            this.embeddingError !== 'invalid-key' &&
            generateEmbedding &&
            putEmbedding
          ) {
            try {
              // Concatenate first + last message, capped at 2000 chars total
              const embedText = (content.firstMessage + ' ' + content.lastMessage).trim().slice(0, 2000);
              if (embedText.length > 0) {
                cctLog(`Generating embedding for ${chatId}...`);
                const vector = await generateEmbedding(embedText, this.semanticApiKey);
                if (vector && vector.length > 0) {
                  await putEmbedding(storageId, vector);
                  cctLog(`Embedding stored for ${chatId}`);
                  this.embeddingError = null;
                }
              }
            } catch (embErr: unknown) {
              const msg = embErr instanceof Error ? embErr.message : String(embErr);
              if (msg === 'INVALID_KEY') {
                cctWarn('Invalid Gemini API key — disabling embedding for this run');
                this.embeddingError = 'invalid-key';
                // Persist the error so the popup can reflect it on next status poll
                state.embeddingError = 'invalid-key';
              } else if (msg === 'RATE_LIMITED') {
                cctWarn('Gemini rate limit hit — backing off for 15s before continuing');
                // Move chatId back from doneChatIds to pendingChatIds so its embedding is retried
                state.doneChatIds.pop();
                state.pendingChatIds.unshift(chatId);
                state.status = 'paused-ratelimited';
                state.pausedAt = Date.now();
                state.rateLimitCooldownMs = 15000;
                await this.saveState(state);
                this._scheduleNext(15000);
                return;
              } else {
                cctWarn(`Embedding failed for ${chatId}:`, embErr);
                // Non-fatal: content is already indexed; embedding is best-effort
              }
            }
          }
          // ── End Phase B ────────────────────────────────────────────

        } else {
          state.failedChatIds.push(chatId);
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          state.retryCounts = state.retryCounts || {};
          const attempts = (state.retryCounts[chatId] || 0) + 1;
          state.retryCounts[chatId] = attempts;

          if (err.status === 403) {
            const liveOrgId = await window.__cctInternal?.fetchOrganizationId?.();
            if (!liveOrgId || liveOrgId !== state.orgId) {
              cctWarn(`Session orgId changed or logged out on 403; aborting queue.`);
              state.status = 'idle';
              state.pendingChatIds = [];
              await this.saveState(state);
              return;
            }
          }

          if (attempts > 3) {
            cctWarn(`Chat ${chatId} exceeded max retries (${attempts}) on status ${err.status}; marking failed.`);
            state.failedChatIds.push(chatId);
          } else {
            cctWarn(`Rate limit hit (attempt ${attempts}/3), pausing for 5 minutes...`);
            state.pendingChatIds.unshift(chatId);
            state.status = 'paused-ratelimited';
            state.pausedAt = Date.now();
            state.rateLimitCooldownMs = this.rateLimitPauseMs;
            await this.saveState(state);
            this._scheduleNext(this.rateLimitPauseMs);
            return;
          }
        } else {
          cctWarn(`Failed to process chat ${chatId}:`, err);
          state.failedChatIds.push(chatId);
        }
      }

      await this.saveState(state);

      // Schedule next item with inter-fetch delay
      this._scheduleNext(this.delayMs);
    } finally {
      this.isProcessing = false;
    }
  }

  async getProgress(): Promise<{ done: number; total: number; failed: number; status: QueueState['status'] }> {
    const state = await this.loadState();
    if (!state) return { done: 0, total: 0, failed: 0, status: 'idle' };
    return {
      done: state.doneChatIds.length,
      total: state.doneChatIds.length + state.pendingChatIds.length + state.failedChatIds.length,
      failed: state.failedChatIds.length,
      status: state.status,
    };
  }
}

// ─── 4. indexAccount ─────────────────────────────────────────────────

export async function indexAccount(accountId: string, orgId: string, apiKey?: string | null): Promise<void> {
  cctLog(`indexAccount called for account ${accountId}`);

  // Resolve API key from semantic settings if not explicitly provided
  let effectiveApiKey = apiKey;
  if (!effectiveApiKey && window.getSemanticSettings) {
    try {
      const settings = await window.getSemanticSettings();
      if (settings && settings.enabled && settings.apiKey) {
        effectiveApiKey = settings.apiKey;
      }
    } catch (_) {}
  }

  const internalBridge = window.__cctInternal ?? {};

  if (!orgId) {
    if (internalBridge.fetchOrganizationId) {
      const fetched = await internalBridge.fetchOrganizationId();
      if (fetched) orgId = fetched;
    }
    if (!orgId) {
      cctWarn(`Could not fetch orgId`);
      return;
    }
  }

  // Safety guard: determine canonical account ID for the active tab's organization.
  const expectedAccountId = `acc_org_${orgId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`;
  // Re-target to the active tab's account so indexing always proceeds for the logged-in session
  const targetAccountId = expectedAccountId;
  if (accountId !== 'all' && accountId !== expectedAccountId) {
    cctLog(`Re-targeting indexAccount from ${accountId} to active tab account ${targetAccountId}`);
  }

  if (!internalBridge.fetchRecentChats) {
    cctWarn(`fetchRecentChats not available on bridge`);
    return;
  }

  const recentChats = await internalBridge.fetchRecentChats();
  if (!recentChats) {
    cctWarn(`Could not fetch recent chats`);
    return;
  }

  let indexedRecords: ChatContentRecord[] = [];
  if (window.getAllChatContentForAccount) {
    indexedRecords = await window.getAllChatContentForAccount(targetAccountId);
  }

  const indexedMap = new Map<string, ChatContentRecord>();
  for (const record of indexedRecords) {
    indexedMap.set(record.chatId, record);
  }

  // Load existing embeddings so we can detect chats already indexed but missing embeddings
  const existingEmbeddings = window.getAllEmbeddings
    ? await window.getAllEmbeddings()
    : {};

  // Build the updatedAt map once here — passed into the queue so processNext()
  // can do a plain lookup instead of re-calling fetchRecentChats() per chat.
  const updatedAtMap: Record<string, number> = {};
  const chatIdsToProcess: string[] = [];
  for (const chat of recentChats) {
    const serverTime = chat.updatedAt ?? 0;
    updatedAtMap[chat.chatId] = serverTime;
    const existing = indexedMap.get(chat.chatId);
    const storageId = `${targetAccountId}:${chat.chatId}`;
    const hasEmbeddableContent = !existing || Boolean(((existing.firstMessage || '') + ' ' + (existing.lastMessage || '')).trim());
    const needsEmbedding = !!effectiveApiKey && !existingEmbeddings[storageId] && hasEmbeddableContent;
    const isUpToDate = existing && existing.serverUpdatedAt > 0 && existing.serverUpdatedAt === serverTime;
    if (isUpToDate && !needsEmbedding) {
      // Already indexed and up to date and embedding present (if semantic enabled)
      continue;
    }
    chatIdsToProcess.push(chat.chatId);
  }

  cctLog(`${chatIdsToProcess.length} chats need indexing out of ${recentChats.length}`);
  await queue.start(targetAccountId, orgId, chatIdsToProcess, updatedAtMap, effectiveApiKey);
}

// ─── 5. waitForBridge ────────────────────────────────────────────────

export async function waitForBridge(): Promise<void> {
  const timeoutMs = 30_000;
  const pollMs = 100;
  const deadline = Date.now() + timeoutMs;

  return new Promise<void>((resolve, reject) => {
    function check() {
      if (window.__cctInternal?.fetchRecentChats) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('waitForBridge: timed out after 30 seconds'));
        return;
      }
      setTimeout(check, pollMs);
    }
    check();
  });
}

// ─── Module init ─────────────────────────────────────────────────────

export const queue = new IndexingQueue();

// Expose on the __cctInternal bridge so content-script.js message handlers
// at lines 1951-1967 can reach queue.resume() and indexAccount().
window.__cctInternal = window.__cctInternal ?? {};
window.__cctInternal.queue = queue;
window.__cctInternal.indexAccount = indexAccount;

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    queue.loadState().then((state) => {
      if (state && state.status === 'paused-tab-hidden') {
        cctLog('Tab became visible, resuming queue...');
        queue.resume();
      }
    }).catch(() => {
      // Extension context may have been invalidated (extension reloaded while tab was open).
      // Silently ignore — the orphaned listener has nothing valid to do anyway.
    });
  }
});
