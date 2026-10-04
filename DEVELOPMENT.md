# Development map

This is the repository entry point for implementation status and review priorities. Package READMEs describe usable behavior; package roadmaps distinguish enabled features from retained, gated code. `plans/` is ignored by Git and contains historical/local planning material: it is not the shared source of current delivery status.

## Current state

Baseline for this update: `a430636` on `main`. This records local implementation, not publication or live-provider certification.

| Area | Implemented | Remaining / limits | Owner documentation |
| --- | --- | --- | --- |
| Codex speed modes | Provider/API/model-guarded fast and ultrafast modes, branch-local preferences and footer status | Account eligibility and live tier acceptance are not inferred from local tests | [codex-fast](packages/codex-fast/README.md) |
| Calm | Branch-local quiet presentation, expandable tool errors, animation and shutdown/reload restoration | Private Pi presentation seams need revalidation when upgrading Pi; no visual/IME certification | [Calm](packages/calm/README.md) |
| Orange | Theme and narrow stock-footer presentation adapter | Compatibility beyond the pinned Pi footer format is unproven | [Orange](packages/orange/README.md) |
| Web | Search routing/auth policy, bounded content extraction, public-network checks and branch-scoped cache | Local fixtures do not certify live endpoints/accounts; registry publication is not validated | [Web](packages/web/README.md) |
| Subagents | Native core, native Git worktrees/lanes, six optional CLI profiles, terminal inspectors; private placement ownership/transport and managed execution components | **4b is incomplete and gated; 5 and 6 are pending** | [Roadmap](packages/subagents/ROADMAP.md), [validation](packages/subagents/VALIDATION.md) |
| Openspace | Committed steps 01–11 through `de396e2`: broker, registry/recovery, messaging, Pi delivery, asks, UI, channels, outbox and CLI | External integrations, handover, Subagents bridge and final integration/release validation remain separate work. Concurrent working-tree changes are not a completed release | [Openspace](packages/openspace/README.md) and its linked contracts |

