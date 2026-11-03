# Device protocol v1

## Windows control panel (0.10.0)

The native control panel uses an independent per-launch secret on an ephemeral loopback-only management port. Browser origins and unexpected Host headers are rejected. Online device changes use the backend's authenticated local administration routes; an unreadable or unverified runtime/lock never triggers an offline permission write. The window does not start or stop the phone service merely by opening or closing.

Local device notes are bound to fingerprint and account generation and are not returned to phones. Forgetting a device removes enrollment, login sessions, notes and device policies, cancels queued jobs and closes live sessions. Active jobs or in-flight device reads prevent deletion. Chat history and attachments remain linked to their existing owner. Re-enrollment requires fresh approval, old tokens stay invalid, and elevated permissions are not inherited. Nonces remain until normal expiry to prevent replay after re-enrollment.

POST /api/login takes username, password, deviceName, publicKey (Base64 DER SubjectPublicKeyInfo, P-256). The same signed-request headers described below are required, with an empty token. An unapproved key returns 202 with approvalRequired and verificationCode, never a token. Enrollment is only created after valid password verification. Local CLI approval is mandatory.

Authenticated requests require Authorization: Bearer TOKEN and x-device-time (epoch milliseconds), x-device-nonce (unique UUID), x-device-signature (Base64 DER SHA256withECDSA signature). All of these bytes are signed as UTF-8, newline-separated:

codex-device-v1
SHA256_HEX(TOKEN)
METHOD
NORMALIZED_AUTHORITY
RAW_PATH_AND_QUERY
TIME
NONCE
SHA256_HEX(BODY)

Authority is lowercase Host, removing trailing default :80 or :443. The authority is bound to the request Host received at the backend. Do not override the tunnel's original Host header when configuring a fixed domain.

Body bytes are exactly the transmitted payload, empty for GET. All signatures use standard DER ECDSA encoding. Time tolerance is three minutes, with serverTime supplied over the existing HTTP response. Used nonces are persisted and rejected across restarts.

WebSocket /events uses first-frame auth with token, after, deviceTime, deviceNonce, deviceSignature. Method is WS and signed body is the UTF-8 decimal after value. Plain bearer-only WebSocket auth is removed. Existing legacy bearer tokens lacking a device binding are rejected.

There is no public approval endpoint. Approval and revocation are performed by scripts/devices.mjs on the computer with the local Windows user's permissions. Registry entries and login tokens are bound to the account generation; password reset invalidates both.

## Project access (0.5.0)

Local device management also configures a persistent project policy per fingerprint and account generation. A new login token never broadens that policy. Explicit directory policies include descendants after canonical path checks; sibling prefixes, traversal and junction escapes do not match. Unlimited mode must be explicitly selected at the computer.

HTTP authorization and event filtering use the phone's current policy; cached/loaded Codex threads do not bypass it. Persisted event workspace attribution supports scoped replay after restart. Attachments are bound to their uploading device before submission and to chat projects afterward. Phones cannot list or revoke another phone's login sessions. Corrupt policies deny access.

Project visibility is distinct from Codex's filesystem sandbox and approval settings. This release retains the global reviewer. It does not implement chat-only isolation or erase information a device previously received. Reviewers and pure-chat execution isolation are later stages.

## Per-device reviewers (0.6.0)

The reviewer is persisted by approved fingerprint and account generation. Existing devices inherit the previous global reviewer once; login token changes never reset the device setting. Messages persist a reviewer snapshot at acceptance. Mode changes affect only subsequent submissions, never pending approvals, questions or queued work. Every phone turn explicitly supplies reviewer plus on-request approval policy without altering sandbox/network boundaries.

Only loopback management with the local admin secret may change reviewers. Phones cannot request an override through chat payloads. Approval and user-input events carry private persisted audience attribution, filtered in status, live delivery and replay; only the submitting identity may respond, even when another phone can access the same project. Internal audience identifiers are stripped from wire messages. Corrupt or unsupported modes deny new tasks; stale turn requests are rejected.

This is approval routing and automatic-review configuration, not a chat-only filesystem isolation mechanism. Learning mode remains a later stage.

## Chat-only device mode (0.8.0)

0.9.1 adds a separate opt-in permission to read other approved chat-only devices' histories and bound images. Only local management can grant it, per fingerprint/current account generation; device revocation clears the grant. It does not broaden original thread, upload, job, request or WebSocket authorization. The new GET-only namespace rechecks viewer/session authority and source approval/mode/generation, including after awaited history reads; it excludes own/coding/old-generation conversations. Images require both exact chat binding and matching mode/owner/generation. No write/control APIs or cross-device event subscriptions are added. Android 0.9.0 keeps its existing behavior without upgrading; only 0.9.1 displays the new optional status field and read-only UI.

Local management can select chat_only through the existing per-device approvals endpoint. It routes requests to a separate ChatOnlyRuntime with private home, sanitized catalog/environment, workspace and identity/generation-specific chat index. Only web search and user questions are registered; file/command/patch/JS/computer/MCP/plugin/delegation tools are absent. Existing coding chats, other devices/generations, file uploads and desktop takeover are denied. Images and durable events carry mode and owner attribution; every status/live/replay/history/response route enforces it. User images are inline bytes, never caller-selected paths. Native operation/permission requests are rejected. This is tool isolation, not an OS jail; the exact CLI is pinned and effective configuration checked.

Cross-mode changes reject active work or in-flight device requests, cancel old queued work, close the private runtime, clear phone views and change a durable modeRevision. Stale retries fail even after an offline round trip to the original mode. Switching user/auto_review alone retains prior snapshot behavior. Revocation/account-generation changes stop private workers and remove credential copies. Authentication refresh stays in the main managed Codex connection; private children receive access credentials without refresh tokens and rotate between tasks before expiry. Failures never replay uncertain work or fall back to privileged execution. Real CLI adversarial tests, signed API isolation/restart tests and authenticated web/math testing passed; phone acceptance remains with the user.

## Desktop takeover (0.7.0 prototype)

Desktop exit requires a separate per-device permission, default denied and scoped to the current account generation. The phone cannot grant it. Preparation is read-only and scoped to an authorized thread; confirmations are opaque, short-lived and identity/thread-bound. Repeated confirmations reuse a receipt. Device authority and directory scope are checked again before launching desktop close and before acquiring the original thread. Current close operations are serialized; restarting the server never replays them.

Desktop identification uses the current user's installed OpenAI.Codex package, same Windows session, executable path and start identity. It excludes any desktop that contains protected bridge processes in its ancestry and revalidates all targets before requesting a normal application quit. The helper restores a supported app window and sends its Ctrl+Q quit shortcut only after verifying foreground ownership, enabled state, an unlocked interactive desktop and released modifier keys. It temporarily activates that window; failure to establish safe input yields an error. Closing a window alone was insufficient because the app stayed in the tray. The helper never kills desktop processes, unrelated CLI processes or the phone's app-server and never modifies writer locks. It may interrupt every task hosted by the desktop application; the phone must show an explicit global-impact confirmation. A timeout or process change yields failure without escalation to force termination.
