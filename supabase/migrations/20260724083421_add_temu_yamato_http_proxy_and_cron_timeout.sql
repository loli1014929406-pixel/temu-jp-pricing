-- Yamato's legacy TLS endpoint rejects the Edge Runtime TLS handshake.
-- pgsql-http uses libcurl/OpenSSL and is exposed only through this fixed-host,
-- validated tracking-number function.
create extension if not exists http with schema extensions;

create or replace function public.fetch_temu_yamato_tracking_html(
  p_tracking_no text
)
returns text
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_tracking_no text := btrim(coalesce(p_tracking_no, ''));
  v_response extensions.http_response;
begin
  if v_tracking_no !~ '^[0-9]{10,14}$' then
    raise exception '无效的 Yamato 物流单号。'
      using errcode = '22023';
  end if;

  perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS', '5000');
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '10000');
  perform extensions.http_set_curlopt(
    'CURLOPT_USERAGENT',
    'TemuOrderTrackingMonitor/1.0'
  );

  select response
  into v_response
  from extensions.http_post(
    'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko',
    'number01=' || v_tracking_no || '&category=0',
    'application/x-www-form-urlencoded;charset=UTF-8'
  ) as response;

  if v_response.status < 200 or v_response.status >= 300 then
    raise exception 'Yamato 查询失败：HTTP %', v_response.status;
  end if;

  return coalesce(v_response.content, '');
end
$$;

revoke all on function public.fetch_temu_yamato_tracking_html(text) from public;
revoke all on function public.fetch_temu_yamato_tracking_html(text) from anon;
revoke all on function public.fetch_temu_yamato_tracking_html(text) from authenticated;
grant execute on function public.fetch_temu_yamato_tracking_html(text) to service_role;

-- A full cross-page refresh can legitimately exceed pg_net's 5 second default.
do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'refresh-temu-tracking-daily-18-jst'
  ) then
    perform cron.unschedule('refresh-temu-tracking-daily-18-jst');
  end if;

  perform cron.schedule(
    'refresh-temu-tracking-daily-18-jst',
    '0 9 * * *',
    $job$
      select net.http_post(
        url := 'https://phisdxcacvqzniyvywgi.supabase.co/functions/v1/refresh-temu-tracking',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'temu_tracking_cron_secret'
            limit 1
          )
        ),
        body := '{"source":"cron"}'::jsonb,
        timeout_milliseconds := 120000
      )
    $job$
  );
end
$$;
