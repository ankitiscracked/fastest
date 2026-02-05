# Security model – V1

## Principles
- Cloud never executes code.
- CLI never accepts remote commands.
- Agents run locally only.

---

## Tokens
- User access token
- Scoped to project operations

---

## Storage
- Blobs are content-addressed.
- No executable artifacts stored.

---

## Trust boundary
- Local machine is trusted by user.
- Cloud is trusted for storage + metadata.
