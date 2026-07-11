alter table public.product_skus
add column if not exists temu_image_url text not null default '';
