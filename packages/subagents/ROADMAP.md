# Subagents scope and roadmap

## Delivery ledger

Current implemented baseline: `a430636`. “Enabled” below refers to local package behavior, not publication or live-provider/platform certification. The root [development map](../../DEVELOPMENT.md) routes repository-wide work; this file owns Subagents' current status.

| Increment | Commit | State |
| --- | --- | --- |
| Native core, supervision, workflows and writer FIFO | `e5d6051` | Enabled |
| Native Git worktrees, lanes and handoff management | `c2b9968` | Enabled |
| Opt-in Claude Code, Codex and Cursor profiles | `ab8dd38` | Enabled; background one-shot only |
| Herdr/Ghostty inspectors and Herdr status metadata | `b5cebde` | Enabled; observation is not process placement |
| Retained Herdr placement intent/receipt ownership | `bab10f1` | Private foundation; placement gated |
| Bounded Herdr RPC/Pi bridge transport | `a13bf94` | Private foundation; placement gated |
| Managed execution host reusing SDK/CLI engines | `a430636` | Locally tested; no pane bootstrap/transport wiring |
| Optional integrations (5), advanced core (6) | — | Pending; retained source is not enabled capability |

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

### Phase 4b preparation: managed executions

The selected placement model is one-shot managed SDK/CLI execution inside retained panes, not persistent interactive agents that can start writing again after an idle badge. Panes and artifacts stay retained. The private execution-host owner now calls the existing background launcher instead of introducing another agent engine: logical host-side profile/model/skill/read selections, an explicit project-trust decision, fresh context, the original deadline and the ordinary native/CLI writer FIFO. Nested cross-host delegation remains unavailable until its lineage and supervision can be carried correctly.

Exclusive private records reserve the runtime slot and run ID. A synced runner-instance receipt precedes the existing startup barrier; results are retained outside the coordinator's consumable mailbox. Completion requires the launcher's live close observation, matching native process-terminal proof and the owned result, not publication or a plausible sidecar alone. Stop is an idempotent engine request, with failures retained, never a release of writer admission. The dispatcher's original writer-storage namespace is pinned into spawned runners. Managed references, including malformed or dangling evidence, block automatic run reclamation. No automatic retries, interactive-agent fallback or artifact deletion are added.

This is a tested ownership/transport foundation and **locally exercised execution-host component, not enabled placement**. It is not yet wired to a pane-host bootstrap or remote transport. Public project panes, saved-machine configuration, allocation-wide deadlines, complete remote resource/identity contracts, supervision routing and trustworthy end-to-end settlement/recovery remain required. Local tests exercise SDK sessions and CLI protocol fixtures, not SSH or live terminal mutation. The execution-host FIFO coordinates only cooperating runs sharing its namespace and root identity; local allocation locks do not coordinate other hosts or manual Herdr operations.

## Remaining work and exit criteria

### 4b — next, still gated

1. **Pane-host bootstrap:** start the managed one-shot execution owner on the selected host using the installed package and SDK/CLI engines. Bind runtime/run/root-session/runner identities before dispatch. Do not fall back to the retained interactive-agent launch path or rediscover ambient extensions.
2. **Transport connection:** carry explicit profile/model/skill/read selections and host project-trust decisions; bound requests, result/artifact transfer, cancellation and reconnect. Preserve the original deadline through allocation, startup, admission and execution, rather than giving each stage a fresh timeout.
3. **End-to-end authority:** distinguish transport acknowledgement, result publication, live process closure and writer release. Preserve the original host storage namespace and uncertain effects across disconnect/crash. Reconnect must not duplicate a launch, adopt a foreign generation or manufacture settlement from idle badges/PIDs. Route immediate-parent supervision explicitly; nested cross-host delegation stays unavailable until lineage and budgets can be carried correctly.
4. **Public machine/project wiring:** expose saved-machine resources and explicit workspace selection only after the preceding contracts work. Adapt project-pane ownership/status/close semantics; retain panes and artifacts by default. Existing local allocation serialization is not cross-host admission or protection against manual topology changes.
5. **Gate removal evidence:** exercise the public dispatch path with real local SDK/CLI processes and socket/host protocol fixtures, including lost acknowledgements, disconnect, replay, cancellation while queued/running, retained artifacts and failed ownership writes. Run root gates and minimum-Node checks. Live SSH, Herdr/Ghostty mutations and provider calls require separate authorization and must not be claimed from fixtures.

