alter table public.products
add column if not exists is_selling boolean not null default true;
