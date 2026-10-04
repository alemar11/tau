# Optional CLI runners

Subagents supports six opt-in, code-owned profiles. Ordinary native delegation never requires these programs, probes them or falls back to them.

| Profile | Access | Prerequisites |
| --- | --- | --- |
| `claude-code` | Plan mode, no tools | Authenticated `claude`; trusted user settings/hooks |
| `claude-code-writer` | Read/Write/Edit/Glob/Grep, `acceptEdits`; no Bash | Same |
| `codex-exec` | Read-only sandbox, approval policy `never` | Authenticated `codex` |
| `codex-exec-writer` | Workspace-write sandbox, approval policy `never` | Same |
| `cursor-agent` | Read-only ask mode, sandbox enabled | `cursor-agent`, API key or existing login, existing workspace trust |
| `cursor-agent-writer` | Print-mode writer, sandbox enabled | Same |

```js
subagent({agent:"codex-exec", task:"Review the supplied files"});
subagent({agent:"claude-code-writer", task:"Implement the selected fix", model:"sonnet:high", worktree:true});
subagent({agent:"cursor-agent-writer", task:"Update the selected file", async:true});
```

These are **background-only, one-shot executions**. Omit `async` or use `async:true`; `async:false`, `clarify` and `foregroundOnly` fail. Status, final output, artifacts and terminal stop work through the normal Subagents controls. A workflow can await `runs.run("review", {agent:"codex-exec",task:"Review"})`; explicitly requesting child `async:true` instead returns a dispatch receipt, not completion.

## Capability boundaries

- No durable resume, native fork context, live steering, trusted tool/supervisor events, native structured output or extension bindings. Receipts explicitly say `not-resumable`; JSON-looking stdout cannot invoke parent tools or answer supervisor questions.
- Pi model defaults are not passed to a CLI. Claude Code accepts explicit model/effort overrides, including `model:"sonnet:high"`, under the configured thinking ceiling. Codex/Cursor use their CLI's model configuration; unsupported Pi model/thinking overrides fail rather than being ignored.
- Agent frontmatter may choose an executable, but cannot widen an adapter's owned argv, tool set or permissions. Read-only selection names are reserved and cannot be shadowed by writer aliases.
- No automatic installation, login, workspace trust, permission bypass, wider writable roots or alternate runner fallback. Claude uses strict empty MCP configuration; native Tau Web and immediate-parent supervision are not injected into external CLIs.
- Adapter-specific environment allowlists exclude ambient child-extension bindings and Git routing overrides. Claude user settings/hooks and Cursor workspace state still require operator trust. CLI access flags and Git worktrees are **not an OS sandbox supplied by Tau**.

## Admission and process evidence

All local CLI launches, including nominally read-only adapters, enter the same FIFO writer scope as native writers. Preflight starts only after admission. Queue time, asynchronous bounded version/help/evidence probes and execution consume the original deadline; cancellation can stop a probe before model execution.

Each probe and execution has a distinct process identity and observed process-group closure. Malformed output, stop, timeout and log finalization do not bypass this barrier. The background runner's exit alone is insufficient. Unknown group/descendant inspection retains writer ownership and prevents worktree discard. No age/PID-based reclamation is added.

Preflight stdout/stderr is bounded to 256 KiB combined; each local probe is bounded to five seconds and the remaining launch deadline. Raw execution logs are bounded to 8 MiB per stream, display tails to 64 KiB per stream. Structured parser input/output has independent code-owned bounds and fails closed on malformed, oversized or missing terminal evidence. Cursor uses a private prompt file, removed after verified settlement and retained when settlement is unknown; task text is not placed in argv. Codex final output comes from its bounded final-message artifact.

Managed worktrees use the same native Git ownership, retention, patch and admission-scoped mutation contracts as native children. A successful CLI result does not authorize cleanup or prove acceptance. See [worktrees](worktrees.md).

Validation uses local protocol fixtures and the real Pi SDK on macOS, without vendor credentials or live-provider calls. Windows/Linux execution is not natively validated; unverified process settlement fails closed. POSIX group inspection cannot establish universal cessation of arbitrary daemonized processes or external services. Trusted hooks, escaped processes and shared resources remain operator responsibilities.
