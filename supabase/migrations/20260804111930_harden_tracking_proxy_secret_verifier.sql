-- Keep the Data API entrypoint invoker-safe. The privileged vault lookup lives
-- outside the exposed public schema, while the public wrapper only returns a
-- boolean equality result and never exposes the secret itself.

create or replace function private.verify_temu_tracking_proxy_secret(
  p_secret text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select coalesce(
    exists (
      select 1
      from vault.decrypted_secrets secret
      where secret.name = 'temu_tracking_cron_secret'
        and secret.decrypted_secret = coalesce(p_secret, '')
    ),
    false
  )
$function$;

revoke all on function private.verify_temu_tracking_proxy_secret(text)
  from public;
grant usage on schema private to anon, authenticated, service_role;
grant execute on function private.verify_temu_tracking_proxy_secret(text)
  to anon, authenticated, service_role;

create or replace function public.verify_temu_tracking_proxy_secret(
  p_secret text
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select private.verify_temu_tracking_proxy_secret(p_secret)
$function$;

revoke all on function public.verify_temu_tracking_proxy_secret(text)
  from public;
grant execute on function public.verify_temu_tracking_proxy_secret(text)
  to anon, authenticated, service_role;
