# tau

An npm-workspaces monorepo for personal [Pi](https://pi.dev) packages. Each directory under `packages/` is an independently installable package with its own manifest, version, and resources. The repository root is tooling only, not a Pi package.

Requires Node.js 22.19+; developed against Pi 0.99.1. Packages are private by default to avoid accidental npm publication.

## Packages

| Package | Description |
| --- | --- |
| [codex-fast](packages/codex-fast/README.md) (`tau-codex-fast`) | Fast and ultrafast commands for supported OpenAI models |
| [calm](packages/calm/README.md) (`calm`) | Quiet transcript presentation with an animated pixel alien |
| [orange](packages/orange/README.md) (`tau-orange`) | Orange-accent dark theme and stock footer without estimated cost |

## Install a package

```sh
pi install /path/to/tau/packages/codex-fast
```

Replace `/path/to/tau` with your checkout's actual path.

Restart Pi or run `/reload`. Local packages are loaded from their directories without copying, so edits only need `/reload`.

To try it without changing Pi settings, from the repository root:

```sh
pi -e ./packages/codex-fast
```

Install each package you want separately. Installing the repository root does not install its workspace packages.

### Migrating an earlier root installation

If you previously installed the repository root, replace that registration:

```sh
pi remove /path/to/tau
pi install /path/to/tau/packages/codex-fast
```

These commands change personal Pi settings. The repository restructuring itself does not change your Pi settings.

## Develop

From the repository root:

```sh
npm install --ignore-scripts
npm run check
npm test
```

The root commands run the available check/test scripts across all workspace packages. To work on only one package:

```sh
npm run check --workspace tau-codex-fast
npm test --workspace tau-codex-fast
```

## Add a package

Create `packages/<name>/package.json` with a unique npm package name, its own version, `"type": "module"`, and a `pi` manifest declaring its resources. Packages can contain extensions, skills, prompts, themes, or a combination.

Keep runtime dependencies in the owning package. Host-provided Pi packages belong in its `peerDependencies` with a `"*"` range. Shared development tooling lives at the root; TypeScript packages can extend `tsconfig.base.json`.

Run `npm install --ignore-scripts` at the root after adding a workspace or changing dependencies. Add package-local check/test scripts when applicable, and keep tests outside extension discovery paths.

## Layout

```text
tau/
├── package.json              # workspace configuration and shared tooling
├── package-lock.json         # shared dependency lockfile
├── tsconfig.base.json        # shared TypeScript options
├── AGENTS.md
└── packages/
    ├── calm/                 # quiet transcript extension and tests
    ├── orange/               # orange theme and cost-free footer
    └── codex-fast/
        ├── package.json      # independently installable Pi package
        ├── README.md
        ├── tsconfig.json
        ├── extensions/
        │   └── codex-fast.ts
        └── tests/
            └── codex-fast.test.mjs
```
