# Next Steps Feature - Implementation Plan

> **Goal**: Surface intelligent, contextual next steps for what to build next based on project intent, current state, and battle-tested wisdom from successful builders.

## Overview

This feature transforms Fastest from a code execution platform into a **project success partner** that understands:
- What you're trying to achieve (project intent + brief)
- What similar successful projects did (external research)
- What battle-tested wisdom applies (curated knowledge)
- Where you are right now (current codebase state)

**Initial Scope**: Two project intents
1. **Startup/Company** - Building to launch, get users, find PMF
2. **Personal Tool** - Building for yourself, scratching an itch

---

## Data Models

### 1. Project Brief (extends projects table)

```sql
-- Add columns to existing projects table
ALTER TABLE projects ADD COLUMN intent TEXT; -- 'startup' | 'personal_tool' | 'learning' | 'fun' | 'portfolio' | 'creative' | 'exploration' | 'open_source'
ALTER TABLE projects ADD COLUMN brief TEXT; -- JSON blob with structured brief
```

**Brief JSON Structure:**

```typescript
// For Startup Intent
interface StartupBrief {
  intent: 'startup';

  // Core
  problem: string;              // "Freelancers struggle to track time across clients"
  target_users: string[];       // ["solo freelancers", "small agencies"]
  unique_angle?: string;        // "Offline-first, no account required"

  // Scope
  mvp_features: string[];       // ["time tracking", "basic invoicing"]
  non_goals: string[];          // ["team collaboration", "payroll"]

  // Context
  reference_projects?: string[];  // ["toggl", "harvest"] - for research
  tech_preferences?: string[];    // ["simple stack", "self-hostable"]

  // Stage
  current_stage: 'idea' | 'building_mvp' | 'pre_launch' | 'launched' | 'growing';
  has_users: boolean;
  has_revenue: boolean;
}

// For Personal Tool Intent
interface PersonalToolBrief {
  intent: 'personal_tool';

  // Core
  problem: string;              // "I waste time switching between 5 apps to start my workday"
  current_workaround?: string;  // "I have a checklist in Notes app"

  // Scope
  must_have: string[];          // ["open all my morning apps", "check calendar"]
  nice_to_have: string[];       // ["weather widget", "news summary"]

  // Context
  platforms: string[];          // ["macos"] or ["web", "cli"]
  tech_preferences?: string[];  // ["rust", "minimal dependencies"]

  // Style
  polish_level: 'hacky' | 'functional' | 'polished';  // How much do you care about UI
}
```

### 2. Wisdom Sources Table

```sql
CREATE TABLE wisdom_sources (
  id TEXT PRIMARY KEY,

  -- Source info
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  source_type TEXT NOT NULL,      -- 'essay' | 'interview' | 'tutorial' | 'video' | 'thread'
  source_name TEXT NOT NULL,      -- 'Paul Graham Essays', 'Indie Hackers', etc.
  published_at TEXT,

  -- Extracted content
  full_content TEXT,              -- For RAG if needed
  summary TEXT NOT NULL,          -- 2-3 sentences
  key_lessons TEXT NOT NULL,      -- JSON array of strings
  quotable_lines TEXT,            -- JSON array of {quote, context}

  -- Classification
  intents TEXT NOT NULL,          -- JSON array: ['startup', 'personal_tool']
  stages TEXT,                    -- JSON array: ['idea', 'mvp', 'growth']
  topics TEXT NOT NULL,           -- JSON array: ['validation', 'launch', 'pricing']

  -- Matching
  surface_triggers TEXT,          -- JSON array: when to show this

  -- Quality
  signal_strength INTEGER NOT NULL DEFAULT 3,  -- 1-5
  manually_reviewed INTEGER NOT NULL DEFAULT 0,

  -- Metadata
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  times_surfaced INTEGER DEFAULT 0,
  positive_feedback INTEGER DEFAULT 0,
  negative_feedback INTEGER DEFAULT 0
);

CREATE INDEX idx_wisdom_intents ON wisdom_sources(intents);
CREATE INDEX idx_wisdom_signal ON wisdom_sources(signal_strength DESC);
```

### 3. Project Research Table

