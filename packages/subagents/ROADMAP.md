# Subagents scope and roadmap

## Phase 1: native core

- Seven bundled roles and custom Markdown profiles, with explicit model, context, tools, skills and extension resolution.
- Foreground Pi SDK sessions and separate background runners, with owned state, results and artifacts.
- FIFO writer admission per canonical directory and root session, including descendants and mixed execution modes. Uncertain ownership remains blocking.
- Native immediate-parent supervision, steering, interrupt, stop and retained-session recovery.
- Worker/VM workflows with dependency barriers, parallel results, structured output and bounded diagnostics.
- Tau Web research tools with loader provenance checks and branch-scoped cache contracts.
- Pi-only fleet, manager, transcript inspection, status and headless/RPC controls.

See [validation evidence](VALIDATION.md) and the [workflow API](extensions/subagents/docs/workflows.md) for current coverage and limits. Source presence does not imply an enabled capability.

## Later phases

| Phase | Scope |
| --- | --- |
| 2 | Git/worktrees, isolated writers, lane/handoff integration, Worktrunk and `gh` sharing |
| 3 | External Claude Code, Codex and Cursor runners and profiles |
| 4 | Herdr/Ghostty placement and terminal inspection/status integration |
| 5 | Optional messaging, MCP, permission and provider integrations |
| 6 | Missions, schedules, watchdog, host steps and advanced acceptance gates |

Automatic memory/refinement policy, council/prompt resources, package subpath APIs and embedded/external-job adapters need scoped increments and behavioral coverage before becoming supported public contracts. Deferred features are rejected at active execution boundaries; they are not silently enabled through defaults.

## Runtime contracts

Pi 0.99.1 supplies the SDK as peer dependencies. Node 22.19+ loads the extension without a build. Configuration, agents, environment and process registries use Tau-owned namespaces, independently of host Pi identities.

Explicitly selected resources must resolve before prompting. Failures do not select another model/provider/runner. Untrusted project context is not inherited. Arbitrary extension code remains trusted host code, not an OS sandbox.

Workflow helpers and host-result objects use code-generation-disabled realms. Emit/console/return share a 512-item, 4 MiB aggregate budget with a 1 MiB per-item maximum. Output snapshots are rebased after writer admission; SDK/tool settlement and output finalization are separate release barriers.

Recovery does not promise universal exactly-once execution. Retained receipts require matching identity and parameters, and writer ownership is never reclaimed solely by age or an unverified PID.
