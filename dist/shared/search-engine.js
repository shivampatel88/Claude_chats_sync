"use strict";
(() => {
  async function buildSearchIndex() {
    const entries = await window.getAllIndexedEntries();
    const index = new MiniSearch({
      fields: ["firstMessage", "lastMessage"],
      storeFields: ["storageId", "accountId", "chatId", "firstMessage", "lastMessage"],
      idField: "storageId"
    });
    const records = Object.entries(entries).map(([storageId, record]) => {
      if (record && typeof record === "object") {
        if (!record.storageId) {
          return { ...record, storageId };
        }
        return record;
      }
      return null;
    }).filter((r) => r !== null && typeof r === "object" && r.storageId);
    if (records.length > 0) {
      index.addAll(records);
    }
    return index;
  }
  function extractSnippet(record, query, queryWords) {
    const firstMessage = record.firstMessage ?? "";
    const lastMessage = record.lastMessage ?? "";
    const WINDOW = 150;
    const words = queryWords ?? query.trim().split(/\s+/).filter((w) => w.length > 0).map((w) => w.toLowerCase());
    for (const field of [firstMessage, lastMessage]) {
      const lower = field.toLowerCase();
      for (const word of words) {
        const idx = lower.indexOf(word);
        if (idx !== -1) {
          const half = Math.floor(WINDOW / 2);
          const start = Math.max(0, idx - half);
          const end = Math.min(field.length, start + WINDOW);
          const snippet = field.slice(start, end);
          return (start > 0 ? "\u2026" : "") + snippet + (end < field.length ? "\u2026" : "");
        }
      }
    }
    if (firstMessage.length <= WINDOW) return firstMessage;
    return firstMessage.slice(0, WINDOW) + "\u2026";
  }
  function searchContent(index, query) {
    if (index === null || index === void 0 || !query.trim()) {
      return [];
    }
    const results = index.search(query, {
      prefix: true,
      fuzzy: 0.2,
      boost: { firstMessage: 2 }
    });
    return results.map((result) => ({
      storageId: result.storageId,
      accountId: result.accountId,
      chatId: result.chatId,
      snippet: extractSnippet(result, query),
      score: result.score
    }));
  }
  window.buildSearchIndex = buildSearchIndex;
  window.searchContent = searchContent;
  const KEYWORD_WEIGHT = 0.3;
  const SEMANTIC_WEIGHT = 0.7;
  const SEMANTIC_ONLY_THRESHOLD = 0.6;
  const MIN_COMBINED_SCORE = 0.05;
  function cosineSimilarity(vecA, vecB) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
  async function searchContentHybrid(index, query, queryEmbedding, searchMode = "hybrid", accountId) {
    const queryWords = query.trim().split(/\s+/).filter((w) => w.length > 0).map((w) => w.toLowerCase());
    const keywordResults = searchContent(index, query);
    if (searchMode === "text" || !queryEmbedding || queryEmbedding.length === 0) {
      return keywordResults;
    }
    const rawScores = keywordResults.map((r) => r.score);
    const maxKeywordScore = Math.max(...rawScores, 1);
    const normalizedKeywordMap = /* @__PURE__ */ new Map();
    for (const r of keywordResults) {
      normalizedKeywordMap.set(r.storageId, r.score / maxKeywordScore);
    }
    const getEmbeds = accountId ? window.getAllEmbeddingsForAccount(accountId) : window.getAllEmbeddings();
    const embeddings = await getEmbeds;
    const semanticScoreMap = /* @__PURE__ */ new Map();
    for (const [storageId, vec] of Object.entries(embeddings)) {
      semanticScoreMap.set(storageId, cosineSimilarity(queryEmbedding, vec));
    }
    const entries = semanticScoreMap.size > 0 ? await window.getAllIndexedEntries() : {};
    if (searchMode === "semantic") {
      const merged2 = [];
      if (semanticScoreMap.size > 0) {
        for (const [storageId, semScore] of semanticScoreMap.entries()) {
          if (semScore >= SEMANTIC_ONLY_THRESHOLD) {
            const record = entries[storageId];
            if (!record) continue;
            merged2.push({
              storageId,
              accountId: record.accountId,
              chatId: record.chatId,
              snippet: extractSnippet(record, query, queryWords),
              score: semScore
            });
          }
        }
      }
      return merged2.sort((a, b) => b.score - a.score);
    }
    const merged = /* @__PURE__ */ new Map();
    for (const r of keywordResults) {
      merged.set(r.storageId, {
        storageId: r.storageId,
        accountId: r.accountId,
        chatId: r.chatId,
        snippet: r.snippet,
        normalizedKeyword: normalizedKeywordMap.get(r.storageId) ?? 0,
        semanticScore: semanticScoreMap.get(r.storageId) ?? 0
      });
    }
    if (semanticScoreMap.size > 0) {
      for (const [storageId, semScore] of semanticScoreMap.entries()) {
        if (merged.has(storageId)) {
          merged.get(storageId).semanticScore = semScore;
        } else if (semScore >= SEMANTIC_ONLY_THRESHOLD) {
          const record = entries[storageId];
          if (!record) continue;
          merged.set(storageId, {
            storageId,
            accountId: record.accountId,
            chatId: record.chatId,
            snippet: extractSnippet(record, query, queryWords),
            normalizedKeyword: 0,
            semanticScore: semScore
          });
        }
      }
    }
    return Array.from(merged.values()).map((r) => ({
      storageId: r.storageId,
      accountId: r.accountId,
      chatId: r.chatId,
      snippet: r.snippet,
      score: r.normalizedKeyword * KEYWORD_WEIGHT + r.semanticScore * SEMANTIC_WEIGHT,
      hasKeyword: r.normalizedKeyword > 0
    })).filter((r) => r.hasKeyword || r.score >= MIN_COMBINED_SCORE).sort((a, b) => b.score - a.score).map(({ hasKeyword: _drop, ...r }) => r);
  }
  window.searchContentHybrid = searchContentHybrid;
})();
