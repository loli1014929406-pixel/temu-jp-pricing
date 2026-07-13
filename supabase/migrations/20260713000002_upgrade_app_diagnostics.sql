-- Add request and cache dimensions required for actionable performance analysis.

alter table public.app_diagnostics
  add column if not exists request_kind text not null default '',
  add column if not exists cache_status text not null default '',
  add column if not exists row_count integer,
  add column if not exists retry_count integer not null default 0,
  add column if not exists trace_id text not null default '';

alter table public.app_diagnostics
  drop constraint if exists app_diagnostics_row_count_check,
  add constraint app_diagnostics_row_count_check
    check (row_count is null or row_count >= 0),
  drop constraint if exists app_diagnostics_retry_count_check,
  add constraint app_diagnostics_retry_count_check
    check (retry_count >= 0);

create index if not exists idx_app_diagnostics_context_created
on public.app_diagnostics(context, created_at desc);

create index if not exists idx_app_diagnostics_trace
on public.app_diagnostics(trace_id)
where trace_id <> '';
