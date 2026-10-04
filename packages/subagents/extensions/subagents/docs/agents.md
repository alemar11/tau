# Agents

Tau bundles scout, researcher, evidence-auditor, worker, reviewer, oracle and delegate. Their Markdown files define role instructions and native tool selections.

Custom Markdown definitions live in `~/.pi/agent/tau-subagents/agents/` (or `$PI_CODING_AGENT_DIR/tau-subagents/agents/`) and `.pi/tau-subagents/agents/`. Project definitions win for scope `both`. No legacy agent directories are imported. Settings use `tauSubagents`.

```markdown
---
name: coordinator
description: Coordinate bounded work
tools: read, subagent, subagent_supervisor, contact_supervisor
inheritProjectContext: true
inheritSkills: false
---
Coordinate only the work assigned by the parent. Await child results.
```

Model precedence: explicit call, profile, launching coordinator snapshot. Thinking can be configured in the profile or with a model suffix. Fresh context is the default; oracle prefers fork. Explicit fork fails without persisted history. Implicit oracle preference may use fresh instead. Repository instructions follow Pi project trust.

`bash`, `write`, `edit`, unclassified tools and arbitrary extension loadouts make a child a writer. Names and role prompts do not make a reader: scout, researcher and oracle are writers. Reviewer and evidence-auditor can be readers. Reader tool calls cannot dynamically acquire mutating capabilities.

Research uses exactly `web_search`, `fetch_web_content`, `get_cached_web_content` from Tau Web. Pass claims, URLs and quotations to a fresh auditor; cache IDs are branch-scoped and do not grant access. The auditor evaluates sources with its own model; fetch failures mean missing evidence, not contradiction.

Six optional CLI profiles are also bundled: `claude-code`, `codex-exec`, `cursor-agent` and their `-writer` variants. They require the corresponding installed/authenticated program, use background-only one-shot execution and are always admitted as writers. Pi model defaults, native tools, Tau Web and supervisor transport are not injected into them. Their capabilities and explicit Claude model/effort overrides are documented in [external runners](external-runners.md). Machine placement and terminal integrations remain deferred to phase 4.
