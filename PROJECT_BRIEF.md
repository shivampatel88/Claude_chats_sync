# Claude Chat Tracker Project Brief

## Purpose

Claude Chat Tracker is a Chrome extension that watches the visible Claude.ai sidebar, turns the chats shown there into structured records, and keeps those records available inside the browser. The goal is to give the user a stable, searchable memory of Claude chats across browser profiles and sessions without depending on Claude's private APIs.

## Intended Outcome

The extension is meant to make Claude usage easier to manage in day-to-day work. A user should be able to:

1. Open Claude and have visible chats tracked automatically.
2. See chats grouped by the Claude account context in which they were observed.
3. Search tracked chats quickly from the popup.
4. Reopen a chat from the extension, even when account switching or login handling is needed.
5. Keep the tracked set available across Chrome profiles through sync.

The product is not trying to recreate Claude itself. It is trying to add a browser-native control layer around Claude so the user can recover, navigate, and organize chats more reliably.

## Core Design Idea

The extension is built around one rule:

> If a chat is visible in Claude, the extension should be able to capture it, classify it, store it, and make it reopenable later.

This means the source of truth is the visible Claude page state, not a backend API or a separate database. The extension reads what Claude renders, translates it into structured data, and stores that data in Chrome storage.

## Main User Experience

The intended user flow is:

1. The user visits Claude.ai in Chrome.
2. The content script detects the current account context from the page.
3. The visible sidebar chats are scraped and normalized.
4. The popup shows the tracked chats with search, filtering, and account grouping.
5. Clicking a chat opens it directly when the current account matches.
6. When the account does not match, the extension guides the user through the proper Claude login state before opening the target chat.

The extension should feel like a quiet companion for Claude rather than a separate app.

## Data Model

The extension tracks two primary entities.

### Accounts

An account record represents the Claude identity observed in a Chrome profile. It can include:

- account ID
- email, when available
- display name
- color
- first seen timestamp
- last seen timestamp
- auto-detection metadata
- fallback identity metadata

### Chats

A chat record represents one visible Claude chat entry. It can include:

- storage ID
- chat ID
- account ID
- title
- URL
- first seen timestamp
- last seen timestamp
- sidebar order
- section or date-bucket metadata
- order-seen timestamp

The key design choice is that chats are tied to both their identity and the context in which they were observed. That makes the data useful for search, filtering, reopening, and sync.

## Responsibility Map

This section names the actual files that own each part of the extension.

### `manifest.json`

Responsible for:

- declaring the extension permissions
- binding the background service worker
- registering the content script on Claude pages
- defining the popup entry point
- exposing the extension icons

### `content/content-script.js`

Responsible for:

- observing `claude.ai` page state
- detecting the current Claude account context
- scraping visible sidebar chats
- normalizing chat titles and URLs
- assigning account metadata to tracked chats
- saving local tracking data
- coordinating pending chat open flows
- reacting to page changes and retrying at the right time

### `popup/popup.js`

Responsible for:

- loading tracked data from storage
- merging local and synced records
- rendering the popup UI state
- search and account filtering
- account rename and delete actions
- star and pin behavior
- opening chats from the tracked index
- preparing account-aware login or reopen handoffs

### `popup/popup.html`

Responsible for:

- the popup structure
- the search input
- account controls
- current account display
- quota/status display
- the chat list container

### `popup/popup.css`

Responsible for:

- the popup visual presentation
- layout and spacing
- chat item styling
- account badges and controls
- quota bar presentation
- inline edit styling

### `background/background.js`

Responsible for:

- owning serialized sync writes
- receiving sync write requests
- keeping sync writes from colliding
- writing compact data to `chrome.storage.sync`

## Operational Model

The extension uses a local-first model.

1. The content script stores the working set in `chrome.storage.local`.
2. The popup reads that local state and presents it to the user.
3. A compact representation is mirrored into `chrome.storage.sync`.
4. The background service worker coordinates sync writes so the browser keeps a convergent shared copy.

This approach is suited to a browser extension because it keeps the live experience fast while still giving the user cross-profile continuity.

## Identity Model

Claude usage can span multiple accounts and browser profiles, so identity is central to the design.

The intended identity flow is:

- Prefer a visible email address when Claude exposes one.
- Fall back to a display-name based identity when email is unavailable.
- Preserve a profile-stable fallback identity when Claude does not expose enough information.
- Keep that identity stable across reloads so chats from one Chrome profile remain attached to the correct account context.

This makes the tracked data feel anchored to the user's actual Claude usage instead of to a transient page state.

## Sync Model

Sync is intended to provide continuity, not complexity.

The extension stores a compact version of the data in `chrome.storage.sync` so that another Chrome profile can recover the same tracked account and chat inventory. The data is compacted to keep it practical for sync storage and to keep the browser responsive.

The sync layer is an implementation detail. The user should experience the result as "my tracked Claude chats are available wherever I open the extension."

## Reopen Model

The reopen flow is one of the most important parts of the product.

The extension is intended to understand whether the current Claude session matches the account that owns the requested chat. If it does, the extension can open the chat directly. If it does not, the extension prepares the account-switch/login sequence first and then returns the user to the target chat.

This is the mechanism that makes the extension more useful than a passive chat index.

## UI Role

The popup is meant to be a compact operator surface rather than a dashboard. It provides:

- chat search
- account selection
- rename and delete actions
- current-account visibility
- status and sync feedback
- chat reopening actions

The design goal is fast scanning and minimal friction.

## What Success Looks Like

The extension is successful when:

- Claude chats are captured automatically from the visible sidebar.
- Chats are organized by the correct account context.
- The popup makes it easy to search and filter them.
- Reopening a chat is straightforward even when account switching is required.
- The same tracked set can be recovered from another Chrome profile through sync.
- The extension feels like a reliable memory layer around Claude.

## Permissions

The extension declares and utilizes permissions with the following scopes and rules:

1. **`cookies`**: This permission is used exclusively for the account-switch reopen flow.
2. **Confirmation**: Cookie clearing happens only after the user explicitly confirms the account switch via a popup warning.
3. **Scope of Effect**: Clearing Anthropic/Claude session cookies affects only cookies related to Claude/Anthropic accounts. As a result, other active Claude browser tabs under the old session may be logged out.

## Assumptions

- Claude exposes enough visible DOM structure for the extension to read chats and identity cues.
- Chrome local and sync storage are enough for the intended data size.
- The user values continuity across profiles more than perfect historical completeness.
- The visible Claude sidebar is the right source of truth for this project.

## Non-Goals

This project is not trying to:

- replace Claude's own interface
- use private Claude APIs
- build a full chat archive service
- act as a generic browser session manager
- become a collaborative shared workspace

The scope stays centered on visible chat tracking, account-aware organization, and reopen flow support.

## Summary

Claude Chat Tracker is a browser-native tracking and reopening layer for Claude.ai. It watches the visible sidebar, records chats with account context, syncs a compact copy across Chrome profiles, and gives the user a fast popup for finding and reopening chats later.
