# Atlas Implementation Plan

> A project intelligence model that powers semantic understanding across the entire application.

---

## Vision

Atlas is not just a view—it's the **project model** itself. The Atlas View is one interface to this model, but the model serves the entire application: coding agent sessions, build suggestions, action items, deployments, and future collaboration features.

**Core Insight**: We already have the data (code + conversations with coding agents). We don't need to pre-build a rigid knowledge structure. We index the data, and let the LLM generate views on demand based on context and questions.

### References

- [Building a Unified Model of Software Systems](https://antimetal.com/resources/blog/building-a-unified-model-of-software-systems) - Antimetal's four-layer architecture (Structural, Temporal, Causal, Semantic)
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) - Just-in-time retrieval, minimum high-signal tokens

---

## Part 1: The Project Model

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│                      PROJECT MODEL (Atlas Core)                     │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │
│  │  Knowledge  │  │   Event     │  │   Context   │  │  Insight  │  │
│  │   Graph     │  │   Stream    │  │   Engine    │  │  Engine   │  │
│  │             │  │             │  │             │  │           │  │
│  │ concepts    │  │ code changed│  │ what's      │  │ what      │  │
│  │ relations   │  │ conversation│  │ relevant    │  │ should    │  │
│  │ decisions   │  │ deployed    │  │ right now?  │  │ happen?   │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Atlas View  │    │  Coding Agent    │    │   Suggestions    │
│  (explore)   │    │  (contextual     │    │   (what to       │
│              │    │   assistance)    │    │    build next)   │
└──────────────┘    └──────────────────┘    └──────────────────┘

        ▼                        ▼                        ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ Action Items │    │   Deployments    │    │   Code Review    │
│ (tasks,      │    │   (impact,       │    │   (context,      │
│  decisions)  │    │    risk)         │    │    rationale)    │
└──────────────┘    └──────────────────┘    └──────────────────┘
```

### What the Model Captures

| Aspect | What It Captures | How It's Used |
|--------|------------------|---------------|
| **Structure** | Modules, functions, dependencies | Navigation, impact analysis |
| **Semantics** | What code does, capabilities | Natural language queries |
| **Decisions** | Why things exist, tradeoffs made | Context during coding, reviews |
| **Patterns** | How problems are solved here | Consistency, suggestions |
| **Gaps** | What's missing, incomplete, fragile | Build suggestions |
| **Activity** | What's changing, who's working where | Coordination, priorities |
| **Intent** | What user is trying to achieve | Contextual assistance |

### Core Queries the Model Supports

```typescript
interface ProjectModel {
  // Exploration (Atlas View)
  getOverview(): ProjectOverview
  getConceptsByLayer(): LayeredConcepts
  getConceptDetail(conceptId: string): ConceptDetail
  query(question: string): AtlasResponse

  // Contextual (Coding Agent)
  getRelevantContext(currentFile: string, task: string): Context
  getRelatedDecisions(codeRange: CodeRange): Decision[]

  // Suggestions (What to build)
  getSuggestions(): Suggestion[]
  getGaps(): Gap[]
  getImprovements(): Improvement[]

  // Actions (Tasks, decisions)
  getActionItems(): ActionItem[]
  getPendingDecisions(): Decision[]
  getBlockers(): Blocker[]

  // Deployments
  getChangeImpact(changes: Change[]): ImpactAnalysis
  getRiskAssessment(deployment: Deployment): RiskAssessment

  // Code Review (future)
  getChangeContext(pr: PullRequest): ChangeContext
  getRelevantHistory(files: string[]): HistoryContext

