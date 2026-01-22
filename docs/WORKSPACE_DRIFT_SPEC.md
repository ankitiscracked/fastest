# Workspace Drift Management

## Overview

Workspace drift occurs when a workspace diverges from the `main` workspace over time. Without proactive management, this leads to complex merge conflicts, lost work, and deployment blockers.

This feature provides:
1. **Drift Detection** — Track what changed relative to main
2. **Risk Analysis** — AI-powered conflict prediction
3. **Resolution Actions** — Guided sync with smart merging

## Mental Model

```
                    main workspace (production)
                    snapshot: snap-100
                          │
          ┌───────────────┼───────────────┐
          │               │               │
    feature-auth     feature-api     experiment
    base: snap-100   base: snap-95   base: snap-90
    current: +5Δ     current: +12Δ   current: +30Δ
          │               │               │
          ▼               ▼               ▼
    [LOW RISK]      [MEDIUM RISK]   [HIGH RISK]

    Risk increases with:
    - Time since base snapshot
    - Number of overlapping files with main
    - Semantic conflict likelihood
```

## Key Concepts

### Main Workspace
- Designated production workspace (typically named "main")
- Serves as the merge target
- Deployments happen from main
- Other workspaces sync TO main, not from each other

### Base Snapshot
- The snapshot a workspace was created from (or last synced to)
- Used as the common ancestor for 3-way diff
- Tracked per workspace

### Drift Report
- Comparison between workspace and main
- Includes: files only in workspace, files only in main, overlapping files
- Generated on-demand or periodically

### Overlapping Files
- Files modified in BOTH the workspace AND main since the base
- These are potential conflict sources
- Primary focus of AI analysis

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                         Drift Service                                   │
├────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐ │
│  │   Detection      │───▶│   Analysis       │───▶│   Resolution     │ │
│  │   Layer          │    │   Layer (AI)     │    │   Layer (AI)     │ │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘ │
│           │                      │                       │             │
│           ▼                      ▼                       ▼             │
│  • Compare snapshots     • Classify risk         • Auto-merge safe    │
│  • Find overlaps         • Explain changes       • Propose merges     │
│  • Track changes         • Predict conflicts     • Guide conflicts    │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Enhanced DriftReport

```typescript
interface DriftReport {
  id: string;
  workspace_id: string;
  workspace_name: string;

  // Snapshot references
  base_snapshot_id: string;       // Common ancestor
  main_snapshot_id: string;       // Current main
  workspace_snapshot_id: string;  // Current workspace (if snapshotted)

  // Time tracking
  base_snapshot_at: string;       // When workspace branched
  main_updated_at: string;        // When main last changed
  analyzed_at: string;            // When this report was generated

  // Change categories
  workspace_only: FileChange[];   // Only changed in workspace
  main_only: FileChange[];        // Only changed in main (need to pull)
  overlapping: OverlappingFile[]; // Changed in both (potential conflict)

  // Computed stats
  total_changes: number;
  overlap_count: number;

  // AI analysis (computed lazily)
  analysis?: DriftAnalysis;
}

interface FileChange {
  path: string;
  change_type: 'added' | 'modified' | 'deleted';
  size_bytes?: number;
  hash?: string;
}

interface OverlappingFile {
  path: string;

  // Change details
  workspace_change: FileChange;
  main_change: FileChange;

  // Diff content (for AI analysis)
  base_content?: string;
  workspace_content?: string;
  main_content?: string;
  workspace_diff?: string;
  main_diff?: string;

  // AI analysis result
  analysis?: FileConflictAnalysis;
}
```

### AI Analysis Types

```typescript
interface DriftAnalysis {
  // Overall assessment
  risk_level: 'low' | 'medium' | 'high';
  auto_mergeable_count: number;
  needs_review_count: number;
  conflict_count: number;

  // Human-readable summary
  summary: string;

  // Recommendations
  recommended_action: 'auto_sync' | 'review_sync' | 'manual_sync';

  // Per-file analysis
  file_analyses: Record<string, FileConflictAnalysis>;
}

interface FileConflictAnalysis {
  risk: 'safe' | 'caution' | 'conflict';

  // What each side was trying to do
  workspace_intent: string;
  main_intent: string;

  // Why they do or don't conflict
  compatibility_explanation: string;

  // Can we merge automatically?
  can_auto_merge: boolean;

  // For caution/conflict: suggested resolution
  suggested_merge?: string;
  merge_strategy?: 'workspace_wins' | 'main_wins' | 'combined' | 'manual';

  // Confidence in the analysis
  confidence: number; // 0-1
}
```

