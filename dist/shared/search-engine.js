"use strict";
export async function buildSearchIndex() {
  const entries = await window.getAllIndexedEntries();
  const index = new MiniSearch({
    fields: ["firstMessage", "lastMessage"],
    storeFields: ["storageId", "accountId", "chatId", "firstMessage", "lastMessage"],
    idField: "storageId"
  });
  const records = Object.values(entries);
  if (records.length > 0) {
    index.addAll(records);
  }
  return index;
}
export function extractSnippet(record, query) {
  const firstMessage = record.firstMessage ?? "";
  const lastMessage = record.lastMessage ?? "";
  const WINDOW = 150;
  const words = query.trim().split(/\s+/).filter((w) => w.length > 0).map((w) => w.toLowerCase());
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
export function searchContent(index, query) {
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