  // Diagram Generation
  generateDiagram(context: DiagramContext): DiagramData
}
```

### How the Model Stays Current

The model evolves with the project through events:

```
Events that update the model:
─────────────────────────────
• Conversation with coding agent → decisions, rationale, intent
• Code change                    → structure, relationships
• Commit                         → activity, changelog
• Deployment                     → state, history
• User feedback                  → corrections, preferences
```

---

## Part 2: Concepts, Layers, and Lenses

These three ideas work together to organize understanding:

### Concepts

**Concepts are the entities in the model** — the "what exists."

Examples:
- "Deployment Engine" (a system)
- "JWT Validation" (a module)
- "Multi-cloud support decision" (a decision)
- "User session management" (a capability)

### Layers

**Layers organize concepts by abstraction level** — the "where it lives."

```
┌─────────────────────────────────────────────────────────┐
│  NARRATIVE    │  Decisions, rationale, project history  │
├───────────────┼─────────────────────────────────────────┤
│  SYSTEM       │  High-level components, boundaries      │
├───────────────┼─────────────────────────────────────────┤
│  CAPABILITY   │  Features, behaviors, what it does      │
├───────────────┼─────────────────────────────────────────┤
│  MODULE       │  Code modules, classes, services        │
├───────────────┼─────────────────────────────────────────┤
│  CODE         │  Functions, methods, implementations    │
└───────────────┴─────────────────────────────────────────┘
```

A concept like "Authentication" might span multiple layers:
- Narrative: "We chose JWT for stateless auth"
- System: "Auth System"
- Capability: "User session management"
- Module: "JWTValidator"
- Code: "validateToken()"

### Lenses

**Lenses are perspectives for viewing any concept** — the "how to view it."

| Lens | Question It Answers | What It Shows |
|------|---------------------|---------------|
| **Code** | What's the implementation? | Actual source code |
| **Rationale** | Why does this exist? | Decisions from conversations |
| **Behavior** | How does it work? | Flow diagrams, sequences |
| **Connections** | What relates to this? | Dependencies, dependents |
| **History** | How has this evolved? | Timeline of changes |
| **Gaps** | What's missing? | Potential improvements |

Any concept can be viewed through any lens.

---

## Part 3: Atlas View UI

### Layout

Three horizontally resizable panes with minimum widths:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  project-name ▾                                               [⚙]  [?]    │
├───────────────┬────────────────────────────────────┬───────────────────────┤
│               │                                    │                       │
│     CHAT      │            MAIN VIEW               │        CANVAS         │
│    PANEL      │                                    │                       │
│               │   Home: concepts by layer          │   LLM-generated       │
│   Contextual  │          ↓                         │   diagrams            │
│   Q&A using   │   Detail: concept deep-dive        │                       │
│   current     │          ↓                         │   Accumulates as      │
│   context     │   Detail: drill deeper...          │   user explores       │
│               │                                    │                       │
│               │   (stack-based navigation)         │   Clears on home      │
│               │                                    │                       │
├───────────────┼────────────────────────────────────┼───────────────────────┤
│  ◀─────────▶  │  ◀──────────────────────────────▶  │  ◀─────────────────▶  │
│   resizable   │           resizable                │      resizable        │
└───────────────┴────────────────────────────────────┴───────────────────────┘
```

### State Persistence

When user navigates away from Atlas:
- Navigation stack preserved
- Canvas diagrams preserved
- Chat history preserved

When they return, they continue exactly where they left off.

---

## Part 4: Main View

The main view uses **stack-based navigation**: Home → Detail → Detail → ... with back navigation.

### Home State: Concepts by Layer

When user first opens Atlas, they see all concepts organized by abstraction layer.

```
┌────────────────────────────────────────────┐
│  ☰ Atlas                          [⟳]     │
├────────────────────────────────────────────┤
│                                            │
│  SYSTEMS                                   │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ Deployment Engine                   │   │
│  │ Orchestrates infrastructure changes │   │
│  │ ─────────────────────────────────── │   │
│  │ 12 modules · 4 decisions · 2d ago   │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ Snapshot System                     │   │
│  │ Manages state capture and rollback  │   │
│  │ ─────────────────────────────────── │   │
│  │ 8 modules · 2 decisions · 5d ago    │   │
│  └────────────────────────────────────┘   │
│                                            │
│  CAPABILITIES                              │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ Multi-provider Support              │   │
│  │ Deploy to AWS, GCP, Azure           │   │
│  │ ─────────────────────────────────── │   │
│  │ 3 modules · 1 decision · 2d ago     │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ Config Management                   │   │
│  │ Handle user configurations          │   │
│  │ ─────────────────────────────────── │   │
│  │ 6 modules · 3 decisions · 1w ago    │   │
│  └────────────────────────────────────┘   │
│                                            │
│  MODULES                                   │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ Deployer                            │   │
│  │ Core deployment orchestrator        │   │
│  │ ─────────────────────────────────── │   │
│  │ 4 functions · 1 decision · 2d ago   │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ ProviderAdapter                     │   │
│  │ Abstract interface for cloud APIs   │   │
│  │ ─────────────────────────────────── │   │
│  │ 6 functions · 2 decisions · 3d ago  │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ...                                       │
│                                            │
└────────────────────────────────────────────┘
```

#### Concept Card Metadata

Each concept card shows:

| Field | Description | Example |
|-------|-------------|---------|
| **Name** | Primary identifier | "Deployment Engine" |
| **Description** | One-line summary | "Orchestrates infrastructure changes" |
| **Layer** | Used for grouping | Systems, Capabilities, Modules |
| **Child count** | What it contains | "12 modules" or "4 functions" |
| **Decision count** | Captured rationale | "4 decisions" |
| **Last activity** | Recency | "2d ago" |