### Sync Action

```typescript
interface SyncAction {
  workspace_id: string;
  direction: 'pull' | 'push';  // pull = main→workspace, push = workspace→main

  // Resolution decisions
  resolutions: FileResolution[];

  // Options
  create_snapshot_before: boolean;
  create_snapshot_after: boolean;
}

interface FileResolution {
  path: string;
  action: 'keep_workspace' | 'keep_main' | 'use_merged' | 'skip';
  merged_content?: string;  // Required if action is 'use_merged'
}

interface SyncResult {
  success: boolean;
  files_updated: number;
  files_skipped: number;
  errors: string[];

  // New snapshot IDs if created
  before_snapshot_id?: string;
  after_snapshot_id?: string;
}
```

---

## API Endpoints

### Get Drift Report

```
GET /workspaces/{workspace_id}/drift
```

Returns drift report comparing workspace to main.

**Query Parameters:**
- `analyze=true` — Include AI analysis (slower)
- `include_content=true` — Include file contents for overlaps

**Response:**
```json
{
  "drift": {
    "id": "drift-abc123",
    "workspace_id": "ws-123",
    "workspace_name": "feature-auth",
    "base_snapshot_id": "snap-100",
    "main_snapshot_id": "snap-105",
    "workspace_only": [
      { "path": "src/auth/login.ts", "change_type": "added" }
    ],
    "main_only": [
      { "path": "src/config/env.ts", "change_type": "modified" }
    ],
    "overlapping": [
      {
        "path": "src/api/client.ts",
        "workspace_change": { "path": "src/api/client.ts", "change_type": "modified" },
        "main_change": { "path": "src/api/client.ts", "change_type": "modified" }
      }
    ],
    "total_changes": 3,
    "overlap_count": 1
  }
}
```

### Analyze Drift (AI)

```
POST /workspaces/{workspace_id}/drift/analyze
```

Triggers AI analysis of overlapping files.

**Request Body:**
```json
{
  "files": ["src/api/client.ts"],  // Optional: specific files only
  "model": "fast"  // "fast" (haiku) or "thorough" (sonnet)
}
```

**Response:**
```json
{
  "analysis": {
    "risk_level": "medium",
    "auto_mergeable_count": 0,
    "needs_review_count": 1,
    "conflict_count": 0,
    "summary": "1 file needs review: src/api/client.ts has overlapping changes to error handling.",
    "recommended_action": "review_sync",
    "file_analyses": {
      "src/api/client.ts": {
        "risk": "caution",
        "workspace_intent": "Added retry logic to API calls",
        "main_intent": "Refactored error handling to use custom error classes",
        "compatibility_explanation": "Both changes touch the error handling code but in different ways. The retry logic wraps API calls while error handling changes the catch blocks. These can likely be combined.",
        "can_auto_merge": false,
        "suggested_merge": "... merged file content ...",
        "merge_strategy": "combined",
        "confidence": 0.85
      }
    }
  }
}
```

### Preview Sync

```
POST /workspaces/{workspace_id}/drift/preview
```

Generate a preview of what sync would do.

**Request Body:**
```json
{
  "direction": "pull",
  "auto_resolve": true  // Use AI suggestions for caution files
}
```

**Response:**
```json
{
  "preview": {
    "files_to_update": [
      { "path": "src/config/env.ts", "action": "keep_main", "reason": "Only changed in main" },
      { "path": "src/api/client.ts", "action": "use_merged", "reason": "AI-merged overlapping changes" }
    ],
    "files_unchanged": [
      { "path": "src/auth/login.ts", "reason": "Only changed in workspace, not affected by pull" }
    ],
    "requires_manual": [],
    "estimated_risk": "low"
  }
}
```

### Execute Sync

```
POST /workspaces/{workspace_id}/sync
```

Execute the sync operation.

**Request Body:**
```json
{
  "direction": "pull",
  "resolutions": [
    { "path": "src/config/env.ts", "action": "keep_main" },
    { "path": "src/api/client.ts", "action": "use_merged", "merged_content": "..." }
  ],
  "create_snapshot_before": true,
  "create_snapshot_after": true
}
```

**Response:**
```json
{
  "result": {
    "success": true,
    "files_updated": 2,
    "files_skipped": 0,
    "errors": [],
    "before_snapshot_id": "snap-110",
    "after_snapshot_id": "snap-111"
  }
}
```

---

## AI Prompt Design

### File Analysis Prompt

