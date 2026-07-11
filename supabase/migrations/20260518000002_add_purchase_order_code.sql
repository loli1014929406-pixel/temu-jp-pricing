alter table public.purchase_orders
add column if not exists order_code text;

update public.purchase_orders
set order_code = 'PO-' || upper(substr(replace(id::text, '-', ''), 1, 8))
where order_code is null or order_code = '';

alter table public.purchase_orders
alter column order_code set default ('PO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));

alter table public.purchase_orders
alter column order_code set not null;

create unique index if not exists purchase_orders_order_code_key
on public.purchase_orders(order_code);
