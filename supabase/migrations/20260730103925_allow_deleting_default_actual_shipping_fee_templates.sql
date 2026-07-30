-- Allow users to permanently dismiss the two legacy default import templates.
-- System templates are soft-deleted so the idempotent initializer keeps seeing
-- their system keys and therefore does not recreate them on the next page load.

alter table public.finance_actual_shipping_fee_import_templates
  add column deleted_at timestamptz;

drop index if exists public.finance_actual_shipping_fee_templates_user_name_uidx;

create unique index finance_actual_shipping_fee_templates_user_name_uidx
  on public.finance_actual_shipping_fee_import_templates (user_id, lower(btrim(name)))
  where deleted_at is null;

create index finance_actual_shipping_fee_templates_visible_user_updated_idx
  on public.finance_actual_shipping_fee_import_templates (user_id, is_system desc, updated_at desc)
  where deleted_at is null;

comment on column public.finance_actual_shipping_fee_import_templates.deleted_at is
  'Soft-deletion marker used for auto-generated templates so the initializer does not recreate them.';
