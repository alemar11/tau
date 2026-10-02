# Tool reference

## Execution

```js
subagent({agent:"scout", task:"Map the relevant source"});
subagent({agent:"reviewer", task:"Review the supplied diff", async:false});
subagent({agent:"oracle", task:"Challenge the chosen design", context:"fork"});
```

Background dispatch returns run identity/artifact locations, not task success. Foreground returns the completed result. Model selection is explicit call → profile → coordinator at launch, with no hidden provider/model/runner fallback. Missing tools and failed required extensions are errors.

## Retained children

Use `action:"status"` with `id`, optionally `view:"transcript"` and bounded `lines`. `view:"fleet"` gives the fleet snapshot. `debug.run` exposes diagnostic references. `children.list` is the workflow child inventory, not a universal list of direct children.

`steer` queues guidance; receipt, delivery and completion are different. `interrupt` requests a resumable pause. `stop` is terminal. `resume` with `id` and `message` validates retained ownership/session/contract and creates a new run identity. It never silently launches fresh. Foreign sessions cannot assume ownership.

`contact_supervisor` is child-to-immediate-parent communication. The parent uses `subagent_supervisor` with `action:"pending"` or `action:"reply",replyTo,message`. Wrong-owner, duplicate and stale replies cannot answer another question.

## Workflows

`workflow:true` selects the single fenced `js workflow` block in the same assistant reply. A workflow string containing `/` is a file path; other strings name workflow resources. `action:"validate"` validates without launching children. See [workflows](workflows.md).

## Output mode details

Use `output` to bind a report; `outputMode:"file-only"` requires a path. `outputSchema` requests validated structured output. Results include output/artifact references and explicit truncation where needed. Never infer successful completion from the presence of an artifact alone.

## Discovery and management

`list`, `get`, `models`, `guide`, `create`, `update`, `delete`, `eject`, `disable`, `enable`, `reset` and profile refinement provide native agent management. Custom profiles still pass phase-one admission and capability checks. Deferred options/actions fail explicitly rather than being silently ignored.

## Pi UI

`/subagents` opens the manager; `/subagents-fleet` shows live children. `/subagents-stop`, `/subagents-steer`, `/subagents-detach`, `/subagent-cost`, `/subagents-guide` and `/run` use the same runtime. Inspection stays in Pi; headless status/control do not require TUI. No external terminal is opened.
