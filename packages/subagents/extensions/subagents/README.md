# Tau Subagents

Native Pi delegation for Tau. Tool: `subagent`; manager: `/subagents`; live fleet: `/subagents-fleet`.

Background is the default; use `async:false` for native foreground. Seven native roles and custom Markdown profiles use explicit model/context/tool contracts. Six optional [CLI profiles](docs/external-runners.md) support background-only Claude Code, Codex and Cursor execution without implicit fallback. Writers queue FIFO per canonical directory/root session; readers may overlap without snapshot isolation. Research uses Tau Web only. Supervision and fleet inspection stay inside Pi; explicit [terminal inspector](docs/terminal-inspectors.md) actions can open separate Herdr/Ghostty viewers without moving or stopping the child.

See [agents](docs/agents.md), [workflows](docs/workflows.md), [controls](docs/tool-reference.md), [configuration](docs/configuration.md), and the owning [package README](../../README.md) for scope and validation limits. Features in later phases are not enabled by copied source files.
