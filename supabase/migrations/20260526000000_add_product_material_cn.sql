alter table public.products
add column if not exists material_cn text not null default '';
