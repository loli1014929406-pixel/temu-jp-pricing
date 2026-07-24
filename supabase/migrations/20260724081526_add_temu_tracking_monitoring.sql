-- Persist carrier checkpoints separately from the operational order stage.
-- One alert is shown per order_no even when the order has multiple SKU rows.
alter table public.temu_orders
  add column if not exists logistics_status_detail text not null default '',
  add column if not exists tracking_category text not null default 'pending',
  add column if not exists tracking_event_time timestamptz,
  add column if not exists tracking_last_checked_at timestamptz,
  add column if not exists tracking_last_query_error text not null default '',
  add column if not exists tracking_last_query_error_at timestamptz,
  add column if not exists tracking_is_exception boolean not null default false,
  add column if not exists tracking_exception_reason text not null default '',
  add column if not exists tracking_exception_fingerprint text not null default '',
  add column if not exists tracking_exception_handled_at timestamptz,
  add column if not exists tracking_exception_handled_by uuid references auth.users(id) on delete set null;

alter table public.temu_orders
  drop constraint if exists temu_orders_tracking_category_check;

alter table public.temu_orders
  add constraint temu_orders_tracking_category_check
  check (
    tracking_category in (
      'pending',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'available_for_pickup',
      'failed_attempt',
      'exception'
    )
  );

create index if not exists idx_temu_orders_tracking_exception_alerts
  on public.temu_orders (tracking_exception_handled_at, order_no)
  where tracking_is_exception = true;

create or replace function public.get_temu_tracking_alerts()
returns table (
  order_no text,
  stage text,
  logistics_tracking_no text,
  logistics_method text,
  logistics_status text,
  logistics_status_detail text,
  tracking_category text,
  tracking_exception_reason text,
  tracking_exception_fingerprint text,
  tracking_exception_handled_at timestamptz,
  tracking_last_checked_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct on (lower(btrim(orders.order_no)))
    orders.order_no,
    public.temu_order_stage(orders) as stage,
    orders.logistics_tracking_no,
    orders.logistics_method,
    orders.logistics_status,
    orders.logistics_status_detail,
    orders.tracking_category,
    orders.tracking_exception_reason,
    orders.tracking_exception_fingerprint,
    orders.tracking_exception_handled_at,
    orders.tracking_last_checked_at
  from public.temu_orders as orders
  where orders.tracking_is_exception = true
    and public.temu_order_stage(orders) in ('shipped', 'uploaded_temu')
  order by
    lower(btrim(orders.order_no)),
    orders.tracking_last_checked_at desc nulls last,
    orders.updated_at desc,
    orders.id
$$;

revoke all on function public.get_temu_tracking_alerts() from public;
grant execute on function public.get_temu_tracking_alerts() to authenticated;

create or replace function public.mark_temu_tracking_exception_handled(
  p_order_no text,
  p_fingerprint text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated_count integer := 0;
begin
  if not public.current_account_can_edit() then
    raise exception '当前账号没有编辑权限，不能处理物流异常。'
      using errcode = '42501';
  end if;

  if btrim(coalesce(p_order_no, '')) = ''
     or btrim(coalesce(p_fingerprint, '')) = '' then
    raise exception '订单号和异常指纹不能为空。'
      using errcode = '22023';
  end if;

  update public.temu_orders
  set
    tracking_exception_handled_at = now(),
    tracking_exception_handled_by = auth.uid()
  where lower(btrim(temu_orders.order_no)) = lower(btrim(p_order_no))
    and temu_orders.tracking_is_exception = true
    and temu_orders.tracking_exception_fingerprint = p_fingerprint;

  get diagnostics v_updated_count = row_count;
  return v_updated_count;
end
$$;

revoke all on function public.mark_temu_tracking_exception_handled(text, text) from public;
grant execute on function public.mark_temu_tracking_exception_handled(text, text) to authenticated;

-- pg_cron schedules are UTC. 09:00 UTC is 18:00 in Japan throughout the year.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (
    select 1
    from vault.secrets
    where name = 'temu_tracking_cron_secret'
  ) then
    perform vault.create_secret(
      gen_random_uuid()::text || gen_random_uuid()::text,
      'temu_tracking_cron_secret',
      'Authenticates the daily Temu tracking Edge Function request'
    );
  end if;
end
$$;

create or replace function public.get_temu_tracking_cron_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'temu_tracking_cron_secret'
  limit 1
$$;

revoke all on function public.get_temu_tracking_cron_secret() from public;
revoke all on function public.get_temu_tracking_cron_secret() from anon;
revoke all on function public.get_temu_tracking_cron_secret() from authenticated;
grant execute on function public.get_temu_tracking_cron_secret() to service_role;

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
        body := '{"source":"cron"}'::jsonb
      )
    $job$
  );
end
$$;
