# Supabase database source of truth

Production database changes are defined by the ordered files in `migrations/`.
Use the Database migration release workflow to preview or apply them.

`schema.sql` is a legacy bootstrap snapshot. It is retained for local context and
must not be used to decide whether a recent migration has been deployed. New RPCs,
indexes, policies, and retention jobs belong in timestamped migrations.

Files under `manual/` are operator-run diagnostics or one-off maintenance scripts;
they are never part of the automatic migration chain.
