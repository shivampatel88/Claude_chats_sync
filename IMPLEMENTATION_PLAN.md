# Claude Chat Tracker - Execution-Ready Remediation Plan

**Date:** June 14, 2026  
**Current manifest version:** 0.4.4  
**Audience:** An implementation agent or developer executing one phase at a time.  
**Primary rule:** After each phase, run the listed checks, report results, and stop. Do not start the next phase until the user explicitly approves.

---

## 0. Executor Contract

Follow these rules exactly.

1. Do not combine phases.
2. Do not start a later phase to "clean up" an earlier phase.
3. Do not change behavior outside the current phase unless the phase explicitly says to.
4. Do not introduce a build system before Phase 7.
5. Do not change storage key names unless the phase explicitly says to.
6. Do not remove existing user data during a migration or fix.
7. Do not use direct `chrome.storage.sync.set()` outside `background/background.js` after Phase 2.
8. After each phase, run syntax checks and report manual checks that still need user verification.
9. If a check fails, fix only that phase's work, rerun checks, then stop again.
10. If a requested implementation detail is impossible because Chrome APIs or the current code disagree, stop and report the blocker instead of guessing.

---

## 1. Current Source Of Truth

The extension currently uses plain Manifest V3 JavaScript. There is no required bundler.

Primary files:

- `manifest.json`
- `background/background.js`
- `content/content-script.js`
- `popup/popup.js`
- `popup/popup.html`
- `popup/popup.css`
- `PROJECT_BRIEF.md`

Current storage keys:

- Local storage:
  - `accounts`
  - `chats`
  - `currentAccountId`
  - `syncStatus`
  - `pendingOpen`
  - `profileLocalId`
  - `lastKnownEmail`
  - `deletedAccountIds`
  - `starredChatIds`
  - `rescrapeRequested`
- Sync storage:
  - `syncAccounts`
  - `syncMeta`
  - `syncChats_0`, `syncChats_1`, etc.

Current compact chat sync format:

```js
{
  c: chatId,
  a: accountId,
  t: title,
  f: firstSeen,
  l: lastSeen,
  o: sidebarOrder,
  os: orderSeenAt,
  st: sectionTimestamp
}
```

Do not change this compact format until a phase explicitly says to.

---

## 2. Standard Verification Commands

Run these commands after every phase that touches JavaScript:

```powershell
node --check background/background.js
node --check content/content-script.js
node --check popup/popup.js
```

If a phase touches only documentation, JavaScript checks are optional but still safe to run.

Manual extension checks require Chrome and must be reported as either:

- `verified`
- `not run`
- `blocked: <reason>`

Do not claim manual checks passed unless they were actually performed.

---

## 3. Phase 0 - Baseline Audit

**Goal:** Confirm the current project state before editing behavior.

### Exact Steps

1. Read:
   - `manifest.json`
   - `background/background.js`
   - `content/content-script.js`
   - `popup/popup.js`
   - `popup/popup.html`
   - `popup/popup.css`
   - `PROJECT_BRIEF.md`
2. Confirm there is no required build step.
3. Confirm whether `package.json` exists.
4. Run the standard JavaScript syntax checks.
5. Do not edit files in this phase unless a syntax check reveals an already-broken file and the user explicitly approves fixing it.

### Acceptance Criteria

- Current architecture is documented in the phase report.
- Syntax checks either pass or failures are reported exactly.
- No source behavior changed.

### Stop Gate

Stop after Phase 0 and wait for approval.

---

## 4. Phase 1 - Account Identity Integrity

**Goal:** Stop chats from being assigned to the wrong account.

### Problem Summary

Current code can assign chats to a stale email identity because `detectAccountIdentity()` uses:

```js
const email = detectAccountEmail() || lastDetectedEmail;
```

Current code also migrates every fallback chat into a real account once an email appears. That can merge unrelated fallback chats into the wrong account.

### Fix 1.1 - Make DOM Email The Only Email For Current Scrapes

File: `content/content-script.js`

#### Required Edit

Change `detectAccountIdentity()` so it uses only the email currently visible in the DOM.

Required behavior:

```js
function detectAccountIdentity() {
  const email = detectAccountEmail();
  if (email) {
    return {
      email,
      displayName: accountLabelFromEmail(email)
    };
  }

  // existing display-name detection remains here
}
```

