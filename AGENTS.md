# Repository instructions

- Keep this file focused on instructions for maintaining this repository; exclude personal details.
- Keep the npm-workspaces root installable as the full Pi bundle, with an explicit `pi` manifest listing package entry points and themes. Update that manifest when adding or removing bundled resources; keep individual packages independently installable.
- Keep each independently installable package in `packages/<name>/`, with its own `package.json`, version, Pi resource manifest, and README.
- Keep extension entry points in the owning package's `extensions/`: one `.ts` file for a small extension, or a directory with `index.ts` for a multi-file extension.
- When implementing Pi extensions, verify APIs against the installed Pi documentation and examples. Target Pi 0.99.1 and import from `@earendil-works/pi-coding-agent`.
- Pi loads TypeScript directly; do not introduce a build step solely to load extensions.
- Declare host-provided Pi packages as peer dependencies in each consuming package, not runtime dependencies. Shared root development dependencies may pin them for type checking.
- Keep runtime dependencies in the package that imports them. Use the shared root lockfile and `tsconfig.base.json` for development tooling.
- For provider-specific behavior, guard the provider/API and leave unrelated requests unchanged.
- After code changes, run `npm run check` and `npm test` from the repository root; these run available workspace scripts. Tests live in the owning package's `tests/` so Pi does not discover them as extensions.
- Consult `README.md` when loading packages or using extension commands.
