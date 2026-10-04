# Optional terminal inspectors

Inspectors display existing **background-run artifacts**. They do not place or move the child process into a terminal. Native delegation and Pi's fleet/transcript view require neither Herdr nor Ghostty.

```js
subagent({action:"inspector.command", id:"<run-id>"});
subagent({action:"inspector.open", id:"<run-id>", index:0, focus:false});
subagent({action:"inspector.status", id:"<run-id>"});
subagent({action:"inspector.close", id:"<run-id>"});
```

Omit `index` for an aggregate viewer. `dir` can select a known run directory within trusted artifact roots; it is not arbitrary file access. `inspector.command` only returns a standalone Node command and never invokes a terminal manager. Foreground runs use Pi-native inspection instead.

An existing binding determines its owner. Otherwise the preference is Herdr, standalone Ghostty, then explicitly registered inspector providers. A failure never falls back to another host. Operator configuration `disabledFeatures:["panes"]` hides these actions and disables Herdr metadata publication.

## Herdr

Opening requires inherited `HERDR_ENV=1` and an explicit `HERDR_PANE_ID`; the current UI selection is not used as caller identity. `HERDR_BIN` can select an installed CLI. The extension checks the version and source pane, then creates one right-hand sibling split in the run cwd, preserving focus by default. No installation, login, workspace creation or Git operation is performed.

Bindings under `<asyncDir>/inspectors/herdr[-<index>].json` retain the endpoint-routing fingerprint, run/child identity, returned pane/terminal IDs and a unique launch token. Intent is persisted **before** the first mutation. Concurrent operations are serialized with generation-checked locks. A recorded `started` launch means command submission was acknowledged, not that the viewer or child is ready or complete. Failed or ambiguous split/start/close operations retain their evidence; opening again does not blindly create another pane or close the previous one.

Close requires matching endpoint and pane/terminal identity, plus a single foreground process with the exact viewer executable/argv and launch token. An idle badge, title, pane ID alone, lost connection or expired timer is insufficient. Missing process details or an occupied/replaced pane require manual inspection. Removal of the binding follows observed pane absence. These CLI checks are not an atomic lock against concurrent manual terminal reassignment.

Herdr's raw-pane API starts at 0.7.5; opening additionally requires returned terminal identity, and managed close requires `pane process-info` with full argv. Older or incompatible replies fail closed. No universal compatibility claim is made for every Herdr release.

An interactive root Pi session inside Herdr also publishes bounded, temporary subagent-count/activity metadata on its own pane. It neither creates terminals nor changes agent execution state. Headless/child sessions and sessions outside Herdr remain inert. Metadata expires, is cleared on disposal, and is only a UI projection—not completion, acceptance or writer-settlement proof.

## Ghostty

The macOS integration requires the **standalone Ghostty.app** AppleScript terminal/surface-configuration API and OS Automation permission. Embedded hosts such as cmux are not treated as the standalone app.

Set `TAU_SUBAGENTS_GHOSTTY_TERMINAL_ID` to an explicitly selected live terminal ID before starting the parent Pi session. The integration will not guess that the front window belongs to this session. Dynamic commands and paths travel as AppleScript arguments, never interpolated script code. Focus restoration within Ghostty is best effort; no live visual verification is claimed.

Returned terminal identity and opening intent are retained in `inspectors/ghostty[-<index>].json`. Status can report terminal presence but cannot prove the child stopped. **Automatic Ghostty close is unsupported**: close the viewer manually. Errors, missing identity and uncertain openings remain blocked for manual reconciliation; they do not trigger retries or fallback hosts.

## Viewer controls and authority

Generated commands enable `steer`/`stop` only when the artifact's parent session matches the calling session and the corresponding `authorityPolicy.steerRun`/`stopRun` decision is `auto`. This is a launch-time policy snapshot. Ownership is checked again for every submission. A manually invoked viewer without explicit permission and owner identity is observation-only.

A child-specific `stop` targets that child; aggregate stop targets the run. External CLI runners cannot be steered, including through this viewer. Supervisor answers remain in the parent Pi session. A queued control request is not proof of delivery or completion.

**Closing any viewer does not stop the underlying run or release writer admission.** Result files, terminal presence, metadata and viewer closure are never process-terminal evidence. Use ordinary `subagent` status/control and the retained ownership contracts for the actual child.

POSIX commands quote arguments for the shell. Windows-generated commands require **PowerShell 7.3+** with Standard native argument passing; they fail explicitly on older PowerShell and are not cmd.exe commands.

## Reconciliation and remaining placement scope

Inspect retained bindings and the actual host before retrying. Legacy/malformed/symlink/oversized bindings, leftover operation locks and ambiguous effects require manual reconciliation. Nonempty or unreadable inspector directories also block ordinary async-artifact retention; evidence is not reclaimed by age. Do not delete evidence merely to bypass a refusal. If a viewer has genuinely disappeared, remove only its reconciled binding/lock—not run, session or writer state.

Project panes and native/CLI process placement on Herdr machines remain gated separately. Their remote resource, writer-admission and settlement contracts are not implied by this inspector integration. Trusted extension authors can register process-local inspector providers through the existing versioned event contract; this does not introduce stable package subpath exports or ambient provider discovery.
