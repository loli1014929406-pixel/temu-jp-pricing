-- Restore quantity-aware last-leg estimation without replacing the current
-- shipment-aware finance metrics. Production received the split-finance
-- migration while finance_dynamic_method_cost still had only its legacy
-- three-argument signature, so finance_split_method_cost permanently selected
-- the compatibility branch that ignores p_quantity.

create or replace function public.finance_dynamic_method_cost(
  p_method jsonb,
  p_weight_g numeric,
  p_exchange_rate numeric,
  p_quantity numeric
)
returns numeric
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_formula text := coalesce(p_method->>'formula', '');
  v_params jsonb := coalesce(p_method->'params', '{}'::jsonb);
  v_currency text := coalesce(
    v_params->>'currency',
    case when v_formula in ('flat_jpy', 'quantity_tier') then 'JPY' else 'RMB' end
  );
  v_rate numeric := case
    when v_currency = 'JPY' then coalesce(p_exchange_rate, 0)
    else 1
  end;
  v_weight_g numeric := greatest(coalesce(p_weight_g, 0), 0);
  v_weight_kg numeric := greatest(coalesce(p_weight_g, 0), 0) / 1000;
  v_quantity integer := greatest(coalesce(floor(p_quantity), 0), 0)::integer;
  v_quantity_prices jsonb;
  v_quantity_price_count integer;
  v_first_weight numeric;
  v_first_price numeric;
  v_extra_price numeric;
begin
  if v_formula = 'sf' then
    v_first_weight := coalesce((v_params->>'firstWeight')::numeric, 1);
    v_first_price := coalesce((v_params->>'firstPrice')::numeric, 8) * v_rate;
    v_extra_price := coalesce((v_params->>'extraPrice')::numeric, 2) * v_rate;
    if v_weight_kg <= 0 then return 0; end if;
    if v_first_weight <= 0 then return v_weight_kg * v_extra_price; end if;
    return least(v_weight_kg, v_first_weight) * (v_first_price / v_first_weight)
      + greatest(v_weight_kg - v_first_weight, 0) * v_extra_price;
  elsif v_formula = 'flat_rmb' then
    return v_weight_kg * coalesce((v_params->>'price')::numeric, 0) * v_rate;
  elsif v_formula = 'flat_rmb_tariff' then
    return v_weight_kg * coalesce((v_params->>'price')::numeric, 0) * v_rate
      * (1 + coalesce((v_params->>'tariffRate')::numeric, 0));
  elsif v_formula in ('flat_jpy', 'fixed_rmb') then
    return coalesce((v_params->>'price')::numeric, 0) * v_rate;
  elsif v_formula = 'quantity_tier' then
    v_quantity_prices := v_params->'quantityPrices';
    if v_quantity <= 0
      or v_quantity_prices is null
      or jsonb_typeof(v_quantity_prices) <> 'array'
    then
      return 0;
    end if;
    v_quantity_price_count := jsonb_array_length(v_quantity_prices);
    if v_quantity_price_count <= 0 then return 0; end if;
    return coalesce(
      (v_quantity_prices->>(least(v_quantity, v_quantity_price_count) - 1))::numeric,
      0
    ) * v_rate;
  elsif v_formula = 'ocs_3cm' then
    v_first_price := coalesce((v_params->>'firstPrice')::numeric, 16.5) * v_rate;
    v_extra_price := coalesce((v_params->>'extraPrice')::numeric, 1.5) * v_rate;
    return v_first_price
      + greatest(greatest(ceil(v_weight_g / 100), 1)::integer - 1, 0)
        * v_extra_price;
  elsif v_formula = 'ocs_small' then
    v_first_price := coalesce((v_params->>'firstPrice')::numeric, 36.5) * v_rate;
    v_extra_price := coalesce((v_params->>'extraPrice')::numeric, 6) * v_rate;
    return v_first_price
      + greatest(greatest(ceil(v_weight_g / 500), 1)::integer - 1, 0)
        * v_extra_price;
  end if;
  return 0;
end;
$$;

create or replace function public.finance_dynamic_method_cost(
  p_method jsonb,
  p_weight_g numeric,
  p_exchange_rate numeric
)
returns numeric
language sql
immutable
security invoker
set search_path = ''
as $$
  select public.finance_dynamic_method_cost(
    p_method,
    p_weight_g,
    p_exchange_rate,
    1
  );
$$;

create or replace function public.finance_split_method_cost(
  p_method jsonb,
  p_weight_g numeric,
  p_exchange_rate numeric,
  p_quantity numeric
)
returns numeric
language sql
immutable
security invoker
set search_path = ''
as $$
  select public.finance_dynamic_method_cost(
    p_method,
    p_weight_g,
    p_exchange_rate,
    p_quantity
  );
$$;

revoke all on function public.finance_dynamic_method_cost(
  jsonb,
  numeric,
  numeric,
  numeric
) from public;
revoke all on function public.finance_dynamic_method_cost(
  jsonb,
  numeric,
  numeric
) from public;
revoke all on function public.finance_split_method_cost(
  jsonb,
  numeric,
  numeric,
  numeric
) from public;

grant execute on function public.finance_dynamic_method_cost(
  jsonb,
  numeric,
  numeric,
  numeric
) to authenticated;
grant execute on function public.finance_dynamic_method_cost(
  jsonb,
  numeric,
  numeric
) to authenticated;
grant execute on function public.finance_split_method_cost(
  jsonb,
  numeric,
  numeric,
  numeric
) to authenticated;

do $$
declare
  v_quantity_tier_method jsonb := jsonb_build_object(
    'formula', 'quantity_tier',
    'params', jsonb_build_object(
      'currency', 'JPY',
      'quantityPrices', jsonb_build_array(225, 269)
    )
  );
  v_flat_jpy_method jsonb := jsonb_build_object(
    'formula', 'flat_jpy',
    'params', jsonb_build_object('currency', 'JPY', 'price', 220)
  );
begin
  if round(public.finance_split_method_cost(
    v_quantity_tier_method,
    0,
    0.041,
    2
  ), 3) <> 11.029 then
    raise exception 'quantity_tier split cost contract failed';
  end if;

  if round(public.finance_dynamic_method_cost(
    v_quantity_tier_method,
    0,
    0.041,
    1
  ), 3) <> 9.225 then
    raise exception 'quantity_tier one-item cost contract failed';
  end if;

  if round(public.finance_split_method_cost(
    v_flat_jpy_method,
    0,
    0.041,
    1
  ), 3) <> 9.020 then
    raise exception 'flat_jpy regression contract failed';
  end if;
end;
$$;
