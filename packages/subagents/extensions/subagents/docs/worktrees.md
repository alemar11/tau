# Native Git worktrees

Opt in per call, or set `worktree: true` in the Subagents configuration:

```js
subagent({agent:"worker", task:"Implement the selected change", worktree:true});
subagent({agent:"worker", task:"Inspect and fix the test", isolation:"worktree", baseRef:"refs/heads/main", async:false});
```

`worktree:false` overrides the configured default. Ordinary native delegation still needs no Git executable. Foreground, background and workflow children use the same allocator and writer admission. A workflow's `worktree:true` is inherited by its children unless overridden.

## Allocation and isolation

- Git and a clean source checkout are required. Uncommitted changes are not copied, committed or stashed automatically. Managed `.pi/subagents/` artifacts are excluded from the cleanliness check.
- Each child receives a separate directory and branch, based on the resolved commit. `baseRef` defaults to `HEAD`; named refs are supported, but revision expressions and raw commit IDs are rejected. A source subdirectory remains the child's relative working directory.
- The provider is always `native`. Worktrunk and automatic allocator selection are excluded. Setup hooks and implicit Git hooks are not enabled. No fallback allocator, dependency installation, merge or upload runs automatically.
- The default location is a sibling `worktrees/<repo>-<path-hash>/` directory. Repositories inside Pi's extension directory use the agent directory's `worktrees/` instead. `worktreeBaseDir` or `TAU_SUBAGENTS_WORKTREE_DIR` can choose a root outside the checkout and Pi extension-discovery directories. `worktreeBranchPrefix` defaults to `tau-subagents/`.
- Writer admission remains FIFO per canonical cwd and root session. Writers on distinct worktrees can overlap; writers targeting the same cwd cannot. Setup waiting and Git allocation consume the original launch deadline and can be cancelled without launching a child.

Worktrees isolate repository files, **not** all process effects. Git metadata is shared. An existing `node_modules` directory is linked, not copied. Absolute output paths, nested/overlapping cwd values, databases, ports and services can still collide. Tools and extensions retain the user's OS permissions; this is not a sandbox.

## Results and recovery

`parallelHandoff.path` points to the manifest with worktree paths, branches, base commits, patch references and retention diagnostics. Patches use a temporary index: collection does not stage the child's files or remove dependency links. A patch is a point-in-time snapshot, not a live view; review the current worktree again after resume or manual edits. Managed runs also expose `effects.trackedMutations`: before/after tracked-file evidence anchored to the commit at writer admission (including changes committed by the child). Dirty-at-start fingerprints avoid attributing pre-existing changes. Untracked files, index-only transitions and changes reverted before collection are not exhaustive mutation history. This is neither acceptance nor authorship proof; ordinary delegation still does not probe Git.

Tracked evidence has a five-second total budget per snapshot/collection, a 500-path limit per tracked-path listing, 1 MiB path-list output and 8 MiB per diff. Oversized, timed-out or failed probes report unavailable/truncated evidence; they never trigger removal. Hooks, fsmonitor, external diff/textconv and inherited Git path overrides are disabled.

Before collection, the finalizer acquires writer admission on the child cwd and validates creation ownership, directory identity and the current branch. It waits at most two seconds, also bounded by the original deadline. Unknown or active writers, changed ownership, missing directories and capture failures leave the worktree intact and report missing evidence. Synchronous Git snapshot commands have a five-second command timeout and an 8 MiB output bound; capture failure does not destroy the authoritative worktree.

A version-1 reservation under `<git-common-dir>/tau-subagents/worktree-owners-v1/` records the branch, allocation run, creator run/root session, path, ownership token, directory identity and original writer-storage namespace. Atomic reservation prevents separate processes from claiming the same branch. Creation ownership is separate from the live writer lease. Neither age nor an unverified PID reclaims a reservation. A malformed or incomplete reservation blocks reuse and requires investigation; failed/cancelled allocation may leave partial artifacts for that investigation.

Interrupt/resume preserves the managed cwd rather than allocating a replacement. A replaced directory or ownership token cannot authorize a resume. Existing session/contract checks still apply, and an uncertain active writer cannot be bypassed by retrying or reloading. Resuming requires the original root session and writer-storage location: changing `TAU_SUBAGENTS_TEMP_ROOT` is not a way around old admission state. Recovery references retain their original ownership across successive resumes.

## Explicit cleanup only

**Worktrees and branches remain after success, failure, interruption or cancellation.** A captured patch never authorizes automatic removal. `cleanupState:"partial"` records deliberate retention, not by itself a failed model task. Artifact retention does not delete worktrees, branches or ownership reservations.

Inspect status and optionally generate a cleanup plan:

```js
subagent({action:"lane.status", handoffPath:"/absolute/path/parallel-handoff.json"});
subagent({action:"worktree.cleanup", mode:"plan", repo:"/absolute/path/repo"});
```

Planning reads Git/metadata and writes a bounded plan artifact, without removing anything. Entries distinguish safe, dirty, active, unknown, stale and ineligible state. Missing writer storage or unverified process settlement means unknown, not idle. Plans expire after 30 minutes and support **no apply/removal mode**. Review again after any change.

For deliberate destruction of the preserved worktrees named in a handoff:

```js
subagent({action:"worktree.discard", handoffPath:"/absolute/path/parallel-handoff.json"});
```

Default policy requires interactive confirmation; headless calls fail unless the operator has explicitly configured an applicable auto-authorization policy. The request still must pass ownership, terminal-process and writer-idleness checks. Authorization is bound to the reviewed manifest digest and rechecked after acquiring the creator's writer leases. Dirty/unmerged work may be lost: this is **discard**, not patch acceptance or integration.

Discard removes only the named managed paths and deletes each branch using its expected HEAD. It does not prune other Git worktree registrations, reclaim reservations, or delete a branch checked out elsewhere. Partial deletion is persisted for manual reconciliation; changed ownership, active/uncertain writers and incomplete earlier cleanup remain blocking. Artifacts inside a directory being removed cannot serve as its retained evidence.

`lane.recordMerge` and `lane.recordSupersession` store attestations bound to handoff facts. They do not perform a merge, query GitHub, or grant deletion authority. The merge-attestation contract includes a supplied PR number and reviewed/merged commit IDs; local cleanup does not require a PR or attestation. Worktrunk and Gist sharing are excluded entirely; `gh` is not required.

Alternatively, after independently verifying cessation and reviewing the work, use Git explicitly:

```sh
git -C /path/to/repo worktree remove /path/to/retained-worktree
git -C /path/to/repo branch -d tau-subagents/retained-branch
```

These non-forcing commands can refuse dirty or unmerged work. Do not bypass that refusal without reviewing what would be lost. Never remove writer/creation ownership records merely to unblock another launch. External/manual Git operations are not protected by Subagents' admission protocol.
