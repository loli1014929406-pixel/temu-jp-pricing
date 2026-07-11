alter table public.purchase_records
add column if not exists purchase_url text not null default '';