#### Required Follow-Up

In `initProfileLocalId()`, do not restore `data.lastKnownEmail` into `lastDetectedEmail`.

Required cleanup:

- Keep the `lastKnownEmail` storage key for backward compatibility.
- Do not read `lastKnownEmail` inside `detectAccountIdentity()`.
- Do not assign `data.lastKnownEmail` to `lastDetectedEmail` during initialization.

Not allowed:

- Do not use `lastKnownEmail` as an email fallback.
- Do not use `lastDetectedEmail` as an email fallback.

#### Required Observer Behavior

Use `lastDetectedEmail` only as an observer de-duplication variable.

When `setupAccountObserver()` finds a visible DOM email:

1. If it differs from `lastDetectedEmail`, update `lastDetectedEmail`.
2. Force a scrape.
3. Let the forced scrape call `detectAccountIdentity()`, which will see the email from the DOM.

### Fix 1.2 - Migrate Only Currently Visible Fallback Chats

File: `content/content-script.js`

#### Required Edit

In `saveScrape(account, chats)`, create:

```js
const currentChatIds = new Set(chats.map(chat => chat.chatId));
```

When `!account.isFallback`, migrate only fallback chats whose `chatId` is in `currentChatIds`.

Required migration logic:

1. Find fallback chats with `c.accountId === profileFallbackAccountId`.
2. Skip fallback chats whose `chatId` is not in `currentChatIds`.
3. For each migrated chat:
   - new storage ID is `${accountId}:${chat.chatId}`
   - copy existing fields
   - set `storageId` to new storage ID
   - set `accountId` to the real account ID
   - delete old fallback storage ID
4. Do not delete the fallback account immediately.
5. After saving current chats, delete the fallback account only if no chats remain with `accountId === profileFallbackAccountId`.

Not allowed:

- Do not migrate all fallback chats.
- Do not delete fallback account while fallback chats still exist.

### Fix 1.3 - Remove Title From Snapshot Identity

File: `content/content-script.js`

#### Required Edit

Change `makeSnapshot(accountId, chats, isFallback)` so `chat.title` is not part of the snapshot.

Required shape:

```js
function makeSnapshot(accountId, chats, isFallback) {
  return JSON.stringify({
    accountId,
    isFallback: Boolean(isFallback),
    chatIds: chats.map(chat => `${chat.sidebarOrder}:${chat.chatId}:${chat.sectionTimestamp || ''}`)
  });
}
```

Do not add title back in a different field.

### Phase 1 Checks

Run:

```powershell
node --check content/content-script.js
```

Manual checks:

1. Open Claude with an email visible. Confirm scraped chats use the email account ID.
2. Open Claude when email is not visible. Confirm chats use the profile fallback ID, not the last known email.
3. Create or simulate fallback chats, then expose an email. Confirm only currently visible fallback chat IDs migrate.
4. Confirm older fallback chats remain under the fallback account.

### Stop Gate

Stop after Phase 1 and wait for approval.

---

## 5. Phase 2 - Sync Correctness

**Goal:** Ensure sync writes are serialized through the background service worker and queued payloads are merged instead of dropped.

### Problem Summary

`popup/popup.js` and `content/content-script.js` can still direct-write to `chrome.storage.sync`.  
`background/background.js` discards queued writes with `syncQueue.pop()` and `syncQueue.length = 0`.

### Fix 2.1 - Add Shared Merge Helpers To Background

File: `background/background.js`

Add pure helper functions in the background file:

