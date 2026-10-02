# Pi observability and recovery evidence

Foreground progress is streamed in the conversation; background status comes from retained runner artifacts. Neither a dispatch receipt nor a finished status query proves the child finished.

```js
subagent({action:"status"});
subagent({action:"status", id:"<run-id>"});
subagent({action:"status", id:"<run-id>", view:"transcript", index:0});
```

`/subagents` manages profiles. `/subagents-fleet` displays current-session children, progress, output and session paths. Its Enter/inspect action opens a bounded, read-only-in-effect view inside Pi: edits in the editor are discarded. There is no external terminal inspector or project-pane integration in phase 1. Headless callers use structured status/transcript results instead of the TUI.

The fleet retains selection/scroll/detail controls, acknowledged steering and confirmed stop. `/subagents-stop <run-id>` and the corresponding tool action use the same authority checks. `/subagents-detach [run-id]` leaves an eligible foreground child running in the current process; it does not make it a daemon. `/subagents-doctor` reports configuration/runtime diagnostics.

The async widget and FleetView are independent presentation options. For compact chat plus live FleetView, set `inlineToolDisplay:"summary"`, `fleetView:true`, and `asyncWidget:false` in `$PI_CODING_AGENT_DIR/tau-subagents/config.json`. These settings do not change execution or completion authority.

`/subagent-cost` aggregates parent and retained child usage. Missing receipts/artifacts can make totals a lower bound. Pi's ordinary footer does not necessarily account for usage delivered through custom child-completion messages.

## Identity and lifecycle

Status exposes run/session/child identities, cwd, resolved/requested model, steps, timestamps, errors, usage and artifact references. Control events distinguish requested, queued, delivered and failed steering; delivery is not model compliance.

Lifecycle artifacts use `lifecycleArtifactVersion:3`. Process-terminal proof is a separate versioned projection with states `pending`, `observed`, `unknown`, or `not-started`. `observed` requires the owning live observer to see the exact runner close and reconcile tracked session leases. Result-file existence, a PID lookup or a stop request is not this proof. Writer ownership is separate again: it remains blocking until the admitted prompt/tools and output finalization settle.

Queued writers identify the blocking run and FIFO position in foreground progress or a background `writer_queued` event. Waiting consumes the original deadline. Reload never reclaims an uncertain writer by file age or an unverified PID.

## Storage

The default root is `<tmpdir>/tau-subagents-<user-scope>/`, overridden by `TAU_SUBAGENTS_TEMP_ROOT`:

```text
async-subagent-runs/<run-id>/
  status.json
  events.jsonl
  output-<index>.log
  subagent-log-<run-id>.md
async-subagent-results/<run-id>.json
writer-admission-v1/<scope-hash>/queue.json
```

Sessions, transcript/input/output/metadata artifacts and workflow `chain-runs` directories keep their distinct storage roles. Explicit output files are distinct from managed artifacts. Status and receipts expose canonical retained paths; readers must tolerate missing, partial, stale or newer-schema artifacts rather than inventing success.

After completion delivery, the one-shot result may be deleted. Version-1 completion replay and bounded output archives preserve correlated evidence for wait/recovery. An archive may point to an existing output/session file or contain a truncated result tail (at most 64 KiB per child). `bg_wait` includes slim completion identities/references rather than duplicating full output. This is retention-bounded recovery, not a universal exactly-once guarantee.

Default async retention is 30 days with a 24-hour tombstone grace; normal artifacts default to 7 days. Retention does not free writer ownership. Inspect incomplete/uncertain runs before explicit resume or replay. A new session does not silently take ownership of another session's run.

## RPC and events

`/subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]` is the native, read-only host inspection bridge. Outside the TUI it emits and immediately retracts a correlated `TAU_SUBAGENT_INSPECT_JSON:` widget payload. Replies are session-scoped, capped at 64 KiB, and mark truncation; hosts should match request IDs instead of rendering the transport widget. No terminal plugin is required.

Core event names include `subagent:async-started`, `subagent:async-complete`, `subagent:child-status`, and `subagent:process-terminal`. Live events are hints and may duplicate; retained status is authoritative for recovery. An awaited workflow child's completion has `awaitedByWorkflow:true` and does not start an extra parent turn.

`launchResolvedExtensions` describes launch intent, not successful tool registration. `runtimeAcknowledgedExtensions` is a bounded, self-declared acknowledgement from cooperating extensions, not proof of health. Tau Web additionally has an actual loader/provenance check before prompting. `pi.events` is process-local; native supervisor and runner coordination use their own correlated, owned filesystem protocols.

No result/session upload, external terminal observer, or optional message bridge is activated by this core.
