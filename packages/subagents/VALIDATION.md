# Native core and Git management validation

Target: Pi **0.99.1**, Node **22.19.0+**. Local automated validation was run on macOS with Node **22.19.0** and **26.10.0**, using the pinned host SDK.

## Gates

From the repository root:

```sh
npm run check
npm test
npm test --workspace subagents
```

**339 Subagents tests pass on both Node versions**, covering native execution, worktree isolation/management and lifecycle contracts. Root type checks pass on both versions. The latest root `npm test` on Node 26.10.0 passed **663 tests** across the workspaces; unrelated concurrent Openspace work was left unchanged.

`npm pack --dry-run --ignore-scripts --workspace subagents --json` verifies the package name/entry and that test files are outside the shipped resource layout.

## Evidence

- Real Pi loader and public tool execution; explicit fork rejection, profile discovery and model selection.
- Real foreground SDK and separate background runner with a deterministic local provider; no live model/provider calls. The native smoke makes Git unavailable and asserts it is not probed.
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

## Limits

- No live-provider credentials/calls, semantic research-quality evaluation or visual TUI verification.
- No native Windows/Linux run; simulated platform unit cases are not native OS validation.
- Not every crash/reload or Git subprocess failure interleaving is fault-injected. Worktrees are not a sandbox: Git metadata, linked dependencies and external resources remain shared. Cleanup planning is advisory, not atomic authorization; there is no plan-apply mode. Explicit discard requires settlement/ownership and may lose dirty work. Automatic deletion/merge and Gist sharing are not enabled. Deferred scope is tracked in `ROADMAP.md`.
- The package is private and depends on sibling Tau `web` via `file:../web`; this validates checkout/local-resource installation, not publication of a standalone registry tarball.
- `npm audit` reports one high-severity transitive `brace-expansion` issue in Pi 0.99.1's published shrinkwrap (`5.0.9`). Normal `npm update`/`npm audit fix` do not replace that locked host dependency. Pi was not silently upgraded and its installed files were not patched. This remains a host SDK security caveat.

No personal Pi installation or publication is part of this validation.
