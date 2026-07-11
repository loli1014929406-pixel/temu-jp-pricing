# Supabase RLS audit

## Current access model

- Application pages require an authenticated Supabase session.
- `account_permissions` maps authenticated email addresses to `admin`, `editor`, or `viewer`.
- Product catalog and warehouse data are intentionally shared across permitted accounts; write and delete capabilities are restricted by permission helper functions.
- Finance expenses and settlement imports remain isolated by `user_id`.

## Hardening applied on 2026-07-10

- New operational RPCs use `SECURITY INVOKER`, pin `search_path`, revoke default `PUBLIC` execution, and grant execution only to `authenticated`.
- Legacy `anon` table grants for expenses and settlement tables are revoked. Existing RLS already blocked anonymous rows, but the grants were unnecessary.
- No existing shared-data RLS policy or finance ownership rule was changed.

## Items requiring business approval before any future policy change

- Whether every permitted account should continue to read every product, warehouse, order, and inventory row.
- Whether `account_profiles` must remain readable by every authenticated account for displaying usernames and user codes.
- Whether editors should be able to update shared records originally created by another account.

Do not narrow these policies until the operating-account model is confirmed, because doing so can make existing shared records disappear from the application.