```
You are analyzing two parallel changes to the same file to determine if they conflict.

## Base Version (common ancestor)
```
{base_content}
```

## Workspace Changes (diff from base)
```
{workspace_diff}
```

## Main Changes (diff from base)
```
{main_diff}
```

## Task

Analyze these changes and provide:

1. **Workspace Intent**: What was the workspace trying to accomplish? (1-2 sentences)

2. **Main Intent**: What was main trying to accomplish? (1-2 sentences)

3. **Compatibility Assessment**:
   - Do these changes touch the same code regions?
   - Are they semantically compatible?
   - Can they coexist without issues?

4. **Risk Level**:
   - `safe`: Changes are in different areas, can merge automatically
   - `caution`: Changes overlap but appear compatible, review suggested merge
   - `conflict`: Changes are incompatible, manual resolution needed

5. **Merge Strategy** (if not conflict):
   - `workspace_wins`: Workspace version should be kept
   - `main_wins`: Main version should be kept
   - `combined`: Both changes can be combined

6. **Suggested Merge** (if risk is safe or caution):
   Provide the merged file content that incorporates both changes.

## Output Format

Respond in JSON:
```json
{
  "workspace_intent": "...",
  "main_intent": "...",
  "compatibility_explanation": "...",
  "risk": "safe|caution|conflict",
  "can_auto_merge": true|false,
  "merge_strategy": "...",
  "suggested_merge": "...",
  "confidence": 0.0-1.0
}
```
```

### Summary Generation Prompt

```
You are summarizing a drift report between a feature workspace and the main workspace.

## Drift Statistics
- Workspace-only changes: {workspace_only_count} files
- Main-only changes: {main_only_count} files
- Overlapping changes: {overlap_count} files

## File Risk Assessments
{file_analyses_json}

## Task

Generate a concise summary (2-3 sentences) that:
1. States the overall risk level
2. Highlights the most important conflicts or concerns
3. Recommends an action

Example: "Medium risk: 2 files have overlapping changes. src/api/client.ts has compatible changes that can be auto-merged. src/auth/session.ts has conflicting session handling logic that needs manual review. Recommend reviewing the session changes before syncing."
```

---

## Smart AI Usage

### When to Use AI

| Scenario | AI Needed? | Model |
|----------|------------|-------|
| Basic drift detection | No | - |
| Counting overlapping files | No | - |
| Classifying file risk | Yes | Haiku (fast) |
| Generating merge suggestions | Yes | Sonnet (thorough) |
| Explaining conflicts | Yes | Haiku (fast) |
| Complex multi-file conflicts | Yes | Sonnet (thorough) |

### Optimization Strategies

1. **Lazy Analysis**: Only analyze when user requests or opens drift panel
2. **Incremental Analysis**: Re-analyze only changed files
3. **Caching**: Cache analysis results until either side changes
4. **Tiered Models**:
   - Use Haiku for initial classification
   - Use Sonnet only for complex merges
5. **Batch Processing**: Analyze multiple files in single API call
6. **Skip Obvious Cases**:
   - File only changed in one side → no AI needed
   - Identical changes → auto-merge without AI
   - Binary files → mark as conflict without AI

### Cost Estimation

```
Per drift analysis (10 overlapping files):
- Classification (Haiku): ~1K tokens × 10 = 10K tokens ≈ $0.003
- Merge generation (Sonnet): ~5K tokens × 3 = 15K tokens ≈ $0.05
- Total: ~$0.05 per analysis

Optimization: Skip files with low overlap, batch similar files
```

---

## Snapshot Comparison Algorithm

### Finding the Base Snapshot

```typescript
async function findBaseSnapshot(
  workspaceId: string,
  mainWorkspaceId: string
): Promise<Snapshot | null> {
  // Get workspace's tracked base
  const workspace = await getWorkspace(workspaceId);

  // The base is the snapshot the workspace was created from
  // or the last sync point
  return workspace.base_snapshot_id
    ? await getSnapshot(workspace.base_snapshot_id)
    : null;
}
```

### Computing Drift

