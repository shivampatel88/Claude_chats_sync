"use strict";

const MAX_SYNC_CHUNK_BYTES = 7000; // 8192-byte limit with 1192-byte safety margin

function compactChat(chat) {
  // Truncate title to 200 chars to prevent individual chat objects from bloating chunks.
  // Claude sidebar titles are already capped visually but stored values may be longer.
  const title = (chat.title || "").slice(0, 200);
  return {
    c: chat.chatId,
    a: chat.accountId,
    t: title,
    f: chat.firstSeen,
    l: chat.lastSeen,
    o: chat.sidebarOrder,
    os: chat.orderSeenAt,
    st: chat.sectionTimestamp || undefined,
    su: chat.serverUpdatedAt || undefined,
  };
}

function expandChat(chat) {
  const chatId = chat.c;
  const accountId = chat.a;
  return {
    storageId: chat.s || `${accountId}:${chatId}`,
    chatId,
    accountId,
    title: chat.t,
    url: chat.u || `https://claude.ai/chat/${chatId}`,
    firstSeen: chat.f,
    lastSeen: chat.l,
    sidebarOrder: chat.o,
    orderSeenAt: chat.os,
    sectionTimestamp: chat.st || null,
    serverUpdatedAt: chat.su || null,
  };
}

function makeChatChunks(chats) {
  // Use JSON.stringify().length — this matches Chrome's actual byte accounting for storage.
  // TextEncoder gives UTF-8 bytes which diverges from JSON char count for non-ASCII content.
  const chunks = [];
  let current = [];

  for (const chat of Object.values(chats || {})) {
    const compact = compactChat(chat);
    const next = [...current, compact];
    const charLen = JSON.stringify(next).length;
    if (charLen > MAX_SYNC_CHUNK_BYTES && current.length > 0) {
      chunks.push(current);
      current = [compact];
    } else {
      current = next;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

function isAccountDeleted(
  accountId,
  deletedAccounts = {},
  deletedAccountIds = [],
) {
  const isLocalDeleted =
    Array.isArray(deletedAccountIds) && deletedAccountIds.includes(accountId);
  const isSyncDeleted = deletedAccounts && Boolean(deletedAccounts[accountId]);
  return Boolean(accountId && (isLocalDeleted || isSyncDeleted));
}

function mergeAccountRecords(existing = {}, incoming = {}) {
  return {
    ...existing,
    ...incoming,
    email: incoming.email || existing.email || null,
    displayName: incoming.displayName || existing.displayName || "",
    firstSeen: Math.min(
      existing.firstSeen || incoming.firstSeen || Date.now(),
      incoming.firstSeen || existing.firstSeen || Date.now(),
    ),
    lastSeen: Math.max(existing.lastSeen || 0, incoming.lastSeen || 0),
  };
}

function mergeAccounts(
  baseAccounts = {},
  incomingAccounts = {},
  deletedAccounts = {},
  deletedAccountIds = [],
) {
  const merged = { ...baseAccounts };
  for (const account of Object.values(incomingAccounts || {})) {
    if (!account || !account.accountId) continue;
    if (isAccountDeleted(account.accountId, deletedAccounts, deletedAccountIds))
      continue;

    const existing = merged[account.accountId] || {};
    merged[account.accountId] = mergeAccountRecords(existing, account);
  }
  for (const accId of Object.keys(merged)) {
    if (isAccountDeleted(accId, deletedAccounts, deletedAccountIds)) {
      delete merged[accId];
    }
  }
  return merged;
}

function mergeChatRecords(existing = {}, incoming = {}) {
  const incomingIsNewer = (incoming.lastSeen || 0) >= (existing.lastSeen || 0);
  const winner = incomingIsNewer ? incoming : existing;
  const loser = incomingIsNewer ? existing : incoming;
  return {
    ...loser,
    ...winner,
    firstSeen: Math.min(
      existing.firstSeen || incoming.firstSeen || Date.now(),
      incoming.firstSeen || existing.firstSeen || Date.now(),
    ),
    lastSeen: Math.max(existing.lastSeen || 0, incoming.lastSeen || 0),
    sectionTimestamp: winner.sectionTimestamp || loser.sectionTimestamp || null,
  };
}

function mergeChats(
  baseChats = {},
  incomingChats = {},
  deletedAccounts = {},
  deletedAccountIds = [],
) {
  const merged = { ...baseChats };
  for (const chat of Object.values(incomingChats || {})) {
    if (!chat || !chat.storageId) continue;
    if (isAccountDeleted(chat.accountId, deletedAccounts, deletedAccountIds))
      continue;

    merged[chat.storageId] = mergeChatRecords(merged[chat.storageId], chat);
  }
  for (const chat of Object.values(merged)) {
    if (isAccountDeleted(chat.accountId, deletedAccounts, deletedAccountIds)) {
      delete merged[chat.storageId];
    }
  }
  return merged;
}
