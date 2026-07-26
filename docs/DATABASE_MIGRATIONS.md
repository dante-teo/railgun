# Database migrations

Railgun manages its SQLite session schema with checked-in
[dbmate](https://github.com/amacneil/dbmate)-format SQL files in
`db/migrations`. The bundled backend copies these files into `dist/migrations`
and applies pending migrations transactionally, recording them in SQLite's
`schema_migrations` table.

## Adding a migration

Do not install dbmate globally. Generate a migration with the ephemeral CLI:

```sh
pnpm dlx dbmate new describe_the_schema_change
```

Write both `-- migrate:up` and `-- migrate:down` sections. Validate it against
a disposable database before committing:

```sh
pnpm dlx dbmate --url "sqlite:/private/tmp/railgun-migration-check.db" \
  --migrations-dir db/migrations --no-dump-schema up
pnpm dlx dbmate --url "sqlite:/private/tmp/railgun-migration-check.db" \
  --migrations-dir db/migrations status
```

Only regular files named `<timestamp>_<description>.sql` are executable
migrations. Documentation, Finder metadata such as `.DS_Store`, and
subdirectories are ignored, so incidental files cannot block backend startup.

Run the persistence tests and `pnpm run build`; the build must leave every
migration in `dist/migrations` so the packaged backend can apply it.

## Existing user data

Older Railgun releases tracked schema state with SQLite `PRAGMA user_version`.
On first launch after this change, the backend upgrades that legacy schema with
the existing compatibility bridge, then records the dbmate baseline as applied.
No user tables or rows are deleted during this import. In particular, retired
Notes tables and their contents remain untouched, though Railgun no longer
exposes Notes functionality.

After the one-time import, the backend applies any migrations created after the
baseline in that same launch. All subsequent changes use dbmate migrations
only.
