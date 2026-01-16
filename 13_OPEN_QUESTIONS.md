# Open questions / decisions to lock soon

1) **ID format**: ULID vs UUIDv7 (ULID recommended)
2) **Canonical JSON hashing**: implement canonicalization or strict minified sorted-keys?
3) **Symlinks**: support in v1? (recommend: ignore or treat as file with link target bytes)
4) **Binary files**: fully supported as blobs (yes)
5) **Large repos**: do we need chunked uploads now? (probably not v1)
6) **Ignore rules**: `.fastignore` format (gitignore-like?) and precedence
7) **Multiple projects per folder**: forbid; require explicit linking
8) **Project slug**: required or optional? (optional; generate from name)
9) **Status model**: store `activity_events` now or later? (recommend now; cheap)
10) **Cloud provider**: R2+Workers vs S3+Lambda; choose based on what you can ship fastest
