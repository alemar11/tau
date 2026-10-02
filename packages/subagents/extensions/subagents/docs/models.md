# Native model selection

Model precedence is explicit call override → selected profile override → the coordinator's resolved model snapshot at launch. The child does not follow later coordinator model changes and does not silently change model/provider/runner after a failure.

Use a registered `provider/model` identity, optionally with a supported thinking suffix. Per-profile `model`, `thinking`, provider overrides and `maxThinking` retain their native resolution/ceiling contracts. Project `tauSubagents` settings take precedence over user settings where applicable; model-scope enforcement rejects disallowed choices before prompting. A request above a thinking ceiling is an error, not a hidden downgrade.

```js
subagent({action:"models"});
subagent({agent:"reviewer", task:"Review the supplied change", model:"provider/model:high", async:false});
```

The model registry must actually expose the requested identity and authentication. Explicitly selected provider extensions must load successfully. Foreground can inherit a supported in-process parent provider registration; a separate background runner cannot serialize arbitrary closures and requires a resolvable provider source. Missing sources or unavailable models fail clearly.

The real host Pi SDK performs model resolution. Registry normalization is not permission to retry on another model. A narrowly validated retained-session compaction recovery may continue once on the same model; ordinary provider failures do not trigger a fallback chain.

The seven bundled profiles do not hard-code external commercial model IDs. Configure your own choices rather than copying example IDs as a fallback policy. `fast:true` remains guarded to native OpenAI-Codex models; unrelated providers are not modified.

External Claude Code/Codex/Cursor CLI model handling is deferred to phase 3. No such runner is selected because a native model could not be resolved.
