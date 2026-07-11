alter table public.products
add column if not exists max_units_per_parcel integer not null default 1;

alter table public.products
drop constraint if exists products_max_units_per_parcel_check;

alter table public.products
add constraint products_max_units_per_parcel_check
check (max_units_per_parcel >= 1);
