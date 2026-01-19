# Fastest - Product Design Document

## Vision

Fastest is an agentic programming platform designed for **parallel, isolated workstreams**. The core insight is that modern AI-assisted development benefits from:

1. **Context isolation** - work on multiple features without interference
2. **Conversation-driven development** - natural back-and-forth with an AI agent
3. **Production safety** - a protected main workspace that's always deployable
4. **Proactive intelligence** - background agents that catch problems early

---

## Core Concepts

### Mental Model

```
Project
  └── Workspaces (isolated environments, each with its own conversation)
        ├── main (special: production-ready, deploy target)
        ├── feature-auth (branched from main, working on auth)
        └── fix-performance (branched from main, independent work)
              └── Conversation (1:1 with workspace, backed by Durable Object)
                    └── Messages (individual prompt → response turns)
                          └── Checkpoints (internal rollback points)
```

### Key Abstractions

| Concept | Definition | Analogy |
|---------|------------|---------|
| **Project** | Top-level container for related work | Git repository |
| **Workspace** | Isolated file environment + conversation | Git worktree + terminal session |
| **Conversation** | The dialogue between user and agent | Chat thread |
| **Message** | Single turn: one prompt → one agent response | Chat message pair |
| **Commit** | Point-in-time snapshot of code state | Git commit |
| **Checkpoint** | Internal rollback point per message | Undo history |
| **Main Workspace** | Special workspace representing production state | `main` branch |

### Why Workspaces = Worktrees

CLI agents like Claude Code have an "amnesia" problem: they track the current working directory, not git branches. When you switch branches, the agent loses all context about what it was working on. The recommended solution is git worktrees - separate directories for each branch.

Our **workspace model solves this by design**:
- Each workspace is an isolated file environment (like a worktree)
- Each workspace has exactly ONE conversation tied to it
- Switching workspaces = switching both files AND conversation context
- No "amnesia" - the agent always knows what it was working on

### Design Decisions

1. **Workspace = Conversation (1:1)**: Each workspace has exactly one ongoing conversation. The conversation history IS the message history. Switching workspaces switches context entirely.

2. **Messages are conversation turns**: A Message is created when the user sends a prompt. The agent executes, produces output, potentially modifies files. The next prompt creates a new Message.

3. **UI decoupled from execution**: Users can switch workspaces while messages run. Messages can be queued. The interface never blocks on agent execution.

4. **Main is special**: The main workspace has additional protections, is the target for merges, and may have deployment integrations.

5. **Clear = Visual Reset**: "Clear conversation" clears messages from the UI but the underlying session continues. Optional: create a code commit on clear.

---

## Session Architecture

### Two Lifecycles

Understanding the separation between sandbox and session lifecycles is crucial:

```
┌─────────────────────────────────────────────────────────────┐
│                    SESSION LIFECYCLE                         │
│  (Persistent - survives sandbox death, stored in DO)        │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              SANDBOX LIFECYCLE                       │    │
│  │  (Ephemeral - can die after idle timeout)           │    │
│  │                                                      │    │
│  │  • Cloudflare Container/Worker                      │    │
│  │  • OpenCode serve process                           │    │
│  │  • File system state                                │    │
│  │  • Running computations                             │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Survives sandbox death:                                    │
│  • Conversation history (messages)                          │
│  • OpenCode session export (for resume)                     │
│  • Last known file state (manifest)                         │
│  • Agent memory/context                                     │
└─────────────────────────────────────────────────────────────┘
```

### Durable Objects Architecture

Each **conversation** (which maps 1:1 to a workspace) gets its own Durable Object:

```
Conversation DO (ConversationSession)
├── messages: Message[]           // Full conversation history
├── opencode_session_id: string   // Current OpenCode session
├── opencode_export: string       // Serialized context for resume
├── last_manifest_hash: string    // Last known file state
└── sandbox_connection: WS?       // Active sandbox connection (if any)
```

**Why per-conversation, not per-workspace?**

Initially we considered per-workspace DOs, but conversations are the unit of state that needs persistence. If we ever needed multiple conversations per workspace, we'd want separate DOs. Since we simplified to 1:1, the distinction is moot, but the conceptual model is cleaner.

### Session Resume Flow

When a sandbox dies and needs to restart:

