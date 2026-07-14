-- Logistics method master data was renamed to OCS Yamato, while historical
-- Temu orders kept the old text value because logistics_method is stored as a
-- snapshot string. Normalize those historical aliases without changing the
-- internal ocs_3cm calculation formula identifier.

update public.temu_orders
set logistics_method = 'OCS Yamato',
    updated_at = now()
where lower(regexp_replace(btrim(logistics_method), '\s+', ' ', 'g')) in (
  'ocs 3cm',
  'ocs 昆山3cm',
  'ocs 昆山 3cm'
);