```sql
-- Stores discovered similar projects from GitHub, etc.
CREATE TABLE project_research (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Source
  source_type TEXT NOT NULL,      -- 'github_repo' | 'product_hunt' | 'hn_post'
  source_url TEXT NOT NULL,

  -- Extracted info
  name TEXT NOT NULL,
  description TEXT,
  stars INTEGER,                  -- For GitHub repos

  -- Analysis
  key_features TEXT,              -- JSON array
  tech_stack TEXT,                -- JSON array
  file_structure TEXT,            -- JSON: simplified tree
  lessons TEXT,                   -- What can we learn from this

  -- Metadata
  researched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_research_project ON project_research(project_id);
```

### 4. Next Steps Table

```sql
CREATE TABLE next_steps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Suggestion content
  title TEXT NOT NULL,            -- "Add magic link authentication"
  description TEXT,               -- Why and how
  rationale TEXT,                 -- Why AI suggested this

  -- Supporting context
  wisdom_source_ids TEXT,         -- JSON array of wisdom_sources.id that informed this
  research_ids TEXT,              -- JSON array of project_research.id

  -- Classification
  category TEXT,                  -- 'feature' | 'validation' | 'launch' | 'technical' | 'user_research'
  priority INTEGER DEFAULT 2,     -- 1=high, 2=medium, 3=low
  effort TEXT,                    -- 'small' | 'medium' | 'large'

  -- Status
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'started' | 'completed' | 'dismissed'

  -- Metadata
  model TEXT,                     -- Which model generated this
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  acted_on_at TEXT
);

CREATE INDEX idx_next_steps_project ON next_steps(project_id, status);
CREATE INDEX idx_next_steps_priority ON next_steps(project_id, priority);
```

### 5. Decision Log Table

```sql
-- Track decisions made during the project (extracted from conversations)
CREATE TABLE project_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id),

  -- Decision
  decision TEXT NOT NULL,         -- "Use SQLite instead of Postgres"
  rationale TEXT,                 -- "Simpler for self-hosted deployment"
  category TEXT,                  -- 'architecture' | 'scope' | 'tech_choice' | 'approach'

  -- Metadata
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_decisions_project ON project_decisions(project_id);
```

---

## API Endpoints

### Project Brief

```
PATCH /v1/projects/:id/brief
  Body: { brief: StartupBrief | PersonalToolBrief }
  Response: { project: Project }

GET /v1/projects/:id/brief
  Response: { brief: Brief, intent: string }
```

### Wisdom Sources (Admin)

```
POST /v1/admin/wisdom-sources
  Body: { url, title, author?, source_type, source_name, ... }
  Response: { source: WisdomSource }

GET /v1/admin/wisdom-sources
  Query: ?intent=startup&topic=validation&limit=50
  Response: { sources: WisdomSource[], total: number }

POST /v1/admin/wisdom-sources/extract
  Body: { url: string }
  Response: { extracted: Partial<WisdomSource> }
  Note: Uses LLM to extract structure from URL
```

### Project Research

```
POST /v1/projects/:id/research
  Body: { query?: string }  -- Optional custom query, otherwise uses brief
  Response: { research: ProjectResearch[] }
  Note: Triggers GitHub search + analysis

GET /v1/projects/:id/research
  Response: { research: ProjectResearch[] }
```

### Next Steps

```
POST /v1/projects/:id/next-steps/generate
  Body: { force?: boolean }  -- Force regenerate even if recent
  Response: { next_steps: NextStep[] }
  Note: This is the main intelligence endpoint

GET /v1/projects/:id/next-steps
  Query: ?status=pending&limit=10
  Response: { next_steps: NextStep[] }

PATCH /v1/projects/:id/next-steps/:nextStepId
  Body: { status: 'started' | 'completed' | 'dismissed' }
  Response: { next_step: NextStep }
```

---

## Next Steps Generation Logic

### Input Assembly

```typescript
interface NextStepContext {
  // Project identity
  project: Project;
  brief: StartupBrief | PersonalToolBrief;

  // Current state
  file_manifest: FileEntry[];           // What files exist
  recent_conversations: ConversationSummary[];  // Last 5-10
  decisions: ProjectDecision[];         // Past decisions

  // External context
  similar_projects: ProjectResearch[];  // GitHub research
  relevant_wisdom: WisdomSource[];      // Matched wisdom

  // Previous next steps
  past_next_steps: NextStep[];  // What was already suggested
}
```

### Wisdom Matching Algorithm

