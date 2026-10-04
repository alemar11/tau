# Subagents validation

Target: Pi **0.99.1**, Node **22.19.0+**. Local automated validation was run on macOS with Node **22.19.0** and **26.10.0**, using the pinned host SDK.

## Gates

From the repository root:

```sh
npm run check
npm test
npm test --workspace subagents
```

**566 Subagents tests pass, with two Windows-only tests skipped, on both Node versions.** The suite covers native execution, optional CLI adapters, terminal inspectors, retained placement ownership/transport, the private managed execution host, worktree management and lifecycle contracts. Root type checks pass on both versions. Repository-wide tests on Node 26.10.0 report **918 passed, two skipped, zero failures**. The native PowerShell integration suite is also not executed on macOS. Concurrent Openspace changes are left untouched.

`npm pack --dry-run --ignore-scripts --workspace subagents --json` verifies the package name/entry and that test files are outside the shipped resource layout: **350 shipped files**, no tests.

## Evidence

- Real Pi loader and public tool execution; explicit fork rejection, profile discovery and model selection.
- Real foreground SDK and separate background runner with a deterministic local provider; no live model/provider calls. The native smoke makes Git unavailable and asserts it is not probed.
- Real SDK/public inspector actions and registration while a native background writer is held at a barrier: viewer open/status/close do not stop the child, change process-terminal evidence or release admission. Phase gates continue rejecting project placement.
- Herdr/Ghostty protocol fixtures: explicit caller identity, durable intent before mutations, retained ambiguous effects, no rollback/fallback/duplicate creation, generation-checked operation locks, changed endpoint/terminal/process rejection, exact viewer argv/token verification, and terminal-presence-only status. No live panes are created or closed.
- Private placement-engine fixtures: synced bounded intent/receipt journals, explicit workspace selection, retained partial allocations/start failures, no blind retries/rollback closure, original storage namespace, concurrent workspace capacity, replaced directories/lock generations and a real killed local lock-holder process. Bridge shutdown retains runtime evidence. Transport disposal, idle badges and quiet output do not claim remote writer cessation. Public project/machine actions remain disabled.
- Real local socket fixtures for the retained placement transport: fragmented/multibyte/coalesced frames, exact byte limits, partial EOF, invalid envelopes/identity, subscription acknowledgement and single disconnect, observer failures, cancellation/deadlines, duplicate waiters, bounded replay and malformed-peer isolation. Pi frames are limited to 1 MiB, RPC frames to 4 MiB, bridge replay to 1024 frames/8 MiB and pending acknowledgements to 64. Transport timeouts/release remain unknown remote state; non-integer or discontinuous reconnect cursors cannot establish continuity. These are not execution/admission/settlement proofs.
- Private managed execution-host tests reuse real SDK sessions and all six local CLI adapter fixtures: explicit host-side profile/model/resources and project trust, fatal missing resources, no Git probes, native/CLI FIFO contention, queued/running cancellation, original deadlines and writer namespace, and independent result/process-proof barriers. Neither publication nor a syntactically valid forged sidecar settles a held writer without the launcher's live close observation; unknown census blocks its successor. Synced startup receipts precede prompting, duplicate calls cannot relaunch, failed stop intents remain latched, foreign/oversized proof cannot assert cessation, and replaced ownership is retained. Managed references block run reclamation even when malformed or dangling. These tests do not start a pane host or establish a remote transport contract.
- Session-owned, explicitly permitted viewer controls; child-safe command generation cannot grant controls, CLI runners reject steering, child stop preserves its target, terminal control characters are neutralized, and ordinary Node runs the packaged viewer. Nonempty/unsafe inspector state blocks artifact retention.
- Herdr metadata lifecycle, bounded labels, missed-event reconciliation, attention overlays, coalescing, refresh/disposal and root-UI/headless gating; POSIX command round-trips and Windows literal-argument/PowerShell-version guards.
- Real public SDK dispatch to local Claude Code, Codex and Cursor protocol fixtures: native/CLI FIFO contention, original launch identity, no implicit Git probes, non-resumable receipts, malformed protocol rejection, queued/running stop, retained worktree mutation evidence and workflow completion barriers.
- Bounded asynchronous preflight with cancellation/deadlines, per-probe process identity and descendant settlement; raw log/parser bounds, environment allowlists, safe argv/private prompt transport, model/effort validation, reserved read-only names and receipt persistence.
- Failed process census keeps ownership and private prompts even after runner exit; a subsequent native writer cannot launch. EPERM alone is never terminal evidence, and missing descendant enumeration fails closed. Terminal observer failures propagate only after logs settle.
- Trusted/untrusted repository context; missing selected extension rejection; attempted dynamic reader capability expansion cannot write.
- Real mixed foreground/background writer contention with file barriers. The next writer waits through output finalization and does not claim its predecessor's file.
- FIFO/cancellation/deadline/symlink scope, generation-safe release, descendant conflict, malformed state, tool/finalizer barriers, independent roots, separate processes and killed-owner retention.
- Native immediate-parent supervision, owner/correlation checks, queued input, interrupt/timeout/compaction lifecycle and retained-session/receipt/revival contracts.
- Real Git worktrees through the public SDK tool: concurrent foreground/background writers, workflow children, unchanged source files, retained paths/branches and handoff patches. Interrupt/resume reuses the managed cwd; altered ownership cannot authorize resume.
- Same-cwd/symlink FIFO and snapshot exclusion while a writer is active; distinct worktrees admit concurrently. Temporary-index snapshots preserve the child's actual index and dependency links.
- Dirty sources, invalid/named base refs, unsafe roots, inherited Git path variables, suppressed Git hooks, cancellation/deadlines (including queued setup), partial allocation, replaced directories/ownership, malformed reservations and cross-process branch contention.
- Workflow dependency/parallel behavior, stable results, status/steer/ref APIs, immutable args, partial failure, unobserved promises, key/spawn/output validation and phase gates.
- Workflow lanes, predecessor/resume references, independent-lane continuation and blocked-stage propagation. Real SDK three-stage lanes retain one managed cwd across successive resumes; ownership references survive foreground history persistence and reject replacement or changed writer namespaces.
- Read-only cleanup plans (including committed divergence without staging), explicit dirty discard, authorization and manifest-digest binding, missing/active writer state, forged process-settlement rejection, replacement ownership, and preservation of unrelated Git registrations. Branches checked out elsewhere survive partial discard; reservations remain intact.
- Handoff merge/supersession attestations and stale fact bindings, without executing merges or GitHub operations.
- Admission-based tracked mutation evidence in real foreground/background SDK results and resumes; pre-existing dirty/staged files, subdirectory cwd, reversions, committed changes, large diffs and oversized evidence. Gist sharing and non-native allocators remain rejected; their launch/upload implementations are removed.
- Regression tests for unrestricted Function exposure through workflow helpers, promises, errors, host results and console inspection callbacks.
- Explicit Tau Web provenance and effective tool availability in foreground/background; Web's owning suite separately verifies transport fixtures and branch-scoped cache behavior.
- Copied installable resources under `node_modules/subagents` and `node_modules/web`, with host/runtime dependencies supplied locally: the real resource loader and background runner work without relying on development-only source paths or a second private SDK.

