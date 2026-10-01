# calm

Quiet transcript presentation for [Pi](https://pi.dev), with a Space Invaders-style pixel alien instead of “Working…”. Standalone: no Firstmate dependency or runtime dependencies. Requires Node.js 22.19+; verified against Pi 0.99.1.

## Install

```sh
pi install /path/to/tau/packages/calm
```

Replace `/path/to/tau` with your checkout's path. Restart Pi or run `/reload`. Local installs load this directory without copying it.

To try it for one session, from the repository root:

```sh
pi -e ./packages/calm
```

## Commands

| Command | Effect |
| --- | --- |
| `/calm` or `/calm toggle` | Toggle Calm |
| `/calm on` | Enable Calm |
| `/calm off` | Restore normal presentation |
| `/calm status` | Show the current preference |

Off by default in each new session. Changes are saved as `tau:calm` custom entries in the current session branch, just like codex-fast. Reload/resume and tree navigation restore the branch's last valid choice; a fresh session starts off. A failed save leaves the current choice unchanged.

The older global `calm.json` file is no longer read or written, and is left untouched. After upgrading, run `/calm on` once in each session where you want Calm.

Calm is terminal-only. In RPC, JSON, and print modes it does not change presentation or write session state.

## Presentation

While enabled:

- Collapsed thinking labels disappear; expanded reasoning stays visible.
- Routine collapsed rows for `bash`, `powershell`, `read`, `edit`, `write`, `grep`, `find`, and `ls` disappear. Failed calls show one summary line in the theme's `error` color (normally red), without the large tool panel: for example, `✗ bash — exited with code 1`. Shell failures prefer exit/timeout/abort status; other failures show the first nonempty error line. Long summaries are truncated to terminal width. Press `Ctrl+O` to reveal full error output. Image-bearing results, expanded tool rows, and other tools retain their normal rendering.
- Settled assistant working notes before tool calls disappear only when they are a single line shorter than 240 trimmed characters. Multiline or longer content, streaming text, final answers, truncation notices, and assistant errors remain visible.
- The stock working row is replaced by a five-row, fifteen-column pixel alien with antennae, square eyes, and separate hand/foot rows drawn with `▀`, `▄`, and `█`, like Pi's block-pixel logo. It walks one column every 480 ms across the full available width, turning at both edges, alternating its feet, and blinking briefly every 9.6 seconds. The body uses the active theme's `accent` color and the eyes use `text`. It switches to a six-column sprite in narrow terminals and a two-row, one-column sprite below six columns, never wrapping. It appears during a run. When Pi settles (including cancellation and failure), it freezes in place and fades through the theme's `muted` and `dim` colors over 480 ms before disappearing. A new run cancels the previous fade. Turning Calm off, changing sessions/branches, or reloading removes it immediately and cancels its timers.

```text
   ▀▄     ▄▀
  ▄█▀▀███▀▀█▄
▄▀███████████▀▄
▀ ▀▀█▀▀▀▀▀█▀▀ ▀
   ▄█     █▄
```

User messages are never filtered. `Ctrl+O` still reveals expanded tools; `Ctrl+T` toggles reasoning visibility. `/calm off` restores hidden working notes too. Nothing is removed from model context, session storage, or exports. No tool implementations, tool registrations, provider requests, or prompts are changed. A `calm` label appears in the extension status bar while enabled and disappears when disabled.

## Compatibility

Pi's public UI API supports the animation and hidden-thinking label. It has no global transcript filter, so `extensions/calm/presentation.ts` isolates small adapters on the exported assistant and tool component prototypes. They capability-check Pi's private layout fields and fail open with a warning if a required seam disappears. There is no numerical version refusal, but compatibility beyond Pi 0.99.1 is not verified.

Calm restores its adapters on shutdown/reload without overwriting adapters installed later by another extension. Other extensions that customize the same transcript components or working row may conflict. Toggling off restores Pi's default working row and thinking label, not another extension's custom settings.

The live transcript redraws; a terminal's existing scrollback may retain an earlier rendering. Built-in images, user-bash rows, status notices, and arbitrary custom-tool rows are not hidden.

## Develop

From the repository root:

```sh
npm run check --workspace calm
npm test --workspace calm
```

- `extensions/calm/index.ts` — command, branch-local session state, and animation/fade lifecycle.
- `extensions/calm/monster.ts` — pixel raster, two-color half-block rendering, and walk/blink frames.
- `extensions/calm/presentation.ts` — isolated, presentation-only compatibility adapters.
- `tests/` — command/lifecycle tests and real Pi component rendering tests.
