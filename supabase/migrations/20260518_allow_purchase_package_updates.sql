drop policy if exists "purchase_packages_delete_own" on public.purchase_packages;
create policy "purchase_packages_delete_own"
on public.purchase_packages for delete
using (auth.uid() = owner_id and status = 'pending');