```
1. User sends prompt to Conversation DO
2. DO checks: do I have an active sandbox connection?
3. If no:
   a. Spin up new sandbox container
   b. Restore files from last_manifest_hash
   c. Start OpenCode with: opencode serve --continue
   d. Feed opencode_export to restore context
   e. Establish WebSocket to sandbox
4. Forward prompt to sandbox
5. Stream response back to user
6. Update opencode_export with new context
```

### Message Flow

```
User                    Conversation DO               Sandbox
  │                           │                          │
  │──── send prompt ─────────▶│                          │
  │                           │                          │
  │                           │── ensure sandbox ───────▶│
  │                           │◀── connection ready ─────│
  │                           │                          │
  │                           │── forward prompt ───────▶│
  │                           │                          │
  │◀──── stream response ─────│◀── stream response ──────│
  │                           │                          │
  │                           │── save message ──────────│ (to DO storage)
  │                           │── update export ─────────│ (for resume)
  │                           │                          │
```

### Clear Conversation Behavior

When user clicks "Clear Conversation":

1. **Visual**: All messages are hidden from the UI
2. **State**: Messages remain in DO (for potential recovery)
3. **Session**: OpenCode session continues (no context loss)
4. **Optional Commit**: If user setting enabled, create a code commit
5. **Fresh Feel**: User sees empty conversation, ready to start "fresh"

This is a **visual reset**, not a session reset. The agent still remembers everything.

---

## Data Model

### D1 Database (Persistent Storage)

```sql
-- Projects: top-level containers
projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

-- Workspaces: isolated file environments
workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  local_path TEXT,                    -- For local dev
  base_commit_id TEXT,                -- What it branched from
  is_main BOOLEAN DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

-- Commits: immutable code snapshots (like git commits)
commits (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT REFERENCES workspaces(id),
  parent_commit_id TEXT REFERENCES commits(id),
  manifest_hash TEXT NOT NULL,        -- R2 reference to file state
  message TEXT,
  created_at TEXT NOT NULL
)

-- Messages: conversation turns (denormalized from DO for querying)
messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL,                 -- 'user' | 'assistant'
  content TEXT NOT NULL,
  status TEXT DEFAULT 'pending',      -- pending, running, completed, failed
  output_commit_id TEXT,              -- Commit created by this message
  created_at TEXT NOT NULL,
  completed_at TEXT
)
```

### Durable Object State

```typescript
interface ConversationDOState {
  // Conversation history
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    created_at: string;
    completed_at?: string;
    files_changed?: string[];
    checkpoint_id?: string;          // For undo
  }>;

  // OpenCode session state
  opencode_session_id: string;
  opencode_export: string;           // Serialized for resume

  // File state
  last_manifest_hash: string;

  // Sandbox connection
  sandbox_id?: string;
  sandbox_connected: boolean;

  // User preferences
  auto_commit_on_clear: boolean;
}
```

### Potential Additions (for goodies)

```sql
drift_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  main_commit_id TEXT NOT NULL,      -- What main is at
  base_commit_id TEXT NOT NULL,      -- What workspace branched from
  files_conflicting TEXT,            -- JSON array
  severity TEXT,                     -- low, medium, high, critical
  analyzed_at TEXT NOT NULL
)

refactoring_suggestions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,                -- duplication, naming, structure, security, performance
  severity TEXT NOT NULL,            -- info, recommended, critical
  description TEXT NOT NULL,
  affected_files TEXT,               -- JSON array
  suggested_prompt TEXT,             -- Pre-filled message prompt
  status TEXT DEFAULT 'pending',     -- pending, applied, dismissed
  created_at TEXT NOT NULL
)

test_coverage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  coverage_percent REAL,
  uncovered_files TEXT,              -- JSON array
  generated_tests TEXT,              -- JSON array of file paths
  last_evolved_at TEXT
)
```

---

## UI Design

### Layout Philosophy

- **Prompt-centric**: The input is always visible and ready
- **Minimal chrome**: No sidebars, dropdowns for navigation
- **Context near input**: Project/workspace selectors adjacent to prompt
- **Suggestions drive velocity**: One-click actions based on state
- **Conversation is primary**: History scrolls above the prompt

