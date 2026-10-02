# Phase-one validation

Target: Pi **0.99.1**, Node **22.19.0+**. Local automated validation was run on macOS with Node **22.19.0** and **26.10.0**, using the pinned host SDK.

## Gates

From the repository root:

```sh
npm run check
npm test
npm test --workspace subagents
```

**297 Subagents tests pass on both Node versions**, covering native execution and lifecycle contracts. Root type checks pass on both versions. The latest root `npm run check` and `npm test` also pass across the current workspaces.

`npm pack --dry-run --ignore-scripts --workspace subagents --json` verifies the package name/entry and that test files are outside the shipped resource layout.

## Evidence

- Real Pi loader and public tool execution; explicit fork rejection, profile discovery and model selection.
- Real foreground SDK and separate background runner with a deterministic local provider; no live model/provider calls. The native smoke makes Git unavailable and asserts it is not probed.
- Trusted/untrusted repository context; missing selected extension rejection; attempted dynamic reader capability expansion cannot write.
- Real mixed foreground/background writer contention with file barriers. The next writer waits through output finalization and does not claim its predecessor's file.
- FIFO/cancellation/deadline/symlink scope, generation-safe release, descendant conflict, malformed state, tool/finalizer barriers, independent roots, separate processes and killed-owner retention.
- Native immediate-parent supervision, owner/correlation checks, queued input, interrupt/timeout/compaction lifecycle and retained-session/receipt/revival contracts.
- Workflow dependency/parallel behavior, stable results, status/steer/ref APIs, immutable args, partial failure, unobserved promises, key/spawn/output validation and phase gates.
- Regression tests for unrestricted Function exposure through workflow helpers, promises, errors, host results and console inspection callbacks.
- Explicit Tau Web provenance and effective tool availability in foreground/background; Web's owning suite separately verifies transport fixtures and branch-scoped cache behavior.
- Copied installable resources under `node_modules/subagents` and `node_modules/web`, with host/runtime dependencies supplied locally: the real resource loader and background runner work without relying on development-only source paths or a second private SDK.

## Limits

- No live-provider credentials/calls, semantic research-quality evaluation or visual TUI verification.
- No native Windows/Linux run; simulated platform unit cases are not native OS validation.
- Not every crash/reload interleaving is fault-injected. Deferred scope is tracked in `ROADMAP.md`.
- The package is private and depends on sibling Tau `web` via `file:../web`; this validates checkout/local-resource installation, not publication of a standalone registry tarball.
- `npm audit` reports one high-severity transitive `brace-expansion` issue in Pi 0.99.1's published shrinkwrap (`5.0.9`). Normal `npm update`/`npm audit fix` do not replace that locked host dependency. Pi was not silently upgraded and its installed files were not patched. This remains a host SDK security caveat.

No personal Pi installation or publication is part of this validation.
