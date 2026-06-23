// content/search-indexer.js

function cctLog(...args) {
  console.log('[CCT-Search]', ...args);
}
function cctWarn(...args) {
  console.warn('[CCT-Search]', ...args);
}

class RateLimitError extends Error {
  constructor(status) {
    super(`Rate limit or forbidden: ${status}`);
    this.status = status;
  }
}

function extractTextFromMessage(message) {
  if (message.text) return message.text;
  if (!Array.isArray(message.content)) return '';

  return message.content.map(block => {
    if (block.type === 'text') return block.text || '';
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return block.content.map(c => (c.type === 'text' ? c.text || '' : '')).join('\n');
    }
    return '';
  }).filter(Boolean).join('\n');
}

/**
 * Fetches the full content of a chat from Claude's internal API.
 * @param {string} orgId 
 * @param {string} chatId 
 * @returns {Promise<{firstMessage: string, lastMessage: string} | null>}
 */
async function fetchChatContent(orgId, chatId) {
  cctLog(`Fetching chat content for ${chatId}...`);
  try {
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${chatId}?tree=true&rendering_mode=messages&render_all_tools=true`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });

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

    const data = await res.json();
    const messages = data.chat_messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }

    const firstHumanMsg = messages.find(m => m.sender === 'human');
    const firstMsg = firstHumanMsg || messages[0];
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

class IndexingQueue {
  constructor() {
    this.key = 'indexingQueue';
    this.delayMs = 2500;
    this.rateLimitPauseMs = 5 * 60 * 1000; // 5 minutes
    this.processNextTimeout = null;
    this.isProcessing = false;
  }

  async loadState() {
    const data = await chrome.storage.local.get([this.key]);
    return data[this.key] || null;
  }

  async saveState(state) {
    await chrome.storage.local.set({ [this.key]: state });
  }

  async start(accountId, orgId, chatIds) {
    cctLog(`Starting queue for account ${accountId} with ${chatIds.length} chats`);
    const state = {
      accountId,
      orgId,
      pendingChatIds: [...chatIds],
      doneChatIds: [],
      failedChatIds: [],
      status: chatIds.length > 0 ? 'running' : 'complete',
      pausedAt: null,
      startedAt: Date.now()
    };
    await this.saveState(state);
    
    if (chatIds.length > 0) {
      this.resume();
    }
  }

  async resume() {
    if (this.isProcessing) return;
    
    const state = await this.loadState();
    if (!state) return;
    
    if (state.status === 'paused-ratelimited') {
      const elapsed = Date.now() - (state.pausedAt || 0);
      if (elapsed < this.rateLimitPauseMs) {
        cctLog(`Queue is ratelimited, still in cooldown for ${Math.round((this.rateLimitPauseMs - elapsed)/1000)}s`);
        return;
      }
      cctLog(`Rate limit cooldown elapsed, resuming...`);
    }

    if (state.status !== 'running' && state.status !== 'paused-tab-hidden' && state.status !== 'paused-ratelimited') {
      return;
    }

    state.status = 'running';
    await this.saveState(state);
    
    this._scheduleNext(0);
  }

  _scheduleNext(delay) {
    if (this.processNextTimeout) {
      window.clearTimeout(this.processNextTimeout);
    }
    this.processNextTimeout = window.setTimeout(() => this.processNext(), delay);
  }

  async processNext() {
    this.isProcessing = true;
    try {
      let state = await this.loadState();
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

      const chatId = state.pendingChatIds.shift();
      const storageId = `${state.accountId}:${chatId}`;

      try {
        const content = await fetchChatContent(state.orgId, chatId);
        if (content) {
          // get current serverUpdatedAt from recent chats
          const { fetchRecentChats } = window.__cctInternal || {};
          let serverUpdatedAt = 0;
          if (fetchRecentChats) {
            const recentChats = await fetchRecentChats() || [];
            const chatMeta = recentChats.find(c => c.chatId === chatId);
            if (chatMeta) serverUpdatedAt = new Date(chatMeta.updatedAt).getTime();
          }

          await window.putChatContent({
            storageId,
            accountId: state.accountId,
            chatId,
            firstMessage: content.firstMessage,
            lastMessage: content.lastMessage,
            indexedAt: Date.now(),
            serverUpdatedAt
          });
          state.doneChatIds.push(chatId);
        } else {
          state.failedChatIds.push(chatId);
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          cctWarn(`Rate limit hit, pausing for 5 minutes...`);
          // Requeue the chat we failed on
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
      
      // Schedule the next one, enforcing the 2500ms delay constraint
      this._scheduleNext(this.delayMs);
      
    } finally {
      this.isProcessing = false;
    }
  }

  async getProgress() {
    const state = await this.loadState();
    if (!state) return { done: 0, total: 0, failed: 0, status: 'idle' };
    return {
      done: state.doneChatIds.length,
      total: state.doneChatIds.length + state.pendingChatIds.length + state.failedChatIds.length,
      failed: state.failedChatIds.length,
      status: state.status
    };
  }
}

const queue = new IndexingQueue();

async function indexAccount(accountId, orgId) {
  cctLog(`indexAccount called for account ${accountId}`);
  
  const internalBridge = window.__cctInternal || {};
  if (!orgId) {
    if (internalBridge.fetchOrganizationId) {
      orgId = await internalBridge.fetchOrganizationId();
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

  let indexedRecords = [];
  if (window.getAllChatContentForAccount) {
    indexedRecords = await window.getAllChatContentForAccount(accountId);
  }
  
  const indexedMap = new Map();
  for (const record of indexedRecords) {
    indexedMap.set(record.chatId, record);
  }

  const chatIdsToProcess = [];
  
  for (const chat of recentChats) {
    const serverTime = new Date(chat.updatedAt).getTime();
    const existing = indexedMap.get(chat.chatId);
    
    if (existing && existing.serverUpdatedAt === serverTime) {
      // already indexed and up to date
      continue;
    }
    chatIdsToProcess.push(chat.chatId);
  }

  await queue.start(accountId, orgId, chatIdsToProcess);
}

// Expose internal references
window.__cctInternal = window.__cctInternal || {};
window.__cctInternal.queue = queue;
window.__cctInternal.indexAccount = indexAccount;
