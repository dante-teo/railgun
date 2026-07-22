# Xcode project generation

- Never manually create, edit, repair, or rely on `apps/macos/RailgunX.xcodeproj` or any other generated `.xcodeproj` directory.
- Treat `apps/macos/project.yml` as the only source of truth for the RailgunX Xcode project. Make project, target, build-setting, package, scheme, and source-inclusion changes there.
- Generate disposable Xcode projects with `apps/macos/scripts/generate-project.sh` before invoking Xcode directly. Use `scripts/run.sh`, `scripts/run-source.sh`, or `scripts/run-mock.sh` for native launches.
- Do not repair generated project files. Regenerate them from `project.yml` instead.
