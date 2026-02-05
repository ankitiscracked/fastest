# Authentication

Fastest supports three authentication methods: device flow (CLI), Google OAuth (web), and Bearer token session management.

## Device flow (CLI)

The CLI uses the OAuth 2.0 Device Authorization Grant (RFC 8628) to authenticate users. This avoids requiring the CLI to handle passwords or browser redirects directly.

Flow implemented across `cli/cmd/fst/commands/login.go` and `api/src/routes/oauth.ts`:

1. **CLI starts flow**: `POST /v1/oauth/device` creates a `device_codes` record with a random `device_code` (secret, 32 chars) and a human-readable `user_code` (format `ABCD-1234`). Returns both codes, a `verification_uri`, and a `verification_uri_complete` URL that pre-fills the code.

2. **CLI displays code**: The user sees the code in the terminal and a browser is opened automatically to the verification URL (the web app's `/device` page).

3. **CLI polls for token**: `POST /v1/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. The API returns `authorization_pending` (400) while waiting, `slow_down` if polling too fast, or the access token once authorized. Default poll interval is 5 seconds; device code expires after 15 minutes.

4. **User authorizes in browser**: The `/device` page on the web app accepts the user code. The user authenticates (via Google OAuth or an existing session) and the web calls `POST /v1/oauth/device/authorize` which sets the device code status to `authorized` and links it to the user.

5. **CLI receives token**: On the next poll, the API sees the `authorized` status, creates a session (30-day expiry), and returns the access token. The CLI saves the token to the OS keychain.

## Google OAuth (web)

The web frontend authenticates via Google Sign-In. The flow is:

1. User clicks sign-in, Google returns an ID token (JWT)
2. Web sends the ID token to `POST /v1/auth/google`
3. API verifies the token with `https://oauth2.googleapis.com/tokeninfo`, checks email verification and audience
4. API finds or creates the user, generates a session token (30-day expiry), returns it
5. Web stores the token and uses it for subsequent API calls

Implemented in `api/src/routes/auth.ts`.

## Session management

Sessions are stored in the `sessions` D1 table with fields: `id`, `user_id`, `token_hash`, `expires_at`, `created_at`.

The token is hashed before storage (see `hashToken` in `api/src/middleware/auth.ts`). The middleware looks up the session by token hash and checks expiration on every authenticated request.

Sessions expire after 30 days. There is no refresh token mechanism; the user must re-authenticate after expiry.

## Token storage (CLI)

The CLI stores the access token in the OS keychain using `github.com/zalando/go-keyring`:

- **Service name**: `fst`
- **User name**: `access_token`

Functions in `cli/internal/auth/token.go`:
- `SaveToken(token)` -- stores in OS keychain
- `GetToken()` -- retrieves from OS keychain, returns empty string if not found
- `ClearToken()` -- deletes from OS keychain
- `FormatKeyringError(err)` -- adds platform-specific hints for keyring failures (Linux Secret Service, macOS keychain locked, etc.)

The token is passed as a `Bearer` token in the `Authorization` header for all API requests. For WebSocket connections, it falls back to a `token` query parameter.

## Auth middleware

`api/src/middleware/auth.ts` exports:

- `getAuthUser(c)` -- resolves Bearer token or query param to `{id, email}`, returns null if invalid
- `requireAuth(c)` -- same but throws on failure
- `authMiddleware` -- Hono middleware that rejects unauthenticated requests with 401

All `/v1/blobs/*`, `/v1/projects/*`, `/v1/workspaces/*`, and `/v1/snapshots/*` routes require authentication. The `/v1/oauth/*` and `/v1/auth/google` endpoints are public.

## API key management

Users can store API keys for LLM providers (Anthropic, OpenAI, Google, etc.) via `POST /v1/auth/api-keys`. Keys are encrypted with AES-256-GCM using a server-side encryption key (`API_KEY_ENCRYPTION_KEY` env var, 32 bytes base64-encoded). Keys are masked in list responses (last 4 characters visible). The internal endpoint `GET /v1/auth/api-keys/values` returns decrypted values for sandbox use.

Implemented in `api/src/routes/auth.ts`.
