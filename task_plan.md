# Task Plan: Multi-Session Cookie Vault & Background Account Sync

## Goal
Enable users to sync conversations and switch between multiple Claude accounts seamlessly from a single Chrome profile, without needing to manually re-authenticate via Google OAuth every time or interrupt the active session.

## Architecture
1. **Session Vault Module (`shared/session-vault.js`)**:
   - `captureCurrentSession(accountId, email)`: Extracts and serializes authentication cookies (`sessionKey`, `lastActiveOrg`, etc.) for `claude.ai` and `anthropic.com` into `chrome.storage.local.sessionVault`.
   - `restoreSession(accountId)`: Atomically wipes active session cookies and injects saved cookies via `chrome.cookies.set()`.
   - `hasSavedSession(accountId)`: Checks whether valid session cookies exist for an account.
   - `removeSavedSession(accountId)`: Purges stored session tokens when an account is deleted.
2. **Background Transient Sync Engine (`background/background.js`)**:
   - Handles `VAULT_SYNC_ACCOUNT`:
     - Snapshots current active account session.
     - Temporarily injects target account's saved cookies (< 500ms).
     - Fetches `https://claude.ai/api/organizations/<orgId>/chat_conversations?limit=100`.
     - Automatically merges and saves new chats to `chrome.storage.local` and `sync`.
     - Guarantees restoration of the original active account's cookies in a strict `try...finally` block.
3. **Instant Account Switch in Popup (`popup/popup.js`)**:
   - When user clicks a chat from Account B or switches accounts:
     - If Account B has a saved session in the vault, snapshot current session, restore Account B's cookies, and navigate directly to the chat without OAuth redirect.
     - Fallback to OAuth `login_hint` if no vault session exists yet.
4. **Passive Auto-Capture in Content Script (`content/content-script.js`)**:
   - When `content-script.js` confirms the user's `accountId` and `orgId`, it signals the background service worker to save/refresh the vault session for that account.

## Phases
- [x] Phase 1: Core Session Vault Module (`shared/session-vault.js`)
  - [x] Implement cookie extraction, serialization, and deserialization.
  - [x] Implement atomic cookie restoration and clearance with `chrome.cookies`.
  - [x] Expose helpers for background worker and popup.
- [x] Phase 2: Background Service Worker Integration (`background/background.js`)
  - [x] Handle `VAULT_CAPTURE_SESSION` message.
  - [x] Handle `VAULT_RESTORE_SESSION` message.
  - [x] Implement `VAULT_SYNC_ACCOUNT` message for transient background chat synchronization.
  - [x] Handle session expiration and error reporting (e.g. 401/403).
- [x] Phase 3: Content Script Passive Capture (`content/content-script.js`)
  - [x] Signal background worker to snapshot session when active account is confirmed.
- [x] Phase 4: Popup UI & Instant Switch Integration (`popup/popup.js` & `popup/popup.html`)
  - [x] Update `openChat(chat)` to use instant vault restoration when available.
  - [x] Add "Sync Account" button / trigger in the Account Selector / Drawer.
  - [x] Visual indicator showing vault status (e.g., "Saved in vault" badge or icon).
  - [x] Expired session alert with 1-click re-authentication flow.
- [x] Phase 5: Verification & Quality Assurance
  - [x] Syntax check with `node -c`.
  - [x] Type check with `npx tsc --noEmit`.
  - [x] Production build check with `node build.js`.
  - [x] Manual verification and regression check.