```typescript
async function matchWisdom(brief: Brief, projectState: ProjectState): Promise<WisdomSource[]> {
  // 1. Filter by intent
  let sources = await db.query(wisdomSources)
    .where(sql`intents LIKE '%${brief.intent}%'`)
    .orderBy(desc(wisdomSources.signalStrength));

  // 2. Filter by stage (for startup)
  if (brief.intent === 'startup' && brief.current_stage) {
    sources = sources.filter(s =>
      JSON.parse(s.stages).includes(brief.current_stage)
    );
  }

  // 3. Check surface triggers
  sources = sources.filter(s => {
    const triggers = JSON.parse(s.surface_triggers || '[]');
    return triggers.some(trigger => evaluateTrigger(trigger, projectState));
  });

  // 4. Diversify topics (don't return 5 sources all about "validation")
  return diversifyByTopic(sources, 5);
}

function evaluateTrigger(trigger: string, state: ProjectState): boolean {
  // Examples:
  // "no_users_yet" -> !state.brief.has_users
  // "building_auth_early" -> state.recent_work.includes('auth') && state.core_feature_incomplete
  // "no_conversations_with_users" -> state.user_interview_count === 0
  // ... pattern matching logic
}
```

### Generation Prompt (Startup Intent)

```markdown
You are an expert startup advisor helping a founder decide what to build next.

## Project Brief
Problem: {brief.problem}
Target Users: {brief.target_users}
MVP Features: {brief.mvp_features}
Non-Goals: {brief.non_goals}
Current Stage: {brief.current_stage}
Has Users: {brief.has_users}
Has Revenue: {brief.has_revenue}

## Current Codebase State
Files: {summarized_file_tree}
Recent work: {recent_conversation_summaries}

## Similar Successful Projects (from research)
{foreach research}
- {research.name}: {research.lessons}
{/foreach}

## Relevant Wisdom
{foreach wisdom}
### From "{wisdom.title}" ({wisdom.source_name})
Key lessons:
{wisdom.key_lessons}

Relevant quote: "{wisdom.quotable_lines[0].quote}"
{/foreach}

## Past Decisions
{foreach decision}
- {decision.decision}: {decision.rationale}
{/foreach}

## Already Suggested (don't repeat)
{past_next_steps.map(s => s.title)}

---

Based on all this context, suggest 3-5 things to build or do next.

For each next step:
1. Be specific and actionable
2. Explain WHY this matters at this stage
3. Reference relevant wisdom when applicable
4. Consider what similar projects did
5. Respect the non-goals (don't suggest things explicitly out of scope)

Prioritize ruthlessly based on the current stage:
- idea stage: validation > building
- building_mvp: core feature > nice-to-haves
- pre_launch: launch prep > new features
- launched: user feedback > assumptions

Format as JSON:
{
  "next_steps": [
    {
      "title": "...",
      "description": "...",
      "rationale": "...",
      "category": "feature|validation|launch|technical|user_research",
      "priority": 1|2|3,
      "effort": "small|medium|large",
      "wisdom_references": ["wisdom_source_id_1"]
    }
  ]
}
```

### Generation Prompt (Personal Tool Intent)

```markdown
You are a pragmatic hacker helping someone build a tool for themselves.

## What They're Building
Problem: {brief.problem}
Current workaround: {brief.current_workaround}
Must have: {brief.must_have}
Nice to have: {brief.nice_to_have}
Polish level: {brief.polish_level}

## Current State
Files: {summarized_file_tree}
Recent work: {recent_conversation_summaries}

## Similar Tools Others Built
{foreach research}
- {research.name}: {research.key_features}
{/foreach}

## Relevant Wisdom
{foreach wisdom}
### From "{wisdom.title}"
{wisdom.key_lessons}
{/foreach}

---

Suggest 3-5 things to build next.

Remember - this is a PERSONAL tool:
- Optimize for the builder's workflow, not hypothetical users
- Hardcoding is fine, config files beat databases
- "Works for me" is the success metric
- Suggest shortcuts and hacks that wouldn't fly in production
- If polish_level is 'hacky', embrace that
- Don't suggest things for "future users" - there are none

Be practical:
- What would make their daily use better?
- What's the 20% effort for 80% value?
- What shortcuts would an experienced dev take?

Format as JSON:
{
  "next_steps": [
    {
      "title": "...",
      "description": "...",
      "rationale": "...",
      "category": "feature|automation|polish|integration",
      "priority": 1|2|3,
      "effort": "small|medium|large",
      "wisdom_references": ["wisdom_source_id_1"]
    }
  ]
}
```

