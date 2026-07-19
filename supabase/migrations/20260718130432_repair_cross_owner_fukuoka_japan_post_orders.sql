-- A small set of imported orders belongs to a different auth owner while its
-- warehouse and logistics configuration share the warehouse owner. Repair the
-- method through the warehouse-owned configuration rather than the order owner.
with repair_targets as (
  select o.id, fukuoka_method.id as logistics_method_id, fukuoka_method.name as logistics_method
  from public.temu_orders o
  join public.warehouses w on w.id = o.warehouse_id
  join public.logistics_methods old_method
    on old_method.id = o.logistics_method_id
   and old_method.owner_id = w.owner_id
  join public.logistics_methods fukuoka_method
    on fukuoka_method.owner_id = w.owner_id
   and regexp_replace(lower(btrim(fukuoka_method.name)), '\s+', '', 'g') = '福冈japanpost'
  where regexp_replace(lower(btrim(w.name)), '\s+', '', 'g') = '福冈'
    and regexp_replace(lower(btrim(old_method.name)), '\s+', '', 'g') = '名古屋japanpost'
)
update public.temu_orders o
set logistics_method_id = repair_targets.logistics_method_id,
    logistics_method = repair_targets.logistics_method,
    updated_at = now()
from repair_targets
where o.id = repair_targets.id;