### Main View Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  Fastest                                            [user ▾]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                                                           │  │
│  │  (Conversation History - infinite scroll, newest at bottom)│  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ You                                                 │  │  │
│  │  │ Add a login form with email and password            │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ Agent                                    ✓ Completed │  │  │
│  │  │                                                     │  │  │
│  │  │ I'll create a login form component with email and   │  │  │
│  │  │ password fields, including validation...            │  │  │
│  │  │                                                     │  │  │
│  │  │ [Created] src/components/LoginForm.tsx              │  │  │
│  │  │ [Modified] src/App.tsx                              │  │  │
│  │  │ [Modified] src/routes.ts                            │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ You                                                 │  │  │
│  │  │ Also add Google OAuth                               │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ Agent                                    ● Running   │  │  │
│  │  │                                                     │  │  │
│  │  │ Adding Google OAuth integration...                  │  │  │
│  │  │ ▌ (streaming output)                                │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Continue the conversation...                           ↵  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  [my-project ▾] / [feature-auth ▾]  ⚠️ 2    💡 3    [+ new]     │
│                                                                 │
│  [Sync with main] [Add tests] [Merge to main] [Run build]       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Component Breakdown

#### 1. Header
- Logo/brand
- User menu (dropdown: settings, logout)
- Minimal, stays out of the way

#### 2. Conversation Area
- Scrollable, cursor-based infinite scroll
- Descending order (newest at bottom, natural chat flow)
- Each message rendered as a message pair:
  - User message (the prompt)
  - Agent message (output + file changes + status)
- Status indicators: pending, running (with streaming), completed, failed

#### 3. Prompt Input
- Always visible at bottom of conversation
- Large, comfortable input area
- Submit on Enter (Shift+Enter for newline)
- Enabled during message run (queues next message)

#### 4. Context Bar (below prompt)
- **Project selector**: Dropdown, shows recent projects
- **Workspace selector**: Dropdown, shows workspaces for current project
  - Visual indicators for workspace status (has changes, running message, etc.)
  - "main" workspace marked distinctly with "prod" badge
- **Status badges**:
  - ⚠️ Drift warnings (clickable to expand)
  - 💡 Refactoring suggestions (clickable to expand)
- **New workspace button**: Quick create

#### 5. Suggestions Bar
- Horizontal row of action buttons
- Contextual based on:
  - Workspace state (has uncommitted changes → "Create commit")
  - Last message status (failed → "Retry")
  - Drift status (behind main → "Sync with main")
  - Refactoring suggestions (→ "Apply refactor: ...")
  - Generic actions (Run tests, Deploy, etc.)
- Suggestions are clickable → either execute immediately or pre-fill prompt

### States and Transitions

#### Empty State (new workspace)
```
┌───────────────────────────────────────────────────────────┐
│                                                           │
│                    No conversation yet                    │
│                                                           │
│         Start by describing what you want to build        │
│                                                           │
└───────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────┐
│ What do you want to build?                             ↵  │
└───────────────────────────────────────────────────────────┘
```

#### Message Running State
- Streaming output in agent message
- Pulsing/animated status indicator
- Prompt input enabled with queuing (shows "Will run after current message")

#### Message Failed State
- Error displayed in agent message
- Suggestions include "Retry" and "Try different approach"

#### Returning User State
- Last active project + workspace auto-selected (from localStorage)
- Conversation history loaded (recent messages)
- If last message was incomplete → "Continue" suggestion prominent

### Workspace Selector Detail

```
┌─────────────────────────────────┐
│ Workspaces                      │
├─────────────────────────────────┤
│ ● main                    prod  │
│   Last: 2 hours ago             │
├─────────────────────────────────┤
│ ○ feature-auth          ⚠️ 2    │
│   3 uncommitted changes         │
├─────────────────────────────────┤
│ ○ fix-performance      ● run    │
│   Message running...            │
├─────────────────────────────────┤
│ + New workspace                 │
└─────────────────────────────────┘
```

- `●` = selected
- `○` = not selected
- `⚠️ 2` = drift warnings
- `● run` = message currently running
- `prod` badge on main

### Conversation Actions

```
┌─────────────────────────────────┐
│ ⋮  Conversation                 │
├─────────────────────────────────┤
│ Clear conversation              │  ← Visual reset, optional commit
│ Create commit                   │  ← Manual code snapshot
│ Export conversation             │  ← Download as markdown
├─────────────────────────────────┤
│ ⚙️ Settings                     │
│   □ Auto-commit on clear        │  ← User preference
└─────────────────────────────────┘
```

---

