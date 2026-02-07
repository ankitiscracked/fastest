# Security model

## Principles

1. **The cloud never executes user code.** The API stores metadata and blobs only. Code execution (agents, builds) happens locally on the user's machine or in isolated sandbox containers.

2. **The CLI never accepts remote commands.** The CLI initiates all communication with the API. There is no mechanism for the API to push commands to the CLI.

3. **Agents run locally.** When `fst merge` or `fst snapshot --agent-summary` invokes an AI agent, it runs as a local subprocess on the user's machine. The API does not trigger agent execution.

## Trust boundaries

- **Local machine**: Trusted by the user. The CLI has full access to the workspace filesystem and the OS keychain.
- **Cloud API**: Trusted for metadata storage and blob persistence. User-scoped storage isolation prevents cross-user access.
- **Web browser**: Communicates with the API over HTTPS using Bearer tokens. No direct filesystem access.

## Token scoping

- Access tokens are scoped to the authenticated user. All API endpoints verify the token against the `sessions` table via hash lookup (`api/src/middleware/auth.ts`).
- Tokens expire after 30 days. There are no refresh tokens; re-authentication is required.
- Token hashing uses a simple hash function for session lookups (see `hashToken` in `api/src/middleware/auth.ts`).

## Storage isolation

- **R2 blobs**: Stored under `{user_id}/blobs/{hash}` and `{user_id}/manifests/{hash}.json`. All blob operations verify the authenticated user and scope reads/writes to their prefix.
- **D1 metadata**: Projects are owned by `owner_user_id`. Workspace and snapshot queries are scoped through project ownership.
- **Local blob cache**: Stored at `~/.cache/fst/blobs/` with standard filesystem permissions (`0644`). The global config directory (`~/.config/fst/`) uses `0700`.

## Content integrity

- **Snapshot IDs** are content-addressed: each ID is the SHA-256 hash of the snapshot's identity fields (manifest hash, sorted parent IDs, author name/email, timestamp). When reading a snapshot, the ID is recomputed and verified. Tampering with any identity field in a `.meta.json` file causes the read to fail with an integrity error. Legacy IDs (with `snap-` prefix) skip this check for backward compatibility. Implementation: `cli/internal/config/snapshot_id.go`.
- Blob uploads are verified server-side: the API computes SHA-256 of the uploaded content and rejects requests where the hash does not match the URL parameter (`api/src/routes/blobs.ts`).
- Manifests are similarly hash-verified on upload.
- Locally, `fst merge` verifies blob hashes when reading from the cache to detect corruption.

## Credential storage

- **CLI tokens**: Stored in the OS keychain (macOS Keychain, GNOME Keyring, Windows Credential Manager) via `go-keyring`. Not stored in plaintext files.
- **User API keys** (for LLM providers): Encrypted with AES-256-GCM before storage in D1. The encryption key is a server-side secret (`API_KEY_ENCRYPTION_KEY`). Keys are never returned in plaintext in list responses.
- **Provider credentials** (Railway, Cloudflare deploy tokens): Stored encrypted in the `provider_credentials` D1 table.

## No remote code execution from CLI

The CLI does not download or execute code from the API. The `fst clone` and `fst pull` commands download file blobs (raw content) and write them to the filesystem, but never interpret them as executable instructions. The `.fstignore` file is read from the local workspace, not from the cloud.
