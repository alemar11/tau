# subagents

Tau-native Pi delegation. Target: **Pi 0.99.1**, **Node 22.19+**, no build step. npm package: **`subagents`**. Public tool: **`subagent`**. See the [scope and roadmap](ROADMAP.md).

## Load

From a Tau checkout with its dependencies installed:

```sh
pi -e ./packages/subagents
# Or retain the local package registration:
pi install /path/to/tau/packages/subagents
```

The Tau root bundle also includes it; install the bundle **or** individual packages, not both. The local `web` dependency belongs to Tau. No external runner, Git executable or terminal manager is required for ordinary native delegation. Git is required only when opting into worktree isolation. Configuration and state use Tau-owned namespaces.

## Use

```js
subagent({agent:"scout", task:"Map the relevant source"});
subagent({agent:"reviewer", task:"Review these supplied changes", async:false});
subagent({agent:"oracle", task:"Challenge the chosen design", context:"fork"});
subagent({action:"status", id:"<run-id>", view:"transcript"});
```

Background is the default; a dispatch receipt is **not** completion. Model precedence is call → profile → coordinator at launch. Context is fresh except oracle's fork preference; an explicit unavailable fork fails. Project instructions follow Pi trust. Seven bundled roles: scout, researcher, evidence-auditor, worker, reviewer, oracle, delegate.

Custom profiles: `$PI_CODING_AGENT_DIR/tau-subagents/agents/` (default `~/.pi/agent/tau-subagents/agents/`) and `.pi/tau-subagents/agents/`. Settings use `tauSubagents`; extension configuration is `tau-subagents/config.json` beneath the agent directory.

- [Profiles and Tau Web](extensions/subagents/docs/agents.md)
- [Workflow API and dependency barriers](extensions/subagents/docs/workflows.md)
- [Native Git worktrees and explicit cleanup](extensions/subagents/docs/worktrees.md)
- [Controls, supervisor replies, output and Pi UI](extensions/subagents/docs/tool-reference.md)
- [Configuration, limits and ownership](extensions/subagents/docs/configuration.md)

`/subagents` opens the manager; `/subagents-fleet` shows live runs and Pi-only transcript inspection. Structured status/control also work headlessly. `contact_supervisor` routes to the immediate parent; `subagent_supervisor` answers correlated questions. Steering, interrupt, terminal stop and explicit resume remain distinct.

## Writer admission and recovery

One writer per **canonical cwd and root session**, across foreground/background, workflows and descendants. FIFO queues allow **64 waiting writers**; time spent waiting counts against the request deadline. Cancellation before admission never prompts a child. A descendant conflicting with its own writer ancestor is rejected.

`bash`, `write`, `edit`, unknown tools/extensions and explicit output-file bindings are conservatively writers. Reader tool calls cannot acquire mutating capabilities dynamically. Managed logs/cache alone do not make a writer. Readers may overlap, but have no immutable snapshot. This is not an OS sandbox or a lock against the coordinator, other sessions, nested/overlapping paths or external programs.

Writer state is versioned in the user-scoped temporary root's `writer-admission-v1/`. `TAU_SUBAGENTS_TEMP_ROOT` can select persistent storage. Admission is not released by a receipt, stop request, saved result or bounded SDK disposal: prompt/tool termination and output finalization must be observed. Malformed state, a crashed transaction or an unverified owner remains blocking; there is **no age/PID-based automatic reclamation**. Diagnose the queue and verify cessation before manually removing any ownership state. Reload does not replay work automatically.

Default limits: depth 2, 64 spawns per run, workflow concurrency 20, single-child timeout 30 minutes. Artifact retention defaults to 7 days; async retention is 30 days with a 24-hour tombstone grace. Writer ownership is separate from artifact cleanup. Do not put secrets in workflow args or public metadata.

## Native worktrees and phase boundaries

Phase two enables native Git worktrees, tracked mutation evidence, workflow lanes and handoff management. Use `worktree:true` (or `isolation:"worktree"`), optionally `baseRef`. Distinct worktrees allow concurrent writers; the same cwd still uses FIFO admission. Worktrees and branches are **retained by default**, including after cancellation. `worktree.cleanup` creates a read-only plan; `worktree.discard` requires explicit authorization and verified settlement/ownership. Merge and supersession actions record evidence, never execute a merge. See the worktree guide for safety and shared-resource limits.

Worktrunk and session sharing through GitHub Gist are explicitly excluded; `gh` is not a Subagents runtime requirement. External AI runners, terminal managers, optional integrations, missions/schedules/watchdog and advanced gates remain tracked for subsequent increments. Their public launch options/actions are rejected. Deferred source is not advertised as an installed capability. Advanced package subpath APIs and council/prompt resources still require their own increments; see `ROADMAP.md`.

## Validation

See [validation evidence and limits](VALIDATION.md), including the Pi 0.99.1 shrinkwrapped dependency audit caveat.

```sh
npm run check
npm test
```

Tests are in this package's `tests/`, outside extension discovery: lifecycle/context/supervision/recovery tests, FIFO/cancellation/ancestry/process-crash tests, workflow boundaries, the real Pi resource loader/tool context, and real foreground/background SDK execution using a deterministic local provider. Tau Web's own suite covers transport/cache behavior; the native smoke additionally checks explicit Web loading/provenance.

These tests do not establish live-model research quality, live-provider authentication, interactive visual correctness, or Windows/Linux process behavior. Simulated platform unit cases are not native OS validation. No live-provider calls or personal Pi installation are part of the suite.
