-- Recreate the atomic RPC after 20261013_auth_rbac_usage.sql.
-- This file changes source only; execute it in Supabase after review.
create or replace function public.record_usage(
  p_bottle_id uuid,
  p_quantity numeric,
  p_quantity_unit text,
  p_purpose text default null,
  p_project_name text default null,
  p_notes text default null
)
returns public.transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bottle_row public.bottles;
  inserted_transaction public.transactions;
  remaining_quantity numeric;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED';
  end if;

  if not public.is_active_user() then
    raise exception 'ACCOUNT_NOT_ACTIVE';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'QUANTITY_MUST_BE_POSITIVE';
  end if;

  select * into bottle_row
  from public.bottles
  where id = p_bottle_id and is_archived = false
  for update;

  if not found then raise exception 'BOTTLE_NOT_FOUND'; end if;
  if bottle_row.status in ('Disposed', 'Quarantined') then raise exception 'BOTTLE_NOT_USABLE'; end if;
  if lower(trim(coalesce(p_quantity_unit, ''))) <> lower(trim(coalesce(bottle_row.quantity_unit, ''))) then raise exception 'UNIT_MISMATCH'; end if;
  if p_quantity > bottle_row.current_quantity then raise exception 'INSUFFICIENT_QUANTITY'; end if;

  remaining_quantity := bottle_row.current_quantity - p_quantity;

  update public.bottles
  set current_quantity = remaining_quantity,
      updated_at = now(),
      status = case
        when bottle_row.status = 'Expired' then 'Expired'::public.bottle_status
        when remaining_quantity <= 0 then 'Depleted'::public.bottle_status
        when remaining_quantity <= coalesce(bottle_row.low_stock_threshold, 0) then 'Low Stock'::public.bottle_status
        else 'Available'::public.bottle_status
      end
  where id = bottle_row.id;

  insert into public.transactions (
    bottle_id, chemical_id, user_id, transaction_type, quantity_before,
    quantity_change, quantity_after, quantity_unit, purpose, project_name,
    notes, created_at
  )
  values (
    bottle_row.id, bottle_row.chemical_id, auth.uid(), 'USAGE'::public.transaction_type,
    bottle_row.current_quantity, -p_quantity, remaining_quantity,
    bottle_row.quantity_unit, p_purpose, p_project_name, p_notes, now()
  )
  returning * into inserted_transaction;

  insert into public.activity_log (
    actor_user_id, action_type, chemical_id, bottle_id, transaction_id, metadata
  )
  values (
    auth.uid(), 'CHEMICAL_USAGE', bottle_row.chemical_id, bottle_row.id,
    inserted_transaction.id,
    jsonb_build_object('quantity', p_quantity, 'unit', bottle_row.quantity_unit)
  );

  return inserted_transaction;
end;
$$;

revoke all on function public.record_usage(uuid, numeric, text, text, text, text) from public;
revoke all on function public.record_usage(uuid, numeric, text, text, text, text) from anon;
grant execute on function public.record_usage(uuid, numeric, text, text, text, text) to authenticated;
