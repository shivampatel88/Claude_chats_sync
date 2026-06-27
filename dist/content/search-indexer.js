"use strict";
(() => {
  const PREFIX = "[CCT-Search]";
  const cctLog = (...args) => console.log(PREFIX, ...args);
  const cctWarn = (...args) => console.warn(PREFIX, ...args);
  class RateLimitError extends Error {
    constructor(status) {
      super(`Rate limit or forbidden: ${status}`);
      this.name = "RateLimitError";
      this.status = status;
    }
  }
  function extractTextFromMessage(message) {
    if (message.text) return message.text;
    if (!Array.isArray(message.content)) return "";
    return message.content.filter((block) => block.type === "text").map((block) => block.text || "").join("\n");
  }
  async function fetchChatContent(orgId, chatId) {
    cctLog(`Fetching chat content for ${chatId}...`);
    try {
      const res = await fetch(
        `https://claude.ai/api/organizations/${orgId}/chat_conversations/${chatId}?tree=true&rendering_mode=messages&render_all_tools=true`,
        { credentials: "include", headers: { Accept: "application/json" } }
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
      const data = await res.json();
      const messages = data.chat_messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return null;
      }
      const firstHumanMsg = messages.find((m) => m.sender === "human");
      const firstMsg = firstHumanMsg ?? messages[0];
      const lastMsg = messages[messages.length - 1];
      let firstText = extractTextFromMessage(firstMsg).trim();
      let lastText = extractTextFromMessage(lastMsg).trim();
      if (firstText.length > 2e3) firstText = firstText.slice(0, 2e3);
      if (lastText.length > 2e3) lastText = lastText.slice(0, 2e3);
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
      this.key = "indexingQueue";
      this.delayMs = 2500;
      this.rateLimitPauseMs = 5 * 60 * 1e3;
      // 5 minutes
      this.processNextTimeout = null;
      this.isProcessing = false;
    }
    async loadState() {
      const data = await chrome.storage.local.get([this.key]);
      return data[this.key] ?? null;
    }
    async saveState(state) {
      await chrome.storage.local.set({ [this.key]: state });
    }
    async start(accountId, orgId, chatIds, updatedAtMap = {}) {
      cctLog(`Starting queue for account ${accountId} with ${chatIds.length} chats`);
      const state = {
        accountId,
        orgId,
        pendingChatIds: [...chatIds],
        doneChatIds: [],
        failedChatIds: [],
        status: chatIds.length > 0 ? "running" : "complete",
        pausedAt: null,
        startedAt: Date.now(),
        updatedAtMap
      };
      await this.saveState(state);
      if (chatIds.length > 0) {
        this.resume();
      }
    }
    resume() {
      if (this.isProcessing) return;
      this._resumeAsync().catch((err) => cctWarn("resume error:", err));
    }
    async _resumeAsync() {
      const state = await this.loadState();
      if (!state) return;
      if (state.status === "paused-ratelimited") {
        const elapsed = Date.now() - (state.pausedAt ?? 0);
        if (elapsed < this.rateLimitPauseMs) {
          cctLog(
            `Queue is ratelimited, still in cooldown for ${Math.round((this.rateLimitPauseMs - elapsed) / 1e3)}s`
          );
          return;
        }
        cctLog(`Rate limit cooldown elapsed, resuming...`);
      }
      if (state.status !== "running" && state.status !== "paused-tab-hidden" && state.status !== "paused-ratelimited") {
        return;
      }
      state.status = "running";
      await this.saveState(state);
      this._scheduleNext(0);
    }
    _scheduleNext(delay) {
      if (this.processNextTimeout !== null) {
        clearTimeout(this.processNextTimeout);
      }
      this.processNextTimeout = setTimeout(() => this.processNext(), delay);
    }
    async processNext() {
      this.isProcessing = true;
      try {
        const state = await this.loadState();
        if (!state || state.status !== "running") return;
        if (document.hidden) {
          cctLog(`Tab is hidden, pausing queue...`);
          state.status = "paused-tab-hidden";
          await this.saveState(state);
          return;
        }
        if (state.pendingChatIds.length === 0) {
          cctLog(`Queue complete!`);
          state.status = "complete";
          await this.saveState(state);
          return;
        }
        const chatId = state.pendingChatIds.shift();
        const storageId = `${state.accountId}:${chatId}`;
        try {
          const content = await fetchChatContent(state.orgId, chatId);
          if (content) {
            const serverUpdatedAt = state.updatedAtMap[chatId] ?? 0;
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
            state.pendingChatIds.unshift(chatId);
            state.status = "paused-ratelimited";
            state.pausedAt = Date.now();
            await this.saveState(state);
            return;
          } else {
            cctWarn(`Failed to process chat ${chatId}:`, err);
            state.failedChatIds.push(chatId);
          }
        }
        await this.saveState(state);
        this._scheduleNext(this.delayMs);
      } finally {
        this.isProcessing = false;
      }
    }
    async getProgress() {
      const state = await this.loadState();
      if (!state) return { done: 0, total: 0, failed: 0, status: "idle" };
      return {
        done: state.doneChatIds.length,
        total: state.doneChatIds.length + state.pendingChatIds.length + state.failedChatIds.length,
        failed: state.failedChatIds.length,
        status: state.status
      };
    }
  }
  async function indexAccount(accountId, orgId) {
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
    let indexedRecords = [];
    if (window.getAllChatContentForAccount) {
      indexedRecords = await window.getAllChatContentForAccount(accountId);
    }
    const indexedMap = /* @__PURE__ */ new Map();
    for (const record of indexedRecords) {
      indexedMap.set(record.chatId, record);
    }
    const updatedAtMap = {};
    const chatIdsToProcess = [];
    for (const chat of recentChats) {
      const serverTime = chat.updatedAt ?? 0;
      updatedAtMap[chat.chatId] = serverTime;
      const existing = indexedMap.get(chat.chatId);
      if (existing && existing.serverUpdatedAt === serverTime) {
        continue;
      }
      chatIdsToProcess.push(chat.chatId);
    }
    cctLog(`${chatIdsToProcess.length} chats need indexing out of ${recentChats.length}`);
    await queue.start(accountId, orgId, chatIdsToProcess, updatedAtMap);
  }
  async function waitForBridge() {
    const timeoutMs = 3e4;
    const pollMs = 100;
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      function check() {
        if (window.__cctInternal?.fetchRecentChats) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("waitForBridge: timed out after 30 seconds"));
          return;
        }
        setTimeout(check, pollMs);
      }
      check();
    });
  }
  const queue = new IndexingQueue();
  window.__cctInternal = window.__cctInternal ?? {};
  window.__cctInternal.queue = queue;
  window.__cctInternal.indexAccount = indexAccount;
})();
