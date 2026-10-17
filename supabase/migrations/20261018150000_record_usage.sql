-- Labventory: researchers record chemical usage.
--
-- Usage is the only inventory change a researcher can make. It goes through
-- record_usage(), which locks the bottle row, checks the account is active,
-- the amount is positive and available, converts mg/g/kg or µL/mL/L into the
-- bottle's own unit, updates the bottle, appends one USAGE transaction and one
-- CHEMICAL_USAGE activity entry, all in one transaction.
--
-- It also removes the old "authenticated append transactions" policy, which let
-- any signed-in user insert transactions directly (fabricated usage history
-- without changing a bottle). Bottles stay writable only by the Admin (existing
-- "admins write bottles" policy); researchers keep read access.
-- Requires 20261018090000 and 20261018120000 (labventory_unit/dimension/factor).

create or replace function public.record_usage(
  p_bottle_id uuid,
  p_quantity numeric,
  p_quantity_unit text,
  p_purpose text default null,
  p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_bottle public.bottles;
  v_unit text := public.labventory_unit(p_quantity_unit);
  v_used numeric;
  v_remaining numeric;
  v_status public.bottle_status;
  v_txn uuid;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'QUANTITY_MUST_BE_POSITIVE'; end if;
  if length(coalesce(p_purpose, '')) > 200 then raise exception 'PURPOSE_TOO_LONG: maximum 200 characters'; end if;
  if length(coalesce(p_notes, '')) > 1000 then raise exception 'NOTES_TOO_LONG: maximum 1000 characters'; end if;
  if v_unit is null then raise exception 'UNIT_NOT_SUPPORTED: use µg, mg, g, kg, µL, mL or L'; end if;

  select * into v_bottle from public.bottles where id = p_bottle_id and not is_archived for update;
  if not found then raise exception 'BOTTLE_NOT_FOUND'; end if;
  if v_bottle.status in ('Disposed', 'Quarantined') then raise exception 'BOTTLE_NOT_USABLE: this bottle is %', v_bottle.status; end if;
  if public.labventory_dimension(v_bottle.quantity_unit) is null then raise exception 'BOTTLE_HAS_NO_UNIT: ask the Admin to correct this bottle'; end if;
  if public.labventory_dimension(v_unit) <> public.labventory_dimension(v_bottle.quantity_unit) then
    raise exception 'UNIT_MISMATCH: this bottle is measured in %', v_bottle.quantity_unit;
  end if;

  -- Stored in the bottle's own unit; units are never mixed in the record.
  v_used := trim_scale(round(p_quantity * public.labventory_factor(v_unit) / public.labventory_factor(v_bottle.quantity_unit), 6));
  if v_used > v_bottle.current_quantity then
    raise exception 'INSUFFICIENT_QUANTITY: only % % left in this bottle', v_bottle.current_quantity, v_bottle.quantity_unit;
  end if;
  v_remaining := v_bottle.current_quantity - v_used;
  v_status := case
    when v_bottle.status = 'Expired' then 'Expired'
    when v_remaining <= 0 then 'Depleted'
    when v_bottle.bottle_size is not null and v_bottle.bottle_size > 0
         and public.labventory_dimension(v_bottle.bottle_size_unit) = public.labventory_dimension(v_bottle.quantity_unit)
         and v_remaining * public.labventory_factor(v_bottle.quantity_unit) < 0.2 * v_bottle.bottle_size * public.labventory_factor(v_bottle.bottle_size_unit) then 'Low Stock'
    else 'Available' end;

  update public.bottles
     set current_quantity = v_remaining, status = v_status, updated_at = now(), updated_by = auth.uid()
   where id = v_bottle.id;

  insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after, source_location_id, reason, notes)
  values (v_bottle.id, v_bottle.chemical_id, auth.uid(), 'USAGE', v_bottle.current_quantity, -v_used, v_remaining, v_bottle.location_id,
          nullif(btrim(coalesce(p_purpose, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_txn;

  insert into public.activity_log (actor_user_id, action_type, chemical_id, bottle_id, transaction_id, metadata)
  values (auth.uid(), 'CHEMICAL_USAGE', v_bottle.chemical_id, v_bottle.id, v_txn, jsonb_build_object(
    'quantity', p_quantity, 'unit', v_unit, 'recorded', v_used, 'bottle_unit', v_bottle.quantity_unit,
    'remaining', v_remaining, 'purpose', nullif(btrim(coalesce(p_purpose, '')), '')));

  return jsonb_build_object('transaction_id', v_txn, 'used', v_used, 'unit', v_bottle.quantity_unit, 'remaining', v_remaining, 'status', v_status);
end;
$$;
revoke all on function public.record_usage(uuid, numeric, text, text, text) from public, anon;
grant execute on function public.record_usage(uuid, numeric, text, text, text) to authenticated;

-- Transactions are written only by record_usage / import_inventory_batch (SECURITY DEFINER).
drop policy if exists "authenticated append transactions" on public.transactions;
drop policy if exists "active users append only own transactions" on public.transactions;
revoke insert, update, delete, truncate on public.transactions from anon, authenticated;

notify pgrst, 'reload schema';