---

## Wisdom Sources - Seed Content

### Startup Intent Sources (Initial 50)

#### Paul Graham Essays (15)
| Title | URL | Key Topics |
|-------|-----|------------|
| Do Things That Don't Scale | paulgraham.com/ds.html | early_users, validation |
| How to Get Startup Ideas | paulgraham.com/startupideas.html | idea, validation |
| Startup = Growth | paulgraham.com/growth.html | growth, metrics |
| The Hardest Lessons for Startups to Learn | paulgraham.com/startuplessons.html | general |
| How to Start a Startup | paulgraham.com/start.html | general, early_stage |
| Be Good | paulgraham.com/good.html | product, users |
| The 18 Mistakes That Kill Startups | paulgraham.com/startupmistakes.html | anti_patterns |
| Schlep Blindness | paulgraham.com/schlep.html | idea, opportunity |
| Default Alive or Default Dead? | paulgraham.com/aord.html | runway, growth |
| Frighteningly Ambitious Startup Ideas | paulgraham.com/ambitious.html | idea, vision |
| Ramen Profitable | paulgraham.com/ramenprofitable.html | revenue, early_stage |
| What Startups Are Really Like | paulgraham.com/really.html | general, expectations |
| Why to Not Not Start a Startup | paulgraham.com/notnot.html | motivation |
| Maker's Schedule, Manager's Schedule | paulgraham.com/makersschedule.html | productivity |
| Write Code, Not Essays | paulgraham.com/essay.html | execution |

#### YC Content (10)
| Title | Source | Key Topics |
|-------|--------|------------|
| How to Plan an MVP | YC Startup School | mvp, scope |
| How to Talk to Users | YC Startup School | validation, users |
| How to Launch | YC Startup School | launch |
| How to Prioritize Your Time | YC Startup School | focus |
| How to Set KPIs and Goals | YC Startup School | metrics |
| Nine Business Models | YC Startup School | business_model |
| How to Get Your First Customers | YC Startup School | early_users |
| How to Measure Product-Market Fit | YC Library | pmf |
| YC's Essential Startup Advice | YC | general |
| A Counterintuitive System for Startup Pricing | YC | pricing |

#### Founder Stories (15)
| Title | Source | Key Topics |
|-------|--------|------------|
| How Notion Started | First Round Review | pivot, persistence |
| How Linear Built a $400M Company | Lenny's Newsletter | quality, differentiation |
| How Stripe's 7 Lines of Code Changed Payments | Various | developer_experience |
| How Superhuman Built a $30M ARR Product | First Round Review | pre_launch, positioning |
| How Figma Won Against Adobe | Various | collaboration, browser_first |
| How Vercel Captured the Frontend | Various | developer_tools |
| The Indie Hackers Podcast - Top Episodes | Indie Hackers | solo_founder |
| How I Got to $100K ARR | Various Indie Hackers | milestones |
| Pieter Levels - Making $2M/year Solo | Various | solo_founder, shipping |
| How Basecamp Stays Small | Signal v. Noise | bootstrapping |
| How ConvertKit Grew to $30M ARR | Nathan Barry | email, creator_economy |
| How Gumroad Survived Near-Death | Sahil Lavingia | resilience, pivot |
| How Discord Started as a Game Company | Various | pivot |
| How Slack Grew from 0 to $1B | Various | growth, enterprise |
| How Calendly Beat 100 Competitors | Various | simplicity |

#### Practical Guides (10)
| Title | Source | Key Topics |
|-------|--------|------------|
| The Mom Test | Rob Fitzpatrick | validation, user_interviews |
| Running Lean | Ash Maurya | lean, validation |
| Zero to Sold | Arvid Kahl | bootstrapping |
| The Minimalist Entrepreneur | Sahil Lavingia | bootstrapping |
| Obviously Awesome | April Dunford | positioning |
| Deploy Empathy | Michele Hansen | user_research |
| Traction | Gabriel Weinberg | channels, growth |
| The SaaS Playbook | Rob Walling | saas |
| Start Small Stay Small | Rob Walling | bootstrapping |
| Getting Real | 37signals | product, simplicity |

### Personal Tool Intent Sources (Initial 30)

