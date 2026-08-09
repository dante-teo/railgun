# Railgun Desktop

A prototype Electron application shell built with TypeScript, React, React Router, Tailwind CSS,
and shadcn/ui. It currently provides the static Tasks interface and local shell interactions; it
is not a supported release surface or connected domain client.

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

From the repository root, start the Electron shell with:

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
`file://` URL. `AppShellLayout` owns the window chrome and pane geometry; its semantic slots keep
the Page limited to composition. Real topbars use the global `window-drag-region` utility, while
interactive controls inside them use `window-no-drag` through their Component or Layout
implementation.

The renderer runs with context isolation and sandboxing enabled and without Node integration.
Keep privileged APIs behind the preload boundary rather than importing Node or Electron APIs into
renderer code.

## Application Shell Contract

The Tasks route composes one full-height shell:

```text
Sidebar | Content | optional Detail | Inspector
```

The shell renders exactly three 52px topbars. Sidebar and Inspector each own an integrated topbar;
Workspace owns one topbar shared by Content and Detail. The Workspace topbar therefore does not
repeat inside either body pane. The hidden macOS titlebar does not reserve an extra row, and the
native traffic lights are positioned within the Sidebar topbar. The BrowserWindow opens at
1440×900, enforces a 1280×720 minimum, and places the traffic lights at `(16, 18)`.

`AppShellLayout` exposes these semantic slots:

- `sidebar` and optional `sidebarTopBar`
- `content` and optional `detail`
- `workspaceTopBar`
- `inspector` and `inspectorTopBar`

Sidebar and Inspector toggles live in their respective topbars while expanded. When either pane
is collapsed, its toggle moves into the Workspace topbar. Collapsing Sidebar also enables the
native traffic-light clearance before the Sidebar toggle. Controls stay in normal flex flow; pane
geometry does not animate.

### Resizing and persistence

| Region    |  Default | Minimum |  Maximum |                               Collapse |
| --------- | -------: | ------: | -------: | -------------------------------------: |
| Sidebar   |    260px |   240px |    360px |                                    0px |
| Content   |    340px |   300px |    520px |                                     No |
| Detail    | Flexible |   420px | Flexible | Omitted with its separator when unused |
| Inspector |    320px |   280px |    440px |                                    0px |

Workspace has a 720px minimum when Detail is present. Without Detail, Content fills Workspace.
Separators are keyboard accessible. A Sidebar or Inspector collapse caused by a toggle, separator
drag, or keyboard action must update the shell visibility state and move the corresponding toggle;
reopening restores the last non-zero width.

Layout state is stored under `railgun.shell.layout.v1` with a schema version, Sidebar, Content, and
Inspector widths, and Sidebar/Inspector visibility. Reads validate the complete record, including
width constraints. Malformed, obsolete, or out-of-range records fall back to defaults.

### Visual foundations

The renderer uses the bundled Barlow variable font for interface text and Departure Mono Nerd Font
only for technical literals such as code, paths, identifiers, and commands. Theme values live as
semantic Tailwind tokens in `src/renderer/src/assets/main.css`. Topbar icon actions share the
`TopBarIconButton` contract so sizing, interaction states, drag behavior, and accessible labeling
remain consistent.

The current Tasks content is intentionally static. Resizing and Sidebar/Inspector collapse are the
only functional shell behaviors; navigation rows, task data, composer controls, inspector fields,
and Sidecar content are placeholders.

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
