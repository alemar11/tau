# Configuration

Extension settings: `$PI_CODING_AGENT_DIR/tau-subagents/config.json` (default `~/.pi/agent/tau-subagents/config.json`). Agent overrides in Pi settings use the `tauSubagents` object. Configuration and state remain separate from other packages.

Background defaults to true. Set `async:false` per call for native foreground execution; CLI adapters are background-only. No global context default is imposed over the profile preference. Default child depth is 2, per-run spawn budget 64, workflow concurrency 20, and single-child timeout 30 minutes. Writer queues allow at most 64 waiting tickets per canonical directory/root session; queue time is part of the original deadline.

Managed state lives in the user-scoped `tau-subagents-*` temporary root, overridable with `TAU_SUBAGENTS_TEMP_ROOT`. Set an absolute persistent root if OS temporary-file cleanup is inappropriate. Writer state has schema version 1 in `writer-admission-v1/`. Other artifact schemas are independently versioned.

Writer ownership is released only after SDK prompt/tool settlement or verified closure of every external probe/execution process group, followed by output finalization. A crash or malformed transaction is not reclaimed by age or a PID guess. Investigate retained state and verify termination before any manual cleanup. Never remove a live or uncertain writer's state to bypass admission. Queue/admission is not an OS sandbox, nor a lock against the parent, other sessions or external programs.

Native controls for timeout, tool/usage budgets, output bounds, artifact retention and fleet presentation remain available. Default artifact cleanup is governed by `artifactConfig.cleanupDays`; active/uncertain writer ownership is outside artifact retention. Do not store secrets in workflow args or public metadata.

`worktree` defaults to false; set it to true to allocate a native Git worktree for each child. `worktreeProvider` supports only `native`; `worktreeBaseDir` and `worktreeBranchPrefix` customize placement and branch naming. Worktree/setup hooks remain rejected. See [worktrees](worktrees.md) for reservation storage, retention and explicit cleanup.

Optional [terminal inspectors](terminal-inspectors.md) use `authorityPolicy.inspectorOpen`, `steerRun` and `stopRun`; `disabledFeatures:["panes"]` disables their public surface and Herdr metadata. Ghostty requires `TAU_SUBAGENTS_GHOSTTY_TERMINAL_ID`; Herdr uses explicit inherited pane identity. Inspector bindings and interrupted operation locks remain retained until reconciled. The separate `project-panes` and `external-machines` feature groups remain mandatorily disabled while placement is adapted.

Worktrunk and session sharing through GitHub Gist are excluded, not deferred; `gh` is not a runtime requirement. Native feature policy rejects deferred terminal placement, generic/external-job runners, scheduler, mission, watchdog, host-step, acceptance-gate and optional-integration options. It cannot be disabled in configuration. The six supported CLI profiles are opt-in and use bounded code-owned adapters; see [external runners](external-runners.md). Native foreground and background load explicitly selected child resources, never arbitrary ambient extensions. Tau Web is loaded once where required and its tool provenance is checked before prompting.
