-- These tenant-scoped tables already have resource/action RLS policies, but
-- they also need Data API table privileges before authenticated users can
-- reach those policies.
revoke all on table public.product_strategy_states from anon;
revoke all on table public.strategy_rule_settings from anon;

grant select, insert, update, delete
  on table public.product_strategy_states
  to authenticated;
grant select, insert, update, delete
  on table public.strategy_rule_settings
  to authenticated;
