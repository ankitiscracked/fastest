# Fastest (fst) — Documentation

A CLI tool for agentic coding workflows. Manage multiple workspaces, track changes, and merge work from parallel development sessions.

## Core Features

- **Projects** — Identity container for your codebase
- **Workspaces** — Multiple working copies (like git worktrees)
- **Snapshots** — Immutable, content-addressed project states
- **Drift** — Track changes from base with LLM-generated summaries
- **Merge** — 3-way merge with agent-assisted conflict resolution
- **Git Export** — Export snapshot history to git commits

## Quick Start

```bash
# Initialize a project
fst init myproject

# Create a linked workspace for parallel work
fst copy -n feature

# Check what changed
fst drift
fst drift --summary  # LLM-generated summary

# Capture a snapshot
fst snapshot -m "Added authentication"

# Merge changes from another workspace
fst merge feature
```

## Documentation

1. [Why Fastest](01_WHY_FASTEST.md) — Problem and solution
2. [Mental Model](02_MENTAL_MODEL.md) — Core concepts
3. [CLI Specification](07_CLI_SPEC_V1.md) — All commands
4. [Phase Plan](03_PHASE_PLAN.md) — Implementation status
5. [Data Model](04_DATA_MODEL_DB_SCHEMA.md) — Database schema
6. [Storage Format](05_STORAGE_FORMAT.md) — Manifest and blob format
7. [API Specification](06_API_SPEC_V1.md) — Cloud API
8. [Web UI](08_WEB_UI_V1.md) — Web interface
9. [Auth & Tokens](09_AUTH_AND_TOKENS.md) — Authentication
10. [Local-Only Mode](10_LOCAL_ONLY_MODE.md) — Offline usage
11. [Git Export](11_GIT_EXPORT.md) — Export to git
12. [Test Plan](12_TEST_PLAN.md) — Testing strategy
13. [Open Questions](13_OPEN_QUESTIONS.md) — Future considerations

## Status

| Phase | Status |
|-------|--------|
| Scaffolding | ✓ Complete |
| Auth | ✓ Complete |
| Projects + Workspaces | ✓ Complete |
| Snapshots + Blob Store | ✓ Complete |
| Drift Detection | ✓ Complete |
| LLM Drift Summaries | ✓ Complete |
| Watch Daemon | Triaged |
| Merge Workflow | ✓ Complete |
| Web UI | In Progress |
| Git Export | ✓ Complete |
