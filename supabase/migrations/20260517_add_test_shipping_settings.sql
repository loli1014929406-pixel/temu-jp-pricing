alter table public.pricing_settings
add column if not exists test_ocs_3cm_first_price_rmb numeric not null default 16.5;

alter table public.pricing_settings
add column if not exists test_ocs_3cm_extra_price_per_100g_rmb numeric not null default 1.5;

alter table public.pricing_settings
add column if not exists test_ocs_small_parcel_first_price_rmb numeric not null default 36.5;

alter table public.pricing_settings
add column if not exists test_ocs_small_parcel_extra_price_per_500g_rmb numeric not null default 6;
