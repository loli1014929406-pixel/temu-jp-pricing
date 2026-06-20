alter table public.pricing_settings
add column if not exists first_leg_methods jsonb;

alter table public.pricing_settings
add column if not exists last_leg_methods jsonb;
