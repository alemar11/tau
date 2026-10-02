# Tau Subagents

Native Pi delegation for Tau. Tool: `subagent`; manager: `/subagents`; live fleet: `/subagents-fleet`.

Background is the default; use `async:false` for foreground. Seven bundled profiles and custom Markdown profiles use explicit model/context/tool contracts. Writers queue FIFO per canonical directory/root session; readers may overlap without snapshot isolation. Research uses Tau Web only. Supervision and inspection stay inside Pi.

See [agents](docs/agents.md), [workflows](docs/workflows.md), [controls](docs/tool-reference.md), [configuration](docs/configuration.md), and the owning [package README](../../README.md) for scope and validation limits. Features in later phases are not enabled by copied source files.
