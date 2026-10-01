# tau-orange

Pi's dark palette with orange accents, plus the stock footer without its estimated cost or `(openai-codex)` provider label. Requires Node.js 22.19+; verified against Pi 0.99.1.

## Install

```sh
pi install /path/to/tau/packages/orange
```

Restart Pi or run `/reload`, then select **tau-orange** under `/settings` → Theme. For a one-session preview from the repository root:

```sh
pi -e ./packages/orange --use-theme tau-orange
```

Orange replaces the primary violet accents and colors the borders. Thinking Off uses the main orange accent; enabled levels progress from pale peach (minimal) through light orange (low), orange (medium), deep orange (high), red-orange (xhigh), and bright red (max). Off and medium intentionally share the main accent. Success, error, warning, and other syntax colors retain their distinct meanings.

The extension hides the stock footer's dollar amount, `(sub)` label, and `(openai-codex)` provider label. Other provider labels, token counts, cache statistics, context usage, model, thinking level, directory, branch, session name, and extension statuses stay unchanged. Hidden columns become blank to preserve the existing layout and right alignment. Usage accounting and stored cost data are untouched.

Pi has no public hide-cost setting, so this small presentation adapter wraps the exported `FooterComponent.render()` method. It does not change installed Pi files, register a replacement footer, or affect custom footers. Beyond Pi 0.99.1, the stock stats-line format is not verified. Shutdown/reload restores the renderer without overwriting a later extension's adapter. RPC, JSON, and print modes are unchanged.

To undo: choose **dark** in `/settings`, remove this package with `pi remove /path/to/tau/packages/orange`, and run `/reload`.

## Develop

From the repository root:

```sh
npm run check
npm test
```