A Node 22 full-suite run exposed a test ordering race: the SDK result watcher consumed a published result while the test waited for separate process-terminal evidence. The fixture now captures the publication first without weakening the terminal-proof assertion; the final Node 22 and Node 26 gates pass.

## Limits

- No live-provider credentials/calls, semantic research-quality evaluation or visual TUI verification. Herdr CLI help/schema and the installed Ghostty AppleScript dictionary were inspected, but host behavior, Automation permissions and actual terminal rendering/focus were not exercised. Inspector/ownership fixtures and locally exercised managed execution do not validate a remote bootstrap, machine/resource mapping, supervision routing or end-to-end remote writer settlement/recovery. The managed host is not yet connected to the placement transport, and project/machine gates remain closed. No SSH connection or live terminal mutation was exercised. Local allocation locks are not distributed admission or protection against manual topology changes.
- No native Windows/Linux run; two Windows-only spawn tests and the native PowerShell integration suite are not executed on macOS. Simulated platform cases are not native OS validation. CLI tests use local protocol fixtures, not actual vendor versions/authentication; process groups cannot prove cessation of arbitrary daemonized writers or external services.
- Not every crash/reload or Git subprocess failure interleaving is fault-injected. Worktrees are not a sandbox: Git metadata, linked dependencies and external resources remain shared. Cleanup planning is advisory, not atomic authorization; there is no plan-apply mode. Explicit discard requires settlement/ownership and may lose dirty work. Automatic deletion/merge and Gist sharing are not enabled. Deferred scope is tracked in `ROADMAP.md`.
- The package is private and depends on sibling Tau `web` via `file:../web`; this validates checkout/local-resource installation, not publication of a standalone registry tarball.
- `npm audit` reports one high-severity transitive `brace-expansion` issue in Pi 0.99.1's published shrinkwrap (`5.0.9`). Normal `npm update`/`npm audit fix` do not replace that locked host dependency. Pi was not silently upgraded and its installed files were not patched. This remains a host SDK security caveat.

No personal Pi installation or publication is part of this validation.
