# Workspace Drift Management & Sync

## Overview

Workspace drift occurs when a workspace diverges from the `main` workspace over time. This feature provides awareness of divergence and AI-powered reconciliation.

**Key Principles:**
- **Agentic-first**: Users work with information, not code. AI handles the low-level work.
- **Drift ≠ Sync**: Drift is information (tracking). Sync is action (reconciliation).
- **Pull only**: Workspaces sync FROM main. This is not "merge into main".
- **AI does the work**: User approves outcomes, not line-by-line diffs.

> **Terminology Note:**
> - **Sync with main**: Pull changes from main INTO your workspace (this spec)
> - **Merge into main**: Push changes from your workspace INTO main (separate feature, typically when work is complete)

---

## Mental Model

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   DRIFT (Information)              SYNC (Action)                │
│   ───────────────────              ──────────────               │
│                                                                 │
│   "What has diverged?"        →    "Pull updates from main"     │
│                                                                 │
│   • Tracking & awareness           • AI-first resolution        │
│   • No files change                • User approves outcome      │
│   • Can ignore indefinitely        • Files get updated          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Direction: main → workspace (sync = pull from main)
```

### Sync vs Merge

| Operation | Direction | Purpose | When |
|-----------|-----------|---------|------|
| **Sync with main** | main → workspace | Stay up to date | Ongoing, multiple times |
| **Merge into main** | workspace → main | Incorporate completed work | Once, when done |

This spec covers **Sync with main**. Merge into main is a separate feature.

---

## Drift Detection

### What We Compare

```
┌─────────────────────┐         ┌─────────────────────┐
│     WORKSPACE       │         │        MAIN         │
│                     │         │                     │
│  Current files      │   vs    │  Current files      │
│  (or last snapshot) │         │  (or last snapshot) │
│                     │         │                     │
└─────────────────────┘         └─────────────────────┘
```

**User can choose comparison mode:**
- Main's current files (recommended) - catches uncommitted changes
- Main's last snapshot - stable comparison point

**No three-way merge needed.** We don't track fork snapshots for drift purposes - that's only for history.

### Drift Categories

```typescript
interface DriftReport {
  id: string;
  workspace_id: string;
  main_workspace_id: string;

  // Comparison metadata
  compared_at: string;
  workspace_state: 'current' | 'snapshot';
  main_state: 'current' | 'snapshot';

  // File categories
  main_only: string[];           // Files in main but not workspace
  workspace_only: string[];      // Files in workspace but not main
  both_same: string[];           // Same content in both
  both_different: string[];      // Different content (needs analysis)

  // AI-generated summary
  summary?: string;
  risk_level?: 'low' | 'medium' | 'high';
}
```

### Categorization Logic

```typescript
function categorizeFiles(workspace: FileMap, main: FileMap): DriftCategories {
  const allPaths = new Set([...Object.keys(workspace), ...Object.keys(main)]);

  const categories = {
    main_only: [],
    workspace_only: [],
    both_same: [],
    both_different: [],
  };

  for (const path of allPaths) {
    const inWorkspace = path in workspace;
    const inMain = path in main;

    if (!inWorkspace && inMain) {
      categories.main_only.push(path);
    } else if (inWorkspace && !inMain) {
      categories.workspace_only.push(path);
    } else if (workspace[path].hash === main[path].hash) {
      categories.both_same.push(path);
    } else {
      categories.both_different.push(path);
    }
  }

  return categories;
}
```

---

## Sync Process

### Philosophy

Traditional sync/merge:
```
User reads diffs → User resolves conflicts → User applies changes
```

Agentic sync:
```
AI reads diffs → AI resolves conflicts → AI presents summary → User approves
```

The user should see:
> "Main added 2 API endpoints. You refactored auth. I've combined them. [Approve]"

NOT:
> "Here are 47 lines of diff. Resolve these 3 conflicts manually."

### Sync Stages

```
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1: Non-AI Work                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  main_only files      → Copy directly (no analysis needed)      │
│  workspace_only files → Keep as-is (no action needed)           │
│  both_same files      → No action needed                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2: AI Analysis (only for both_different)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  For each file with different content:                          │
│  1. AI analyzes what each side changed (semantic intent)        │
│  2. AI determines if changes are compatible                     │
│  3. If compatible → AI generates combined version               │
│  4. If incompatible → AI prepares choice for user               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3: User Approval                                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Show summary of all changes                                    │
│  If conflicts: present semantic choices (not code)              │
│  User approves → Apply all changes                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Drift Report