#### Philosophy & Mindset (10)
| Title | Source | Key Topics |
|-------|--------|------------|
| The Unix Philosophy | Various | simplicity, composability |
| Worse is Better | Richard Gabriel | pragmatism |
| In Praise of Scripting | Various | automation |
| Write Code Every Day | John Resig | habit, shipping |
| Tools for Thought | Various | personal_knowledge |
| The Setup / Uses This Interviews | usesthis.com | inspiration |
| My Productivity System | Various dev blogs | workflow |
| Why I Built My Own X | HN threads | motivation |
| Scratching Your Own Itch | Various | personal_tools |
| The Joy of Personal Projects | Various | mindset |

#### Practical Patterns (10)
| Title | Source | Key Topics |
|-------|--------|------------|
| Dotfiles Best Practices | GitHub | configuration |
| CLI Tool Patterns | Various | cli_design |
| Automation Scripts Collection | Various | automation |
| Personal API Patterns | Various | integration |
| Local-First Software | Ink & Switch | offline, sync |
| SQLite as Application File Format | sqlite.org | database |
| Single-File Tools | Various | simplicity |
| Shell Scripting Tips | Various | shell |
| Makefile Magic | Various | automation |
| Personal Infrastructure | r/selfhosted | hosting |

#### Tool Showcases (10)
| Title | Source | Key Topics |
|-------|--------|------------|
| Things I Built for Myself (HN Thread) | Hacker News | inspiration |
| Show HN: My Personal Tool | Various HN | examples |
| Raycast/Alfred Workflow Examples | Various | macos |
| Personal Dashboard Examples | GitHub | dashboard |
| CLI Tools in Rust/Go | GitHub trending | implementation |
| Obsidian Plugin Development | Obsidian | plugins |
| Browser Extension Examples | GitHub | extensions |
| Hammerspoon Configurations | GitHub | macos_automation |
| Personal Finance Tools | HN threads | examples |
| Home Automation Setups | r/homeassistant | iot |

---

## Frontend Implementation

### New Components

#### 1. ProjectBriefWizard

```typescript
// web/src/components/project/ProjectBriefWizard.tsx
interface ProjectBriefWizardProps {
  projectId: string;
  onComplete: (brief: Brief) => void;
}

// Multi-step wizard:
// Step 1: Choose intent (startup | personal_tool | ...)
// Step 2: Intent-specific questions
// Step 3: Review & confirm
```

#### 2. NextSteps

```typescript
// web/src/components/next-steps/NextSteps.tsx
interface NextStepsProps {
  projectId: string;
  onStartSuggestion: (nextStepId: string, prompt: string) => void;
}

// Displays:
// - List of next steps with priority badges
// - Expandable rationale with wisdom citations
// - "Start working on this" button -> creates conversation with context
// - Dismiss/complete actions
```

#### 3. WisdomCard

```typescript
// web/src/components/next-steps/WisdomCard.tsx
interface WisdomCardProps {
  source: WisdomSource;
  context?: string;  // Why this is relevant now
}

// Displays:
// - Title + source
// - Key quote
// - "Read more" link
// - Collapsible key lessons
```

### Updated Home Page

```tsx
// web/src/pages/Home.tsx

export function Home() {
  // ... existing code ...

  return (
    <div className="h-full flex flex-col bg-surface-50">
      {/* ... existing error banner ... */}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-8">
          {/* Hero / Prompt Section - existing */}

          {/* NEW: Next Steps - prominent placement */}
          {currentProject?.brief && (
            <div className="mb-8">
              <NextSteps
                projectId={currentProject.id}
                onStartSuggestion={(nextStepId, prompt) => {
                  // Create conversation with next step context
                  handleSubmitPrompt(prompt);
                }}
              />
            </div>
          )}

          {/* NEW: Project Brief CTA if no brief */}
          {currentProject && !currentProject.brief && (
            <div className="mb-8 p-4 bg-accent-50 border border-accent-200 rounded-md">
              <p className="text-sm text-accent-800 mb-2">
                Set up your project brief to get intelligent next steps
              </p>
              <button
                onClick={() => setShowBriefWizard(true)}
                className="text-sm font-medium text-accent-600 hover:text-accent-700"
              >
                Set up project →
              </button>
            </div>
          )}

          {/* Action Items - existing */}
          <div className="mb-8">
            <ActionItems ... />
          </div>

          {/* Recent Conversations - existing */}
        </div>
      </div>

      {/* Brief Wizard Modal */}
      {showBriefWizard && (
        <ProjectBriefWizard
          projectId={currentProject.id}
          onComplete={(brief) => {
            setShowBriefWizard(false);
            // Trigger research + next step generation
          }}
        />
      )}
    </div>
  );
}
```