## Suggestion Engine

### Sources of Suggestions

1. **Workspace State**
   - Has uncommitted changes → "Create commit"
   - Has changes vs main → "Merge to main"
   - Is behind main → "Sync with main"

2. **Last Message**
   - Failed → "Retry", "Try different approach"
   - Completed with TODOs → "Continue: [next step]"
   - Created new files → "Add tests for [file]"

3. **Background Agents** (Goodies)
   - Drift detection → "Sync with main (2 conflicts)"
   - Refactoring → "Extract helper from [files]"
   - Test coverage → "Generate tests for [uncovered]"

4. **Project Patterns**
   - Has CI config → "Run build"
   - Has deploy config → "Deploy to [env]"
   - Has test config → "Run tests"

### Suggestion Priority

1. **Blockers** (red): Failed message retry, critical drift
2. **Warnings** (yellow): Significant drift, quality issues
3. **Recommendations** (blue): Refactoring, test coverage
4. **Convenience** (gray): Run tests, deploy, etc.

---

## Goodies (Background Agents)

### 1. Drift Detection Agent

**Purpose**: Warn when a feature workspace has diverged significantly from main, making future merges difficult.

**Trigger**:
- When main gets a new commit
- Periodically (every N minutes)
- On-demand when user opens workspace

**Analysis**:
1. Compare main's current state vs workspace's `base_commit_id`
2. Identify files changed in main since branching
3. Cross-reference with files changed in workspace
4. Classify conflicts:
   - **Textual**: Same lines modified (certain conflict)
   - **Semantic**: Related code changed (likely conflict)
   - **Structural**: Renamed/moved files (complex merge)

**Output**:
- Severity score (low/medium/high/critical)
- List of potentially conflicting files
- Suggested action (sync now, review diff, etc.)

**UI Integration**:
- Badge on workspace selector: `⚠️ 3`
- Expandable card in conversation area
- Suggestion: "Sync with main (3 potential conflicts)"

### 2. Refactoring Suggestion Agent

**Purpose**: Continuously analyze code quality and suggest improvements.

**Trigger**:
- After message completes (analyze new code)
- On workspace idle (deep analysis)
- Before merge to main (quality gate)

**Analysis Categories**:
- **Duplication**: Similar code blocks that could be extracted
- **Naming**: Inconsistent naming conventions
- **Structure**: Files too large, poor organization
- **Patterns**: Not following project conventions
- **Security**: Potential vulnerabilities
- **Performance**: Obvious inefficiencies

**Output**:
- Severity (info/recommended/critical)
- Affected files
- Description of issue
- Pre-filled prompt to fix it

**UI Integration**:
- Badge on workspace selector: `💡 5`
- Expandable card showing suggestions
- "Apply refactor" button → creates message with suggested prompt

### 3. Auto-Evolving Unit Tests Agent

**Purpose**: Automatically generate and maintain unit tests as code evolves.

**Trigger**:
- After message completes (if code changed)
- On-demand ("Generate tests" action)
- Scheduled (nightly coverage analysis)

**Behavior**:
1. Analyze changed files
2. Identify untested or undertested code paths
3. Generate appropriate unit tests
4. Update existing tests if interfaces changed
5. Run tests to verify they pass

**User Control**:
- Enable/disable per workspace
- Configure coverage targets
- Review generated tests before committing
- Exclude files/patterns from auto-testing

**Output**:
- Generated test files
- Coverage delta (before/after)
- Test results (pass/fail)

**UI Integration**:
- Coverage indicator in workspace selector
- "Review generated tests" suggestion
- "Accept tests" / "Modify" / "Reject" actions

### 4. Project Architecture Diagram Agent

**Purpose**: Automatically generate and maintain visual ASCII/text diagrams showing project architecture, file structure, and component relationships.

**Trigger**:
- After significant code changes (new files, new modules)
- On-demand ("Show architecture" action)
- Periodically (weekly refresh)

**Diagram Types**:
- **File tree**: Project structure with annotations
- **Component graph**: How components/modules connect
- **Data flow**: How data moves through the system
- **API map**: Endpoints and their relationships
- **Dependency graph**: Internal and external dependencies

