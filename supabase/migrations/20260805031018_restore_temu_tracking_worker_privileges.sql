-- Tracking refresh runs in an Edge Function after either user permission checks
-- or cron-secret verification. The tenant cutover changed these worker-only RPCs
-- to SECURITY INVOKER while service_role intentionally has no direct order-table
-- grants, so every carrier result failed when it tried to persist.
--
-- Restore the narrow worker boundary: only service_role may execute the two
-- functions, and both functions keep their existing shop/order/tracking filters.

alter function public.get_temu_tracking_candidates(uuid[])
  security definer;
alter function public.save_temu_tracking_result(
  uuid, text, text, timestamptz, text, text, text, text, timestamptz,
  boolean, text, text, boolean, boolean, text
) security definer;

revoke all on function public.get_temu_tracking_candidates(uuid[])
  from public, anon, authenticated;
revoke all on function public.save_temu_tracking_result(
  uuid, text, text, timestamptz, text, text, text, text, timestamptz,
  boolean, text, text, boolean, boolean, text
) from public, anon, authenticated;

grant execute on function public.get_temu_tracking_candidates(uuid[])
  to service_role;
grant execute on function public.save_temu_tracking_result(
  uuid, text, text, timestamptz, text, text, text, text, timestamptz,
  boolean, text, text, boolean, boolean, text
) to service_role;

comment on function public.get_temu_tracking_candidates(uuid[]) is
  'Worker-only tracking candidate lookup after caller authorization in refresh-temu-tracking.';
comment on function public.save_temu_tracking_result(
  uuid, text, text, timestamptz, text, text, text, text, timestamptz,
  boolean, text, text, boolean, boolean, text
) is
  'Worker-only tracking persistence scoped by shop, order and tracking number.';
