-- Centralized, sanitized application diagnostics.
-- Business payloads, credentials, request bodies, and URL query strings are not stored.

create table if not exists public.app_diagnostics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('error', 'slow-operation', 'navigation')),
  context text not null default '',
  message text not null default '',
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  path text not null default '',
  app_version text not null default '',
  created_at timestamptz not null default now()
);

grant select, insert, delete on table public.app_diagnostics to authenticated;

alter table public.app_diagnostics enable row level security;

drop policy if exists "app_diagnostics_insert_own" on public.app_diagnostics;
create policy "app_diagnostics_insert_own"
on public.app_diagnostics for insert to authenticated
with check (auth.uid() = user_id);

drop policy if exists "app_diagnostics_select_own_or_admin" on public.app_diagnostics;
create policy "app_diagnostics_select_own_or_admin"
on public.app_diagnostics for select to authenticated
using (auth.uid() = user_id or public.current_account_can_delete());

drop policy if exists "app_diagnostics_delete_admin" on public.app_diagnostics;
create policy "app_diagnostics_delete_admin"
on public.app_diagnostics for delete to authenticated
using (public.current_account_can_delete());

create index if not exists idx_app_diagnostics_created
on public.app_diagnostics(created_at desc);

create index if not exists idx_app_diagnostics_user_created
on public.app_diagnostics(user_id, created_at desc);
