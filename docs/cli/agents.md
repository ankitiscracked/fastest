# Coding Agent Integration

How `fst` detects and invokes coding agents for summaries and merge conflict resolution. Source: `cli/internal/agent/agent.go`, `cli/cmd/fst/commands/agents.go`.

## Supported agents

| Name | Command | Invocation style | Description |
|------|---------|-----------------|-------------|
| `claude` | `claude` | `claude -p "<prompt>"` | Claude Code (Anthropic) |
| `codex` | `codex` | `codex exec "<prompt>"` | OpenAI Codex CLI |
| `amp` | `amp` | `amp -x "<prompt>"` | Amp CLI |
| `agent` | `agent` | `agent -p "<prompt>"` | Cursor Agent CLI |
| `gemini` | `gemini` | `gemini -p "<prompt>"` | Gemini CLI |
| `droid` | `droid` | `droid exec "<prompt>"` | Factory Droid CLI |

Defined as `KnownAgents` in `cli/internal/agent/agent.go`.

## Agent detection

Agents are detected by checking if their command is on `PATH` using `exec.LookPath`. The `fst agents list` command shows all known agents and whether each is currently available.

## Preferred agent

Set with `fst agents set-preferred <name>`. Stored in `~/.config/fst/agents.json`:

```json
{
  "preferred_agent": "claude"
}
```

When an agent is needed (for summaries or merges), the selection order is:

1. `--agent` flag (on commands that support it)
2. `FST_AGENT` environment variable
3. Preferred agent from `agents.json`
4. First available agent from the known agents list

## Agent capabilities

Agents are invoked for four tasks:

### Snapshot summaries (`--agent-summary`)

`InvokeSummary(agentName, diffText)` -- generates a concise summary of changes in a snapshot. Used by `fst snapshot --agent-summary`.

### Conflict summaries

`InvokeConflictSummary(agentName, conflictText)` -- summarizes detected conflicts between workspaces. Used by `fst drift --agent-summary`.

### Drift summaries

`InvokeDriftSummary(agentName, driftText)` -- summarizes drift between workspaces. Used by `fst drift --agent-summary`.

### Merge conflict resolution

`InvokeMerge(agentName, baseContent, oursContent, theirsContent, filePath)` -- resolves a three-way merge conflict. The agent receives base, ours, and theirs versions and returns a `MergeResult` containing:

- `Strategy` -- list of strings describing what the agent did
- `MergedCode` -- the resolved file content

The agent's output is parsed by looking for a `---MERGED CODE---` separator. Everything before it is treated as strategy explanation; everything after is the merged file content.

## Commands

```
fst agents                      # List detected agents (runs list by default)
fst agents list                 # Show all known agents with availability (alias: ls)
fst agents set-preferred claude # Set preferred agent
```

## Commands that use agents

| Command | Flag | Purpose |
|---------|------|---------|
| `fst snapshot` | `--agent-summary`, `--agent` | Generate snapshot summary |
| `fst drift` | `--agent-summary` | Summarize drift/conflicts |
| `fst merge` | `--agent-summary` | Summarize merge; agent mode resolves conflicts |
| `fst pull` | `--agent-summary` | Summarize pulled changes |
| `fst sync` | `--agent-summary` | Summarize sync results |

The default merge conflict mode is **Agent** -- `fst merge` invokes the preferred agent to resolve conflicts automatically. Use `--manual`, `--theirs`, or `--ours` to override.