```typescript
interface DriftReport {
  id: string;
  workspace_id: string;
  main_workspace_id: string;

  // What we compared
  compared_at: string;
  workspace_state: 'current' | 'snapshot';
  main_state: 'current' | 'snapshot';

  // File categorization
  main_only: string[];
  workspace_only: string[];
  both_same: string[];
  both_different: string[];

  // Computed
  total_drift_files: number;      // main_only + both_different
  has_overlaps: boolean;          // both_different.length > 0

  // AI-generated (computed lazily)
  analysis?: DriftAnalysis;
}

interface DriftAnalysis {
  // Human-readable summaries
  main_changes_summary: string;       // "Added rate limiting, fixed auth bug"
  workspace_changes_summary: string;  // "Added retry logic, custom errors"

  // Risk assessment
  risk_level: 'low' | 'medium' | 'high';
  risk_explanation: string;

  // Recommendation
  can_auto_sync: boolean;
  recommendation: string;             // "Safe to sync automatically"
}
```

### Sync Preview

```typescript
interface SyncPreview {
  id: string;
  workspace_id: string;
  drift_report_id: string;

  // Actions that need no user input
  auto_actions: AutoAction[];

  // Decisions user must make
  decisions_needed: ConflictDecision[];

  // Summary
  files_to_update: number;
  files_to_add: number;
  files_unchanged: number;

  // AI summary of what will happen
  summary: string;
}

interface AutoAction {
  path: string;
  action: 'copy_from_main' | 'keep_workspace' | 'ai_combined';
  description: string;  // "Added from main" or "Combined your retry logic with main's error handling"
}

interface ConflictDecision {
  path: string;

  // Semantic descriptions (not code!)
  main_intent: string;      // "Set timeout to 30 seconds for stability"
  workspace_intent: string; // "Set timeout to 5 seconds for faster feedback"
  conflict_reason: string;  // "These values are mutually exclusive"

  // Options for user
  options: DecisionOption[];

  // AI recommendation
  recommended_option_id?: string;
}

interface DecisionOption {
  id: string;
  label: string;              // "Use 30 seconds (main)"
  description?: string;       // "Better for production stability"

  // If custom input allowed
  allows_custom_input?: boolean;
  custom_input_label?: string; // "Enter timeout in seconds"
}
```

### Sync Execution

```typescript
interface SyncRequest {
  workspace_id: string;
  preview_id: string;

  // User's decisions for conflicts
  decisions: Record<string, string>;  // path → selected option_id
  custom_values?: Record<string, string>; // path → custom value if applicable

  // Options
  create_snapshot_before: boolean;
  create_snapshot_after: boolean;
}

interface SyncResult {
  success: boolean;

  files_updated: number;
  files_added: number;
  errors: string[];

  // Snapshots created
  snapshot_before_id?: string;
  snapshot_after_id?: string;
}
```

---

## API Endpoints

### Get Drift Report

```
GET /workspaces/{workspace_id}/drift
```

**Query Parameters:**
- `main_state`: `current` | `snapshot` (default: `current`)
- `include_analysis`: `true` | `false` (default: `false`)

**Response:**
```json
{
  "drift": {
    "id": "drift-abc123",
    "workspace_id": "ws-feature",
    "main_workspace_id": "ws-main",
    "compared_at": "2024-01-15T10:30:00Z",
    "workspace_state": "current",
    "main_state": "current",
    "main_only": ["src/middleware/rateLimit.ts", "src/api/health.ts"],
    "workspace_only": ["src/utils/retry.ts"],
    "both_same": ["package.json", "tsconfig.json"],
    "both_different": ["src/api/client.ts"],
    "total_drift_files": 3,
    "has_overlaps": true
  }
}
```

### Analyze Drift (AI)

```
POST /workspaces/{workspace_id}/drift/analyze
```

Triggers AI analysis for the current drift state.

**Response:**
```json
{
  "analysis": {
    "main_changes_summary": "Added rate limiting middleware and health check endpoint",
    "workspace_changes_summary": "Added retry logic to API client with exponential backoff",
    "risk_level": "low",
    "risk_explanation": "Changes are in different areas of the codebase. The one overlapping file (client.ts) has compatible changes.",
    "can_auto_sync": true,
    "recommendation": "Safe to sync. Main's error handling and your retry logic can be combined."
  }
}
```

### Prepare Sync

```
POST /workspaces/{workspace_id}/sync/prepare
```

Prepares the sync by analyzing all files and generating the preview.