Concepts are continuously generated and updated by the background indexing process.

### Detail State: Concept Deep-Dive

Clicking a concept opens its detail view in place (pushes to navigation stack).

```
┌────────────────────────────────────────────┐
│  [← Back]  [⌂ Home]                        │
├────────────────────────────────────────────┤
│                                            │
│  SYSTEM                                    │
│  # Deployment Engine                       │
│                                            │
│  Orchestrates infrastructure provisioning  │
│  across multiple cloud providers. Handles  │
│  the full lifecycle from config parsing    │
│  to resource creation.                     │
│                                            │
│  ──────────────────────────────────────    │
│                                            │
│  ## Why It Exists                          │
│                                            │
│  Created to abstract deployment logic      │
│  from provider-specific details. Before    │
│  this, deployment code was duplicated      │
│  across CLI commands.                      │
│                                            │
│  ──────────────────────────────────────    │
│                                            │
│  ## Decisions                              │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ "Use async deployment queue"        │   │
│  │ Jan 20 · from conversation          │   │
│  │                                     │   │
│  │ We decided to queue deployments to  │   │
│  │ handle concurrent requests and      │   │
│  │ provide better progress tracking.   │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ "Provider adapter pattern"          │   │
│  │ Jan 15 · from conversation          │   │
│  │                                     │   │
│  │ Chose adapter pattern to support    │   │
│  │ multiple clouds without coupling.   │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ──────────────────────────────────────    │
│                                            │
│  ## Connections                            │
│                                            │
│  CONTAINS                                  │
│  → Deployer                  module        │
│  → ProviderAdapter           module        │
│  → DeploymentQueue           module        │
│                                            │
│  DEPENDS ON                                │
│  → Config Management         capability    │
│  → Snapshot System           system        │
│                                            │
│  USED BY                                   │
│  → CLI Deploy Command                      │
│  → API /deploy endpoint                    │
│                                            │
│  ──────────────────────────────────────    │
│                                            │
│  ## Code                                   │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ src/deploy/deployer.ts              │   │
│  │ ────────────────────────────────    │   │
│  │ export class Deployer {             │   │
│  │   private queue: DeploymentQueue;   │   │
│  │                                     │   │
│  │   async deploy(config: Config) {    │   │
│  │     const validated = await         │   │
│  │       this.validate(config);        │   │
│  │     ...                             │   │
│  │ ────────────────────────────────    │   │
│  │ [View full file]                    │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ┌────────────────────────────────────┐   │
│  │ src/deploy/queue.ts                 │   │
│  │ ────────────────────────────────    │   │
│  │ export class DeploymentQueue {      │   │
│  │   ...                               │   │
│  │ ────────────────────────────────    │   │
│  │ [View full file]                    │   │
│  └────────────────────────────────────┘   │
│                                            │
└────────────────────────────────────────────┘
```

#### Detail View Sections

| Section | Content |
|---------|---------|
| **Header** | Layer badge, name, description |
| **Why It Exists** | Synthesized rationale from conversations |
| **Decisions** | Specific decisions extracted from conversations |
| **Connections** | Contains, Depends On, Used By (all clickable) |
| **Code** | Relevant code snippets with "View full file" button |

#### Navigation

- **Clicking a linked concept** (e.g., "→ Deployer") pushes new detail view onto stack
- **[← Back]** pops the stack, returns to previous view
- **[⌂ Home]** clears stack, returns to concept list, clears canvas

### File View State

Clicking "View full file" on a code snippet temporarily replaces the canvas with the file viewer.

```
Canvas temporarily replaced:

┌───────────────────────────────────────┐
│  src/deploy/deployer.ts        [✕]   │
├───────────────────────────────────────┤
│   1  import { Provider } from './..  │
│   2  import { Config } from '../..   │
│   3                                   │
│   4  export class Deployer {         │
│   5    private queue: DeploymentQ..  │
│   6    private provider: Provider;   │
│   7                                   │
│   8    constructor(                   │
│   9      provider: Provider,         │
│  10      queue: DeploymentQueue      │
│  11    ) {                           │
│  12      this.provider = provider;   │
│  13      this.queue = queue;         │
│  14    }                             │
│  15                                   │
│  16    async deploy(config: Config)  │
│  17      // Validate configuration   │
│  18      const validated = await     │
│  19        this.validate(config);    │
│  20                                   │
│  21      // Queue the deployment     │
│  22      const job = await           │
│  23        this.queue.enqueue({      │
│  24          config: validated,      │
│  25          provider: this.provider │
│  26        });                       │
│  27                                   │
│  28      return job;                 │
│  29    }                             │
│  30                                   │
│  31    private async validate(       │
│  32      config: Config              │
│  33    ): Promise<ValidatedConfig> { │
│  34      // Validation logic...      │
│  35    }                             │
│  36  }                               │
│                                       │
└───────────────────────────────────────┘
```

