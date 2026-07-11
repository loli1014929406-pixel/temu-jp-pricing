alter table public.pricing_settings
add column if not exists test_sf_3cm_price_rmb numeric not null default 0.4;