For Subagents, the next implementation step is the **managed pane-host bootstrap and transport connection**, not enabling all remaining feature flags. The [ordered remaining work](packages/subagents/ROADMAP.md#remaining-work-and-exit-criteria) includes its acceptance boundaries.

## Code and test ownership

| Area | Code | Main behavioral evidence |
| --- | --- | --- |
| Shared tooling | Root `package.json`, lockfile, `mise.toml`, `tsconfig.base.json`; package manifests/configs | Workspace checks; Pi resource-loader and installed-layout tests in the consuming packages |
| Codex speed modes | `packages/codex-fast/extensions/codex-fast.ts` | Provider/API isolation, payload preservation, branch restore and command transitions |
| Calm / Orange | Owning `extensions/`, plus Orange's `themes/` | Lifecycle restoration and real Pi component rendering, including narrow widths and later adapters |
| Web | `packages/web/extensions/web/` | Local HTTP/DNS/worker fixtures, auth/routing boundaries, cross-process cache and real SDK branch visibility |
| Subagents | [Subsystem map](packages/subagents/ROADMAP.md#implementation-map) | Local SDK/CLI/socket/Git integration tests plus focused lifecycle, ownership and protocol regressions |
| Openspace | `packages/openspace/src/`, `extensions/`, CLI and extension API entries | Real local broker processes/sockets, SDK delivery, protocol faults and installed CLI/API consumers |

Runtime dependencies belong to the importing package. Pi is host-provided through peers; root development dependencies pin **0.99.1**. Node **22.19.0** is the minimum supported runtime. TypeScript is loaded directly; no extension-only build is needed.

## Development loop

Use root npm commands as workspace tooling; load individual package directories for targeted development. Do not change personal Pi registration, call live providers or mutate terminal topology merely to run tests.

```sh
mise exec -- npm run check
mise exec -- npm test
# Narrow the feedback loop, but run root gates after code changes:
mise exec -- npm test --workspace subagents
mise exec -- npm test --workspace web
```

`check` runs the available workspace TypeScript checks; there is no separate repository lint command. The Subagents TypeScript tests execute with Node's type stripping, but are not included in its extension `tsconfig.json`: passing runtime tests does not imply those test files were type-checked.

Use a targeted `npm pack --dry-run --ignore-scripts --workspace <npm-name> --json` check when resource/packaging boundaries change. An installed-layout test is useful evidence for resolution, not proof that a registry tarball has been published or can install independently of all local dependencies.

After a selected increment: inspect the diff, run relevant behavioral tests and root gates, update its roadmap/validation limits, and commit only that scope when authorized. Keep concurrent package changes separate. A local commit does not imply a push.

## What makes a test worth keeping

A test should identify a behavior or regression, exercise the responsible boundary, and assert an externally meaningful result or a load-bearing internal invariant.

- Prefer actual outputs, state transitions, forbidden side effects and retained ownership over source-text searches, helper existence or a broad “did not throw”.
- Keep boundary cases that fail differently: malformed input, exact byte limits, cancellation, identity drift, unknown settlement and repeated delivery are not interchangeable just because they use similar setup.
- Use focused units for parsers/state machines and a smaller number of real loader/SDK/process/socket tests for wiring. Do not mock the same boundary the test claims to verify.
- A test for a tiny helper can protect shell quoting, redaction or correlation; size is not a deletion criterion. Conversely, a large smoke test is not useful if its assertions only check launch receipts.
- Before removing a test, name the surviving test that preserves each meaningful assertion and scenario. Source presence or a passing reduced suite is not evidence of equivalent coverage.
- For a suspected weak test, try a bounded regression mutation in an isolated copy. It should fail at the intended assertion, not merely crash during import. Do not weaken ownership/settlement assertions to make timing-sensitive tests pass.
- Share fixtures when they remove duplicated setup without hiding assertions. Avoid expanding unrelated production code solely to make tests convenient.
- Test counts are a run summary, not a coverage or quality target. Record untested live providers, platforms, UI behavior and failure interleavings explicitly.

## Maintenance review after `bcfb873`

The review inventoried all six workspaces, root tooling/configuration and documentation, and inspected representative implementations and tests. It is not a line-by-line audit of every retained Subagents subsystem. Openspace was inspected read-only because it has concurrent work; no changes there belong to this review. `node_modules/` and the generated lockfile were checked for dependency ownership, not manually cleaned; ignored `plans/` remains historical material.

| Finding | Correction and evidence |
| --- | --- |
| Calm's “no extension bar label” test never recorded `setStatus` | The UI fixture now implements the actual Pi method. An isolated mutation adding an optional `setStatus` call passed the old test and fails the corrected assertion. |
| Web's “live lock” fixture had an invalid token, so it never reached the live-process check | Use a valid UUID/current PID and assert unchanged ownership, records and readable content. Keep malformed/incomplete ownership as separate coverage. Removing the live-owner check in an isolated copy passed the old test and now fails. |
| Parallel result ordering was tested only with immediately resolved callbacks | Hold item zero while later items finish; assert input-ordered results, full bounded concurrency and immediate startup. A completion-order mutation passed the old test and fails the new one. Add queued-permit recovery after rejection and deterministic settlement barriers. |

The standalone “starts within 20 ms” test was replaced, not simply dropped: the new out-of-order test asserts that all three initial workers start in the same turn, while the fourth waits for capacity. Existing early-rejection settlement coverage remains, without polling sleeps. These three targeted mutations demonstrate sensitivity to those regressions only, not a repository-wide mutation score.

Small verified cleanup: remove unused exports/imports from `packages/subagents/tests/support/helpers.ts` (the only consumer imports the retained event-bus and agent fixtures), the unused local worker-index argument, and Calm's never-configured private `smallBodyFrames` branch. Test support is not shipped or dynamically discovered as an extension. No public API, feature gate or execution engine was removed. Keep small quoting, redaction, policy-default and identity tests where they protect distinct contracts; gated modules are not assumed dead.

Validation on macOS: root `npm run check` on Node 22.19.0 and 26.10.0; root `npm test` on Node 26 reports **927 passed, two skipped, zero failed**. That working-tree run includes 234 concurrent Openspace tests and is not a commit-only release certification. All affected-package suites also pass on Node 22: Calm 30, Subagents 566/two skipped, Web 76. Review and tests do not certify live providers, native Windows/Linux or terminal placement.

## Open maintenance issues

- **Packaging documentation conflicts:** root `package.json`, `README.md` and on-disk `AGENTS.md` describe an aggregate bundle; the Subagents load guide says the root is tooling-only. Individual-package loading is the common supported path. Reconcile the intended root policy before changing installation instructions or the resource manifest; this documentation update does not choose a new packaging policy.
- **Host dependency caveat:** the pinned Pi 0.99.1 shrinkwrap retains the reported `brace-expansion` issue. See [Subagents validation](packages/subagents/VALIDATION.md#limits). Do not silently upgrade or patch the host SDK as unrelated cleanup.
- **Deferred code is not automatically dead:** Subagents' missions, watchdog, project placement and integration sources include shared readers/types used by current recovery paths. Trace callers and registration before removal; keep their public gates until their full contracts are validated.
- **Review boundary:** Openspace has concurrent changes. Inventory and read-only inspection are possible, but cleanup or claims about its final state must be based on its owning change, not silently folded into a Subagents review.