- **[✕]** closes file view, restores canvas
- File view includes syntax highlighting and line numbers

---

## Part 5: Canvas View

The canvas displays **LLM-generated diagrams** that visualize the current context. It accumulates diagrams as the user explores and clears when returning to Atlas home.

### Diagram Generation

When a detail page loads or a chat question is asked, the LLM generates appropriate diagram data:

```typescript
interface DiagramData {
  id: string;
  type: 'flow' | 'dependency' | 'component' | 'sequence';
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

interface DiagramNode {
  id: string;
  label: string;
  type: 'input' | 'output' | 'process' | 'decision' | 'data' | 'component';
  description?: string;
  conceptRef?: string;  // Links to a concept (clickable)
  highlighted?: boolean; // Current focus
}

interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  type: 'flow' | 'dependency' | 'data' | 'calls';
}
```

### Diagram Types

| Type | When Used | Visual Style |
|------|-----------|--------------|
| **Flow** | "How does X work?" | Sequential arrows, process steps |
| **Dependency** | Viewing module connections | Graph with depends-on edges |
| **Component** | Viewing a system | Nested boxes showing structure |
| **Sequence** | "What happens when X?" | Timeline-style interactions |

The LLM decides which type based on context.

### Example: Flow Diagram

For the question "How does deployment work?", the LLM generates:

```json
{
  "id": "deploy-flow-1",
  "type": "flow",
  "title": "Deployment Flow",
  "nodes": [
    { "id": "1", "label": "User Config", "type": "input" },
    { "id": "2", "label": "Validator", "type": "process", "conceptRef": "validator-module" },
    { "id": "3", "label": "Deployer", "type": "process", "conceptRef": "deployer-module" },
    { "id": "4", "label": "Provider Adapter", "type": "process", "conceptRef": "provider-adapter" },
    { "id": "5", "label": "Cloud Resources", "type": "output" },
    { "id": "6", "label": "Snapshot", "type": "data", "conceptRef": "snapshot-system" }
  ],
  "edges": [
    { "from": "1", "to": "2", "label": "validates" },
    { "from": "2", "to": "3", "label": "passes config" },
    { "from": "3", "to": "4", "label": "calls provider" },
    { "from": "4", "to": "5", "label": "provisions" },
    { "from": "3", "to": "6", "label": "creates snapshot", "type": "data" }
  ]
}
```

Rendered:

```
┌───────────────────────────────────────┐
│  Deployment Flow                      │
├───────────────────────────────────────┤
│                                       │
│  ┌─────────────┐                     │
│  │ User Config │                     │
│  └──────┬──────┘                     │
│         │ validates                   │
│         ▼                            │
│  ┌─────────────┐                     │
│  │  Validator  │                     │
│  └──────┬──────┘                     │
│         │ passes config              │
│         ▼                            │
│  ┌─────────────┐     ┌────────────┐  │
│  │  Deployer   │────▶│  Snapshot  │  │
│  └──────┬──────┘     └────────────┘  │
│         │ calls provider             │
│         ▼                            │
│  ┌─────────────┐                     │
│  │  Provider   │                     │
│  │  Adapter    │                     │
│  └──────┬──────┘                     │
│         │ provisions                  │
│         ▼                            │
│  ┌─────────────┐                     │
│  │   Cloud     │                     │
│  │  Resources  │                     │
│  └─────────────┘                     │
│                                       │
└───────────────────────────────────────┘
```

Nodes with `conceptRef` are clickable — clicking opens that concept in the main view.

### Example: Dependency Diagram

When viewing the "Provider Adapter" module:

```
┌───────────────────────────────────────┐
│  Provider Adapter Dependencies        │
├───────────────────────────────────────┤
│                                       │
│         ┌─────────────┐              │
│         │  Deployer   │              │
│         └──────┬──────┘              │
│                │ uses                 │
│                ▼                      │
│  ┌─────────────────────────┐         │
│  │    Provider Adapter     │ ◀── current
│  └─────────────────────────┘         │
│         ╱      │      ╲              │
│        ╱       │       ╲             │
│       ▼        ▼        ▼            │
│  ┌───────┐ ┌───────┐ ┌───────┐      │
│  │  AWS  │ │  GCP  │ │ Azure │      │
│  └───────┘ └───────┘ └───────┘      │
│                                       │
└───────────────────────────────────────┘
```