**Response:**
```json
{
  "preview": {
    "id": "sync-preview-xyz",
    "workspace_id": "ws-feature",
    "drift_report_id": "drift-abc123",
    "auto_actions": [
      {
        "path": "src/middleware/rateLimit.ts",
        "action": "copy_from_main",
        "description": "New rate limiting middleware from main"
      },
      {
        "path": "src/api/health.ts",
        "action": "copy_from_main",
        "description": "New health check endpoint from main"
      },
      {
        "path": "src/api/client.ts",
        "action": "ai_combined",
        "description": "Combined your retry logic with main's improved error handling"
      }
    ],
    "decisions_needed": [],
    "files_to_update": 1,
    "files_to_add": 2,
    "files_unchanged": 3,
    "summary": "3 files will change. All changes can be synced automatically."
  }
}
```

**Response with conflicts:**
```json
{
  "preview": {
    "id": "sync-preview-xyz",
    "auto_actions": [...],
    "decisions_needed": [
      {
        "path": "src/config/timeout.ts",
        "main_intent": "Set API timeout to 30 seconds for production stability",
        "workspace_intent": "Set API timeout to 5 seconds for faster development feedback",
        "conflict_reason": "Both sides changed the same timeout value to different settings",
        "options": [
          {
            "id": "use_main",
            "label": "30 seconds (main)",
            "description": "Better for production stability"
          },
          {
            "id": "use_workspace",
            "label": "5 seconds (yours)",
            "description": "Better for fast iteration"
          },
          {
            "id": "custom",
            "label": "Custom value",
            "allows_custom_input": true,
            "custom_input_label": "Timeout in seconds"
          }
        ],
        "recommended_option_id": "use_main"
      }
    ],
    "summary": "3 files will change. 1 decision needed."
  }
}
```

### Execute Sync

```
POST /workspaces/{workspace_id}/sync/execute
```

**Request:**
```json
{
  "preview_id": "sync-preview-xyz",
  "decisions": {
    "src/config/timeout.ts": "use_workspace"
  },
  "create_snapshot_before": true,
  "create_snapshot_after": true
}
```

**Response:**
```json
{
  "result": {
    "success": true,
    "files_updated": 1,
    "files_added": 2,
    "errors": [],
    "snapshot_before_id": "snap-110",
    "snapshot_after_id": "snap-111"
  }
}
```

---

## AI Prompt Design

### Drift Summary Prompt

```
You are analyzing the differences between two workspaces in a software project.

## Files only in main (workspace is missing these):
{main_only_files}

## Files only in workspace (not in main):
{workspace_only_files}

## Files that differ between both:
{both_different_files}

For the differing files, here are the changes:
{file_diffs}

## Task

Provide a concise analysis:

1. **Main changes summary** (1-2 sentences): What did main add or change?
2. **Workspace changes summary** (1-2 sentences): What did the workspace add or change?
3. **Risk level** (low/medium/high): How risky is syncing these changes?
4. **Risk explanation** (1 sentence): Why this risk level?
5. **Can auto-sync** (true/false): Can all changes be synced without user decisions?
6. **Recommendation** (1 sentence): What should the user do?

Respond in JSON format.
```

### File Sync Analysis Prompt

```
You are syncing two versions of a file. Your goal is to combine both sets of changes.

## Workspace version:
```
{workspace_content}
```

## Main version:
```
{main_content}
```

## Task

1. Understand what each version was trying to accomplish
2. Determine if the changes are compatible
3. If compatible: produce a combined version that includes both changes
4. If incompatible: explain the conflict in simple terms

## Response Format

```json
{
  "workspace_intent": "Brief description of what workspace changed",
  "main_intent": "Brief description of what main changed",
  "compatible": true/false,
  "combined_content": "...full combined file if compatible...",
  "conflict_reason": "...explanation if incompatible...",
  "options": [
    // Only if incompatible - provide 2-3 resolution options
    {
      "id": "option_id",
      "label": "Short label",
      "description": "Why choose this",
      "resulting_content": "...file content if this option is chosen..."
    }
  ],
  "recommended_option": "option_id or null"
}
```

Important:
- Describe intents in plain English, not code terms
- Focus on WHAT changed, not HOW (line numbers, syntax)
- If changes are in completely different parts of the file, they're compatible
- Only mark as incompatible if the same logical setting/behavior is changed differently
```

---

## UI/UX Design

### Drift Indicator (Sidebar)

Simple indicator on workspace, no counts:

```
┌──────────────────┐
│ ▼ my-project     │
│   ● main         │
│   ○ feature  ⚠️  │  ← Drift indicator
│   ○ bugfix   ✓   │  ← Synced indicator
└──────────────────┘
```

### Drift Panel (Information)

Shown on workspace detail page or as slide-out panel:

```
┌─────────────────────────────────────────────────────────────────┐
│ Drift from Main                                    [Refresh]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Your workspace has diverged from main.                          │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐│
│ │                                                             ││
│ │  What's new in main:                                        ││
│ │  • Added rate limiting to API endpoints                     ││
│ │  • New health check endpoint                                ││
│ │                                                             ││
│ │  What you've changed:                                       ││
│ │  • Added retry logic to API calls                           ││
│ │                                                             ││
│ │  Overlap: 1 file                                            ││
│ │  Risk: Low - changes appear compatible                      ││
│ │                                                             ││
│ └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│ Compare against: (•) Current files  ( ) Last snapshot           │
│                                                                 │
│                                              [Sync with Main]   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Sync Flow - Preparing

```
┌─────────────────────────────────────────────────────────────────┐
│ Preparing Sync                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ◐ Analyzing differences...                                    │
│                                                                 │
│   ✓ 2 files to add from main                                   │
│   ✓ 1 file to combine                                          │
│   ◐ Checking for conflicts...                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Sync Flow - Ready (No Conflicts)

```
┌─────────────────────────────────────────────────────────────────┐
│ Ready to Sync                                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ✓ All changes can be synced automatically                       │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐│
│ │                                                             ││
│ │  Will be added from main:                                   ││
│ │  • Rate limiting middleware                                 ││
│ │  • Health check endpoint                                    ││
│ │                                                             ││
│ │  Will be combined:                                          ││
│ │  • API client - combined retry logic with error handling    ││
│ │                                                             ││
│ │  Your changes preserved:                                    ││
│ │  • Retry utility functions                                  ││
│ │                                                             ││
│ └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│ ☑ Create snapshot before sync                                   │
│                                                                 │
│              [Cancel]                      [Apply Sync]         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Sync Flow - Decision Needed

```
┌─────────────────────────────────────────────────────────────────┐
│ Decision Needed                                       1 of 1    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ config/timeout.ts                                               │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐│
│ │                                                             ││
│ │  Main changed:                                              ││
│ │  "Set API timeout to 30 seconds for stability"              ││
│ │                                                             ││
│ │  You changed:                                               ││
│ │  "Set API timeout to 5 seconds for faster feedback"         ││
│ │                                                             ││
│ │  Why this conflicts:                                        ││
│ │  Both sides set the timeout to different values.            ││
│ │                                                             ││
│ └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│ Choose one:                                                     │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐│
│ │ ( ) 30 seconds (main) ★ recommended                         ││
│ │     Better for production stability                         ││
│ ├─────────────────────────────────────────────────────────────┤│
│ │ (•) 5 seconds (yours)                                       ││
│ │     Better for fast iteration                               ││
│ ├─────────────────────────────────────────────────────────────┤│
│ │ ( ) Custom: [____] seconds                                  ││
│ └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│              [Back]                           [Continue]        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Sync Flow - Complete

```
┌─────────────────────────────────────────────────────────────────┐
│ ✓ Sync Complete                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Your workspace is now up to date with main.                     │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐│
│ │                                                             ││
│ │  • 2 files added                                            ││
│ │  • 1 file combined                                          ││
│ │  • Snapshot created: snap-111                               ││
│ │                                                             ││
│ └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│                                              [Done]             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Drift Detection (No AI)

- [ ] Add `main_workspace_id` to Project model
- [ ] Implement file comparison logic (workspace vs main)
- [ ] Create drift report API endpoint
- [ ] Add drift indicator to sidebar
- [ ] Basic drift panel showing file counts

### Phase 2: AI Analysis

- [ ] Implement drift summary generation
- [ ] Add risk level classification
- [ ] Create `/drift/analyze` endpoint
- [ ] Update drift panel with AI summaries

### Phase 3: Sync Preparation

- [ ] Implement non-AI sync actions (copy, keep)
- [ ] Implement AI file combination
- [ ] Create conflict detection and option generation
- [ ] Build `/sync/prepare` endpoint
- [ ] Build sync preview UI

### Phase 4: Sync Execution

- [ ] Implement sync application logic
- [ ] Add snapshot before/after support
- [ ] Create `/sync/execute` endpoint
- [ ] Build sync confirmation UI
- [ ] Build decision UI for conflicts

### Phase 5: Polish

- [ ] Background drift checking
- [ ] Drift notifications
- [ ] Keyboard shortcuts
- [ ] Error handling and recovery
- [ ] Performance optimization for large workspaces

---

## Open Questions

1. **Automatic drift checking**: Should we check drift automatically on workspace load, or only on user request?

2. **Notification threshold**: At what point should we notify users about drift? (e.g., after N files diverge, or after N days)

3. **Conflict escalation**: If AI can't determine compatibility, should we default to "needs decision" or attempt a best-guess combination?

4. **Undo support**: Should users be able to undo a sync (beyond restoring from snapshot)?
