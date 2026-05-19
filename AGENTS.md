# Codex Project Rules

## Data Lookup Rule

When answering questions about product information, purchase records, inventory, pricing, or profit data for this project:

- Prefer the local Supabase snapshot at `local-data/codex-supabase-data.json`.
- The snapshot stores rows under the top-level `tables` object.
- If the user asks for the latest data, or if the snapshot is missing or clearly stale for the question, run `npm run sync:data` first, then read the refreshed snapshot.
- Do not query Supabase directly unless the local snapshot is unavailable, sync fails, or the user explicitly asks for a live database check.
- `local-data/` is local-only project data and should remain ignored by git.