**Output**:
```
┌─────────────────────────────────────────────────────────┐
│                    fastest-app                          │
├─────────────────────────────────────────────────────────┤
│  ┌─────────┐     ┌─────────┐     ┌─────────┐           │
│  │   Web   │────▶│   API   │────▶│   DB    │           │
│  │ (React) │     │ (Hono)  │     │  (D1)   │           │
│  └─────────┘     └────┬────┘     └─────────┘           │
│                       │                                 │
│                       ▼                                 │
│                 ┌─────────┐                             │
│                 │ Sandbox │                             │
│                 │(Workers)│                             │
│                 └─────────┘                             │
└─────────────────────────────────────────────────────────┘
```

**User Control**:
- Choose diagram types to generate
- Customize detail level (high-level vs detailed)
- Annotate with custom notes
- Export as markdown/image

**UI Integration**:
- "Show architecture" command in suggestions
- Collapsible architecture panel
- Updates highlighted when structure changes

---

## Implementation Phases

### Phase 1: Core Conversation UI ✅
- [x] Redesign workspace detail page as conversation view
- [x] Implement prompt input with message creation
- [x] ConversationMessage component for message display
- [x] PromptInput component with auto-resize
- [x] Basic suggestions (SuggestionsBar component)
- [ ] Message status streaming (running state with live output)
- [ ] Conversation history with infinite scroll (cursor-based pagination)

### Phase 2: Navigation & Context
- [x] Project selector dropdown (ContextBar)
- [x] Workspace selector dropdown with status indicators
- [x] Main workspace visual distinction ("prod" badge)
- [ ] "New workspace" flow (modal)
- [ ] Returning user experience (restore last context from localStorage)
- [ ] Workspace creation API integration

### Phase 3: Session Architecture
- [ ] Conversation Durable Object implementation
- [ ] Message storage in DO
- [ ] Sandbox connection management
- [ ] OpenCode session resume flow
- [ ] Session export/restore for context preservation

### Phase 4: Clear Conversation & Commits
- [ ] "Clear conversation" action (visual reset)
- [ ] User setting: auto-commit on clear
- [ ] Manual "Create commit" action
- [ ] Commit history view

### Phase 5: Smart Suggestions
- [ ] Suggestion engine based on workspace state
- [ ] Last message analysis for "continue" suggestions
- [ ] Project pattern detection (CI, deploy, test configs)
- [ ] Suggestion priority and ordering

### Phase 6: Drift Detection
- [ ] Background agent for drift analysis
- [ ] Drift severity calculation
- [ ] UI integration (badges, cards, suggestions)
- [ ] "Sync with main" action

### Phase 7: Refactoring Agent
- [ ] Code analysis triggers
- [ ] Suggestion generation
- [ ] UI integration
- [ ] "Apply refactor" message creation

### Phase 8: Auto-Evolving Tests
- [ ] Test generation on code change
- [ ] Coverage tracking
- [ ] User controls (enable/disable, targets)
- [ ] Review flow for generated tests

---

## Open Questions

1. **Queuing behavior**: When a message is running, should new prompts queue or be blocked?
   - **Decision**: Allow queuing, show queue indicator

2. **Conversation persistence**: How much history to keep? Forever? Configurable?
   - **Decision**: Keep all in DO, use pagination for performance

3. **Commit frequency**: Auto-commit after each message? User-triggered only?
   - **Decision**: User-triggered, with option to auto-commit on clear

4. **Main workspace protection**: Prevent direct prompts to main? Require merge from feature?
   - **Decision**: Allow direct work on main, but show warning for risky operations

5. **Multi-user**: How do workspaces work with multiple team members?
   - **Deferred**: Focus on single-user first

6. **Undo granularity**: Can users undo to any checkpoint, or just the last message?
   - **Decision**: Start with last-message undo, expand later if needed

---

## Terminology Reference

| Old Term | New Term | Notes |
|----------|----------|-------|
| Job | Message | Single conversation turn |
| Snapshot | Commit | Immutable code state |
| - | Checkpoint | Internal undo point per message |
| Session | Conversation | 1:1 with workspace, backed by DO |

---

## Success Metrics

1. **Time to first prompt**: How quickly can a returning user start working?
2. **Context switch time**: How quickly can user move between workspaces?
3. **Merge success rate**: Do drift warnings reduce merge conflicts?
4. **Suggestion acceptance rate**: Are suggestions actually useful?
5. **Test coverage trend**: Does auto-test generation improve coverage?
6. **Resume success rate**: How often does session resume work correctly?
