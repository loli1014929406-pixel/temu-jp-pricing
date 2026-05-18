alter table public.purchase_records
add column if not exists alibaba_order_no text not null default '';

alter table public.purchase_records
add column if not exists tracking_no text not null default '';
