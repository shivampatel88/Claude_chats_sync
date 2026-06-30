# Claude Chat Tracker

A Manifest V3 Chrome extension that scrapes, indexes, and cross-profile-syncs Claude.ai conversations using hybrid BM25 + cosine-similarity search over 768-dimension Gemini embeddings — with a fully automated multi-account session switcher that injects OAuth `login_hint` via dynamic `declarativeNetRequest` rules to eliminate manual re-authentication. Ships with a zero-footprint developer mode toggled by a secret five-tap easter egg — invisible to users, fully instrumented for owner-level post-deployment debugging.

---

## The Problem

Claude gives you no search. Every conversation lives in a sidebar list you scroll through by hand. If you run multiple accounts — a personal free tier, a company workspace, a client project — those histories are siloed behind separate Chrome profiles with no way to search across them, no way to reopen a chat from another account without manually logging out and back in, and no persistent record if you clear your browser data.

Before this extension existed, the workflow was: remember which account had the conversation, switch profiles or clear cookies manually, log back in via Google, navigate back to Claude, scroll until you find it. For someone switching accounts multiple times a day, that is 3–5 minutes of friction per lookup. This extension collapses that to one click.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude.ai Tab                          │
│                                                             │
│  content-script.js          search-indexer.ts               │
│  ┌─────────────────┐        ┌──────────────────┐            │
│  │ DOM scraper      │        │ Indexing queue    │            │
│  │ SPA nav watcher  │        │ 2500ms cadence    │◄──────────┼──── Claude REST API
│  │ Session observer │        │ Rate-limit backoff│            │     (private, no key)
│  └────────┬────────┘        └────────┬─────────┘            │
└───────────┼─────────────────────────┼────────────────────────┘
            │                         │
            ▼                         ▼
     chrome.storage.local  ◄──────────┘
            │
            │  SYNC_DATA message
            ▼
┌───────────────────────────┐
│   background.js           │
│   Service Worker          │
│   ┌─────────────────────┐ │
│   │ Serializing queue   │ │──► chrome.storage.sync  (100KB cap)
│   │ DNR rule manager    │ │
│   │ Quota GC (90-day)   │ │
│   └─────────────────────┘ │
└───────────────────────────┘
            │
            │  (account switch initiated)
            ▼
┌──────────────────────────────────────┐
│  accounts.google.com OAuth page      │
│  google-account-helper.js            │
│  Auto-clicks matching account tile   │
│  or OAuth "Continue" button          │
└──────────────────────────────────────┘
            │
            ▼
┌───────────────────────────┐
│  Extension Popup          │
│  popup.js                 │
│  ┌─────────────────────┐  │
│  │ Chat dashboard      │  │──► chrome.storage.local (read)
│  │ Hybrid search UI    │  │
│  │ Cookie evictor      │  │
│  │ MiniSearch + cosine │  │
│  └─────────────────────┘  │
│  minisearch.js (vendored) │
└───────────────────────────┘
            │
            ▼