```js
function mergeAccountRecords(existing = {}, incoming = {}) {
  return {
    ...existing,
    ...incoming,
    email: incoming.email || existing.email || null,
    displayName: incoming.displayName || existing.displayName || '',
    firstSeen: Math.min(existing.firstSeen || incoming.firstSeen || Date.now(), incoming.firstSeen || existing.firstSeen || Date.now()),
    lastSeen: Math.max(existing.lastSeen || 0, incoming.lastSeen || 0)
  };
}

function mergeAccounts(baseAccounts = {}, incomingAccounts = {}) {
  const merged = { ...baseAccounts };
  for (const account of Object.values(incomingAccounts || {})) {
    if (!account || !account.accountId) continue;
    merged[account.accountId] = mergeAccountRecords(merged[account.accountId], account);
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
    firstSeen: Math.min(existing.firstSeen || incoming.firstSeen || Date.now(), incoming.firstSeen || existing.firstSeen || Date.now()),
    lastSeen: Math.max(existing.lastSeen || 0, incoming.lastSeen || 0),
    sectionTimestamp: winner.sectionTimestamp || loser.sectionTimestamp || null
  };
}

function mergeChats(baseChats = {}, incomingChats = {}) {
  const merged = { ...baseChats };
  for (const chat of Object.values(incomingChats || {})) {
    if (!chat || !chat.storageId) continue;
    merged[chat.storageId] = mergeChatRecords(merged[chat.storageId], chat);
  }
  return merged;
}
```

The exact formatting can differ, but the semantics must match.

### Fix 2.2 - Teach Background To Read Existing Sync Data

File: `background/background.js`

Add an `expandChat(row)` function equivalent to popup/content.

Add `readSyncedData()` inside background:

1. Read `syncAccounts` and `syncMeta`.
2. Read all `syncChats_*` chunks based on `syncMeta.chatChunkCount`.
3. Expand compact rows into full chat records.
4. Return `{ accounts, chats, meta }`.

This must not call popup or content functions.

### Fix 2.3 - Merge Queue Batch Instead Of Dropping Writes

File: `background/background.js`

Replace current `processQueue()` behavior.

Required behavior:

1. If `syncInProgress` or queue empty, return.
2. Set `syncInProgress = true`.
3. Copy all queued items into `batch`.
4. Clear `syncQueue`.
5. Read existing synced data.
6. Merge existing synced accounts/chats with every batch item.
7. Write the merged result with `doSyncWrite()`.
8. Send `{ ok: true }` to every queued request.
9. If any error happens, send `{ ok: false, error }` to every queued request.
10. Set `syncInProgress = false`.
11. If new queue items arrived while writing, call `processQueue()` again.

Not allowed:

- Do not use `syncQueue.pop()` as the only payload.
- Do not clear queued requests without responding to each sender.
- Do not drop earlier queued payloads.

### Fix 2.4 - Remove Popup Direct Sync Fallback

File: `popup/popup.js`

In `writeSyncedData(accounts, chats, previousChunkCount = 0)`:

1. Call `sendSyncToBackground(accounts, chats)`.
2. If it succeeds, return.
3. If it fails, throw the error.
4. Do not build sync chunks.
5. Do not call `syncSet`.
6. Do not call `syncRemove`.
7. Keep the `previousChunkCount` parameter to avoid changing call sites, and mark it as intentionally unused with `void previousChunkCount;`.

Expected function shape:

```js
async function writeSyncedData(accounts, chats, previousChunkCount = 0) {
  void previousChunkCount;
  await sendSyncToBackground(accounts, chats);
}
```

### Fix 2.5 - Remove Content Direct Sync Fallback

File: `content/content-script.js`

In `syncMergedData(localAccounts, localChats)`:

1. Keep reading current sync data before sending if the function already does that.
2. Merge current sync with local data.
3. Send merged result to background.
4. If background send fails, store failed `syncStatus` locally.
5. Do not call content-script `writeSyncedData()` as a fallback.

After this fix, leave `content/content-script.js` `writeSyncedData()` in place only if removing it causes extra unrelated edits. If it remains, add a comment above it:

```js
// Deprecated after Phase 2: sync writes must go through the background service worker.
```

No code path may call it after Phase 2.

### Phase 2 Checks

Run:

```powershell
node --check background/background.js
node --check content/content-script.js
node --check popup/popup.js
```

Manual checks:

1. Open popup and Claude tab at the same time.
2. Trigger a scrape and a popup write close together.
3. Confirm sync status becomes `Synced`.
4. Confirm no console error says a message port closed without response.
5. Confirm sync chunks contain data from both payloads when payloads differ.

### Stop Gate

Stop after Phase 2 and wait for approval.

---

## 6. Phase 3 - Synced Tombstones For Deleted Accounts

**Goal:** Deleted accounts must not reappear from sync or from open Claude tabs.

### New Sync Key

Add this key to `SYNC_KEYS` in every file that reads or writes sync metadata:

