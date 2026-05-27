alter table public.temu_orders
  add column if not exists sku_code text not null default '',
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null,
  add column if not exists warehouse_name text not null default '',
  add column if not exists logistics_method text not null default '',
  add column if not exists label_printed_at text not null default '';

update public.temu_orders
set logistics_method = case
  when logistics_method in ('OCS 昆山3cm', 'OCS 昆山 3cm') then 'OCS 3cm'
  when logistics_method = 'OCS 昆山小包' then 'OCS 小包'
  else logistics_method
end
where logistics_method in ('OCS 昆山3cm', 'OCS 昆山 3cm', 'OCS 昆山小包');

create index if not exists temu_orders_owner_warehouse_idx
on public.temu_orders(owner_id, warehouse_id);

create index if not exists temu_orders_owner_label_printed_idx
on public.temu_orders(owner_id, label_printed_at);