┌───────────────────────────┐
│  dev-mode.js              │
│  (loaded first, all       │
│   contexts)               │
│  ┌─────────────────────┐  │
│  │ devMode flag reader │  │
│  │ console silencer    │  │
│  │ 5-tap easter egg    │  │
│  └─────────────────────┘  │
└───────────────────────────┘
```

**`content-script.js`** — Scrapes the Claude sidebar via DOM selectors on `a[href*="/chat/"]`, intercepts `history.pushState` to detect SPA navigation without page reloads, and resolves account identity from Claude's internal org API. Runs inside every Claude tab.

**`search-indexer.ts`** — A throttled queue that fetches the first and last message of each conversation from Claude's private REST API at one request per 2500ms. Backs off for 5 minutes on `403`/`429`, pauses entirely when the tab is hidden, and persists its queue state to `chrome.storage.local` so it survives tab suspensions.

**`background.js`** — The only writer to `chrome.storage.sync`. All writes from content scripts and popup pass through a serializing in-memory queue here to prevent write-after-write races. Also owns the `declarativeNetRequest` dynamic rule for OAuth redirection and runs quota-based pruning when sync storage crosses 85% of Chrome's 100KB limit.

**`google-account-helper.js`** — Injected into `accounts.google.com/o/oauth2/*`. When an account switch triggers Google's chooser or consent screen, this script auto-clicks the right tile without user interaction.

**`popup.js`** — Offline-first dashboard reading from local storage. Orchestrates hybrid keyword + semantic search, handles the account switch initiation sequence (cookie eviction → DNR rule → tab open), and manages starred chats and account visibility filters.

**`dev-mode.js`** — Loaded first in every JS context (popup and all content scripts). Reads the `devMode` flag from `chrome.storage.local` and, when off, replaces `console.log/warn/info/debug/group/groupEnd` with no-ops for that entire context — silencing all other scripts automatically, with no per-call guards needed anywhere in the codebase. Exposes `window.CCT_DEV_MODE` and `window.cctDevToggle()` for the popup's 5-tap easter egg handler.

---

## Engineering Decisions

**Dynamic `declarativeNetRequest` for cross-domain OAuth parameter injection**

What I did: When switching to Account B, the extension registers a transient DNR redirect rule that matches `accounts.google.com/o/oauth2/*` and appends `login_hint=target@email.com` to the URL query string. The rule is removed immediately after login completes.

Why not the obvious thing: You cannot pass `login_hint` through a Claude-side redirect — Claude initiates the OAuth flow internally and Google strips unrecognized parameters before the consent screen. A content script on the Google page cannot inject it into the URL after navigation has started. DNR rules intercept at the network layer before the request leaves the browser.

The tradeoff: `declarativeNetRequest` requires declaring the permission in `manifest.json`, which Chrome Web Store flags for additional review. The rule is also applied globally to the profile for the duration of the switch — if the user opens a different Google OAuth flow simultaneously, it would also receive the hint. In practice this window is under 3 seconds; acceptable for a personal productivity tool.

---

**Exhaustive cookie domain permutation on session eviction**

What I did: Before opening the login page, the extension calls `chrome.cookies.getAll()` for each of `claude.ai`, `anthropic.com`, and `auth.anthropic.com`, then generates four URL variants per cookie (`https://host/path`, `http://host/path`, `https://www.rootdomain/path`, `http://www.rootdomain/path`) and calls `chrome.cookies.remove()` against all of them.

Why not the obvious thing: `chrome.cookies.remove({ url: "https://claude.ai", name: "..." })` silently fails if the cookie was set with a domain of `.claude.ai` or `auth.anthropic.com`. Chrome's cookie API matches on the exact scope of the stored cookie's domain attribute, not just the host. Calling remove on the wrong URL variant is a no-op with no error thrown.

The tradeoff: This fires `4 × N` remove calls where N is the total cookie count across three domains. It works because the tab is being navigated away immediately after, so the latency of parallel `Promise.all` calls does not matter. A more targeted approach would require knowing each cookie's exact domain attribute before picking the right URL — that information is available in the `cookie.domain` field, which is exactly what the permutation logic reads.

---

**Serializing sync writes through a background queue rather than writing from each context**

What I did: All `chrome.storage.sync` writes are message-passed to `background.js`, which maintains a simple in-memory array (`syncQueue`). The queue drains one batch at a time — read current sync state, merge all pending items, write once, resolve all callers.

Why not the obvious thing: Both the content script and the popup can trigger sync writes within the same second (a new chat scraped at the same time the user opens the popup). Chrome's sync storage does not have transactions. Two concurrent read-modify-write cycles will silently drop whichever write loses the race.

The tradeoff: Every sync write becomes asynchronous — the caller sends a message and waits for a response before confirming success. This adds a round-trip but eliminates an entire class of data loss bugs that would be nearly impossible to reproduce or debug in the field.

---

**768-dimension Gemini embeddings instead of the model default**

What I did: The Gemini `gemini-embedding-001` API supports an `outputDimensionality` parameter. I cap it at 768 instead of the default 3072.

Why not the obvious thing: A 3072-dimension float array serialized to JSON is roughly 55KB per chat record. `chrome.storage.local` has a default 5MB quota, and loading thousands of 55KB records into memory for cosine similarity at search time is slow regardless of quota. At 768 dimensions the same record is ~14KB — a 75% reduction — with acceptable semantic recall for this use case.

The tradeoff: Truncated dimensions lose some representation fidelity. For queries where the distinction between closely related topics matters, recall degrades. Given that users are searching their own conversations with their own vocabulary, precision matters more than exhaustive recall — the queries are short and the corpus is personal.

---

**`stableStringify` for change detection before sync writes**

What I did: Before writing updated chat records to sync storage, the extension serializes both the old and new version using a hand-rolled `stableStringify` that sorts object keys before encoding, then compares the strings.

Why not the obvious thing: `JSON.stringify` does not guarantee key ordering. Two semantically identical objects built in different orders — common when merging partial updates — produce different strings. Using `JSON.stringify` for diffing would trigger a sync write on every scrape cycle even when nothing changed, burning through Chrome's sync write quota (1800 writes per hour, per Chrome's documented limit).

The tradeoff: The hand-rolled sort adds a small amount of compute per comparison. It is negligible for the record sizes involved, and the quota savings are material — each avoided write is one fewer tick against the hourly cap.

---

**Zero-footprint developer mode via context-level console interception**

What I did: `dev-mode.js` loads before every other script in both the popup and content script contexts. It reads a `devMode` flag from `chrome.storage.local` once on startup. If the flag is not set — the default for all users — it replaces `console.log`, `console.warn`, `console.info`, `console.debug`, `console.group`, and `console.groupEnd` on the global object with no-ops. Because this runs first and mutates the global `console`, every subsequent script in that context inherits the silenced methods without any per-call guards.

Why not the obvious thing: Per-call guards (`if (DEBUG) console.log(...)`) scatter conditional logic across every file and are easy to forget. Wrapping `console` at the environment level is a single change point. The service worker (`background.js`) runs in a separate context that does not share `window` with the popup, so it gets its own inline async IIFE that reads `devMode` from storage on startup and re-assigns `bgLog`/`bgWarn` to no-ops when the flag is absent.

The easter egg: Clicking the popup title (`h1`) five times within 1.5 seconds toggles `devMode` in `chrome.storage.local`. The popup re-reads `CCT_DEV_MODE` immediately, re-applies the mode (badge, width, diagnostic button, account stats panel) without reloading, and confirms the toggle with a non-blocking in-popup toast. Since this extension is distributed as an unpacked load — not from the Chrome Web Store — there is no environment variable that distinguishes the owner's install from any other developer's install. The 5-tap gesture solves that without config files, build flags, or separate extension IDs.

The tradeoff: Replacing global `console` methods affects the entire context, including third-party vendored scripts (MiniSearch). In practice this is acceptable — those libraries are not expected to produce output in production. The replacement is also irreversible for the lifetime of that context; there is no "restore" path because no code should be calling `console` outside dev mode anyway.

---

## Tech Stack

| Technology | Role in this project | Why not X |
|---|---|---|
| Chrome Extension APIs (MV3) | Content injection, cookie management, `declarativeNetRequest`, storage, service worker | MV2 — deprecated; Chrome is actively blocking MV2 extensions from the Web Store |
| `chrome.storage.sync` | Cross-profile chat sync (accounts + recent chats, compacted to single-char keys to fit the 8192-byte per-key limit) | Firebase / custom backend — requires auth infrastructure and a server; the point of this tool is zero external dependencies |
| `chrome.storage.local` | Full chat index, embeddings, queue state, diagnostic ring buffer, `devMode` flag | IndexedDB — more capable but overkill; the record sizes and access patterns here fit key-value storage without needing cursor-based iteration |
| MiniSearch v7.2.0 (vendored) | Client-side BM25 full-text search over first/last message fields | Lunr.js — no built-in fuzzy matching; Flexsearch — different scoring model, less composable with custom ranking logic |
| Google Gemini `gemini-embedding-001` | 768-dim dense vectors for semantic search | Xenova/Transformers.js + ONNX — works offline but adds 100MB+ to the extension package, which Chrome Web Store caps at 128MB total |
| TypeScript 5.x | Type safety on the four search and embedding modules | Plain JS — the storage schemas have enough structural complexity (discriminated unions, optional fields, nested generics) that runtime type errors would be a real debugging cost |
| esbuild 0.28.1 | Compiles TS to IIFE scripts; injects `EMBEDDING_KEY` from `.env` at build time | Webpack — unnecessary overhead for a project with 4 compiled files and no module graph complexity |
| Vanilla CSS | Dark-mode popup dashboard with HSL tokens, custom scrollbars, keyframe animations | Tailwind — the popup is a fixed-size single-page panel; utility classes add more complexity than they remove at this surface area |
| `dev-mode.js` (custom) | Context-level console interception; persistent dev flag via storage; 5-tap easter egg toggle | Per-call `DEBUG` guards — scatters conditional logic across every file; environment variables — not resolvable at runtime for unpacked extensions with no build distinction between installs |

---

## Quick Start

### Option A: Load Pre-Built Release (No Setup Needed)
Since pre-compiled build artifacts are tracked and committed inside the `dist/` directory, you can run the extension immediately without setting up Node.js or compiling code:

1. **Download the source repository**: Click the green **Code** button and select **Download ZIP** (or clone the repository using Git). Extract the ZIP archive.
2. **Load into Chrome**: 
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** using the toggle switch in the top-right corner.
   - Click the **Load unpacked** button in the top-left corner.
   - Select the extracted project root directory.
3. **Launch**: Open a [Claude.ai](https://claude.ai) tab. Click the extension icon in your Chrome toolbar to open the search dashboard.
4. **Configure Semantic Search (Optional)**: Open the search settings panel inside the popup, paste your Google Gemini API key, and enable Semantic Search.

---

### Option B: Build from Source (For Custom Key Embedding)
If you prefer to modify the codebase or embed a default Gemini API key directly into the compiled package:

**Prerequisites**: Chrome 120+, Node.js 18+

1. **Clone the repository**:
   ```bash
   git clone https://github.com/yourhandle/claude-chat-sync.git
   cd claude-chat-sync
   npm install
   ```
2. **Embed a default API key** (Optional):
   ```bash
   echo "EMBEDDING_KEY=your_gemini_api_key_here" > .env
   ```
3. **Build the TypeScript modules**:
   ```bash
   npm run build
   ```
   This compiles the TypeScript files under `src/` to browser-compatible scripts in the `dist/` directory.
4. **Load into Chrome**: Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select this project directory.

---

> **Note**: If the popup shows no chats immediately after loading, refresh your active Claude.ai tab. The sidebar scraper runs after the page load reaches `document_idle`, which may occur slightly after React hydration on slower networks.

To enable semantic search with background indexing, open the settings drawer in the popup, input your API key, and toggle the mode. The background indexer runs at a 2.5-second interval to stay within rate limits.

---

## What I'd Do Next

- **Replace the `alert()` session-mismatch dialog with a non-blocking overlay.** When the phantom-scrape detector fires during indexing, it calls `alert()` in the content script, halting the main thread. The correct fix is a custom banner rendered in the extension's shadow DOM — isolated from Claude's styles and non-blocking.

- **Encrypt the Gemini API key at rest.** The key is written to `chrome.storage.local` as plain text. Chrome extension storage is readable by anyone with filesystem access to the profile directory. The right approach: derive an encryption key from a user-supplied passphrase, wrap the API key with WebCrypto `AES-GCM` before storing it, and decrypt on demand.

- **Index beyond first and last messages.** The current 2-message, 2000-char cap was chosen to fit storage quotas. A better design is progressive indexing: store a hash of the conversation's message count, and when `serverUpdatedAt` changes on a known chat, re-fetch and append the middle messages incrementally rather than replacing the full record.

- **Write tests for the merge functions.** `mergeChats`, `mergeAccounts`, and `gcTombstones` in `shared.js` are the correctness-critical core of this extension. They have complex edge cases around tombstoning, phantom-scrape detection, and fallback account handling. Right now they are validated only by reading the code. Unit tests with a few dozen fixtures covering the collision and resurrection paths would have caught two bugs found during manual testing.

- **Make the sync quota GC threshold configurable.** The 90-day cutoff is hardcoded. A daily Claude user will hit the 100KB sync cap faster than a weekly user; someone who rarely opens the popup may return to find their older chats pruned without warning. Exposing the retention window as a setting — with a plain-English explanation of the quota constraint — is more honest than a silent fixed cutoff.

- **Promote dev-mode instrumentation to a named debug protocol.** The current `cct_diag_v1` ring buffer captures identity-decision events and chatId collisions. With the easter-egg developer mode now stable, the next step is to route structured events from the indexing queue and sync layer into the same buffer — making the exported snapshot a complete operational log rather than a partial one. This would also enable automated regression detection: replay a snapshot against the merge functions and assert the output is deterministic.
