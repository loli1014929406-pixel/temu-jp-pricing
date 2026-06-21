alter table public.purchase_order_items
add column if not exists sku_id uuid references public.product_skus(id) on delete set null;

alter table public.purchase_order_items
add column if not exists sku_quantity integer;

alter table public.purchase_order_items
drop constraint if exists purchase_order_items_sku_quantity_check;

alter table public.purchase_order_items
add constraint purchase_order_items_sku_quantity_check
check (sku_quantity is null or sku_quantity > 0);