### Accumulation Behavior

As the user explores, diagrams accumulate vertically in the canvas:

```
┌───────────────────────────────────────┐
│  CANVAS                        [⌂]   │
├───────────────────────────────────────┤
│                                       │
│  ┌─────────────────────────────────┐ │
│  │  Deployment Flow                 │ │
│  │  ┌───┐    ┌───┐    ┌───┐       │ │
│  │  │ A │───▶│ B │───▶│ C │       │ │
│  │  └───┘    └───┘    └───┘       │ │
│  └─────────────────────────────────┘ │
│                                       │
│  ┌─────────────────────────────────┐ │
│  │  Provider Dependencies          │ │
│  │       ┌───┐                     │ │
│  │       │ X │                     │ │
│  │      ╱    ╲                    │ │
│  │  ┌───┐    ┌───┐                │ │
│  │  │ Y │    │ Z │                │ │
│  │  └───┘    └───┘                │ │
│  └─────────────────────────────────┘ │
│                                       │
│  ┌─────────────────────────────────┐ │
│  │  Error Handling Flow            │ │
│  │  ...                            │ │
│  └─────────────────────────────────┘ │
│                                       │
│  (scrollable)                        │
│                                       │
└───────────────────────────────────────┘
```

**Accumulation rules:**
- New diagram added when navigating to a detail page
- New diagram added when chat question warrants visualization
- Diagrams scroll vertically within the canvas
- **[⌂] or navigating to Atlas home clears all diagrams**

---

## Part 6: Chat Panel

The chat panel provides contextual Q&A. It uses the current detail page and canvas content as context.

### Layout

```
┌───────────────────┐
│  CHAT             │
├───────────────────┤
│                   │
│  Context:         │
│  • Deployer       │
│  • deploy()       │
│  ─────────────    │
│                   │
│  ┌─────────────┐  │
│  │ How does    │  │
│  │ error       │  │
│  │ handling    │  │
│  │ work here?  │  │
│  └─────────────┘  │
│         You       │
│                   │
│  ┌─────────────┐  │
│  │ The deploy  │  │
│  │ function    │  │
│  │ uses a try/ │  │
│  │ catch with  │  │
│  │ automatic   │  │
│  │ rollback... │  │
│  │             │  │
│  │ See also:   │  │
│  │ → Rollback  │  │
│  │ → ErrorLog  │  │
│  └─────────────┘  │
│        Atlas      │
│                   │
│                   │
├───────────────────┤
│ Ask a question... │
└───────────────────┘
```

### Behavior

1. **Context Display**: Shows what's currently informing the conversation (current detail page, visible canvas diagrams)

2. **Contextual Answers**: Responses are informed by:
   - Current detail page content
   - Canvas diagrams
   - Relevant code and conversations from the index

3. **Concept Links**: Responses can include clickable concept references (→ Rollback) that open in the main view

4. **Diagram Generation**: Questions that warrant visualization trigger new diagrams on the canvas

5. **Chat History**: Preserved when navigating away from Atlas

### Integration with Canvas

When a chat question warrants visualization:

```
User: "How does error handling work in the deployer?"

Atlas: "The deployer uses a try/catch pattern with automatic
rollback. When an error occurs..."

→ Canvas adds new diagram: "Error Handling Flow"
```

---

## Part 7: Technical Implementation

### Directory Structure