```typescript
async function computeDrift(
  baseSnapshot: Snapshot,
  workspaceSnapshot: Snapshot,
  mainSnapshot: Snapshot
): Promise<DriftReport> {
  // Get file manifests
  const baseFiles = await getManifest(baseSnapshot.manifest_hash);
  const workspaceFiles = await getManifest(workspaceSnapshot.manifest_hash);
  const mainFiles = await getManifest(mainSnapshot.manifest_hash);

  // Compute changes from base to workspace
  const workspaceChanges = diffManifests(baseFiles, workspaceFiles);

  // Compute changes from base to main
  const mainChanges = diffManifests(baseFiles, mainFiles);

  // Find overlapping paths
  const workspacePaths = new Set(workspaceChanges.map(c => c.path));
  const mainPaths = new Set(mainChanges.map(c => c.path));

  const overlappingPaths = [...workspacePaths].filter(p => mainPaths.has(p));

  return {
    workspace_only: workspaceChanges.filter(c => !mainPaths.has(c.path)),
    main_only: mainChanges.filter(c => !workspacePaths.has(c.path)),
    overlapping: overlappingPaths.map(path => ({
      path,
      workspace_change: workspaceChanges.find(c => c.path === path)!,
      main_change: mainChanges.find(c => c.path === path)!,
    })),
  };
}

function diffManifests(
  base: FileManifest,
  current: FileManifest
): FileChange[] {
  const changes: FileChange[] = [];

  // Find added and modified
  for (const [path, entry] of Object.entries(current.files)) {
    const baseEntry = base.files[path];
    if (!baseEntry) {
      changes.push({ path, change_type: 'added', hash: entry.hash });
    } else if (baseEntry.hash !== entry.hash) {
      changes.push({ path, change_type: 'modified', hash: entry.hash });
    }
  }

  // Find deleted
  for (const path of Object.keys(base.files)) {
    if (!current.files[path]) {
      changes.push({ path, change_type: 'deleted' });
    }
  }

  return changes;
}
```

---

## Merge/Resolution Logic

### Three-Way Merge

```typescript
async function threeWayMerge(
  basePath: string,
  workspacePath: string,
  mainPath: string,
  file: OverlappingFile,
  analysis: FileConflictAnalysis
): Promise<MergeResult> {
  // If AI provided a suggested merge and we trust it
  if (analysis.can_auto_merge && analysis.suggested_merge) {
    return {
      success: true,
      content: analysis.suggested_merge,
      strategy: 'ai_merged',
    };
  }

  // For conflicts, we need manual intervention
  if (analysis.risk === 'conflict') {
    return {
      success: false,
      conflict: true,
      base_content: file.base_content,
      workspace_content: file.workspace_content,
      main_content: file.main_content,
      explanation: analysis.compatibility_explanation,
    };
  }

  // For caution, provide suggestion but require review
  return {
    success: false,
    needs_review: true,
    suggested_content: analysis.suggested_merge,
    explanation: analysis.compatibility_explanation,
  };
}
```

### Applying Resolutions

```typescript
async function applySync(
  workspace: Workspace,
  resolutions: FileResolution[]
): Promise<SyncResult> {
  const errors: string[] = [];
  let updated = 0;
  let skipped = 0;

  for (const resolution of resolutions) {
    try {
      switch (resolution.action) {
        case 'keep_main':
          // Copy main's version to workspace
          await copyFileFromMain(workspace, resolution.path);
          updated++;
          break;

        case 'keep_workspace':
          // Keep workspace version (no action needed for pull)
          skipped++;
          break;

        case 'use_merged':
          // Write the merged content
          await writeFile(workspace, resolution.path, resolution.merged_content!);
          updated++;
          break;

        case 'skip':
          skipped++;
          break;
      }
    } catch (err) {
      errors.push(`${resolution.path}: ${err.message}`);
    }
  }

  // Update workspace's base snapshot to main's current
  await updateWorkspaceBase(workspace.id, mainSnapshot.id);

  return { success: errors.length === 0, files_updated: updated, files_skipped: skipped, errors };
}
```

---

## UI/UX Design

### Sidebar Drift Indicator

```
┌──────────────────┐
│ PROJECTS         │
│ ───────────      │
│ ▼ my-app         │
│   ● main         │
│   ○ feature  ⚠️3 │  ← Badge shows drift count
│   ○ bugfix   ✓   │  ← Checkmark = synced
│   ○ experiment ⚠️12
└──────────────────┘
```

### Workspace Detail - Drift Section