```js
deletedAccounts: 'syncDeletedAccounts'
```

Files:

- `background/background.js`
- `content/content-script.js`
- `popup/popup.js`

### Tombstone Shape

Use this exact shape:

```js
{
  [accountId]: {
    accountId,
    deletedAt,
    deletedByProfileId
  }
}
```

Set `deletedByProfileId` to the local `profileLocalId` value. If `profileLocalId` cannot be read, set it to `'unknown'`.

### Fix 3.1 - Read Tombstones From Sync

Files:

- `popup/popup.js`
- `content/content-script.js`
- `background/background.js`

Wherever `readSyncedData()` exists, also read `SYNC_KEYS.deletedAccounts` and return:

```js
{
  accounts,
  chats,
  meta,
  deletedAccounts
}
```

Default `deletedAccounts` to `{}`.

### Fix 3.2 - Filter Tombstoned Accounts And Chats During Merge

Files:

- `popup/popup.js`
- `content/content-script.js`
- `background/background.js`

Add a helper:

```js
function isAccountDeleted(accountId, deletedAccounts = {}) {
  return Boolean(accountId && deletedAccounts[accountId]);
}
```

Required behavior:

1. `mergeAccounts()` must skip incoming accounts whose `accountId` is tombstoned.
2. `mergeChats()` must skip incoming chats whose `accountId` is tombstoned.
3. Before writing sync, remove accounts and chats whose account ID is tombstoned.

### Fix 3.3 - Popup Delete Writes Tombstone First

File: `popup/popup.js`

In the delete-account handler:

1. Read synced data.
2. Create a tombstone for the account.
3. Merge it with existing synced tombstones.
4. Remove the account from synced accounts.
5. Remove that account's chats from synced chats.
6. Send the pruned data plus tombstones through background.
7. Remove the account and chats locally.
8. Store local `deletedAccountIds` as a compatibility cache.

If the sync tombstone write fails:

1. Still store local tombstone compatibility cache.
2. Still remove locally after confirmation.
3. Set `syncStatus.ok = false`.
4. Report that cross-profile deletion will not be guaranteed until sync succeeds.

### Fix 3.4 - Content Script Must Not Resurrect Tombstoned Accounts

File: `content/content-script.js`

Before `saveScrape()` writes an account:

1. Read local `deletedAccountIds`.
2. Read sync tombstones if sync API is available.
3. If current `account.accountId` is tombstoned:
   - do not save the account
   - do not save its chats
   - set local `syncStatus` with a clear message
   - return from `runFullScrape()` or `saveScrape()`

Use this exact message:

```js
'Current Claude account was deleted from tracker; scrape skipped'
```

### Fix 3.5 - Tombstone Retention

Use retention constant:

```js
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
```

Garbage collect tombstones only when both are true:

1. `Date.now() - deletedAt > TOMBSTONE_RETENTION_MS`
2. No synced account or synced chat exists for that account ID

Do not delete fresh tombstones.

### Phase 3 Checks

Run:

```powershell
node --check background/background.js
node --check content/content-script.js
node --check popup/popup.js
```

Manual checks:

1. Delete an account.
2. Reopen popup. Confirm account stays deleted.
3. Manually simulate sync containing that account again. Confirm popup filters it.
4. Keep Claude tab open under deleted account and trigger scrape. Confirm it does not re-add the account.
5. Confirm `syncDeletedAccounts` exists in sync storage after delete.

### Stop Gate

Stop after Phase 3 and wait for approval.

---

## 7. Phase 4 - Reopen And Login Flow Safety

**Goal:** Make account-switch opening explicit and less destructive.

### Fix 4.1 - Remove Automatic Google Click

File: `content/content-script.js`

Required behavior:

1. `handlePendingOpen()` may show a toast.
2. `handlePendingOpen()` must not call a function that clicks Google automatically.
3. The Google button may be clicked only inside the toast `Start login` button event handler.

Implementation:

1. Remove or disable the call to `startGoogleLoginIfAvailable(pendingOpen)` from `handlePendingOpen()`.
2. Keep `findGoogleSignInElement()`.
3. Keep manual click logic inside the existing `openButton.addEventListener('click', ...)`.
4. If keeping `startGoogleLoginIfAvailable()` for future use, ensure it is not called automatically.