```
src/
├── model/                              # Core project intelligence
│   ├── ProjectModel.ts                 # Main interface
│   ├── graph/
│   │   ├── KnowledgeGraph.ts           # Concepts + relationships
│   │   ├── ConceptExtractor.ts         # Extract concepts from code
│   │   └── RelationshipBuilder.ts      # Build connections
│   ├── events/
│   │   ├── EventStream.ts              # Track project events
│   │   ├── CodeChangeHandler.ts        # React to code changes
│   │   └── ConversationHandler.ts      # React to conversations
│   ├── context/
│   │   ├── ContextEngine.ts            # What's relevant now?
│   │   └── Retriever.ts                # Semantic retrieval
│   ├── insights/
│   │   ├── InsightEngine.ts            # What should happen?
│   │   ├── SuggestionGenerator.ts      # Build suggestions
│   │   ├── GapAnalyzer.ts              # Find gaps
│   │   └── ActionExtractor.ts          # Extract action items
│   ├── diagrams/
│   │   └── DiagramGenerator.ts         # LLM-based diagram generation
│   ├── storage/
│   │   └── ModelStore.ts               # Persist the model
│   └── types.ts
│
├── atlas/                              # Atlas View (UI)
│   ├── components/
│   │   ├── AtlasView.tsx               # Main container (3 panes)
│   │   ├── ProjectSelector.tsx         # Project dropdown
│   │   ├── MainView/
│   │   │   ├── index.tsx               # Stack-based navigation container
│   │   │   ├── HomeView.tsx            # Concepts by layer
│   │   │   ├── ConceptCard.tsx         # Concept list item
│   │   │   ├── DetailView.tsx          # Concept detail page
│   │   │   └── FileView.tsx            # Full file viewer
│   │   ├── ChatPanel/
│   │   │   ├── index.tsx               # Chat container
│   │   │   ├── ContextDisplay.tsx      # Shows current context
│   │   │   ├── MessageList.tsx         # Chat messages
│   │   │   └── ChatInput.tsx           # Input field
│   │   └── CanvasView/
│   │       ├── index.tsx               # Canvas container
│   │       ├── DiagramRenderer.tsx     # Renders diagram data
│   │       ├── FlowDiagram.tsx         # Flow diagram type
│   │       ├── DependencyDiagram.tsx   # Dependency diagram type
│   │       ├── ComponentDiagram.tsx    # Component diagram type
│   │       └── SequenceDiagram.tsx     # Sequence diagram type
│   │
│   ├── hooks/
│   │   ├── useAtlasState.ts            # Main state management
│   │   ├── useNavigationStack.ts       # Stack-based navigation
│   │   └── useCanvasState.ts           # Canvas diagram accumulation
│   │
│   ├── engine/
│   │   ├── AtlasEngine.ts              # Orchestrates Atlas operations
│   │   ├── prompts.ts                  # LLM prompts
│   │   └── responseParser.ts           # Parse LLM responses
│   │
│   └── types.ts
│
├── agent/                              # Coding agent integration
│   └── contextProvider.ts              # Queries model for agent context
│
├── suggestions/                        # Build suggestions feature
│   └── ...
│
└── deployments/                        # Deployment integration
    └── ...
```

### Types

```typescript
// src/model/types.ts

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface Concept {
  id: string;
  name: string;
  layer: 'narrative' | 'system' | 'capability' | 'module' | 'code';
  description: string;

  // Metadata for display
  childCount?: number;      // "12 modules"
  decisionCount?: number;   // "4 decisions"
  lastActivity?: string;    // "2d ago"

  // Relationships
  contains?: string[];      // Child concept IDs
  dependsOn?: string[];     // Dependency concept IDs
  usedBy?: string[];        // Dependent concept IDs

  // Code mapping
  codeRefs?: CodeRef[];

  // From conversations
  rationale?: string;
  decisions?: Decision[];
}

export interface CodeRef {
  file: string;
  symbol?: string;
  range: { start: number; end: number };
  snippet?: string;
}

export interface Decision {
  id: string;
  title: string;
  summary: string;
  date: string;
  source: 'conversation' | 'commit' | 'manual';
  conversationId?: string;
}

export interface DiagramData {
  id: string;
  type: 'flow' | 'dependency' | 'component' | 'sequence';
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DiagramNode {
  id: string;
  label: string;
  type: 'input' | 'output' | 'process' | 'decision' | 'data' | 'component';
  description?: string;
  conceptRef?: string;
  highlighted?: boolean;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  type: 'flow' | 'dependency' | 'data' | 'calls';
}

// src/atlas/types.ts

export interface AtlasState {
  projectId: string;
  navigationStack: NavigationEntry[];
  canvasDiagrams: DiagramData[];
  chatHistory: ChatMessage[];
  fileViewOpen?: string;  // File path if file view is open
}

export interface NavigationEntry {
  type: 'home' | 'detail';
  conceptId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  conceptRefs?: string[];  // Clickable concept links
  diagramGenerated?: string;  // ID of diagram added to canvas
}
```

### State Management

