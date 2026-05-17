alter table public.profit_calculations
add column if not exists coupon_discount_rate numeric not null default 10;
