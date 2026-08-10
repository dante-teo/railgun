# Database migrations

Railgun embeds up-only SQLx migrations from
`crates/railgun-backend/migrations` in the production executable. Pending
migrations run transactionally and are tracked by `_sqlx_migrations`.

Create and validate migrations with the repository task binary:

```sh
cargo xtask migration new describe_the_schema_change
cargo xtask migration check
cargo test --workspace --locked
```

Migration files use `<timestamp>_<description>.sql` names. `build.rs` tracks the
directory so changing or adding a migration always rebuilds the embedded
payload. `cargo xtask migration check` sorts filenames lexically before
validating their strictly increasing order, so validation does not depend on
filesystem enumeration order.

Older databases retain their historical `PRAGMA user_version`. Before SQLx
runs, the compatibility importer upgrades versions 0 through 7, reconstructs
message parent chains, preserves retired Notes tables, and leaves the former
`schema_migrations` ledger untouched. The idempotent SQLx baseline then
validates required tables, columns, indexes, checks, and foreign keys.

Message persistence distinguishes two timestamps:

- `messages.created_at` is the storage timestamp used by active-leaf ordering and session-summary
  activity dates.
- Nullable `messages.event_at` is the semantic message time used for transcript turn boundaries and
  duration labels.

The `event_at` migration deliberately leaves existing rows `NULL`. Historical `created_at` values
were recorded while checkpointing a completed turn and therefore cannot be reconstructed into
accurate user-start or assistant-completion boundaries. Never backfill `event_at` from `created_at`;
legacy transcripts must remain untimed and render the **Worked** fallback.

Never seed `_sqlx_migrations` manually, delete unknown tables, or add a down
migration. Test fresh, legacy, current, malformed, and rollback cases before
shipping a schema change.