```typescript
// src/atlas/hooks/useAtlasState.ts

export function useAtlasState(projectId: string) {
  const [state, setState] = useState<AtlasState>(() =>
    loadPersistedState(projectId) || createInitialState(projectId)
  );

  // Persist state when it changes
  useEffect(() => {
    persistState(projectId, state);
  }, [state]);

  // Navigation
  function navigateToDetail(conceptId: string) {
    setState(prev => ({
      ...prev,
      navigationStack: [...prev.navigationStack, { type: 'detail', conceptId }],
      fileViewOpen: undefined
    }));
  }

  function navigateBack() {
    setState(prev => ({
      ...prev,
      navigationStack: prev.navigationStack.slice(0, -1),
      fileViewOpen: undefined
    }));
  }

  function navigateHome() {
    setState(prev => ({
      ...prev,
      navigationStack: [{ type: 'home' }],
      canvasDiagrams: [],  // Clear canvas
      fileViewOpen: undefined
    }));
  }

  // Canvas
  function addDiagram(diagram: DiagramData) {
    setState(prev => ({
      ...prev,
      canvasDiagrams: [...prev.canvasDiagrams, diagram]
    }));
  }

  // File view
  function openFileView(filePath: string) {
    setState(prev => ({ ...prev, fileViewOpen: filePath }));
  }

  function closeFileView() {
    setState(prev => ({ ...prev, fileViewOpen: undefined }));
  }

  // Chat
  function addChatMessage(message: ChatMessage) {
    setState(prev => ({
      ...prev,
      chatHistory: [...prev.chatHistory, message]
    }));
  }

  return {
    state,
    navigateToDetail,
    navigateBack,
    navigateHome,
    addDiagram,
    openFileView,
    closeFileView,
    addChatMessage
  };
}
```

### Atlas Engine

```typescript
// src/atlas/engine/AtlasEngine.ts

export class AtlasEngine {
  constructor(
    private model: ProjectModel,
    private llm: LLMService
  ) {}

  // Get concepts organized by layer for home view
  async getConceptsByLayer(projectId: string): Promise<LayeredConcepts> {
    return this.model.getConceptsByLayer(projectId);
  }

  // Get full detail for a concept
  async getConceptDetail(conceptId: string): Promise<ConceptDetail> {
    return this.model.getConceptDetail(conceptId);
  }

  // Generate diagram for current context
  async generateDiagram(context: DiagramContext): Promise<DiagramData> {
    const prompt = buildDiagramPrompt(context);
    const response = await this.llm.generate(prompt);
    return parseDiagramResponse(response);
  }

  // Answer a chat question
  async answerQuestion(
    question: string,
    context: ChatContext
  ): Promise<ChatResponse> {
    const relevantCode = await this.model.retrieveCode(question);
    const relevantConversations = await this.model.retrieveConversations(question);

    const prompt = buildChatPrompt({
      question,
      currentConcept: context.currentConcept,
      canvasDiagrams: context.canvasDiagrams,
      relevantCode,
      relevantConversations
    });

    const response = await this.llm.generate(prompt);
    const parsed = parseChatResponse(response);

    // Generate diagram if warranted
    let diagram: DiagramData | undefined;
    if (parsed.shouldGenerateDiagram) {
      diagram = await this.generateDiagram({
        question,
        concept: context.currentConcept,
        diagramType: parsed.suggestedDiagramType
      });
    }

    return {
      answer: parsed.answer,
      conceptRefs: parsed.conceptRefs,
      diagram
    };
  }

  // Get file content for file view
  async getFileContent(projectId: string, filePath: string): Promise<string> {
    return this.model.getFileContent(projectId, filePath);
  }
}
```

### Main View Component

```tsx
// src/atlas/components/MainView/index.tsx

export function MainView() {
  const { state, navigateToDetail, navigateBack, navigateHome } = useAtlasState();
  const currentEntry = state.navigationStack[state.navigationStack.length - 1];

  return (
    <div className="atlas-main-view">
      {currentEntry.type === 'home' ? (
        <HomeView onConceptClick={navigateToDetail} />
      ) : (
        <DetailView
          conceptId={currentEntry.conceptId!}
          onConceptClick={navigateToDetail}
          onBack={navigateBack}
          onHome={navigateHome}
        />
      )}
    </div>
  );
}
```

### Canvas Component

```tsx
// src/atlas/components/CanvasView/index.tsx

export function CanvasView() {
  const { state, closeFileView, navigateHome, navigateToDetail } = useAtlasState();

  // If file view is open, show file instead of canvas
  if (state.fileViewOpen) {
    return (
      <FileView
        filePath={state.fileViewOpen}
        onClose={closeFileView}
      />
    );
  }

  return (
    <div className="atlas-canvas">
      <div className="canvas-header">
        <span>Canvas</span>
        <button onClick={navigateHome} title="Clear canvas and go home">⌂</button>
      </div>

      <div className="canvas-diagrams">
        {state.canvasDiagrams.map(diagram => (
          <DiagramRenderer
            key={diagram.id}
            diagram={diagram}
            onNodeClick={(node) => {
              if (node.conceptRef) {
                navigateToDetail(node.conceptRef);
              }
            }}
          />
        ))}

        {state.canvasDiagrams.length === 0 && (
          <div className="canvas-empty">
            Diagrams will appear here as you explore concepts
            and ask questions.
          </div>
        )}
      </div>
    </div>
  );
}
```

