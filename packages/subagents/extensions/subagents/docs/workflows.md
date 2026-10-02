# Workflows and orchestration

The script engine uses a worker/VM and the common native launch pipeline. Use one top-level workflow and stable child keys.

```js workflow
const scan = await runs.run("scan", {agent:"scout", task:args.task});
const reviews = await runs.all([
  {key:"correctness", agent:"reviewer", task:scan.output},
  {key:"risks", agent:"reviewer", task:scan.output}
]);
return reviews.map(result => ({runId:result.runId, ok:result.ok, output:result.output}));
```

Call `subagent({workflow:true,args:{task:"Inspect the selected change"}})` in that same reply, or store the script and use `workflow:"./review.js"`. Validate first with `action:"validate"`.

## API inventory

| Baseline API | Phase 1 |
| --- | --- |
| `runs.run(key, params)` | Ported; ordinary calls await actual final child results |
| `runs.all(items)` | Ported; ordered result array, common admission and limits |
| `runs.status(keyOrRunId)` | Ported |
| `runs.steer(key,message,options)` | Ported; queued/delivered/missed/failed receipt, not compliance proof |
| `runs.ref(result)`, `runs.refs(results)` | Ported artifact references |
| `emit(value)`, bounded console, frozen `args` | Ported |
| Retained `resume` references | Ported; validated identity and contract, new run identity |
| `runs.lanes` | Deferred to phase 2; rejected |
| `runs.host` | Deferred to phase 6; rejected, including named resources |
| `state.get`, `state.set` | Mission state deferred to phase 6; rejected |
| Worktree/gate/mission launch options | Deferred and rejected |

Await promises before reading output. Explicit child `async:true` deliberately returns a running receipt with `ok:false`, not a completed result. The dispatcher may finish while that child continues; inspect the later child result. Ordinary omitted child async preserves dependency barriers even when execution uses a separate background runner.

Scripts have no filesystem, shell or arbitrary host-tool access. They are bounded orchestration, not an OS sandbox for children. Duplicate keys with incompatible parameters, non-JSON results, unobserved launch promises, invalid structured output and exceeded budgets fail with partial evidence retained. Nested async functions are rejected by the portability contract; use top-level await and plain Promise-returning helpers. Emit, console and return values share a budget of 512 items and 4 MiB of JSON, with a 1 MiB per-item maximum; exceeding it fails with prior evidence retained.

All children share native resolution, supervision and writer admission. Readers may overlap; writers on one canonical cwd/root session queue FIFO. A writer may not await a conflicting descendant writer. Default workflow concurrency is 20, per-run spawn cap 64, writer queue cap 64.

Reload does not automatically replay work. The runtime-replacement receipt machinery may reuse a successful or still-running background child only when the same script/args/key/parameters match during an explicit subsequent launch. It does not promise universal exactly-once execution. Inspect partial/uncertain runs before retrying.
