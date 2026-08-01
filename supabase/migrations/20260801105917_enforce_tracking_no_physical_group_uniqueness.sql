-- Order fulfillment keeps a stricter invariant than finance fee identity:
-- one tracking number may only identify one physical parcel. Reusing it on
-- several logical shipments is allowed only inside the same confirmed merge.

create or replace function public.validate_temu_order_tracking_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_combined_shipment_id uuid;
begin
  if btrim(new.logistics_tracking_no) = '' then
    return new;
  end if;

  select member.combined_shipment_id
    into v_combined_shipment_id
  from public.temu_order_combined_shipment_members member
  where member.shipment_id = new.id;

  if exists (
    select 1
    from public.temu_order_shipments other
    left join public.temu_order_combined_shipment_members other_member
      on other_member.shipment_id = other.id
    where other.id <> new.id
      and lower(btrim(other.logistics_tracking_no)) =
        lower(btrim(new.logistics_tracking_no))
      and (
        v_combined_shipment_id is null
        or other_member.combined_shipment_id is distinct from v_combined_shipment_id
      )
  ) then
    raise exception '相同物流单号只能属于一个普通包裹或一个已确认的合并包裹。'
      using errcode = '23505';
  end if;

  return new;
end
$$;

revoke all on function public.validate_temu_order_tracking_identity() from public;
