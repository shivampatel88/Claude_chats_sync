# Findings & Architectural Discoveries

## Chrome MV3 Cookie & Network Model
- **Cookie Jar**: A single Chrome profile maintains a shared cookie jar for `claude.ai`. Modifying cookies via `chrome.cookies.set()` or `chrome.cookies.remove()` updates the jar immediately for all tabs in that profile.
- **Content Scripts vs Background**: Content scripts on `claude.ai` cannot access the `chrome.cookies` API directly. However, the background service worker (`background/background.js`) and extension pages (`popup/popup.html`) have full `chrome.cookies` permissions.
- **Transient Background Cookie Swap**:
  - A background fetch from the service worker to `https://claude.ai/api/...` automatically includes the cookies in the current cookie jar.
  - By performing a rapid swap (< 400ms) with an unconditional `try...finally` restore, the background service worker can authenticate as Account B, fetch conversations, and restore Account A before the user or open tabs experience any disruption.
- **Claude Authentication Cookies**:
  - `sessionKey`: Primary authentication token (HTTP-only, Secure, Lax).
  - `lastActiveOrg`: Active organization identifier.
  - `anthropic-device-id`: Device identifier token.
  - Storing and restoring these cookies reproduces an active session without triggering OAuth chooser screens.
- **Session Expiration**:
  - Claude tokens can expire or be invalidated if explicitly logged out on the server.
  - The Vault must detect HTTP 401/403 responses during background sync and flag `expired: true` so the user is prompted with a 1-click re-login via the existing Google OAuth `login_hint` flow.
