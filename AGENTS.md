# Xcode project generation

- Never manually create, edit, repair, or rely on `apps/macos/RailgunX.xcodeproj` or any other generated `.xcodeproj` directory.
- Treat `apps/macos/project.yml` as the only source of truth for the RailgunX Xcode project. Make project, target, build-setting, package, scheme, and source-inclusion changes there.
- Generate disposable Xcode projects with `apps/macos/scripts/generate-project.sh` before invoking Xcode directly. Use `scripts/run.sh`, `scripts/run-source.sh`, or `scripts/run-mock.sh` for native launches.
- Do not repair generated project files. Regenerate them from `project.yml` instead.

# Native verification

- After changing Swift data-model APIs, initializers, target source inclusion, or cross-file native interfaces, generate the disposable project and run an app-target `xcodebuild build` before declaring completion. Unit tests or package-only builds do not replace this check.
- Do not run `scripts/run.sh`, `scripts/run-source.sh`, or `scripts/run-mock.sh` merely to verify a change: they launch the GUI app on the user's machine. Run them only when the user explicitly asks to launch the app.