### Fix 4.2 - Shorten Pending Open TTL

File: `content/content-script.js`

Change:

```js
const PENDING_OPEN_TTL_MS = 15 * 60 * 1000;
```

to:

```js
const PENDING_OPEN_TTL_MS = 60 * 1000;
```

### Fix 4.3 - Make Google Button Detection Less Brittle

File: `content/content-script.js`

Required matching rules:

1. If `aria-label` contains `google`, match it.
2. If a child image `alt` or `src` contains `google`, match it only when the element is a button/link/role button.
3. If only visible text contains `google`, also require one action word:
   - `continue`
   - `sign`
   - `log`
4. Never match a button that has no Google reference.

### Fix 4.4 - Confirm Before Cookie Clearing

File: `popup/popup.js`

In `openChat(chat)`, before `clearClaudeSession()`:

1. Show a confirmation with:
   - target account name
   - current account name
   - warning that Claude/Anthropic session cookies will be cleared
2. If user cancels, return without writing `pendingOpen`, clearing cookies, or opening login.
3. If user confirms, continue with existing pending-open flow.

Use `confirm()` in this phase. Do not build a custom modal in this phase.

### Fix 4.5 - Permission Documentation

File: `PROJECT_BRIEF.md`

Add a short section explaining:

1. The extension uses `cookies` permission only for account-switch reopen flow.
2. Cookie clearing happens only after user confirmation.
3. It affects Claude/Anthropic session cookies and can log out other Claude tabs.

Do not change `manifest.json` host permissions in this phase. Permission narrowing is deferred until cookie behavior is manually verified.

### Phase 4 Checks

Run:

```powershell
node --check content/content-script.js
node --check popup/popup.js
```

Manual checks:

1. Click a chat from a different account.
2. Confirm warning appears before cookie clearing.
3. Cancel warning. Confirm no login tab opens.
4. Confirm warning and continue. Confirm login tab opens.
5. Confirm Google is not clicked automatically.
6. Press `Start login`. Confirm Google button is clicked only then.
7. Wait more than 60 seconds after pending flow starts. Confirm stale login does not continue.

### Stop Gate

Stop after Phase 4 and wait for approval.

---

## 8. Phase 5 - Title, Sorting, And Migration Hygiene

**Goal:** Reduce churn and make title/date behavior safer.

### Fix 5.1 - Narrow Title Deduplication

File: `content/content-script.js`

Required behavior:

1. Apply `deduplicate()` to `aria-label`.
2. Apply `deduplicate()` to raw fallback `textContent`.
3. Do not apply `deduplicate()` to the `title` attribute.
4. Do not apply `deduplicate()` to the first visible text span.

Required `getTitleFromLink()` source order:

1. `aria-label`, deduplicated
2. `title` attribute, not deduplicated
3. first visible `span:not([aria-hidden])`, not deduplicated
4. raw `textContent`, deduplicated

### Fix 5.2 - Version Doubled Title Migration

File: `content/content-script.js`

Add constant:

```js
const MIGRATION_DOUBLED_TITLES_V1 = 'migration_doubledTitles_v1';
```

In `initProfileLocalId()`:

1. Read `MIGRATION_DOUBLED_TITLES_V1`.
2. If true, skip `migrateDoubledTitles()`.
3. If absent, run `migrateDoubledTitles()`.
4. After migration completes without throwing, set `{ [MIGRATION_DOUBLED_TITLES_V1]: true }`.

Do not run migration on every page load after the flag is set.

### Fix 5.3 - Parse Month Buckets Explicitly

File: `content/content-script.js`

Replace `new Date(label)` month parsing in `bucketToTimestamp(label)`.

Required behavior:

1. Support labels like `january 2026`.
2. Support labels like `january`.
3. If year is missing, use current year.
4. Return timestamp for the first day of that month at local midnight.
5. Return `null` for unrecognized labels.

Use an explicit month map. Do not depend on `new Date(label)`.

### Fix 5.4 - Improve Same-Bucket Sorting Tie-Breakers

File: `popup/popup.js`

Keep current priority:

1. Starred chats first.
2. Same account with fresh sidebar order uses sidebar order.
3. Newer bucket/time first.

Change tie-breaker after same bucket/time:

