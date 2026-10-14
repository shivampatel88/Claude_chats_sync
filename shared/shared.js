"use strict";

const MAX_SYNC_CHUNK_BYTES = 7000; // 8192-byte limit with 1192-byte safety margin
const _utf8Encoder = new TextEncoder();

function utf8ByteLength(value, key = "") {
  return _utf8Encoder.encode(JSON.stringify(value)).length + _utf8Encoder.encode(key).length;
}

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
  // Use UTF-8 byte length (+ key length) to strictly match Chromium's SettingsStorageQuotaEnforcer
  const chunks = [];
  let current = [];

  for (const chat of Object.values(chats || {})) {
    const compact = compactChat(chat);
    const next = [...current, compact];
    const byteLen = utf8ByteLength(next, "syncChats_00");
    if (byteLen > MAX_SYNC_CHUNK_BYTES && current.length > 0) {
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

  // Build a reverse index: chatId → array of {storageId, accountId} from the
  // base chats.  Used below to detect real-account chatId collisions before they
  // are silently merged — the collision signature of a phantom scrape.
  const chatIdIndex = new Map();
  for (const [sid, chat] of Object.entries(merged)) {
    if (!chat || !chat.chatId) continue;
    if (!chatIdIndex.has(chat.chatId)) chatIdIndex.set(chat.chatId, []);
    chatIdIndex.get(chat.chatId).push({ sid, accountId: chat.accountId });
  }

  for (const chat of Object.values(incomingChats || {})) {
    if (!chat || !chat.storageId) continue;
    if (isAccountDeleted(chat.accountId, deletedAccounts, deletedAccountIds))
      continue;

    // ── PHANTOM-SCRAPE COLLISION DETECTOR ────────────────────────────────────
    // A chatId appearing under two different modern (acc_org_) accounts is
    // the exact signature of a phantom scrape: identity resolved to the wrong
    // account while the sidebar was showing another account's chats.
    const isLegacyAcct = (id) => typeof id !== 'string' || !id.startsWith('acc_org_');
    const existingEntries = chatIdIndex.get(chat.chatId) || [];
    const realCollisions = existingEntries.filter(
      (e) =>
        e.sid !== chat.storageId &&
        !isLegacyAcct(e.accountId) &&
        !isLegacyAcct(chat.accountId),
    );
    if (realCollisions.length > 0) {
      const collisionInfo = {
        chatId:   chat.chatId,
        title:    chat.title,
        incoming: { sid: chat.storageId, accountId: chat.accountId },
        existing: realCollisions,
      };
      // Always log to console for dev visibility.
      console.warn('[CCT-MERGE] ⚠️ real-account chatId collision (phantom-scrape signature):', collisionInfo);
      // Also push to the persistent diag buffer (if loaded).
      if (typeof window !== 'undefined' && window.cctDiag) {
        window.cctDiag.push('chatId-collision', {
          chatId:   chat.chatId,
          title:    chat.title,
          incoming: chat.accountId,
          existing: realCollisions.map((e) => e.accountId),
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // If incoming chat belongs to a modern acc_org_ account, remove any legacy pre-org duplicate from merged
    if (!isLegacyAcct(chat.accountId)) {
      for (const e of existingEntries) {
        if (e.sid !== chat.storageId && isLegacyAcct(e.accountId)) {
          delete merged[e.sid];
        }
      }
    }

    merged[chat.storageId] = mergeChatRecords(merged[chat.storageId], chat);

    // Keep the reverse index current for entries added during this loop pass.
    if (!chatIdIndex.has(chat.chatId)) chatIdIndex.set(chat.chatId, []);
    if (!chatIdIndex.get(chat.chatId).find((e) => e.sid === chat.storageId)) {
      chatIdIndex.get(chat.chatId).push({ sid: chat.storageId, accountId: chat.accountId });
    }
  }

  for (const chat of Object.values(merged)) {
    if (isAccountDeleted(chat.accountId, deletedAccounts, deletedAccountIds)) {
      delete merged[chat.storageId];
    }
  }

  // NOTE: we intentionally do NOT deduplicate by chatId across accounts here.
  //
  // Rationale:
  //   - The same chatId appearing under two different accountIds is a valid state.
  //     Claude's chatId (UUID) is scoped to an org, not globally unique across the
  //     entire system — two separate orgs can independently generate the same UUID.
  //   - A "same storageId appearing twice" scenario is impossible by construction:
  //     storageId = accountId + ":" + chatId, so if both components match, the two
  //     entries are literally the same object and the merge keying by storageId has
  //     already collapsed them.
  //   - Cross-account chatId dedup in this layer was previously added as Fix 2 under
  //     the (incorrect) assumption that two emails mapped to the same Claude account.
  //     That assumption was disproved. The fix has been reverted to prevent silent
  //     data loss for legitimate cross-account chatId coincidences.
  //   - The display layer (visibleChats in popup.js) handles the transient overlap
  //     created by the fallback→real migration window by suppressing entries whose
  //     accountId starts with "acc_pfl_" when a real-account entry for the same
  //     chatId already exists.
  //   - Real-account collisions ARE logged and pushed to the diag buffer above
  //     (they are never silently swallowed).

  return merged;
}
