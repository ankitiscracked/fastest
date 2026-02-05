# Auth & tokens (v1)

## Goals
- Single account for web + CLI
- Minimal friction
- Secure-enough for v1, extensible later

## Recommended approach: Magic link + one-time code
Flow:
1) CLI `fast login` opens a URL (or prints it)
2) Web login completes email verification
3) Web shows a one-time code
4) CLI exchanges code for access token

Alternative: OAuth device flow (later).

## Token storage
- Prefer OS keychain if available
- Fallback: encrypted file in `~/.config/fast/credentials.json` (document clearly)

## Token scope
v1 scope can be simple: “user session token”.
Later add:
- project-scoped tokens
- fine-grained scopes

## Threat model (v1)
We are not doing remote execution, so the main risk is:
- token theft enables reading/writing project metadata and snapshots

Mitigations:
- short access token TTL
- revoke endpoint
- rate limiting
- audit events (optional)