1. If same account and both have fresh sidebar order, use sidebar order.
2. Then compare `lastSeen` descending.
3. Then title ascending.

Do not make `lastSeen` the primary signal over `sectionTimestamp`.

### Fix 5.5 - Make Sync Pruning Background-Owned And Visible

Files:

- `background/background.js`
- `popup/popup.js`
- `content/content-script.js`

After Phase 2, all sync writes go through `background/background.js`. Therefore sync quota pruning must also happen in the background worker.

#### Required Background Behavior

In `background/background.js`, before `doSyncWrite()` writes chunks:

1. Check sync bytes with `chrome.storage.sync.getBytesInUse(null)`.
2. If usage is at or below 85 percent, write all chats.
3. If usage is above 85 percent:
   - keep only chats with `lastSeen` newer than 90 days
   - do not modify local storage
   - do not delete old chats from the payload object outside this write
   - return prune metadata to the message sender

Use this return shape from the background message response:

```js
{
  ok: true,
  prunedCount,
  cutoffDays: 90
}
```

When no pruning happened, use:

```js
{
  ok: true,
  prunedCount: 0,
  cutoffDays: 90
}
```

#### Required Popup Behavior

In `popup/popup.js`, update `sendSyncToBackground()` so it resolves with the full response object, not just `undefined`.

In `persistData()`:

1. Capture the response from `writeSyncedData()`.
2. If `response.prunedCount > 0`, set `syncStatus.message` to:

```js
`Synced; ${response.prunedCount} older chats skipped from sync`
```

3. If no pruning happened, keep the existing `Synced` message.

#### Required Content Script Behavior

In `content/content-script.js`, when background sync succeeds:

1. Read the response object.
2. If `response.prunedCount > 0`, store local `syncStatus.message` as:

```js
`Synced; ${response.prunedCount} older chats skipped from sync`
```

3. If no pruning happened, keep the existing `Synced` message.

#### Cleanup

Remove or stop using popup-only `checkSyncQuotaAndPrune()` after background pruning is implemented.

### Phase 5 Checks

Run:

```powershell
node --check content/content-script.js
node --check popup/popup.js
```

Manual checks:

1. Doubled title collapses.
2. Normal repeated-word title stays unchanged.
3. Migration runs once, then skips.
4. Month bucket labels produce stable timestamps.
5. Starred chats stay on top.
6. Same bucket sorting uses `lastSeen` before alphabetical.
7. Sync pruning, if triggered, does not delete local chats.

### Stop Gate

Stop after Phase 5 and wait for approval.

---

## 9. Phase 6 - Performance And Low-Risk Cleanup

**Goal:** Reduce unnecessary observer and storage work without changing core behavior.

### Fix 6.1 - Scope Account Observer

File: `content/content-script.js`

Required behavior:

1. Try these observer roots in order:
   - `document.querySelector('aside')`
   - `document.querySelector('nav')`
   - `document.querySelector('header')`
   - `document.body`
   - `document.documentElement`
2. Observe the first existing root.
3. Keep `childList: true` and `subtree: true`.
4. Do not add `characterData: true`.
5. Keep the existing throttle timer.

### Fix 6.2 - Skip No-Op Local Writes In Content Script

File: `content/content-script.js`

Add or reuse a stable stringify helper.

Before `storageSet(storagePayload)` in `saveScrape()`:

1. Compare stored `accounts` with next `accounts`.
2. Compare stored `chats` with next `existingChats`.
3. Compare stored `currentAccountId` with next account ID.
4. Compare stored `lastKnownEmail` if setting it.
5. If all are identical, skip `storageSet`.
6. Still allow sync scheduling only when data changed.

Do not change storage schema.

### Fix 6.3 - Clean Dead Popup Fallbacks

File: `popup/popup.js`

Review `createAccount()`.

Required edit:

1. Remove the `prompt()` fallback from `createAccount()`.
2. Keep account creation routed through `_showInlineEdit`.
3. If `_showInlineEdit` is unexpectedly missing, return without creating an account and set `syncStatus` or console warning with:

```js
'Account editor is unavailable'
```

Do not change account creation behavior beyond this cleanup.

### Phase 6 Checks

Run:

```powershell
node --check content/content-script.js
node --check popup/popup.js
```

