# 0031. Electrobun replaces Electron as the desktop runtime

Date: 2026-07-13

## Status

Accepted

## Context

T9 was planned to add Electron build infrastructure (`electron`, `vite-plugin-electron`,
`electron-builder`) to `apps/desktop/`. During implementation, `electron-builder`'s
transitive dependency tree (~400 packages) failed to resolve via pnpm in the
development environment — its resolution stalled indefinitely regardless of
timeout, `--ignore-scripts`, or `--no-frozen-lockfile` flags. This was a
packaging/tooling problem, not a correctness problem, but it revealed a broader
concern: Electron's dependency surface is large and its postinstall downloads a
~130 MB platform binary that must be re-downloaded per environment.

Electrobun (v1.18.1) was evaluated as an alternative. It ships everything needed
in a single npm package that resolves in ~4 seconds, has no postinstall binary
download (the CLI lazily downloads its platform binary on first invocation), and
its architecture is a better fit for the existing codebase:

- Bun is already installed on the development machine and used in parts of the
  toolchain.
- The renderer (`apps/desktop/renderer/`) uses no Electron APIs — it is plain
  React DOM and would have required zero changes to work under Electrobun's
  system webview.
- The gateway (`apps/desktop/gateway/`) is plain Node.js/TypeScript with a `ws`
  dependency; `ws` is Bun-compatible without changes.
- Electrobun's main process runs under Bun (not Node), which is a stricter
  departure but acceptable since the main process code (T10) had not been
  written yet.

## Decision

Replace the Electron build stack with Electrobun for `apps/desktop/`.

### Package changes

`electron`, `vite-plugin-electron`, and `electron-builder` are removed.
`electrobun@^1.18.1` is added as a **production dependency** (Electrobun bundles
its own runtime into the app; it is required at build time and at runtime, so
`dependencies` is correct). `@types/bun@^1.3.14` is added as a devDependency
to provide type definitions for the Bun main process code that T10 will write.
`"type": "module"` is removed from `package.json` — Electrobun's CLI manages
module format internally and does not require the package-level ESM flag.

### Scripts

| Script | Command |
|---|---|
| `dev` | `electrobun dev --watch` |
| `build` | `electrobun build` |
| `build:canary` | `electrobun build --env=canary` |
| `build:stable` | `electrobun build --env=stable` |
| `preview` | `vite preview` (Vite renderer dev only) |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |

`preview` stays because Vite remains for renderer development and vitest.
`test` is added as a convenience alias for `vitest run` (was previously only
runnable via root `pnpm vitest run --project @railgun/desktop`).

### Build config

`electron-builder.config.ts` is replaced by `electrobun.config.ts`:

```ts
export default {
  app: { name: "Railgun", identifier: "com.railgun.desktop", version: "0.1.0" },
  runtime: { exitOnLastWindowClosed: true },
  build: {
    bun: { entrypoint: "src/bun/index.ts" },
    views: {
      renderer: {
        entrypoint: "renderer/main.tsx",
        jsx: { runtime: "automatic", importSource: "react" },
      },
    },
    copy: { "index.html": "views/renderer/index.html" },
    mac: { codesign: false, notarize: false },
  },
} satisfies ElectrobunConfig;
```

Electrobun bundles the Bun main process (`src/bun/`) and each named view
(`renderer/`) independently using `bun build`. Views target `"browser"`;
the Bun process targets `"bun"`. The renderer's `index.html` is copied
into the build output via `build.copy`.

### TypeScript

`tsconfig.json` gains `"src/bun/**/*"` in `include` (T10's main process source)
and replaces `"electron"` in `types` with `"bun"` (resolves `@types/bun`).

`pnpm-workspace.yaml`'s `allowBuilds` entry for `electron` is removed.

### Build output

Electrobun writes dev builds to `build/` (was `dist-electron/` + `release/`).
`.gitignore` is updated accordingly.

### Vite and Vitest

Vite stays as the dev server for standalone renderer development and as the
Vitest runner for all tests. The `electron()` plugin is removed; the `react()`
plugin and `test` config are unchanged. All 141 tests continue to pass.

### Architecture boundary

Electrobun uses Bun (not Node.js) for the main process. The renderer still runs
in a system webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on
Linux). IPC between the Bun main process and the renderer uses Electrobun's
typed RPC mechanism (replacing Electron's `contextBridge`/`ipcMain` pattern that
T10 would have implemented).

One forward compatibility note: `renderer/main.tsx` uses `import.meta.env.DEV`
(a Vite-ism) for dev/prod branching. Under Electrobun, `bun build` targets
`"browser"` but does not inject `import.meta.env`. T10 must replace this with a
value passed from the main process via Electrobun RPC, or use `process.env.NODE_ENV`
if Electrobun's bundler injects it (verify at T10 time).

## Alternatives considered

**Keep Electron, fix the pnpm resolution.** The resolution hang was environmental
(slow/blocked npm registry for the `electron-builder` dep tree) rather than
fundamentally broken. The user resolved it manually out-of-band. This would have
worked but leaves the large dependency surface intact for future maintainers.

**Keep Electron, remove electron-builder.** Use only `electron` +
`vite-plugin-electron` and hand-roll packaging. Reduces the dep surface but
loses cross-platform packaging for T11+.

**Tauri.** Requires Rust toolchain; adds build complexity beyond the scope of
these tasks.

## Consequences

- `pnpm install` completes in ~4s for the desktop package (was
  indefinitely stalled due to `electron-builder`).
- Main process code (T10) must target the Bun runtime API, not Node.js.
  `ws` and other dependencies are Bun-compatible; the gateway code in
  `apps/desktop/gateway/` is unaffected.
- Electron's preload/contextBridge IPC pattern is replaced by Electrobun's
  typed RPC. T10 implements this instead.
- App bundle sizes will be smaller (~14 MB system webview vs ~150 MB Chromium).
- `renderer/main.tsx`'s `import.meta.env.DEV` guard must be updated in T10.
- Code signing and notarization are disabled for now (`codesign: false`,
  `notarize: false`); T11 enables them.