Only then reconsider `project-panes` and `external-machines` in `src/shared/phase-one.ts`. The filename is historical; it still owns current feature gates.

### 5 — optional integrations

Inventory and adapt messaging (including the separately developed Openspace bridge), MCP selections, permission contracts, extension bindings and provider-specific integrations. For each integration, define capability discovery, identity/authority, unavailable-provider errors, resource provenance and lifecycle cleanup before enabling it. Add tests at the consumer boundary; native delegation must keep working without the integration. Never substitute another provider or widen permissions after failure.

### 6 — advanced core

Adapt missions, schedules, watchdog, workflow host steps and advanced acceptance/review gates after their dependencies are proven. Durable restart/recovery, duplicate dispatch prevention, cancellation, budgets and publication-versus-completion semantics need behavioral coverage before exposure. Existing neutral `false` settings remain valid; source presence is not an enabled scheduling or acceptance service.

Automatic memory/refinement policy, council/prompt resources, package subpath APIs and embedded/external-job adapters still require scoped implementation and behavioral coverage. Worktrunk, Gist sharing and Orca remain excluded, not backlog items.

## Implementation map

Paths below are relative to `extensions/subagents/src/`; tests live separately in `tests/`.

| Boundary | Owning code | Relevant tests |
| --- | --- | --- |
| Registration, public dispatch and gates | `extension/`, `shared/phase-one.ts`, `shared/disabled-features.ts`, `runs/foreground/subagent-executor.ts` | `sdk.test.mjs`, `installed.test.mjs`, public SDK suites |
| SDK resources, launch and supervision | `runs/shared/child-{launch,session,runtime-config}.ts`, `intercom/native-supervisor-channel.ts` | `native.test.mjs`, `unit/child-*.test.ts`, supervisor/fork suites |
| Writer and process lifecycle | `runs/shared/writer-admission.ts`, `runs/background/{async-execution,subagent-runner,process-terminal,owned-process-tree}.ts` | `writer-admission.test.mjs`, native/external SDK and process-tree suites |
| Git ownership and handoffs | `runs/shared/worktree*.ts`, `parallel-handoff.ts`, `lane-metadata.ts`, `mutation-evidence.ts` | `worktrees.test.mjs`, `worktree-sdk.test.mjs`, `worktree-management.test.mjs`, mutation/handoff units |
| Workflows and recovery | `workflows/`, foreground detach reconciliation and history, background resume/status | `workflows.test.mjs`, `unit/workflow-*.test.ts`, retained-resume SDK tests |
| CLI adapters | `runs/shared/*-adapter.ts`, `external-cli-{preflight,runner,contract}.ts` | `external-sdk.test.mjs`, adapter/preflight/runner units |
| Inspectors and metadata | `inspectors/`, `integrations/herdr-status.ts`, `api/inspectors.ts` | `inspectors-sdk.test.mjs`, inspector/bootstrap/shell/status units |
| Private placement components | `runs/shared/herdr-{placed-run,placement-journal,connection,wire,pi-protocol,pi-channel,managed-execution}.ts`, `extension/herdr-pi-bridge.ts` | `herdr-managed.test.mjs`, `unit/herdr-{placement-retention,transport}.test.ts` |
| Deferred advanced features | `missions/`, `watchdog/`, optional API/integration modules | Retained reader/recovery tests do not prove these features are publicly enabled |

Keep the ledger, exit criteria and [validation evidence](VALIDATION.md) aligned with behavior that actually landed. A new component test does not complete an unwired end-to-end phase.

## Runtime contracts

Pi 0.99.1 supplies the SDK as peer dependencies. Node 22.19+ loads the extension without a build. Configuration, agents, environment and process registries use Tau-owned namespaces, independently of host Pi identities.

Explicitly selected resources must resolve before prompting. Failures do not select another model/provider/runner. Untrusted project context is not inherited. Arbitrary extension code remains trusted host code, not an OS sandbox.

Workflow helpers and host-result objects use code-generation-disabled realms. Emit/console/return share a 512-item, 4 MiB aggregate budget with a 1 MiB per-item maximum. Output snapshots are rebased after writer admission; SDK/tool settlement and output finalization are separate release barriers.

Recovery does not promise universal exactly-once execution. Retained receipts require matching identity and parameters, and writer ownership is never reclaimed solely by age or an unverified PID.
