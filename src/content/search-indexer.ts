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
}

interface CctInternal {
  fetchRecentChats?: () => Promise<RecentChat[] | null>;
  fetchOrganizationId?: () => Promise<string | null>;
  queue?: IndexingQueue;
  indexAccount?: (accountId: string, orgId: string) => Promise<void>;
}

declare global {
  interface Window {
    __cctInternal?: CctInternal;
    putChatContent?: (record: ChatContentRecord) => Promise<void>;
    getChatContent?: (storageId: string) => Promise<ChatContentRecord | null>;
    getAllIndexedEntries?: () => Promise<Record<string, ChatContentRecord>>;
    getAllChatContentForAccount?: (accountId: string) => Promise<ChatContentRecord[]>;
    deleteChatContentForAccount?: (accountId: string) => Promise<number>;
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
  if (message.text) return message.text;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
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

  async loadState(): Promise<QueueState | null> {
    const data = await chrome.storage.local.get([this.key]);
    return (data[this.key] as QueueState) ?? null;
  }

  async saveState(state: QueueState): Promise<void> {
    await chrome.storage.local.set({ [this.key]: state });
  }

  async start(
    accountId: string,
    orgId: string,
    chatIds: string[],
    updatedAtMap: Record<string, number> = {},
  ): Promise<void> {
    cctLog(`Starting queue for account ${accountId} with ${chatIds.length} chats`);
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
      const elapsed = Date.now() - (state.pausedAt ?? 0);
      if (elapsed < this.rateLimitPauseMs) {
        cctLog(
          `Queue is ratelimited, still in cooldown for ${Math.round((this.rateLimitPauseMs - elapsed) / 1000)}s`,
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

    state.status = 'running';
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
      if (!state || state.status !== 'running') return;

      if (document.hidden) {
        cctLog(`Tab is hidden, pausing queue...`);
        state.status = 'paused-tab-hidden';
        await this.saveState(state);
        return;
      }

      if (state.pendingChatIds.length === 0) {
        cctLog(`Queue complete!`);
        state.status = 'complete';
        await this.saveState(state);
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

          await window.putChatContent!({
            storageId,
            accountId: state.accountId,
            chatId,
            firstMessage: content.firstMessage,
            lastMessage: content.lastMessage,
            indexedAt: Date.now(),
            serverUpdatedAt,
          });
          state.doneChatIds.push(chatId);
        } else {
          state.failedChatIds.push(chatId);
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          cctWarn(`Rate limit hit, pausing for 5 minutes...`);
          // Requeue the chat that failed
          state.pendingChatIds.unshift(chatId);
          state.status = 'paused-ratelimited';
          state.pausedAt = Date.now();
          await this.saveState(state);
          return;
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

export async function indexAccount(accountId: string, orgId: string): Promise<void> {
  cctLog(`indexAccount called for account ${accountId}`);

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
    indexedRecords = await window.getAllChatContentForAccount(accountId);
  }

  const indexedMap = new Map<string, ChatContentRecord>();
  for (const record of indexedRecords) {
    indexedMap.set(record.chatId, record);
  }

  // Build the updatedAt map once here — passed into the queue so processNext()
  // can do a plain lookup instead of re-calling fetchRecentChats() per chat.
  const updatedAtMap: Record<string, number> = {};
  const chatIdsToProcess: string[] = [];
  for (const chat of recentChats) {
    const serverTime = chat.updatedAt ?? 0;
    updatedAtMap[chat.chatId] = serverTime;
    const existing = indexedMap.get(chat.chatId);
    if (existing && existing.serverUpdatedAt === serverTime) {
      // Already indexed and up to date
      continue;
    }
    chatIdsToProcess.push(chat.chatId);
  }

  cctLog(`${chatIdsToProcess.length} chats need indexing out of ${recentChats.length}`);
  await queue.start(accountId, orgId, chatIdsToProcess, updatedAtMap);
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
