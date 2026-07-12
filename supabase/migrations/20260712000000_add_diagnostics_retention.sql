-- Keep centralized diagnostics for 90 days. Supabase Cron runs inside the database.
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-app-diagnostics-90-days') then
    perform cron.unschedule('purge-app-diagnostics-90-days');
  end if;
  perform cron.schedule(
    'purge-app-diagnostics-90-days',
    '17 3 * * *',
    $job$delete from public.app_diagnostics where created_at < now() - interval '90 days'$job$
  );
end $$;
