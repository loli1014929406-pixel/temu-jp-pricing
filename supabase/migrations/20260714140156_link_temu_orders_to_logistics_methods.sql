-- Make the logistics method master row the stable identity used by orders.
-- The legacy text column remains populated for backwards compatibility with
-- existing exports and RPCs, but it is kept in sync with the current master
-- name by triggers.

alter table public.temu_orders
  add column if not exists logistics_method_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'temu_orders_logistics_method_id_fkey'
      and conrelid = 'public.temu_orders'::regclass
  ) then
    alter table public.temu_orders
      add constraint temu_orders_logistics_method_id_fkey
      foreign key (logistics_method_id)
      references public.logistics_methods(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists idx_temu_orders_logistics_method_id
on public.temu_orders (logistics_method_id, id);

create or replace function public.logistics_method_match_key(p_value text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select case regexp_replace(lower(btrim(coalesce(p_value, ''))), '\s+', '', 'g')
    when 'ocs昆山3cm' then 'ocs-yamato'
    when 'ocs3cm' then 'ocs-yamato'
    when 'ocsyamato' then 'ocs-yamato'
    when 'ocs昆山小包' then 'ocs-small'
    when 'ocs小包' then 'ocs-small'
    when '福冈尾程' then 'fukuoka-japan-post'
    when '福岡尾程' then 'fukuoka-japan-post'
    when '福冈japanpost' then 'fukuoka-japan-post'
    when '福岡japanpost' then 'fukuoka-japan-post'
    when '大阪尾程' then 'osaka-japan-post'
    when '大阪japanpost' then 'osaka-japan-post'
    else regexp_replace(lower(btrim(coalesce(p_value, ''))), '\s+', '', 'g')
  end;
$$;

create or replace function public.resolve_logistics_method_id(p_value text)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select method.id
  from public.logistics_methods method
  where public.logistics_method_match_key(method.name) =
    public.logistics_method_match_key(p_value)
  order by method.is_active desc, method.sort_order, method.created_at, method.id
  limit 1;
$$;

update public.temu_orders order_row
set logistics_method_id = public.resolve_logistics_method_id(order_row.logistics_method)
where order_row.logistics_method_id is null
  and btrim(order_row.logistics_method) <> ''
  and public.resolve_logistics_method_id(order_row.logistics_method) is not null;

update public.temu_orders order_row
set logistics_method = method.name
from public.logistics_methods method
where order_row.logistics_method_id = method.id
  and order_row.logistics_method is distinct from method.name;

create or replace function public.sync_temu_order_logistics_method()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_method public.logistics_methods%rowtype;
begin
  if new.logistics_method_id is not null then
    select * into v_method
    from public.logistics_methods method
    where method.id = new.logistics_method_id;

    if found then
      new.logistics_method := v_method.name;
    end if;
    return new;
  end if;

  if btrim(coalesce(new.logistics_method, '')) = '' then
    new.logistics_method_id := null;
    new.logistics_method := '';
    return new;
  end if;

  new.logistics_method_id := public.resolve_logistics_method_id(new.logistics_method);
  if new.logistics_method_id is not null then
    select * into v_method
    from public.logistics_methods method
    where method.id = new.logistics_method_id;
    new.logistics_method := v_method.name;
  end if;

  return new;
end;
$$;

drop trigger if exists temu_orders_sync_logistics_method on public.temu_orders;
create trigger temu_orders_sync_logistics_method
before insert or update of logistics_method_id, logistics_method
on public.temu_orders
for each row
execute function public.sync_temu_order_logistics_method();

create or replace function public.propagate_logistics_method_name()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.name is not distinct from old.name then
    return new;
  end if;

  update public.temu_orders order_row
  set logistics_method = new.name
  where order_row.logistics_method_id = new.id
    and order_row.logistics_method is distinct from new.name;

  update public.pricing_settings settings
  set
    first_leg_methods = case
      when settings.first_leg_methods is null then null
      else (
        select coalesce(
          jsonb_agg(
            case
              when config.item->>'db_method_id' = new.id::text
                then jsonb_set(config.item, '{name}', to_jsonb(new.name), true)
              else config.item
            end
            order by config.ordinality
          ),
          '[]'::jsonb
        )
        from jsonb_array_elements(settings.first_leg_methods)
          with ordinality as config(item, ordinality)
      )
    end,
    last_leg_methods = case
      when settings.last_leg_methods is null then null
      else (
        select coalesce(
          jsonb_agg(
            case
              when config.item->>'db_method_id' = new.id::text
                then jsonb_set(config.item, '{name}', to_jsonb(new.name), true)
              else config.item
            end
            order by config.ordinality
          ),
          '[]'::jsonb
        )
        from jsonb_array_elements(settings.last_leg_methods)
          with ordinality as config(item, ordinality)
      )
    end
  where exists (
      select 1
      from jsonb_array_elements(coalesce(settings.first_leg_methods, '[]'::jsonb)) config
      where config->>'db_method_id' = new.id::text
    )
    or exists (
      select 1
      from jsonb_array_elements(coalesce(settings.last_leg_methods, '[]'::jsonb)) config
      where config->>'db_method_id' = new.id::text
    );

  return new;
end;
$$;

drop trigger if exists logistics_methods_propagate_name on public.logistics_methods;
create trigger logistics_methods_propagate_name
after update of name on public.logistics_methods
for each row
execute function public.propagate_logistics_method_name();

revoke all on function public.logistics_method_match_key(text) from public;
revoke all on function public.resolve_logistics_method_id(text) from public;
revoke all on function public.sync_temu_order_logistics_method() from public;
revoke all on function public.propagate_logistics_method_name() from public;

grant execute on function public.logistics_method_match_key(text) to authenticated;
grant execute on function public.resolve_logistics_method_id(text) to authenticated;
