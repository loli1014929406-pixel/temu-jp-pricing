-- Cover the audit-user foreign key used by combined shipment administration.
create index if not exists temu_order_combined_shipments_created_by_idx
  on public.temu_order_combined_shipments(created_by);
