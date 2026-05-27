alter table public.temu_orders
  add column if not exists logistics_tracking_no text not null default '',
  add column if not exists logistics_status text not null default '';

create index if not exists temu_orders_owner_tracking_idx
on public.temu_orders(owner_id, logistics_tracking_no);
