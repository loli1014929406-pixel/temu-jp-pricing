alter table public.temu_orders
add column if not exists actual_shipping_fee_rmb numeric not null default 0;
