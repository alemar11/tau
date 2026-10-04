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

## Phase 2: native Git worktrees and handoffs

Native Git allocation is enabled for direct and workflow children in both execution modes. It uses durable branch reservations, the existing writer FIFO, bounded snapshot collection and retained worktrees/branches. Interrupt/resume keeps the owned cwd. See [worktrees](extensions/subagents/docs/worktrees.md).

Managed children capture bounded tracked-file evidence after admission, including retained resumes; ordinary delegation remains Git-free. `runs.lanes()` sequences dependent stages while independent lanes can overlap. Lane status, merge/supersession attestations, read-only cleanup planning and explicitly authorized discard are enabled. No automatic merge, removal, upload or repository-wide prune occurs. A plan is not permission to delete; unknown ownership, process settlement or writer state blocks discard.

Only native Git worktrees are supported. Worktrunk and session sharing through GitHub Gist are explicitly excluded, not deferred. Subagents does not require `gh`; this does not restrict operators or agents using it for separately authorized GitHub work.

## Phase 3: optional CLI runners

The code-owned Claude Code, Codex and Cursor adapters and their read-only/writer profiles are enabled as background-only, one-shot runners. Native and CLI writers share admission; asynchronous deadline-bound preflight probes and execution each carry process-group settlement evidence. Unknown writers retain ownership, including after failed census or cancellation. Workflows await final results, native Git worktrees remain retained, and receipts explicitly reject unsupported resume/steering/fork/structured-output capabilities. See [external runners](extensions/subagents/docs/external-runners.md).

Validation uses local CLI protocol fixtures through the real SDK, not vendor authentication or live models. No runner installation, login, fallback or permission bypass is added.

## Phase 4a: terminal inspection and status

Optional Herdr/Ghostty artifact viewers, standalone commands, process-local inspector registration and interactive-root Herdr metadata are enabled. Intent/identity retention prevents blind retries; Herdr close requires exact viewer-process evidence and confirmed pane absence. Ghostty requires an explicit source terminal and supports presence reporting, not automatic close. Controls remain session-owned and policy-bound. Closing a viewer never settles the child or frees admission. See [terminal inspectors](extensions/subagents/docs/terminal-inspectors.md).

This increment deliberately separates observation from execution placement. The retained placement engines still need adaptation to explicit remote resources, writer admission and fail-closed remote settlement before their gates can be removed.

### Phase 4b preparation: retained placement ownership

The private placement engine now journals intent before remote runtime allocation, pane creation and agent startup, and retains returned identities before further operations. Journals are append-only, bounded and synced; uncertain writes and replaced directories block further effects. Allocation requires an explicitly selected workspace, never a cwd/label inference or fallback workspace, and serializes its twenty-pane cap in the original local storage namespace. Crashed or failed allocation locks are not reclaimed by age or PID.

Cleanup releases local transports only. Remote panes, processes, runtime directories and journals remain retained after success, failure, cancellation and disconnect. Neither Herdr `idle`/`done` nor quiet terminal output proves writer settlement; the private remote CLI projection no longer advertises verified stop. Local native/CLI stop support is unchanged.

The transport foundation now validates bounded JSON/UTF-8 frames independently of socket fragmentation, rejects malformed RPC envelopes, and correlates acknowledgements without replacing pending requests. Pi bridge requests have finite waits, cancellation and the original launch deadline; replay is bounded by both bytes and frame count. Disconnect, release and timeout reject pending/future transport waits with unknown remote state, not successful execution or stopped writers. Malformed peers terminate only their bridge connection, retaining runtime evidence.

This is a tested ownership/transport foundation, **not enabled placement**. Transport deadlines do not yet bound runtime allocation or establish remote writer admission. Public project panes, saved-machine configuration/wiring, explicit remote resource loading, deadline-bound remote writer admission and authoritative process-settlement evidence remain required. No live SSH placement or terminal mutation was exercised; local allocation locks do not coordinate other hosts or manual Herdr operations.

## Remaining phases

| Phase | Scope |
| --- | --- |
| 4b | Herdr project panes and native/CLI process placement |
| 5 | Optional messaging, MCP, permission and provider integrations |
| 6 | Missions, schedules, watchdog, host steps and advanced acceptance gates |

Automatic memory/refinement policy, council/prompt resources, package subpath APIs and embedded/external-job adapters need scoped increments and behavioral coverage before becoming supported public contracts. Deferred features are rejected at active execution boundaries; they are not silently enabled through defaults.

## Runtime contracts

Pi 0.99.1 supplies the SDK as peer dependencies. Node 22.19+ loads the extension without a build. Configuration, agents, environment and process registries use Tau-owned namespaces, independently of host Pi identities.

Explicitly selected resources must resolve before prompting. Failures do not select another model/provider/runner. Untrusted project context is not inherited. Arbitrary extension code remains trusted host code, not an OS sandbox.

Workflow helpers and host-result objects use code-generation-disabled realms. Emit/console/return share a 512-item, 4 MiB aggregate budget with a 1 MiB per-item maximum. Output snapshots are rebased after writer admission; SDK/tool settlement and output finalization are separate release barriers.

Recovery does not promise universal exactly-once execution. Retained receipts require matching identity and parameters, and writer ownership is never reclaimed solely by age or an unverified PID.
