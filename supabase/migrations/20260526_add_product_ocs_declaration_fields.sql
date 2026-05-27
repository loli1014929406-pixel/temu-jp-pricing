alter table public.products
add column if not exists product_name_en text not null default '';

alter table public.products
add column if not exists material_en text not null default '';
