# Supabase RLS audit

## Current access model

- Application pages require an authenticated Supabase session.
- `account_permissions` maps authenticated email addresses to `admin`, `editor`, or `viewer`.
- Product catalog and warehouse data are intentionally shared across permitted accounts; write and delete capabilities are restricted by permission helper functions.
- Finance expenses and settlement imports remain isolated by `user_id`.

## Confirmed business scope

- Confirmed by the project owner on 2026-07-11: all permitted login accounts belong to the same operating team.
- Product, warehouse, logistics, order, purchase, and inventory visibility should remain shared across that team.
- Finance expenses, settlement imports, account profiles, and other explicitly user-owned records should remain isolated by `user_id` or `owner_id` where their current policies require it.
- A tenant/company boundary is not required for the current deployment. Revisit this decision before adding accounts from another team or company.

## Hardening applied on 2026-07-10

- New operational RPCs use `SECURITY INVOKER`, pin `search_path`, revoke default `PUBLIC` execution, and grant execution only to `authenticated`.
- Legacy `anon` table grants for expenses and settlement tables are revoked. Existing RLS already blocked anonymous rows, but the grants were unnecessary.
- No existing shared-data RLS policy or finance ownership rule was changed.

## Hardening applied on 2026-07-13

- Permission bootstrap now fails closed: an empty `account_permissions` table no longer promotes every authenticated account to administrator.
- The first administrator must be inserted explicitly with Supabase administrative credentials.
- Purchase receipt and settlement import writes use transaction RPCs so status, inventory, adjustment, file, and detail rows cannot be partially committed.

## Team operational sharing applied on 2026-07-11

- `temu_orders` and all purchase-management tables are readable by every permitted team account.
- Editors can update shared operational rows and admins retain delete authority.
- New operational rows keep the creating account in `owner_id`; a trigger prevents later ownership changes.
- Team-wide Temu order-line uniqueness prevents duplicate imports from different accounts.
- Finance expenses, settlement files, settlement records, account profiles, and per-user settings remain owner-isolated.

## Guardrails for future policy changes

- Keep team-shared operational reads unless the account model changes.
- Keep `account_profiles` readable by authenticated team accounts only where usernames and user codes must be displayed.
- Preserve the current editor/admin write boundaries for shared records unless the project owner approves a different workflow.

Do not introduce tenant isolation or narrow shared operational policies without a new business decision, because doing so can make existing team records disappear from the application.
