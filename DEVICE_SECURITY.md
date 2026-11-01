# Device protocol v1

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
