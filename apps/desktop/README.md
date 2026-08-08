# Railgun Desktop

An empty Electron application shell built with TypeScript, React, React Router, Tailwind CSS,
and shadcn/ui.

## Requirements

- pnpm 11.20.0, as pinned by `packageManager`
- Node.js 20.19 or newer

pnpm uses the Node 24 runtime declared in `devEngines` for project scripts when its managed
runtime support is available.

## Setup

```sh
pnpm install
```

## Development

From the repository root, start the empty Electron shell with:

```sh
scripts/run.sh
```

Start it with the deterministic Rust mock backend using:

```sh
scripts/run-mock.sh
```

The mock launcher builds `railgun-mock-backend`, sets `RAILGUNX_BACKEND_MODE=mock`, and uses the
`ready-idle` scenario by default. Override the scenario for a run with, for example:

```sh
RAILGUNX_MOCK_SCENARIO=delayed-startup scripts/run-mock.sh
```

Both root launchers forward additional arguments to `pnpm dev`. To work directly in this
directory without a configured backend, run:

```sh
pnpm dev
```

These commands launch the GUI and should not be used as verification commands.

## Renderer Architecture

Renderer UI follows three layers: **Page**, **Layout**, and **Component**. Pages compose the app
without Tailwind classes; Layouts own spatial styling; Components own reusable visual styling and
variants. The complete rules are in [`AGENTS.md`](./AGENTS.md).

The renderer deliberately uses `HashRouter` because production pages are loaded from an Electron
`file://` URL. The hidden title bar is made movable by `WindowLayout` through the global
`window-drag-region` utility. Interactive controls placed inside a drag region must use the
`window-no-drag` utility through their Component or Layout implementation.

The renderer runs with context isolation and sandboxing enabled and without Node integration.
Keep privileged APIs behind the preload boundary rather than importing Node or Electron APIs into
renderer code.

## Electron Binary Repair

Electron's JavaScript package and downloaded application binary are installed separately. An
interrupted or script-disabled install can therefore leave the package linked while its executable
is missing; `electron-vite` reports this state as `Error: Electron uninstall`.

`predev`, `prestart`, and `postinstall` run the checked-in preflight automatically. To repair the
binary explicitly, run:

```sh
pnpm ensure:electron
```

The repair requires network access when the Electron archive is not already cached.

## Checks

The check suite does not launch the Electron window:

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm exec prettier --check .
pnpm build
```

## Packaging

Create an unpacked application for local inspection without using a signing identity:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm build:unpack
```

Build platform artifacts with:

```sh
pnpm build:mac
pnpm build:win
pnpm build:linux
```

Electron Builder may automatically use a matching macOS signing identity from the keychain;
timestamped signing also requires access to Apple's timestamp service. The current tagged GitHub
release workflow publishes only the native arm64 macOS application, not Electron artifacts.

App versions are kept aligned by the repository-level release command:

```sh
scripts/release-version.sh patch --dry-run
```

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
