# tau

An npm-workspaces monorepo for personal [Pi](https://pi.dev) packages. Each directory under `packages/` is an independently installable package with its own manifest, version, and resources. The repository root is also an installable bundle containing all packages, alongside shared development tooling.

Requires Node.js 22.19+; developed against Pi 0.99.1. Packages are private by default to avoid accidental npm publication.

## Packages

| Package | Description |
| --- | --- |
| [codex-fast](packages/codex-fast/README.md) (`tau-codex-fast`) | Fast and ultrafast commands for supported OpenAI models |
| [calm](packages/calm/README.md) (`calm`) | Quiet transcript presentation with a random animated pixel alien |
| [orange](packages/orange/README.md) (`tau-orange`) | Orange-accent dark theme and stock footer without estimated cost |
| [openspace](packages/openspace/README.md) (`openspace`) | Local broker, registry and message transport; Pi adapter pending, not yet bundled |
| [web](packages/web/README.md) (`web`) | Web search, page/PDF reading, and branch-scoped cache |
| [subagents](packages/subagents/README.md) (`subagents`) | Native Pi delegation, workflows, supervision and FIFO writer admission |

## Install the whole bundle

Once these changes are on GitHub:

```sh
pi install git:github.com/alemar11/tau
```

Or install from a local checkout:

```sh
pi install /path/to/tau
```

Restart Pi or run `/reload`. This loads codex-fast, Calm, Web, Subagents, and Orange's footer extension, and makes the **tau-orange** theme available under `/settings` → Theme. Calm and Codex speed modes remain off until enabled with their commands. Web's three tools are available by default; see its README for authentication, explicit API billing modes, and cache limits. Subagents exposes `subagent` and `/subagents`; delegation still requires operator authorization. Its phase-one scope and recovery limits are documented in its README.

To try the bundle for one session from the repository root:

```sh
pi -e .
```

Use `pi config` to disable individual bundled resources. Update the GitHub installation with `pi update git:github.com/alemar11/tau`.

Install either the bundle or individual packages, not both: overlapping installations can load the same extensions and theme twice. If switching from individual packages, remove their registrations with `pi remove <source>` before installing the bundle.

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

Install individual packages when you do not want the full bundle. To switch from the bundle to individual packages, remove the bundle registration with `pi remove <source>`, then install the package directories you want.

## Develop

The project-level `mise.toml` pins Node.js 22.19.0 to check the minimum supported runtime without changing the global Node version. From the repository root:

```sh
mise install
mise exec -- npm install --ignore-scripts
mise exec -- npm run check
mise exec -- npm test
```

With mise shell activation, the ordinary `npm` commands use the project version automatically.

The root commands run the available check/test scripts across all workspace packages. To work on only one package:

```sh
npm run check --workspace tau-codex-fast
npm test --workspace tau-codex-fast
```

## Add a package

Create `packages/<name>/package.json` with a unique npm package name, its own version, `"type": "module"`, and a `pi` manifest declaring its resources. Packages can contain extensions, skills, prompts, themes, or a combination.

Keep runtime dependencies in the owning package. Host-provided Pi packages belong in its `peerDependencies` with a `"*"` range. Shared development tooling lives at the root; TypeScript packages can extend `tsconfig.base.json`.

Add the package's extension entry points and any themes, skills, or prompts to the root `pi` manifest so the bundle includes them. List entry points explicitly, not helper modules or tests.

Run `npm install --ignore-scripts` at the root after adding a workspace or changing dependencies. Add package-local check/test scripts when applicable, and keep tests outside extension discovery paths.

## Layout

```text
tau/
├── package.json              # bundle manifest, workspaces, and shared tooling
├── package-lock.json         # shared dependency lockfile
├── tsconfig.base.json        # shared TypeScript options
├── AGENTS.md
└── packages/
    ├── calm/                 # quiet transcript extension and tests
    ├── orange/               # orange theme and cost-free footer
    ├── openspace/            # broker and session registry; messaging pending
    ├── web/                  # search, document extraction, and cache
    ├── subagents/            # native delegation, workflows, supervision, and tests
    └── codex-fast/
        ├── package.json      # independently installable Pi package
        ├── README.md
        ├── tsconfig.json
        ├── extensions/
        │   └── codex-fast.ts
        └── tests/
            └── codex-fast.test.mjs
```
