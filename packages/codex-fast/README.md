# tau-codex-fast

Fast and ultrafast commands for [Pi](https://pi.dev). Requires Node.js 22.19+; developed against Pi 0.99.1.

## Install

```sh
pi install /path/to/tau/packages/codex-fast
```

Replace `/path/to/tau` with your checkout's actual path.

Restart Pi or run `/reload`. This registers only this package in your personal Pi settings, not other packages in the monorepo.

To try it for one session, from the repository root:

```sh
pi -e ./packages/codex-fast
```

Run `/reload` after editing an extension.

## Develop

From the repository root:

```sh
npm install --ignore-scripts
npm run check --workspace tau-codex-fast
npm test --workspace tau-codex-fast
```

See the [monorepo README](../../README.md) for shared tooling and adding packages.

## Codex speed modes

Select a supported `openai` or legacy `openai-codex` model, then run:

| Command | Effect |
| --- | --- |
| `/codex-fast` | Toggle fast mode (`service_tier: "priority"`) |
| `/codex-ultrafast` | Toggle ultrafast mode (`service_tier: "ultrafast"`) |
| Either command with `on` | Enable that mode explicitly (idempotent) |
| Either command with `off` | Disable all speed modes |
| Either command with `status` | Show the selected mode and whether it is active |
| Either command with `toggle` | Explicitly toggle that mode |

Only one mode can be selected at a time. Switching commands selects the other mode; repeating the selected mode's command turns it off. Unsupported models cannot enable a mode, but you can always turn a selected mode off.

The footer shows only `fast` or `ultrafast` when the selected mode is eligible for the current model. The indicator is hidden when off or inactive. This indicates request eligibility, not confirmation that the server granted the tier. Switching to an unsupported model suspends the effect without clearing your selection; switching back restores it. Use either command with `status` for details.

### Supported models

Fast mode supports these model IDs under both `openai/` and `openai-codex/`:

- `gpt-5.4`, `gpt-5.5`
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
- `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`

Ultrafast supports only:

- `openai/gpt-5.6-sol`
- `openai/gpt-6-astra`
- `openai-codex/gpt-6-astra`

These conservative allowlists follow the [reference implementation](https://github.com/calesennett/pi-codex-fast/blob/329472633597840f78be5574be5356bb5bfe9bd7/extensions/codex-fast.ts). The extension also checks the provider's Responses API; other providers/APIs and unlisted models are never modified.

Neither mode changes your model or reasoning effort. Tier availability depends on your account and model, and may consume usage faster. For ultrafast, check the [Codex access requirements](https://learn.chatgpt.com/docs/agent-configuration/speed) or [API access requirements](https://developers.openai.com/api/docs/guides/ultrafast-mode). Live account eligibility is not verified by the extension.

Disabled by default. The selected mode is saved in the current session branch and restored after reload/resume or tree navigation, including migration of older boolean fast-mode entries. No global or project settings are rewritten. Turning it off does not override service tiers set elsewhere.

## Layout

- `extensions/` — TypeScript extension entry points, discovered through `package.json`.
- `tests/` — offline behavior tests using Node's built-in test runner.
- `tsconfig.json` — package-local type checking, extending shared repository options.