Manual checks:

1. Claude sidebar changes still trigger scrape.
2. Opening account/profile UI still triggers email detection.
3. Popup search works.
4. Star works.
5. Rename works.
6. Create account works.

### Stop Gate

Stop after Phase 6 and wait for approval.

---

## 10. Phase 7 - Shared Code Refactor

**Goal:** Remove duplicated logic only after behavior is correct.

### Required Decision Before Editing

Ask the user to choose:

1. No-bundler shared script.
2. Add a build step with a bundler.
3. Skip shared-code refactor.

Do not choose automatically.

### If User Chooses No-Bundler

1. First verify Chrome can load the proposed shared helper from each target context.
2. If the helper cannot be loaded safely by popup, content, and background without a bundler, stop and report that no-bundler extraction is blocked.
3. If loading is safe, create the shared helper file.
4. Do not break content script injection.
5. Keep `manifest.json` valid.

### If User Chooses Bundler

1. Add `package.json`.
2. Add build script.
3. Bundle all entry points.
4. Update manifest to built outputs.
5. Document build command.

### Helpers Eligible For Extraction

Extract pure helpers only:

- `compactChat`
- `expandChat`
- `makeChatChunks`
- `mergeAccounts`
- `mergeChats`
- tombstone filters
- stable stringify

Do not extract Chrome API wrappers in the first refactor pass.

### Phase 7 Checks

Run:

```powershell
node --check background/background.js
node --check content/content-script.js
node --check popup/popup.js
```

If a bundler is added, also run the build command.

Manual checks:

1. Extension loads unpacked.
2. Content script runs on Claude.
3. Popup opens.
4. Background worker receives sync messages.

### Stop Gate

Stop after Phase 7 and wait for approval.

---

## 11. Phase 8 - Documentation And Release Prep

**Goal:** Align documentation and release metadata with the implemented behavior.

### Required Edits

1. Update `PROJECT_BRIEF.md` if identity, sync, or reopen behavior changed.
2. Add a README only if the user approves.
3. Document cookie permission clearly.
4. Document sync limits and pruning.
5. Update `manifest.json` version only after user approval.
6. Prepare a manual release checklist.

### Phase 8 Checks

1. Confirm documentation matches actual code.
2. Confirm manifest version was not changed without user approval.
3. Confirm permission text is accurate.

### Stop Gate

Stop after Phase 8 and wait for release approval.

---

## 12. Final Manual Acceptance Checklist

Run after the last approved implementation phase.

1. Load unpacked extension.
2. Open Claude with Account A.
3. Confirm visible chats appear under Account A when email is visible.
4. Hide or fail email detection. Confirm fallback account is used instead of stale email.
5. Open Claude with Account B.
6. Confirm Account A and Account B chats do not mix.
7. Confirm only visible fallback chats migrate when an email appears.
8. Open popup.
9. Search chats.
10. Filter by account.
11. Star and unstar a chat.
12. Rename an account.
13. Delete an account.
14. Confirm deleted account does not reappear after popup reload.
15. Confirm deleted account does not reappear from an open Claude tab scrape.
16. Trigger content scrape and popup write close together.
17. Confirm sync status settles.
18. Open same-account chat.
19. Open different-account chat.
20. Confirm cookie warning appears before logout/session clearing.
21. Confirm Google login is not clicked automatically.
22. Press `Start login` and confirm Google click happens then.
23. Confirm stale pending open expires after 60 seconds.
24. Confirm no console errors in content script, popup, or background worker.

---

## 13. Claims From Review That Do Not Require Direct Fixes

Use this section to avoid over-fixing.

1. `lastDetectedEmail` is not process-global across browser tabs. The real issue is stale email fallback within a tab/profile. Phase 1 fixes that.
2. Title in the snapshot is not by itself a duplicate record bug. It causes extra saves and combines badly with account ID changes. Phase 1 removes it from snapshot identity.
3. `deduplicate()` does not mangle short titles like `Bug bug`. It is still broader than necessary. Phase 5 narrows where it is applied.
4. `lastSeen` is an extension observation timestamp, not Claude's true activity timestamp. Do not treat it as a perfect activity signal.
5. Host permission narrowing is deferred until cookie behavior is manually verified.