### Diagram Renderer

```tsx
// src/atlas/components/CanvasView/DiagramRenderer.tsx

export function DiagramRenderer({
  diagram,
  onNodeClick
}: {
  diagram: DiagramData;
  onNodeClick: (node: DiagramNode) => void;
}) {
  switch (diagram.type) {
    case 'flow':
      return <FlowDiagram diagram={diagram} onNodeClick={onNodeClick} />;
    case 'dependency':
      return <DependencyDiagram diagram={diagram} onNodeClick={onNodeClick} />;
    case 'component':
      return <ComponentDiagram diagram={diagram} onNodeClick={onNodeClick} />;
    case 'sequence':
      return <SequenceDiagram diagram={diagram} onNodeClick={onNodeClick} />;
  }
}
```

### CSS Layout

```css
/* src/atlas/styles.css */

.atlas-view {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.atlas-chat-panel {
  min-width: 250px;
  max-width: 400px;
  width: 300px;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  resize: horizontal;
  overflow: auto;
}

.atlas-main-view {
  flex: 1;
  min-width: 400px;
  overflow-y: auto;
  resize: horizontal;
}

.atlas-canvas {
  min-width: 300px;
  max-width: 500px;
  width: 350px;
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  resize: horizontal;
  overflow: auto;
}

.canvas-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.canvas-diagrams {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.canvas-empty {
  color: var(--text-muted);
  text-align: center;
  padding: 40px 20px;
}

/* Resizable panels */
.atlas-chat-panel::-webkit-resizer,
.atlas-main-view::-webkit-resizer,
.atlas-canvas::-webkit-resizer {
  background: var(--border-color);
}
```

---

## Part 8: Implementation Phases

### Phase 1: Core Model Foundation

**Goal**: Build the indexing and storage layer.

- [ ] Define core types (Concept, CodeRef, Decision, etc.)
- [ ] Implement ProjectStore (access code files, conversations)
- [ ] Implement Indexer (extract concepts from code)
- [ ] Implement ConversationHandler (extract decisions, rationale)
- [ ] Implement ModelStore (persist indexed data)
- [ ] Background indexing process

### Phase 2: Atlas View - Home

**Goal**: Display concepts by layer.

- [ ] AtlasView container with 3-pane layout
- [ ] Resizable panels
- [ ] HomeView with concepts grouped by layer
- [ ] ConceptCard component
- [ ] ProjectSelector
- [ ] State persistence (navigation, canvas, chat)

### Phase 3: Atlas View - Detail

**Goal**: Concept detail pages with stack navigation.

- [ ] DetailView component
- [ ] Navigation stack implementation
- [ ] Back/Home navigation
- [ ] Linked concepts (clickable)
- [ ] Code snippets display
- [ ] FileView (temporary canvas replacement)

### Phase 4: Canvas - Diagrams

**Goal**: LLM-generated diagrams.

- [ ] DiagramGenerator (LLM prompts)
- [ ] DiagramData schema
- [ ] DiagramRenderer (routes to type-specific renderers)
- [ ] FlowDiagram component
- [ ] DependencyDiagram component
- [ ] Diagram accumulation logic
- [ ] Clickable nodes → navigate to concept

### Phase 5: Chat Panel

**Goal**: Contextual Q&A.

- [ ] ChatPanel component
- [ ] ContextDisplay (shows current context)
- [ ] MessageList
- [ ] ChatInput
- [ ] AtlasEngine.answerQuestion()
- [ ] Concept links in responses
- [ ] Diagram generation from questions

### Phase 6: Integration

**Goal**: Connect to rest of application.

- [ ] Route setup (/atlas)
- [ ] Navigation link in app
- [ ] Coding agent context provider (uses model)
- [ ] Loading states
- [ ] Error handling

---

## Part 9: Open Questions

1. **Embedding model** - Which service for semantic search?
2. **LLM for generation** - Claude for quality vs faster model for iteration?
3. **Index storage** - `.atlas/` in project root or centralized?
4. **Conversation format** - How are agent conversations currently stored?
5. **Diagram rendering** - Use existing library (D3, React Flow) or custom?

---

## Part 10: Future Enhancements

- Additional diagram types (ERD, state machine)
- Drag-and-drop canvas interaction
- Collaborative annotations
- Timeline view (project evolution)
- Comparison view (before/after changes)
- Export/share diagrams
- Integration with deployment pipeline
- Code review context provider