---

## Implementation Phases

### Current V0 (Implemented)

**Database:**
- [x] Add `intent` and `brief` columns to projects table
- [x] Create `next_steps` table
- [x] Add feedback counters on next steps (helpful / not helpful)

**API:**
- [x] `PATCH /projects/:id/brief` - Save project brief
- [x] `GET /projects/:id/brief` - Get project brief
- [x] `POST /projects/:id/next-steps/generate` - Generate next steps
- [x] `GET /projects/:id/next-steps` - List next steps
- [x] `PATCH /projects/:id/next-steps/:nextStepId` - Update status
- [x] `POST /projects/:id/next-steps/:nextStepId/feedback` - Record helpful / not helpful

**Frontend:**
- [x] `ProjectBriefWizard` component
- [x] `NextSteps` component
- [x] Update Home page with next steps
- [x] Brief setup flow
- [x] Suggestion → Conversation flow

### Phase 1: Foundation (Week 1)

**Database:**
- [ ] Create `wisdom_sources` table
- [ ] Create `project_research` table
- [ ] Create `project_decisions` table

**API (Admin / Research):**
- [ ] `POST /admin/wisdom-sources` - Add wisdom source
- [ ] `GET /admin/wisdom-sources` - List wisdom sources

**Seed Data:**
- [ ] Manually curate 20 startup wisdom sources (PG essays first)
- [ ] Manually curate 10 personal tool wisdom sources
- [ ] Create extraction script for remaining sources

### Phase 2: Intelligence (Week 2)

**Research:**
- [ ] GitHub search integration
- [ ] `POST /projects/:id/research` - Trigger research
- [ ] LLM-based analysis of found repos

**Suggestions:**
- [ ] Wisdom matching algorithm
- [ ] Generation prompts for both intents

### Phase 3: Frontend (Week 3)

**Components:**
- [ ] `WisdomCard` component

**Integration:**
- [ ] Wisdom citations in next steps UI
- [ ] Suggestion refresh on project changes

### Phase 4: Polish (Week 4)

**Quality:**
- [ ] Add remaining wisdom sources (50 startup, 30 personal tool)
- [ ] Tune next step quality

**Features:**
- [ ] Decision extraction from conversations
- [ ] "Why this next step" explainer

---

## Success Metrics

1. **Engagement**: % of projects with briefs set up
2. **Quality**: User feedback on next steps (helpful/not helpful)
3. **Action**: % of next steps that lead to conversations
4. **Retention**: Do users with next steps active return more?

---

## Future Extensions

After initial two intents are validated:

1. **More intents**: Learning, Fun/Vibe, Portfolio, Creative, Open Source
2. **Milestone system**: Stage-based checkpoints with nudges
3. **Devil's advocate mode**: Challenge assumptions
4. **Cross-project learning**: Personal patterns across all user's projects
5. **Community wisdom**: User-contributed lessons
6. **Proactive coaching**: Unsolicited observations ("You've been building for 3 weeks without user feedback...")

---

## Appendix: LLM Extraction Prompt

For extracting structure from new wisdom sources:

```markdown
Analyze this content and extract structured wisdom:

CONTENT:
{content}

SOURCE: {url}
TYPE: {blog_post | essay | interview | tutorial | documentation}

Extract the following as JSON:

{
  "summary": "2-3 sentence summary of what this is about",
  "key_lessons": ["lesson 1", "lesson 2", "lesson 3", "lesson 4", "lesson 5"],
  "quotable_lines": [
    {"quote": "exact quote", "context": "when/why to use this quote"}
  ],
  "intents": ["startup", "personal_tool", "learning", "fun", "portfolio", "creative", "exploration", "open_source"],
  "stages": ["idea", "building_mvp", "pre_launch", "launched", "growing"],
  "topics": ["validation", "launch", "users", "pricing", "architecture", "growth", "hiring", "fundraising"],
  "signal_strength": 4,
  "surface_triggers": [
    "user_has_no_users_yet",
    "building_before_validating",
    "over_engineering"
  ]
}

Be selective with intents - only include those where this content is HIGHLY relevant.
For surface_triggers, think about what project state would make this wisdom timely.
```
