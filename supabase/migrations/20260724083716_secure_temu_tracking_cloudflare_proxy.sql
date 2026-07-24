-- Remove the failed pgsql-http fallback. Yamato requires a legacy TLS cipher
-- that the managed database client does not expose.
drop function if exists public.fetch_temu_yamato_tracking_html(text);
drop extension if exists http;

-- Cloudflare already proxies carrier traffic for the app and can negotiate
-- Yamato's legacy TLS endpoint. It validates this scoped secret through
-- Supabase without storing the secret itself.
create or replace function public.verify_temu_tracking_proxy_secret(
  p_secret text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    length(p_secret) >= 64
      and p_secret = (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'temu_tracking_cron_secret'
        limit 1
      ),
    false
  )
$$;

revoke all on function public.verify_temu_tracking_proxy_secret(text) from public;
grant execute on function public.verify_temu_tracking_proxy_secret(text) to anon;
grant execute on function public.verify_temu_tracking_proxy_secret(text) to authenticated;
grant execute on function public.verify_temu_tracking_proxy_secret(text) to service_role;