```
┌─────────────────────────────────────────────────────────────────┐
│  Workspace: feature-auth                                        │
│  Base: main @ 3 days ago                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ⚠️ DRIFT DETECTED                              [Sync with Main] │
│                                                                  │
│  3 files have diverged from main                                │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ ✓ src/api/routes.ts                              SAFE     │ │
│  │   Only changed in main • Will be pulled in                 │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ ⚠️ src/api/client.ts                            CAUTION   │ │
│  │   Both sides modified error handling                       │ │
│  │   AI: "Changes appear compatible"      [View Merge]        │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ ❌ src/config/session.ts                       CONFLICT   │ │
│  │   Incompatible session timeout changes                     │ │
│  │   [Keep Mine] [Keep Main] [Manual Merge]                   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Merge Preview Modal

```
┌─────────────────────────────────────────────────────────────────┐
│  Merge Preview: src/api/client.ts                    [×]        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────┬─────────────────────────────────────┐ │
│  │ WORKSPACE           │ MAIN                                │ │
│  ├─────────────────────┼─────────────────────────────────────┤ │
│  │ async function      │ async function                      │ │
│  │ fetchData() {       │ fetchData() {                       │ │
│  │+  for (let i = 0;   │   try {                             │ │
│  │+    i < 3; i++) {   │     const res = await              │ │
│  │     try {           │       fetch(url);                   │ │
│  │       const res =   │-    return res.json();              │ │
│  │         await       │+    if (!res.ok) {                  │ │
│  │         fetch(url); │+      throw new ApiError(          │ │
│  │       return res;   │+        res.status);                │ │
│  │+    } catch (e) {   │+    }                               │ │
│  │+      if (i === 2)  │+    return res.json();              │ │
│  │+        throw e;    │   } catch (e) {                     │ │
│  │+    }               │+    throw new ApiError(e);          │ │
│  │+  }                 │   }                                 │ │
│  │ }                   │ }                                   │ │
│  └─────────────────────┴─────────────────────────────────────┘ │
│                                                                  │
│  AI Analysis:                                                   │
│  "Workspace added retry logic, main added custom error class.   │
│   These can be combined: retry with ApiError on final failure." │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ SUGGESTED MERGE                                             ││
│  │                                                             ││
│  │ async function fetchData() {                                ││
│  │   for (let i = 0; i < 3; i++) {                            ││
│  │     try {                                                   ││
│  │       const res = await fetch(url);                        ││
│  │       if (!res.ok) {                                       ││
│  │         throw new ApiError(res.status);                    ││
│  │       }                                                    ││
│  │       return res.json();                                   ││
│  │     } catch (e) {                                          ││
│  │       if (i === 2) throw new ApiError(e);                  ││
│  │     }                                                      ││
│  │   }                                                        ││
│  │ }                                                          ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  [Use Suggested Merge]  [Edit Manually]  [Keep Workspace]       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Sync Confirmation

```
┌─────────────────────────────────────────────────────────────────┐
│  Sync feature-auth with main                         [×]        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  This will apply the following changes:                         │
│                                                                  │
│  ✓ Pull 2 files from main                                      │
│  ✓ Auto-merge 1 file                                           │
│  ⚠️ Skip 1 conflicting file (resolve manually after)            │
│                                                                  │
│  ☑ Create snapshot before sync                                  │
│  ☑ Create snapshot after sync                                   │
│                                                                  │
│           [Cancel]                    [Sync Now]                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Detection (No AI)
- [ ] Add `base_snapshot_id` tracking to workspace
- [ ] Implement snapshot comparison algorithm
- [ ] Create drift report API endpoint
- [ ] Add drift indicator to sidebar UI
- [ ] Basic drift report display on workspace page

### Phase 2: Risk Analysis (AI)
- [ ] Design and test AI prompts
- [ ] Implement file analysis endpoint
- [ ] Add risk classification UI (safe/caution/conflict)
- [ ] Generate human-readable explanations
- [ ] Caching layer for analysis results

### Phase 3: Resolution (AI)
- [ ] Implement merge suggestion generation
- [ ] Build merge preview UI
- [ ] Create sync execution endpoint
- [ ] Add resolution action buttons
- [ ] Snapshot before/after sync

### Phase 4: Polish
- [ ] Batch file analysis for performance
- [ ] Background drift checking
- [ ] Notifications for high drift
- [ ] Keyboard shortcuts for common actions
- [ ] Undo sync capability

---

## Open Questions

1. **Sync Direction**: Should we support push (workspace→main) or only pull (main→workspace)?
   - Current assumption: Both, but pull is primary

2. **Automatic Sync**: Should we auto-sync safe files without user confirmation?
   - Current assumption: No, always require confirmation

3. **Conflict Markers**: Should we support git-style conflict markers for manual resolution?
   - Current assumption: Yes, as fallback

4. **Multi-Workspace Conflicts**: What if two workspaces both want to sync to main?
   - Current assumption: First-come-first-served, second sees updated main

5. **Large Files**: How to handle large binary files?
   - Current assumption: Skip AI analysis, simple overwrite options only
