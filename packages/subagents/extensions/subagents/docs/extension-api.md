# Native extension APIs

Phase 1 exposes the `subagent`, `subagent_supervisor` and `bg_wait` tools and the inherited native RPC/event bridges. Tool calls and native workflow children share validation, session ownership, depth/spawn limits, model selection and writer admission. Deferred actions cannot be enabled through RPC.

The `src/api/` modules include code for later increments. Package subpath exports for extension integrations are not yet a stable public Tau contract. Do not treat source presence as registration. Runtime-agent, capability-ceiling, required-extension and workflow-resource contracts remain in the roadmap; optional provider and terminal plugin registrations are deferred.

Native supervision routes a child's correlated request to its immediate parent. A root session does not gain another parent's reply authority by knowing a request ID. Replies use `subagent_supervisor`; steering is separate. No external message transport is required.

`runs.host`, mission state, external jobs, terminal inspectors and permission/MCP bridges are not exposed in phase 1. Custom Pi extensions are explicitly selected child resources, not ambient fallbacks. Unknown tool or extension capabilities conservatively require writer admission.
