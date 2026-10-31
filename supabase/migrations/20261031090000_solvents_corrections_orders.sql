-- Labventory: solvent inventories, audited usage corrections, edits and chemical ordering.
--
-- Reuses the existing chemicals / bottles / transactions model:
--   * bottles.inventory_category separates the general chemical register from the
--     Commercial Solvents and NMR Solvents tabs. Every physical can or bottle is one row.
--   * bottles.current_quantity may be NULL = "not yet verified" (e.g. a 25 L can whose
--     remaining amount was never recorded). Usage cannot be recorded until the Admin
--     enters a counted amount (set_verified_quantity).
--   * Last used by / at / quantity and the total recorded usage are maintained on the
--     bottle by the trusted functions below, never typed in by users.
--   * Corrections never change or delete the original usage transaction: the difference
--     is appended as an ADJUSTMENT transaction linked to it, and the before/after values,
--     who, when and why go to transaction_corrections.
--   * Signed-in users can no longer insert bottles or change quantities directly (even the
--     Admin); quantities change only through the SECURITY DEFINER functions here.
--   * Chemicals to be ordered live in their own tables and never count as stock until
--     receive_order() creates the physical bottle and a STOCK_IN transaction.
-- Requires 20261018090000 .. 20261018180000.

-- ---------------------------------------------------------------- bottles
alter table public.bottles
  add column if not exists inventory_category text not null default 'CHEMICAL',
  add column if not exists untracked_quantity numeric not null default 0,
  add column if not exists total_used numeric not null default 0,
  add column if not exists last_used_by uuid references public.profiles(id),
  add column if not exists last_used_at timestamptz,
  add column if not exists last_used_quantity numeric,
  add column if not exists last_usage_transaction_id uuid,
  add column if not exists legacy_last_used_by text;
alter table public.bottles drop constraint if exists bottles_inventory_category_check;
alter table public.bottles add constraint bottles_inventory_category_check
  check (inventory_category in ('CHEMICAL', 'COMMERCIAL_SOLVENT', 'NMR_SOLVENT'));
alter table public.bottles drop constraint if exists bottles_low_stock_threshold_check;
alter table public.bottles add constraint bottles_low_stock_threshold_check check (low_stock_threshold is null or low_stock_threshold >= 0);
-- NULL now means "remaining quantity not verified yet"; the existing >= 0 check still applies otherwise.
alter table public.bottles alter column current_quantity drop not null;
alter table public.bottles alter column current_quantity drop default;
create index if not exists bottles_category_idx on public.bottles (inventory_category);

-- ---------------------------------------------------------------- transactions
alter table public.transactions
  add column if not exists quantity_unit text,
  add column if not exists experiment text,
  add column if not exists corrects_transaction_id uuid references public.transactions(id);
create index if not exists transactions_corrects_idx on public.transactions (corrects_transaction_id);
create index if not exists transactions_user_idx on public.transactions (user_id, created_at desc);

-- Backfill from the existing rows: units, recorded totals, last use and usage before tracking started.
update public.transactions t set quantity_unit = b.quantity_unit from public.bottles b where b.id = t.bottle_id and t.quantity_unit is null;
update public.bottles b set
  total_used = coalesce(u.total, 0),
  last_used_by = u.last_user, last_used_at = u.last_at, last_used_quantity = u.last_qty, last_usage_transaction_id = u.last_id
from (
  select bottle_id, -sum(quantity_change) total,
         (array_agg(user_id order by created_at desc, id desc))[1] last_user,
         max(created_at) last_at,
         (array_agg(-quantity_change order by created_at desc, id desc))[1] last_qty,
         (array_agg(id order by created_at desc, id desc))[1] last_id
    from public.transactions where transaction_type = 'USAGE' group by bottle_id
) u where u.bottle_id = b.id;
update public.bottles b set untracked_quantity = greatest(b.initial_quantity - s.stocked, 0)
from (select bottle_id, sum(quantity_change) stocked from public.transactions where transaction_type = 'STOCK_IN' group by bottle_id) s
where s.bottle_id = b.id and b.initial_quantity is not null;

-- ---------------------------------------------------------------- helpers
-- Low-stock limit in the bottle's own unit: the bottle's configured threshold when set (> 0, compatible
-- unit), otherwise the system default of 20% of the initial quantity (or bottle size).
create or replace function public.labventory_low_limit(b public.bottles) returns numeric
language sql stable set search_path = public as $$
  select case
    when coalesce(b.low_stock_threshold, 0) > 0 then
      case when public.labventory_dimension(coalesce(b.low_stock_threshold_unit, b.quantity_unit)) = public.labventory_dimension(b.quantity_unit)
           then b.low_stock_threshold * public.labventory_factor(coalesce(b.low_stock_threshold_unit, b.quantity_unit)) / public.labventory_factor(b.quantity_unit) end
    when coalesce(b.initial_quantity, 0) > 0 then 0.2 * b.initial_quantity
    when coalesce(b.bottle_size, 0) > 0 and public.labventory_dimension(b.bottle_size_unit) = public.labventory_dimension(b.quantity_unit)
      then 0.2 * b.bottle_size * public.labventory_factor(b.bottle_size_unit) / public.labventory_factor(b.quantity_unit)
  end
$$;

create or replace function public.labventory_status_for(b public.bottles, p_remaining numeric) returns public.bottle_status
language sql stable set search_path = public as $$
  select case
    when b.status in ('Expired', 'Quarantined', 'Disposed') then b.status
    when b.expiry_date is not null and b.expiry_date < current_date then 'Expired'::public.bottle_status
    when p_remaining is null then 'Available'::public.bottle_status
    when p_remaining <= 0 then 'Depleted'::public.bottle_status
    when p_remaining < public.labventory_low_limit(b) then 'Low Stock'::public.bottle_status
    else 'Available'::public.bottle_status end
$$;

create or replace function public.labventory_text(p jsonb, p_key text, p_max integer default 200) returns text
language plpgsql immutable as $$
declare v text := nullif(btrim(coalesce(p->>p_key, '')), '');
begin
  if v is not null and length(v) > p_max then raise exception 'VALUE_TOO_LONG: % (maximum % characters)', p_key, p_max; end if;
  return v;
end; $$;

create or replace function public.labventory_number(p jsonb, p_key text) returns numeric
language plpgsql immutable as $$
declare v text := nullif(btrim(coalesce(p->>p_key, '')), '');
begin
  if v is null then return null; end if;
  if v !~ '^\d+(\.\d+)?$' then raise exception 'INVALID_NUMBER: % must be a number zero or above', p_key; end if;
  return v::numeric;
end; $$;

-- Place (room) + tray -> location row, reusing an existing one when it matches.
create or replace function public.labventory_location(p_place text, p_tray text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_place text := nullif(btrim(coalesce(p_place, '')), ''); v_tray text := nullif(btrim(coalesce(p_tray, '')), '');
begin
  if v_place is null then return null; end if;
  select id into v_id from public.locations
   where not is_archived and public.labventory_norm(room) = public.labventory_norm(v_place)
     and cabinet is null and shelf is null and public.labventory_norm(tray) is not distinct from public.labventory_norm(v_tray)
   order by created_at limit 1;
  if v_id is null then
    insert into public.locations (room, tray, source_value) values (v_place, v_tray, concat_ws(' / ', v_place, v_tray)) returning id into v_id;
  end if;
  return v_id;
end; $$;

create or replace function public.labventory_supplier(p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_name is null then return null; end if;
  select id into v_id from public.suppliers where not is_archived and normalized_name = public.labventory_norm(v_name) limit 1;
  if v_id is null then insert into public.suppliers (vendor_name, normalized_name) values (v_name, public.labventory_norm(v_name)) returning id into v_id; end if;
  return v_id;
end; $$;

-- Chemical master record: an explicitly chosen existing chemical, else exact CAS match, else exact name
-- match (case/space-insensitive) when no CAS was given, else a new chemical. Never fuzzy-merged.
create or replace function public.labventory_chemical(p_chemical_id uuid, p_name text, p_cas text, p_formula text, p_actor uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_name text := nullif(btrim(coalesce(p_name, '')), ''); v_cas text := nullif(btrim(coalesce(p_cas, '')), '');
begin
  if p_chemical_id is not null then
    select id into v_id from public.chemicals where id = p_chemical_id and not is_archived;
    if v_id is null then raise exception 'CHEMICAL_NOT_FOUND'; end if;
    return v_id;
  end if;
  if v_name is null then raise exception 'CHEMICAL_NAME_REQUIRED'; end if;
  if v_cas is not null then
    if not public.labventory_cas_valid(v_cas) then raise exception 'INVALID_CAS_NUMBER: %', v_cas; end if;
    select id into v_id from public.chemicals where not is_archived and cas_number = v_cas
     order by (public.labventory_norm(name) = public.labventory_norm(v_name)) desc, created_at limit 1;
  else
    select id into v_id from public.chemicals where not is_archived and cas_number is null and public.labventory_norm(name) = public.labventory_norm(v_name) order by created_at limit 1;
  end if;
  if v_id is null then
    insert into public.chemicals (name, cas_number, molecular_formula, created_by, updated_by)
    values (v_name, v_cas, nullif(btrim(coalesce(p_formula, '')), ''), p_actor, p_actor) returning id into v_id;
  end if;
  return v_id;
end; $$;

-- Internal: creates one physical bottle (+ STOCK_IN when its quantity is known). Callers check permissions.
create or replace function public.labventory_add_bottle(p jsonb, p_chemical_id uuid, p_actor uuid, p_reason text, p_reference text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text := public.labventory_text(p, 'bottle_id', 60);
  v_category text := coalesce(public.labventory_text(p, 'category', 40), 'CHEMICAL');
  v_unit text := public.labventory_unit(p->>'unit');
  v_size numeric := public.labventory_number(p, 'bottle_size');
  v_size_unit text := coalesce(public.labventory_unit(p->>'bottle_size_unit'), public.labventory_unit(p->>'unit'));
  v_qty numeric := public.labventory_number(p, 'quantity');
  v_initial numeric := public.labventory_number(p, 'initial_quantity');
  v_threshold numeric := public.labventory_number(p, 'low_stock_threshold');
  v_loc uuid := public.labventory_location(public.labventory_text(p, 'place', 120), public.labventory_text(p, 'tray', 60));
  v_row public.bottles;
begin
  if v_code is null then raise exception 'BOTTLE_ID_REQUIRED'; end if;
  if exists (select 1 from public.bottles where lower(bottle_id) = lower(v_code)) then raise exception 'DUPLICATE_BOTTLE_ID: % is already used', v_code; end if;
  if v_category not in ('CHEMICAL', 'COMMERCIAL_SOLVENT', 'NMR_SOLVENT') then raise exception 'INVALID_CATEGORY'; end if;
  if v_unit is null then raise exception 'UNIT_NOT_SUPPORTED: use µg, mg, g, kg, µL, mL or L'; end if;
  if v_size is not null and public.labventory_dimension(v_size_unit) is distinct from public.labventory_dimension(v_unit) then raise exception 'UNIT_MISMATCH: bottle size and quantity must both be mass or both volume'; end if;
  -- Initial (maximum) quantity defaults to the pack size, in the quantity unit.
  if v_initial is null and v_size is not null then v_initial := trim_scale(round(v_size * public.labventory_factor(v_size_unit) / public.labventory_factor(v_unit), 6)); end if;
  if v_initial is null and v_qty is not null then v_initial := v_qty; end if;
  if v_qty is not null and v_initial is not null and v_qty > v_initial then raise exception 'QUANTITY_EXCEEDS_INITIAL: % % is more than the initial %', v_qty, v_unit, v_initial; end if;

  insert into public.bottles (bottle_id, chemical_id, inventory_category, supplier_id, manufacturer, batch_lot_number, catalog_number,
    bottle_size, bottle_size_unit, current_quantity, initial_quantity, quantity_unit, untracked_quantity,
    low_stock_threshold, low_stock_threshold_unit, purchase_date, expiry_date, location_id, status, notes, legacy_last_used_by, raw_source, created_by, updated_by)
  values (v_code, p_chemical_id, v_category, public.labventory_supplier(public.labventory_text(p, 'supplier', 120)),
    public.labventory_text(p, 'manufacturer', 120), public.labventory_text(p, 'batch_lot_number', 80), public.labventory_text(p, 'catalog_number', 80),
    v_size, case when v_size is null then null else v_size_unit end, v_qty, v_initial, v_unit,
    case when v_qty is not null and v_initial is not null then v_initial - v_qty else 0 end,
    coalesce(v_threshold, 0), case when v_threshold is null then null else coalesce(public.labventory_unit(p->>'low_stock_threshold_unit'), v_unit) end,
    nullif(p->>'purchase_date', '')::date, nullif(p->>'expiry_date', '')::date, v_loc, 'Available',
    public.labventory_text(p, 'notes', 1000), public.labventory_text(p, 'legacy_last_used_by', 120), p->'raw_source', p_actor, p_actor)
  returning * into v_row;
  update public.bottles set status = public.labventory_status_for(v_row, v_qty) where id = v_row.id;

  if v_qty is not null then
    insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after, quantity_unit, destination_location_id, reason, reference_number)
    values (v_row.id, p_chemical_id, p_actor, 'STOCK_IN', 0, v_qty, v_qty, v_unit, v_loc, p_reason, p_reference);
  end if;
  return v_row.id;
end; $$;

-- ---------------------------------------------------------------- direct-write guard
-- Requests from the website run as the "authenticated" role; trusted functions run as their owner.
-- So even the Admin cannot insert bottles or overwrite calculated quantities through the API.
create or replace function public.guard_bottle_quantities() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then raise exception 'USE_ADD_FUNCTION: bottles are created through the add, import or receive functions' using errcode = '42501'; end if;
    if new.current_quantity is distinct from old.current_quantity or new.total_used is distinct from old.total_used
       or new.untracked_quantity is distinct from old.untracked_quantity or new.quantity_unit is distinct from old.quantity_unit
       or new.last_used_by is distinct from old.last_used_by or new.last_used_at is distinct from old.last_used_at
       or new.last_used_quantity is distinct from old.last_used_quantity or new.last_usage_transaction_id is distinct from old.last_usage_transaction_id then
      raise exception 'QUANTITY_IS_CALCULATED: remaining quantity changes only through usage, corrections and stock counts' using errcode = '42501';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists bottles_guard_quantities on public.bottles;
create trigger bottles_guard_quantities before insert or update on public.bottles for each row execute function public.guard_bottle_quantities();

-- ---------------------------------------------------------------- record_usage (adds experiment, unit, last-used)
drop function if exists public.record_usage(uuid, numeric, text, text, text);
drop function if exists public.record_usage(uuid, numeric, text, text, text, text);
create function public.record_usage(
  p_bottle_id uuid, p_quantity numeric, p_quantity_unit text,
  p_purpose text default null, p_notes text default null, p_experiment text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bottle public.bottles;
  v_unit text := public.labventory_unit(p_quantity_unit);
  v_used numeric; v_remaining numeric; v_status public.bottle_status; v_txn uuid;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'QUANTITY_MUST_BE_POSITIVE'; end if;
  if length(coalesce(p_purpose, '')) > 200 then raise exception 'PURPOSE_TOO_LONG: maximum 200 characters'; end if;
  if length(coalesce(p_experiment, '')) > 200 then raise exception 'EXPERIMENT_TOO_LONG: maximum 200 characters'; end if;
  if length(coalesce(p_notes, '')) > 1000 then raise exception 'NOTES_TOO_LONG: maximum 1000 characters'; end if;
  if v_unit is null then raise exception 'UNIT_NOT_SUPPORTED: use µg, mg, g, kg, µL, mL or L'; end if;

  select * into v_bottle from public.bottles where id = p_bottle_id and not is_archived for update;
  if not found then raise exception 'BOTTLE_NOT_FOUND'; end if;
  if v_bottle.status in ('Disposed', 'Quarantined') then raise exception 'BOTTLE_NOT_USABLE: this bottle is %', v_bottle.status; end if;
  if v_bottle.current_quantity is null then raise exception 'QUANTITY_NOT_VERIFIED: the Admin must enter the counted amount for this bottle before usage can be recorded'; end if;
  if public.labventory_dimension(v_bottle.quantity_unit) is null then raise exception 'BOTTLE_HAS_NO_UNIT: ask the Admin to correct this bottle'; end if;
  if public.labventory_dimension(v_unit) <> public.labventory_dimension(v_bottle.quantity_unit) then
    raise exception 'UNIT_MISMATCH: this bottle is measured in %', v_bottle.quantity_unit;
  end if;

  v_used := trim_scale(round(p_quantity * public.labventory_factor(v_unit) / public.labventory_factor(v_bottle.quantity_unit), 6));
  if v_used <= 0 then raise exception 'QUANTITY_MUST_BE_POSITIVE'; end if;
  if v_used > v_bottle.current_quantity then
    raise exception 'INSUFFICIENT_QUANTITY: only % % left in this bottle', v_bottle.current_quantity, v_bottle.quantity_unit;
  end if;
  v_remaining := v_bottle.current_quantity - v_used;
  v_status := public.labventory_status_for(v_bottle, v_remaining);

  insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after, quantity_unit, source_location_id, reason, experiment, notes)
  values (v_bottle.id, v_bottle.chemical_id, auth.uid(), 'USAGE', v_bottle.current_quantity, -v_used, v_remaining, v_bottle.quantity_unit, v_bottle.location_id,
          nullif(btrim(coalesce(p_purpose, '')), ''), nullif(btrim(coalesce(p_experiment, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_txn;

  update public.bottles
     set current_quantity = v_remaining, status = v_status, total_used = total_used + v_used,
         last_used_by = auth.uid(), last_used_at = now(), last_used_quantity = v_used, last_usage_transaction_id = v_txn,
         updated_at = now(), updated_by = auth.uid()
   where id = v_bottle.id;

  insert into public.activity_log (actor_user_id, action_type, entity_type, chemical_id, bottle_id, transaction_id, metadata)
  values (auth.uid(), 'CHEMICAL_USAGE', v_bottle.inventory_category, v_bottle.chemical_id, v_bottle.id, v_txn, jsonb_build_object(
    'quantity', p_quantity, 'unit', v_unit, 'recorded', v_used, 'bottle_unit', v_bottle.quantity_unit,
    'remaining', v_remaining, 'purpose', nullif(btrim(coalesce(p_purpose, '')), ''), 'experiment', nullif(btrim(coalesce(p_experiment, '')), '')));

  return jsonb_build_object('transaction_id', v_txn, 'used', v_used, 'unit', v_bottle.quantity_unit, 'before', v_bottle.current_quantity, 'remaining', v_remaining, 'status', v_status);
end; $$;
revoke all on function public.record_usage(uuid, numeric, text, text, text, text) from public, anon;
grant execute on function public.record_usage(uuid, numeric, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- corrections
create table if not exists public.transaction_corrections (
  id uuid primary key default gen_random_uuid(),
  original_transaction_id uuid not null references public.transactions(id),
  adjustment_transaction_id uuid references public.transactions(id),
  bottle_id uuid not null references public.bottles(id),
  corrected_by uuid not null references public.profiles(id),
  old_quantity numeric not null, new_quantity numeric not null check (new_quantity >= 0), quantity_unit text not null,
  old_purpose text, new_purpose text, old_experiment text, new_experiment text, old_notes text, new_notes text,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  created_at timestamptz not null default now()
);
create index if not exists transaction_corrections_original_idx on public.transaction_corrections (original_transaction_id, created_at desc);
alter table public.transaction_corrections enable row level security;
drop policy if exists "active users read corrections" on public.transaction_corrections;
create policy "active users read corrections" on public.transaction_corrections for select to authenticated using (public.is_active_user());
revoke insert, update, delete, truncate on public.transaction_corrections from anon, authenticated;
grant select on public.transaction_corrections to authenticated;

-- Admin: any usage entry. Researcher: only their own, within 24 hours of recording it.
create or replace function public.correct_usage(
  p_transaction_id uuid, p_quantity numeric, p_quantity_unit text, p_reason text,
  p_purpose text default null, p_experiment text default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_txn public.transactions; v_bottle public.bottles; v_last public.transaction_corrections;
  v_unit text := public.labventory_unit(p_quantity_unit);
  v_old numeric; v_new numeric; v_delta numeric; v_remaining numeric; v_adj uuid; v_id uuid; v_status public.bottle_status;
  v_old_purpose text; v_old_experiment text; v_old_notes text; v_new_purpose text; v_new_experiment text; v_new_notes text;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED: explain why this entry is being corrected'; end if;
  if length(p_reason) > 500 then raise exception 'REASON_TOO_LONG: maximum 500 characters'; end if;
  if p_quantity is null or p_quantity < 0 then raise exception 'INVALID_QUANTITY: enter the amount actually used (0 if none)'; end if;
  if v_unit is null then raise exception 'UNIT_NOT_SUPPORTED: use µg, mg, g, kg, µL, mL or L'; end if;

  select * into v_txn from public.transactions where id = p_transaction_id;
  if not found or v_txn.transaction_type <> 'USAGE' then raise exception 'USAGE_ENTRY_NOT_FOUND'; end if;
  if not public.is_admin() then
    if v_txn.user_id <> auth.uid() then raise exception 'NOT_YOUR_ENTRY: researchers can only correct their own usage' using errcode = '42501'; end if;
    if v_txn.created_at < now() - interval '24 hours' then raise exception 'CORRECTION_WINDOW_CLOSED: entries can be corrected by the researcher within 24 hours; ask the Admin' using errcode = '42501'; end if;
  end if;

  select * into v_bottle from public.bottles where id = v_txn.bottle_id for update;
  if v_bottle.current_quantity is null then raise exception 'QUANTITY_NOT_VERIFIED'; end if;
  if public.labventory_dimension(v_unit) is distinct from public.labventory_dimension(v_bottle.quantity_unit) then raise exception 'UNIT_MISMATCH: this bottle is measured in %', v_bottle.quantity_unit; end if;

  select * into v_last from public.transaction_corrections where original_transaction_id = v_txn.id order by created_at desc, id desc limit 1;
  v_old := coalesce(v_last.new_quantity, -v_txn.quantity_change);
  v_old_purpose := case when v_last.id is null then v_txn.reason else v_last.new_purpose end;
  v_old_experiment := case when v_last.id is null then v_txn.experiment else v_last.new_experiment end;
  v_old_notes := case when v_last.id is null then v_txn.notes else v_last.new_notes end;
  v_new_purpose := coalesce(nullif(btrim(coalesce(p_purpose, '')), ''), v_old_purpose);
  v_new_experiment := coalesce(nullif(btrim(coalesce(p_experiment, '')), ''), v_old_experiment);
  v_new_notes := coalesce(nullif(btrim(coalesce(p_notes, '')), ''), v_old_notes);
  v_new := trim_scale(round(p_quantity * public.labventory_factor(v_unit) / public.labventory_factor(v_bottle.quantity_unit), 6));
  v_delta := v_new - v_old;  -- > 0: more was used than recorded
  if v_delta = 0 and v_new_purpose is not distinct from v_old_purpose and v_new_experiment is not distinct from v_old_experiment and v_new_notes is not distinct from v_old_notes then
    raise exception 'NOTHING_TO_CORRECT: the corrected values are the same as the current ones';
  end if;
  v_remaining := v_bottle.current_quantity - v_delta;
  if v_remaining < 0 then
    raise exception 'INSUFFICIENT_QUANTITY: correcting to % % would need % % more, but only % % is left', v_new, v_bottle.quantity_unit, v_delta, v_bottle.quantity_unit, v_bottle.current_quantity, v_bottle.quantity_unit;
  end if;
  if v_bottle.initial_quantity is not null and v_remaining > v_bottle.initial_quantity + coalesce((select sum(quantity_change) from public.transactions where bottle_id = v_bottle.id and transaction_type = 'STOCK_IN'), 0) then
    raise exception 'CORRECTION_TOO_LARGE: the bottle would hold more than was ever stocked';
  end if;

  if v_delta <> 0 then
    v_status := public.labventory_status_for(v_bottle, v_remaining);
    insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after, quantity_unit, reason, notes, corrects_transaction_id)
    values (v_bottle.id, v_bottle.chemical_id, auth.uid(), 'ADJUSTMENT', v_bottle.current_quantity, -v_delta, v_remaining, v_bottle.quantity_unit,
            'Usage correction', btrim(p_reason), v_txn.id)
    returning id into v_adj;
    update public.bottles
       set current_quantity = v_remaining, status = v_status, total_used = total_used + v_delta,
           last_used_quantity = case when last_usage_transaction_id = v_txn.id then v_new else last_used_quantity end,
           updated_at = now(), updated_by = auth.uid()
     where id = v_bottle.id;
  end if;

  insert into public.transaction_corrections (original_transaction_id, adjustment_transaction_id, bottle_id, corrected_by, old_quantity, new_quantity, quantity_unit,
    old_purpose, new_purpose, old_experiment, new_experiment, old_notes, new_notes, reason)
  values (v_txn.id, v_adj, v_bottle.id, auth.uid(), v_old, v_new, v_bottle.quantity_unit,
    v_old_purpose, v_new_purpose, v_old_experiment, v_new_experiment, v_old_notes, v_new_notes, btrim(p_reason))
  returning id into v_id;

  insert into public.activity_log (actor_user_id, target_user_id, action_type, entity_type, entity_id, chemical_id, bottle_id, transaction_id, metadata)
  values (auth.uid(), v_txn.user_id, 'USAGE_CORRECTED', 'transaction_correction', v_id, v_bottle.chemical_id, v_bottle.id, v_txn.id,
    jsonb_build_object('old_quantity', v_old, 'new_quantity', v_new, 'unit', v_bottle.quantity_unit, 'reason', btrim(p_reason), 'adjustment_transaction_id', v_adj));

  return jsonb_build_object('correction_id', v_id, 'old_quantity', v_old, 'new_quantity', v_new, 'unit', v_bottle.quantity_unit, 'remaining', coalesce(v_remaining, v_bottle.current_quantity));
end; $$;
revoke all on function public.correct_usage(uuid, numeric, text, text, text, text, text) from public, anon;
grant execute on function public.correct_usage(uuid, numeric, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- stock counts (Admin)
-- Enters the counted remaining amount: the first verified amount of a "Needs review" bottle (STOCK_IN),
-- or a stock-count adjustment of a known bottle (ADJUSTMENT, reason required). Difference goes to untracked.
create or replace function public.set_verified_quantity(p_bottle_id uuid, p_quantity numeric, p_quantity_unit text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_bottle public.bottles; v_unit text := public.labventory_unit(p_quantity_unit); v_qty numeric; v_status public.bottle_status; v_txn uuid; v_type public.transaction_type;
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity < 0 then raise exception 'INVALID_QUANTITY'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED: say how the amount was checked'; end if;
  select * into v_bottle from public.bottles where id = p_bottle_id and not is_archived for update;
  if not found then raise exception 'BOTTLE_NOT_FOUND'; end if;
  if v_unit is null or public.labventory_dimension(v_unit) is distinct from public.labventory_dimension(v_bottle.quantity_unit) then raise exception 'UNIT_MISMATCH: this bottle is measured in %', v_bottle.quantity_unit; end if;
  v_qty := trim_scale(round(p_quantity * public.labventory_factor(v_unit) / public.labventory_factor(v_bottle.quantity_unit), 6));
  if v_bottle.initial_quantity is not null and v_qty > v_bottle.initial_quantity then raise exception 'QUANTITY_EXCEEDS_INITIAL: % % is more than the initial % %', v_qty, v_bottle.quantity_unit, v_bottle.initial_quantity, v_bottle.quantity_unit; end if;
  if v_qty = v_bottle.current_quantity then raise exception 'NOTHING_TO_CORRECT: the counted amount equals the recorded amount'; end if;
  v_type := case when v_bottle.current_quantity is null then 'STOCK_IN' else 'ADJUSTMENT' end;
  v_status := public.labventory_status_for(v_bottle, v_qty);
  insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after, quantity_unit, reason, notes)
  values (v_bottle.id, v_bottle.chemical_id, auth.uid(), v_type, coalesce(v_bottle.current_quantity, 0), v_qty - coalesce(v_bottle.current_quantity, 0), v_qty, v_bottle.quantity_unit,
          case when v_type = 'STOCK_IN' then 'Verified opening quantity' else 'Stock count' end, btrim(p_reason))
  returning id into v_txn;
  update public.bottles set current_quantity = v_qty, status = v_status,
         untracked_quantity = case when v_bottle.current_quantity is null then coalesce(v_bottle.initial_quantity - v_qty - v_bottle.total_used, 0) else untracked_quantity + (v_bottle.current_quantity - v_qty) end,
         updated_at = now(), updated_by = auth.uid()
   where id = v_bottle.id;
  insert into public.activity_log (actor_user_id, action_type, entity_type, chemical_id, bottle_id, transaction_id, metadata)
  values (auth.uid(), 'STOCK_COUNTED', v_bottle.inventory_category, v_bottle.chemical_id, v_bottle.id, v_txn,
          jsonb_build_object('before', v_bottle.current_quantity, 'after', v_qty, 'unit', v_bottle.quantity_unit, 'reason', btrim(p_reason)));
  return jsonb_build_object('transaction_id', v_txn, 'before', v_bottle.current_quantity, 'remaining', v_qty, 'status', v_status);
end; $$;
revoke all on function public.set_verified_quantity(uuid, numeric, text, text) from public, anon;
grant execute on function public.set_verified_quantity(uuid, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------- add / edit (Admin)
create or replace function public.create_inventory_item(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_chem uuid; v_id uuid;
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  v_chem := public.labventory_chemical(nullif(p->>'chemical_id', '')::uuid, p->>'chemical_name', p->>'cas_number', p->>'molecular_formula', auth.uid());
  v_id := public.labventory_add_bottle(p, v_chem, auth.uid(), 'Added by Admin');
  insert into public.activity_log (actor_user_id, action_type, entity_type, chemical_id, bottle_id, metadata)
  values (auth.uid(), 'INVENTORY_ADDED', coalesce(p->>'category', 'CHEMICAL'), v_chem, v_id, jsonb_build_object('bottle_id', p->>'bottle_id'));
  return jsonb_build_object('id', v_id, 'chemical_id', v_chem);
end; $$;
revoke all on function public.create_inventory_item(jsonb) from public, anon;
grant execute on function public.create_inventory_item(jsonb) to authenticated;

-- Corrects descriptive details. Keys present in p_changes are applied; quantities are never edited here.
-- Chemical-level keys (chemical_name, cas_number, molecular_formula) change the chemical for all its bottles.
create or replace function public.update_inventory_item(p_bottle_id uuid, p_changes jsonb, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old public.bottles; v_new public.bottles; v_chem public.chemicals; v_key text; v_before jsonb := '{}'; v_after jsonb := '{}';
  v_allowed text[] := array['bottle_id','manufacturer','place','tray','bottle_size','bottle_size_unit','initial_quantity','low_stock_threshold','low_stock_threshold_unit',
                            'notes','expiry_date','status','chemical_name','cas_number','molecular_formula','category','batch_lot_number'];
  v_code text; v_unit text; v_num numeric; v_loc uuid; v_place text; v_tray text;
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY: only the Admin can edit inventory records' using errcode = '42501'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'CHANGES_MUST_BE_AN_OBJECT'; end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if not v_key = any(v_allowed) then raise exception 'FIELD_NOT_EDITABLE: %', v_key; end if;
  end loop;
  select * into v_old from public.bottles where id = p_bottle_id and not is_archived for update;
  if not found then raise exception 'BOTTLE_NOT_FOUND'; end if;
  select * into v_chem from public.chemicals where id = v_old.chemical_id for update;
  v_new := v_old;

  if p_changes ? 'bottle_id' then
    v_code := public.labventory_text(p_changes, 'bottle_id', 60);
    if v_code is null then raise exception 'BOTTLE_ID_REQUIRED'; end if;
    if exists (select 1 from public.bottles where lower(bottle_id) = lower(v_code) and id <> v_old.id) then raise exception 'DUPLICATE_BOTTLE_ID: % is already used', v_code; end if;
    v_new.bottle_id := v_code;
  end if;
  if p_changes ? 'manufacturer' then v_new.manufacturer := public.labventory_text(p_changes, 'manufacturer', 120); end if;
  if p_changes ? 'notes' then v_new.notes := public.labventory_text(p_changes, 'notes', 1000); end if;
  if p_changes ? 'batch_lot_number' then v_new.batch_lot_number := public.labventory_text(p_changes, 'batch_lot_number', 80); end if;
  if p_changes ? 'expiry_date' then v_new.expiry_date := nullif(p_changes->>'expiry_date', '')::date; end if;
  if p_changes ? 'category' then
    if p_changes->>'category' not in ('CHEMICAL', 'COMMERCIAL_SOLVENT', 'NMR_SOLVENT') then raise exception 'INVALID_CATEGORY'; end if;
    v_new.inventory_category := p_changes->>'category';
  end if;
  if p_changes ? 'place' or p_changes ? 'tray' then
    select room, tray into v_place, v_tray from public.locations where id = v_old.location_id;
    if p_changes ? 'place' then v_place := public.labventory_text(p_changes, 'place', 120); end if;
    if p_changes ? 'tray' then v_tray := public.labventory_text(p_changes, 'tray', 60); end if;
    v_new.location_id := public.labventory_location(v_place, v_tray);
  end if;
  if p_changes ? 'bottle_size' or p_changes ? 'bottle_size_unit' then
    v_num := case when p_changes ? 'bottle_size' then public.labventory_number(p_changes, 'bottle_size') else v_old.bottle_size end;
    v_unit := case when p_changes ? 'bottle_size_unit' then public.labventory_unit(p_changes->>'bottle_size_unit') else v_old.bottle_size_unit end;
    if v_num is not null and public.labventory_dimension(v_unit) is distinct from public.labventory_dimension(v_old.quantity_unit) then raise exception 'UNIT_MISMATCH: bottle size must be in the same kind of unit as %', v_old.quantity_unit; end if;
    v_new.bottle_size := v_num; v_new.bottle_size_unit := case when v_num is null then null else v_unit end;
  end if;
  if p_changes ? 'initial_quantity' then
    v_num := public.labventory_number(p_changes, 'initial_quantity');
    if v_num is not null and v_old.current_quantity is not null and v_num < v_old.current_quantity then raise exception 'INITIAL_BELOW_REMAINING: the initial quantity cannot be less than the % % remaining', v_old.current_quantity, v_old.quantity_unit; end if;
    v_new.initial_quantity := v_num;
    if v_num is not null and v_old.current_quantity is not null then
      v_new.untracked_quantity := greatest(v_num - v_old.current_quantity - v_old.total_used, 0);
    end if;
  end if;
  if p_changes ? 'low_stock_threshold' or p_changes ? 'low_stock_threshold_unit' then
    v_num := case when p_changes ? 'low_stock_threshold' then coalesce(public.labventory_number(p_changes, 'low_stock_threshold'), 0) else v_old.low_stock_threshold end;
    v_unit := case when p_changes ? 'low_stock_threshold_unit' then public.labventory_unit(p_changes->>'low_stock_threshold_unit') else coalesce(v_old.low_stock_threshold_unit, v_old.quantity_unit) end;
    if v_num > 0 and public.labventory_dimension(v_unit) is distinct from public.labventory_dimension(v_old.quantity_unit) then raise exception 'UNIT_MISMATCH: the threshold must be in the same kind of unit as %', v_old.quantity_unit; end if;
    v_new.low_stock_threshold := v_num; v_new.low_stock_threshold_unit := case when v_num > 0 then v_unit end;
  end if;
  if p_changes ? 'status' then
    if p_changes->>'status' not in ('Available', 'Quarantined', 'Disposed', 'Expired') then raise exception 'STATUS_NOT_SETTABLE: Low Stock and Depleted are calculated'; end if;
    v_new.status := (p_changes->>'status')::public.bottle_status;
    if v_new.status = 'Available' then v_new.status := public.labventory_status_for(v_new, v_new.current_quantity); end if;
  elsif v_new.status in ('Available', 'Low Stock', 'Depleted') then
    v_new.status := public.labventory_status_for(v_new, v_new.current_quantity);
  end if;

  if p_changes ? 'chemical_name' or p_changes ? 'cas_number' or p_changes ? 'molecular_formula' then
    if p_changes ? 'chemical_name' and public.labventory_text(p_changes, 'chemical_name', 200) is null then raise exception 'CHEMICAL_NAME_REQUIRED'; end if;
    if public.labventory_text(p_changes, 'cas_number', 20) is not null and not public.labventory_cas_valid(p_changes->>'cas_number') then raise exception 'INVALID_CAS_NUMBER: %', p_changes->>'cas_number'; end if;
    v_before := v_before || jsonb_build_object('chemical_name', v_chem.name, 'cas_number', v_chem.cas_number, 'molecular_formula', v_chem.molecular_formula);
    update public.chemicals set
      name = case when p_changes ? 'chemical_name' then public.labventory_text(p_changes, 'chemical_name', 200) else name end,
      cas_number = case when p_changes ? 'cas_number' then public.labventory_text(p_changes, 'cas_number', 20) else cas_number end,
      molecular_formula = case when p_changes ? 'molecular_formula' then public.labventory_text(p_changes, 'molecular_formula', 100) else molecular_formula end,
      updated_at = now(), updated_by = auth.uid()
    where id = v_chem.id returning * into v_chem;
    v_after := v_after || jsonb_build_object('chemical_name', v_chem.name, 'cas_number', v_chem.cas_number, 'molecular_formula', v_chem.molecular_formula);
  end if;

  update public.bottles set bottle_id = v_new.bottle_id, manufacturer = v_new.manufacturer, notes = v_new.notes, batch_lot_number = v_new.batch_lot_number,
         expiry_date = v_new.expiry_date, inventory_category = v_new.inventory_category, location_id = v_new.location_id,
         bottle_size = v_new.bottle_size, bottle_size_unit = v_new.bottle_size_unit, initial_quantity = v_new.initial_quantity, untracked_quantity = v_new.untracked_quantity,
         low_stock_threshold = v_new.low_stock_threshold, low_stock_threshold_unit = v_new.low_stock_threshold_unit, status = v_new.status,
         updated_at = now(), updated_by = auth.uid()
   where id = v_old.id;

  v_before := v_before || jsonb_strip_nulls(jsonb_build_object('bottle_id', v_old.bottle_id, 'manufacturer', v_old.manufacturer, 'location_id', v_old.location_id, 'bottle_size', v_old.bottle_size,
    'bottle_size_unit', v_old.bottle_size_unit, 'initial_quantity', v_old.initial_quantity, 'low_stock_threshold', v_old.low_stock_threshold, 'notes', v_old.notes, 'expiry_date', v_old.expiry_date,
    'status', v_old.status, 'category', v_old.inventory_category));
  v_after := v_after || jsonb_strip_nulls(jsonb_build_object('bottle_id', v_new.bottle_id, 'manufacturer', v_new.manufacturer, 'location_id', v_new.location_id, 'bottle_size', v_new.bottle_size,
    'bottle_size_unit', v_new.bottle_size_unit, 'initial_quantity', v_new.initial_quantity, 'low_stock_threshold', v_new.low_stock_threshold, 'notes', v_new.notes, 'expiry_date', v_new.expiry_date,
    'status', v_new.status, 'category', v_new.inventory_category));
  insert into public.activity_log (actor_user_id, action_type, entity_type, entity_id, chemical_id, bottle_id, metadata)
  values (auth.uid(), 'INVENTORY_EDITED', 'bottle', v_old.id, v_old.chemical_id, v_old.id,
          jsonb_build_object('before', v_before, 'after', v_after, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return jsonb_build_object('id', v_old.id, 'bottle_id', v_new.bottle_id, 'status', v_new.status);
end; $$;
revoke all on function public.update_inventory_item(uuid, jsonb, text) from public, anon;
grant execute on function public.update_inventory_item(uuid, jsonb, text) to authenticated;

-- Researchers may change their own display name; nothing else on their profile.
create or replace function public.update_my_profile(p_full_name text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_full_name, ''))) not between 2 and 120 then raise exception 'INVALID_NAME: 2 to 120 characters'; end if;
  update public.profiles set full_name = btrim(p_full_name), updated_at = now() where id = auth.uid();
end; $$;
revoke all on function public.update_my_profile(text) from public, anon;
grant execute on function public.update_my_profile(text) to authenticated;

-- ---------------------------------------------------------------- names for usage history
-- Researchers can read only their own profile row; usage history and "Last used by" need colleagues'
-- names and emails, so this view exposes just those columns to active users.
create or replace view public.people_directory as
  select id, full_name, email, role, account_status from public.profiles where public.is_active_user();
revoke all on public.people_directory from anon;
grant select on public.people_directory to authenticated;

-- Every usage entry with its current (corrected) values. Original transactions are never changed.
create or replace view public.usage_history with (security_invoker = true) as
  select t.id, t.created_at, t.bottle_id, b.bottle_id as bottle_code, b.inventory_category as category, b.chemical_id, c.name as chemical, c.cas_number as cas,
         b.manufacturer, t.user_id, p.full_name as user_name, p.email as user_email,
         -t.quantity_change as recorded_quantity, coalesce(lc.new_quantity, -t.quantity_change) as quantity, coalesce(t.quantity_unit, b.quantity_unit) as quantity_unit,
         t.quantity_before, t.quantity_after,
         case when lc.id is null then t.experiment else lc.new_experiment end as experiment,
         case when lc.id is null then t.reason else lc.new_purpose end as purpose,
         case when lc.id is null then t.notes else lc.new_notes end as notes,
         (select count(*) from public.transaction_corrections x where x.original_transaction_id = t.id)::integer as correction_count,
         lc.created_at as last_corrected_at
    from public.transactions t
    join public.bottles b on b.id = t.bottle_id
    join public.chemicals c on c.id = b.chemical_id
    left join public.people_directory p on p.id = t.user_id
    left join lateral (select * from public.transaction_corrections x where x.original_transaction_id = t.id order by x.created_at desc, x.id desc limit 1) lc on true
   where t.transaction_type = 'USAGE';
revoke all on public.usage_history from anon;
grant select on public.usage_history to authenticated;

-- ---------------------------------------------------------------- chemicals to be ordered
create table if not exists public.chemical_order_requests (
  id uuid primary key default gen_random_uuid(),
  chemical_id uuid references public.chemicals(id),
  source_bottle_id uuid references public.bottles(id),
  chemical_name text not null check (length(btrim(chemical_name)) between 1 and 200),
  cas_number text check (cas_number is null or public.labventory_cas_valid(cas_number)),
  molecular_formula text,
  category text not null default 'CHEMICAL' check (category in ('CHEMICAL', 'COMMERCIAL_SOLVENT', 'NMR_SOLVENT')),
  requested_quantity numeric not null check (requested_quantity > 0),
  quantity_unit text not null check (public.labventory_dimension(quantity_unit) is not null),
  preferred_pack_size text, preferred_supplier text, reason text, experiment text,
  priority text not null default 'Normal' check (priority in ('Low', 'Normal', 'High', 'Urgent')),
  notes text,
  status text not null default 'Requested' check (status in ('Requested', 'Pending Approval', 'Approved', 'Ordered', 'Partially Received', 'Received', 'Rejected', 'Cancelled')),
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now(),
  supplier text, purchase_order_number text, order_date date, expected_delivery date, unit_price numeric check (unit_price is null or unit_price >= 0),
  admin_notes text, decision_note text,
  quantity_received numeric not null default 0 check (quantity_received >= 0),
  updated_at timestamptz not null default now()
);
create index if not exists order_requests_status_idx on public.chemical_order_requests (status, requested_at desc);
create index if not exists order_requests_requester_idx on public.chemical_order_requests (requested_by, requested_at desc);

create table if not exists public.order_request_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.chemical_order_requests(id),
  from_status text, to_status text not null, changed_by uuid not null references public.profiles(id),
  note text, details jsonb not null default '{}', created_at timestamptz not null default now()
);
create index if not exists order_history_request_idx on public.order_request_history (request_id, created_at);

create table if not exists public.order_receipts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.chemical_order_requests(id),
  bottle_id uuid not null references public.bottles(id),
  quantity numeric not null check (quantity > 0), quantity_unit text not null,
  received_by uuid not null references public.profiles(id), received_at timestamptz not null default now()
);

alter table public.chemical_order_requests enable row level security;
alter table public.order_request_history enable row level security;
alter table public.order_receipts enable row level security;
drop policy if exists "admin or requester reads requests" on public.chemical_order_requests;
create policy "admin or requester reads requests" on public.chemical_order_requests for select to authenticated
  using (public.is_admin() or (requested_by = auth.uid() and public.is_active_user()));
drop policy if exists "admin or requester reads request history" on public.order_request_history;
create policy "admin or requester reads request history" on public.order_request_history for select to authenticated
  using (public.is_admin() or exists (select 1 from public.chemical_order_requests r where r.id = request_id and r.requested_by = auth.uid() and public.is_active_user()));
drop policy if exists "admin or requester reads receipts" on public.order_receipts;
create policy "admin or requester reads receipts" on public.order_receipts for select to authenticated
  using (public.is_admin() or exists (select 1 from public.chemical_order_requests r where r.id = request_id and r.requested_by = auth.uid() and public.is_active_user()));
revoke insert, update, delete, truncate on public.chemical_order_requests, public.order_request_history, public.order_receipts from anon, authenticated;
grant select on public.chemical_order_requests, public.order_request_history, public.order_receipts to authenticated;

create or replace function public.order_is_open(p_status text) returns boolean language sql immutable as $$
  select p_status in ('Requested', 'Pending Approval', 'Approved', 'Ordered', 'Partially Received') $$;

-- Any active user. Warns (DUPLICATE_OPEN_REQUEST) when an open request for the same chemical exists,
-- unless p_allow_duplicate is true.
create or replace function public.submit_order_request(p jsonb, p_allow_duplicate boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text := public.labventory_text(p, 'chemical_name', 200); v_cas text := public.labventory_text(p, 'cas_number', 20);
  v_unit text := public.labventory_unit(p->>'quantity_unit'); v_qty numeric := public.labventory_number(p, 'requested_quantity');
  v_chem uuid := nullif(p->>'chemical_id', '')::uuid; v_dup public.chemical_order_requests; v_id uuid;
begin
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  if v_name is null then raise exception 'CHEMICAL_NAME_REQUIRED'; end if;
  if v_cas is not null and not public.labventory_cas_valid(v_cas) then raise exception 'INVALID_CAS_NUMBER: %', v_cas; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'QUANTITY_MUST_BE_POSITIVE'; end if;
  if v_unit is null then raise exception 'UNIT_NOT_SUPPORTED: use µg, mg, g, kg, µL, mL or L'; end if;
  if v_chem is not null and not exists (select 1 from public.chemicals where id = v_chem and not is_archived) then raise exception 'CHEMICAL_NOT_FOUND'; end if;
  if coalesce(p->>'priority', 'Normal') not in ('Low', 'Normal', 'High', 'Urgent') then raise exception 'INVALID_PRIORITY'; end if;

  perform pg_advisory_xact_lock(hashtext('labventory.order_requests'));
  select * into v_dup from public.chemical_order_requests r
   where public.order_is_open(r.status)
     and ((v_chem is not null and r.chemical_id = v_chem) or (v_cas is not null and r.cas_number = v_cas)
          or (public.labventory_norm(r.chemical_name) = public.labventory_norm(v_name)))
   order by r.requested_at desc limit 1;
  if found and not coalesce(p_allow_duplicate, false) then
    raise exception 'DUPLICATE_OPEN_REQUEST: % is already on the order list (status %, requested %). Submit again to add it anyway.',
      v_dup.chemical_name, v_dup.status, to_char(v_dup.requested_at at time zone 'Asia/Kolkata', 'DD Mon YYYY');
  end if;

  insert into public.chemical_order_requests (chemical_id, source_bottle_id, chemical_name, cas_number, molecular_formula, category, requested_quantity, quantity_unit,
    preferred_pack_size, preferred_supplier, reason, experiment, priority, notes, requested_by)
  values (v_chem, nullif(p->>'source_bottle_id', '')::uuid, v_name, v_cas, public.labventory_text(p, 'molecular_formula', 100), coalesce(nullif(p->>'category', ''), 'CHEMICAL'),
    v_qty, v_unit, public.labventory_text(p, 'preferred_pack_size', 60), public.labventory_text(p, 'preferred_supplier', 120), public.labventory_text(p, 'reason', 500),
    public.labventory_text(p, 'experiment', 200), coalesce(nullif(p->>'priority', ''), 'Normal'), public.labventory_text(p, 'notes', 1000), auth.uid())
  returning id into v_id;
  insert into public.order_request_history (request_id, from_status, to_status, changed_by, note, details)
  values (v_id, null, 'Requested', auth.uid(), null, jsonb_build_object('duplicate_of', v_dup.id));
  insert into public.activity_log (actor_user_id, action_type, entity_type, entity_id, chemical_id, metadata)
  values (auth.uid(), 'ORDER_REQUESTED', 'order_request', v_id, v_chem, jsonb_build_object('chemical', v_name, 'quantity', v_qty, 'unit', v_unit));
  return jsonb_build_object('id', v_id, 'duplicate_of', v_dup.id);
end; $$;
revoke all on function public.submit_order_request(jsonb, boolean) from public, anon;
grant execute on function public.submit_order_request(jsonb, boolean) to authenticated;

-- Status changes and detail edits. Admin: workflow + order details. Requester: cancel or edit
-- their own request while it is still Requested / Pending Approval.
create or replace function public.update_order_request(p_id uuid, p_status text default null, p_changes jsonb default '{}', p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req public.chemical_order_requests; v_admin boolean := public.is_admin(); v_key text; v_to text; v_from text;
  v_admin_keys text[] := array['supplier','purchase_order_number','order_date','expected_delivery','unit_price','admin_notes',
                               'chemical_name','cas_number','molecular_formula','requested_quantity','quantity_unit','preferred_pack_size','preferred_supplier','reason','experiment','priority','notes'];
  v_owner_keys text[] := array['chemical_name','cas_number','molecular_formula','requested_quantity','quantity_unit','preferred_pack_size','preferred_supplier','reason','experiment','priority','notes'];
begin
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  select * into v_req from public.chemical_order_requests where id = p_id for update;
  if not found or (not v_admin and v_req.requested_by <> auth.uid()) then raise exception 'REQUEST_NOT_FOUND'; end if;
  p_changes := coalesce(p_changes, '{}');
  for v_key in select jsonb_object_keys(p_changes) loop
    if not v_key = any(case when v_admin then v_admin_keys else v_owner_keys end) then raise exception 'FIELD_NOT_EDITABLE: %', v_key using errcode = '42501'; end if;
  end loop;
  if not v_admin and p_changes <> '{}' and v_req.status not in ('Requested', 'Pending Approval') then raise exception 'REQUEST_LOCKED: it has already been %', lower(v_req.status) using errcode = '42501'; end if;
  if not public.order_is_open(v_req.status) and (p_changes <> '{}' or p_status is not null) then raise exception 'REQUEST_CLOSED: this request is %', v_req.status; end if;

  v_from := v_req.status;
  v_to := nullif(btrim(coalesce(p_status, '')), '');
  if v_to is not null and v_to <> v_req.status then
    if v_admin then
      if not (
        (v_req.status in ('Requested') and v_to in ('Pending Approval', 'Approved', 'Rejected', 'Cancelled')) or
        (v_req.status = 'Pending Approval' and v_to in ('Approved', 'Rejected', 'Cancelled')) or
        (v_req.status = 'Approved' and v_to in ('Ordered', 'Cancelled')) or
        (v_req.status = 'Ordered' and v_to in ('Cancelled')) or
        (v_req.status = 'Partially Received' and v_to in ('Received', 'Cancelled'))
      ) then raise exception 'INVALID_STATUS_CHANGE: % cannot become % (receiving stock sets Partially Received / Received)', v_req.status, v_to; end if;
    else
      if not (v_to = 'Cancelled' and v_req.status in ('Requested', 'Pending Approval')) then raise exception 'ADMIN_ONLY: only the Admin can %', lower(v_to) using errcode = '42501'; end if;
    end if;
    if v_to = 'Rejected' and length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'REASON_REQUIRED: give a reason for rejecting'; end if;
  else v_to := null; end if;

  if p_changes ? 'cas_number' and public.labventory_text(p_changes, 'cas_number', 20) is not null and not public.labventory_cas_valid(p_changes->>'cas_number') then raise exception 'INVALID_CAS_NUMBER: %', p_changes->>'cas_number'; end if;
  if p_changes ? 'requested_quantity' and coalesce(public.labventory_number(p_changes, 'requested_quantity'), 0) <= 0 then raise exception 'QUANTITY_MUST_BE_POSITIVE'; end if;
  if p_changes ? 'quantity_unit' and public.labventory_unit(p_changes->>'quantity_unit') is null then raise exception 'UNIT_NOT_SUPPORTED'; end if;
  if p_changes ? 'priority' and p_changes->>'priority' not in ('Low', 'Normal', 'High', 'Urgent') then raise exception 'INVALID_PRIORITY'; end if;
  if p_changes ? 'chemical_name' and public.labventory_text(p_changes, 'chemical_name', 200) is null then raise exception 'CHEMICAL_NAME_REQUIRED'; end if;

  update public.chemical_order_requests set
    chemical_name = case when p_changes ? 'chemical_name' then public.labventory_text(p_changes, 'chemical_name', 200) else chemical_name end,
    cas_number = case when p_changes ? 'cas_number' then public.labventory_text(p_changes, 'cas_number', 20) else cas_number end,
    molecular_formula = case when p_changes ? 'molecular_formula' then public.labventory_text(p_changes, 'molecular_formula', 100) else molecular_formula end,
    requested_quantity = case when p_changes ? 'requested_quantity' then public.labventory_number(p_changes, 'requested_quantity') else requested_quantity end,
    quantity_unit = case when p_changes ? 'quantity_unit' then public.labventory_unit(p_changes->>'quantity_unit') else quantity_unit end,
    preferred_pack_size = case when p_changes ? 'preferred_pack_size' then public.labventory_text(p_changes, 'preferred_pack_size', 60) else preferred_pack_size end,
    preferred_supplier = case when p_changes ? 'preferred_supplier' then public.labventory_text(p_changes, 'preferred_supplier', 120) else preferred_supplier end,
    reason = case when p_changes ? 'reason' then public.labventory_text(p_changes, 'reason', 500) else reason end,
    experiment = case when p_changes ? 'experiment' then public.labventory_text(p_changes, 'experiment', 200) else experiment end,
    priority = case when p_changes ? 'priority' then p_changes->>'priority' else priority end,
    notes = case when p_changes ? 'notes' then public.labventory_text(p_changes, 'notes', 1000) else notes end,
    supplier = case when p_changes ? 'supplier' then public.labventory_text(p_changes, 'supplier', 120) else supplier end,
    purchase_order_number = case when p_changes ? 'purchase_order_number' then public.labventory_text(p_changes, 'purchase_order_number', 80) else purchase_order_number end,
    order_date = case when p_changes ? 'order_date' then nullif(p_changes->>'order_date', '')::date when v_to = 'Ordered' and order_date is null then current_date else order_date end,
    expected_delivery = case when p_changes ? 'expected_delivery' then nullif(p_changes->>'expected_delivery', '')::date else expected_delivery end,
    unit_price = case when p_changes ? 'unit_price' then public.labventory_number(p_changes, 'unit_price') else unit_price end,
    admin_notes = case when p_changes ? 'admin_notes' then public.labventory_text(p_changes, 'admin_notes', 1000) else admin_notes end,
    status = coalesce(v_to, status),
    decision_note = case when v_to is not null and nullif(btrim(coalesce(p_note, '')), '') is not null then btrim(p_note) else decision_note end,
    updated_at = now()
  where id = p_id returning * into v_req;

  insert into public.order_request_history (request_id, from_status, to_status, changed_by, note, details)
  values (p_id, v_from, v_req.status, auth.uid(), nullif(btrim(coalesce(p_note, '')), ''), case when p_changes = '{}' then '{}'::jsonb else jsonb_build_object('changes', p_changes) end);
  insert into public.activity_log (actor_user_id, target_user_id, action_type, entity_type, entity_id, chemical_id, metadata)
  values (auth.uid(), v_req.requested_by, case when v_to is null then 'ORDER_EDITED' else 'ORDER_' || upper(replace(v_to, ' ', '_')) end, 'order_request', p_id, v_req.chemical_id,
          jsonb_build_object('chemical', v_req.chemical_name, 'status', v_req.status, 'note', nullif(btrim(coalesce(p_note, '')), '')));
  return to_jsonb(v_req);
end; $$;
revoke all on function public.update_order_request(uuid, text, jsonb, text) from public, anon;
grant execute on function public.update_order_request(uuid, text, jsonb, text) to authenticated;

-- Admin receives (part of) an order: creates the physical bottle + STOCK_IN, links it to the request,
-- and moves the request to Partially Received / Received. p_complete null = decide from quantities.
create or replace function public.receive_order(p_request_id uuid, p_item jsonb, p_complete boolean default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req public.chemical_order_requests; v_chem uuid; v_bottle uuid; v_qty numeric := public.labventory_number(p_item, 'quantity');
  v_unit text := public.labventory_unit(p_item->>'unit'); v_received numeric; v_to text; v_from text; v_item jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select * into v_req from public.chemical_order_requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if v_req.status not in ('Ordered', 'Partially Received', 'Approved') then raise exception 'NOT_ORDERED_YET: a request must be approved or ordered before stock is received (it is %)', v_req.status; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'QUANTITY_MUST_BE_POSITIVE: enter the quantity received'; end if;
  if v_unit is null then raise exception 'UNIT_NOT_SUPPORTED: use µg, mg, g, kg, µL, mL or L'; end if;

  v_chem := public.labventory_chemical(coalesce(nullif(p_item->>'chemical_id', '')::uuid, v_req.chemical_id),
                                       coalesce(p_item->>'chemical_name', v_req.chemical_name), coalesce(p_item->>'cas_number', v_req.cas_number),
                                       coalesce(p_item->>'molecular_formula', v_req.molecular_formula), auth.uid());
  v_item := p_item || jsonb_build_object('category', coalesce(nullif(p_item->>'category', ''), v_req.category),
                                         'supplier', coalesce(nullif(p_item->>'supplier', ''), v_req.supplier));
  v_bottle := public.labventory_add_bottle(v_item, v_chem, auth.uid(), 'Order received', v_req.id::text);
  insert into public.order_receipts (request_id, bottle_id, quantity, quantity_unit, received_by) values (v_req.id, v_bottle, v_qty, v_unit, auth.uid());

  v_received := v_req.quantity_received + case when public.labventory_dimension(v_unit) = public.labventory_dimension(v_req.quantity_unit)
    then v_qty * public.labventory_factor(v_unit) / public.labventory_factor(v_req.quantity_unit) else 0 end;
  v_to := case when p_complete is true then 'Received' when p_complete is false then 'Partially Received'
               when v_received >= v_req.requested_quantity then 'Received' else 'Partially Received' end;
  v_from := v_req.status;
  update public.chemical_order_requests set quantity_received = trim_scale(round(v_received, 6)), status = v_to, chemical_id = coalesce(chemical_id, v_chem), updated_at = now() where id = v_req.id;
  insert into public.order_request_history (request_id, from_status, to_status, changed_by, note, details)
  values (v_req.id, v_from, v_to, auth.uid(), nullif(btrim(coalesce(p_item->>'note', '')), ''), jsonb_build_object('bottle_id', v_bottle, 'bottle_code', p_item->>'bottle_id', 'quantity', v_qty, 'unit', v_unit));
  insert into public.activity_log (actor_user_id, target_user_id, action_type, entity_type, entity_id, chemical_id, bottle_id, metadata)
  values (auth.uid(), v_req.requested_by, 'ORDER_RECEIVED', 'order_request', v_req.id, v_chem, v_bottle, jsonb_build_object('quantity', v_qty, 'unit', v_unit, 'status', v_to));
  return jsonb_build_object('bottle_id', v_bottle, 'chemical_id', v_chem, 'status', v_to, 'quantity_received', v_received);
end; $$;
revoke all on function public.receive_order(uuid, jsonb, boolean) from public, anon;
grant execute on function public.receive_order(uuid, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------- solvent import
alter table public.inventory_import_batches add column if not exists kind text not null default 'CHEMICAL';

-- One row per physical can/bottle: {row, part, category, name, bottle_id, generated_id, pack_size, pack_unit,
-- quantity, quantity_unit, make, place, legacy_last_used_by, raw}. Dry run validates only. A real run imports
-- all valid rows atomically or nothing; bottles whose ID already exists with the same solvent are skipped,
-- so importing the same sheet twice adds nothing.
create or replace function public.import_solvent_batch(p_idempotency_key uuid, p_file_name text, p_file_sha256 text, p_rows jsonb, p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch uuid := gen_random_uuid(); v_existing public.inventory_import_batches; v_row jsonb; v_results jsonb := '[]'; v_seen text[] := '{}';
  v_errors text[]; v_warnings text[]; v_status text; v_code text; v_name text; v_category text; v_size numeric; v_size_unit text; v_qty numeric; v_qty_unit text;
  v_match public.bottles; v_chem uuid; v_new integer := 0; v_skipped integer := 0; v_bad integer := 0; v_review integer := 0; v_item jsonb;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if not public.is_designated_admin() then raise exception 'ONLY_DESIGNATED_ADMIN_CAN_IMPORT' using errcode = '42501'; end if;
  if p_idempotency_key is null or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_FILE_HASH'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'FILE_HAS_NO_ROWS'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'TOO_MANY_ROWS'; end if;
  perform pg_advisory_xact_lock(hashtext('labventory.inventory_import'));
  select * into v_existing from public.inventory_import_batches where idempotency_key = p_idempotency_key or file_sha256 = p_file_sha256 limit 1;
  if found then
    return jsonb_build_object('already_imported', true, 'batch_id', v_existing.id, 'imported_at', v_existing.created_at, 'summary', v_existing.summary);
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_errors := '{}'; v_warnings := '{}'; v_match := null;
    v_name := nullif(btrim(coalesce(v_row->>'name', '')), ''); v_code := nullif(btrim(coalesce(v_row->>'bottle_id', '')), '');
    v_category := v_row->>'category';
    v_size := case when coalesce(v_row->>'pack_size', '') ~ '^\d+(\.\d+)?$' then (v_row->>'pack_size')::numeric end;
    v_size_unit := public.labventory_unit(v_row->>'pack_unit');
    v_qty := case when coalesce(v_row->>'quantity', '') ~ '^\d+(\.\d+)?$' then (v_row->>'quantity')::numeric end;
    v_qty_unit := public.labventory_unit(v_row->>'quantity_unit');
    if v_category not in ('COMMERCIAL_SOLVENT', 'NMR_SOLVENT') then v_errors := v_errors || 'Unknown section'::text; end if;
    if v_name is null then v_errors := v_errors || 'Solvent name is missing'::text; end if;
    if v_code is null then v_errors := v_errors || 'Bottle ID is missing'::text; end if;
    if v_size is null or v_size_unit is null then v_errors := v_errors || format('Pack size "%s" has no recognisable amount and unit', coalesce(v_row->'raw'->>'pack_size', ''))::text; end if;
    if v_code is not null and lower(v_code) = any(v_seen) then v_errors := v_errors || format('Bottle ID %s appears twice in this file', v_code)::text; end if;
    if v_code is not null then v_seen := v_seen || lower(v_code); end if;
    if coalesce((v_row->>'generated_id')::boolean, false) then v_warnings := v_warnings || format('No Bottle ID in the sheet; %s was assigned', v_code)::text; end if;
    if nullif(btrim(coalesce(v_row->>'place', '')), '') is null then v_warnings := v_warnings || 'Location is missing'::text; end if;
    if v_qty is not null and v_qty_unit is null then v_warnings := v_warnings || 'Available quantity has no unit; marked Needs review'::text; v_qty := null; end if;
    if v_qty is not null and v_size is not null and public.labventory_dimension(v_qty_unit) is distinct from public.labventory_dimension(v_size_unit) then
      v_warnings := v_warnings || 'Available quantity and pack size use different kinds of unit; marked Needs review'::text; v_qty := null;
    end if;
    if v_qty is not null and v_size is not null and v_qty * public.labventory_factor(v_qty_unit) > v_size * public.labventory_factor(v_size_unit) then
      v_warnings := v_warnings || format('Available %s %s is more than the %s %s pack size; marked Needs review', v_qty, v_qty_unit, v_size, v_size_unit)::text; v_qty := null;
    end if;
    if v_qty is null then v_warnings := v_warnings || 'Remaining quantity unknown; the Admin must enter it before usage can be recorded'::text; end if;
    if nullif(btrim(coalesce(v_row->>'legacy_last_used_by', '')), '') is not null then v_warnings := v_warnings || 'Last used by kept as legacy information (no date or usage record)'::text; end if;
    if coalesce(v_row->>'flag', '') <> '' then v_warnings := v_warnings || (v_row->>'flag'); end if;

    if v_code is not null then select * into v_match from public.bottles where lower(bottle_id) = lower(v_code); end if;
    if v_match.id is not null then
      if v_match.inventory_category = v_category and exists (select 1 from public.chemicals c where c.id = v_match.chemical_id and public.labventory_norm(c.name) = public.labventory_norm(v_name)) then
        v_status := 'existing';
      else
        v_errors := v_errors || format('Bottle ID %s is already used by another bottle', v_code)::text;
      end if;
    end if;
    if cardinality(v_errors) > 0 then v_status := 'error'; v_bad := v_bad + 1;
    elsif v_status = 'existing' then v_skipped := v_skipped + 1;
    else
      v_status := case when p_dry_run then 'valid' else 'imported' end; v_new := v_new + 1;
      if v_qty is null then v_review := v_review + 1; end if;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object('row', v_row->'row', 'part', v_row->'part', 'bottle_id', v_code, 'name', v_name, 'category', v_category,
      'status', v_status, 'quantity', v_qty, 'unit', coalesce(v_qty_unit, v_size_unit), 'errors', to_jsonb(v_errors), 'warnings', to_jsonb(v_warnings)));
    v_status := null;
  end loop;

  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'new', v_new, 'existing', v_skipped, 'errors', v_bad, 'needs_review', v_review, 'rows', v_results);
  end if;
  if v_bad > 0 then raise exception 'IMPORT_HAS_ERRORS: % row(s) must be fixed before importing; nothing was saved', v_bad; end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_code := btrim(v_row->>'bottle_id');
    continue when exists (select 1 from public.bottles where lower(bottle_id) = lower(v_code));
    v_size_unit := public.labventory_unit(v_row->>'pack_unit');
    v_qty := (select (x->>'quantity')::numeric from jsonb_array_elements(v_results) x where lower(x->>'bottle_id') = lower(v_code) limit 1);
    v_chem := public.labventory_chemical(null, v_row->>'name', null, null, auth.uid());
    v_item := jsonb_build_object('bottle_id', v_code, 'category', v_row->>'category', 'manufacturer', v_row->>'make', 'place', v_row->>'place',
      'bottle_size', v_row->>'pack_size', 'bottle_size_unit', v_size_unit, 'unit', v_size_unit,
      'quantity', case when v_qty is null then null else trim_scale(round(v_qty * public.labventory_factor(public.labventory_unit(v_row->>'quantity_unit')) / public.labventory_factor(v_size_unit), 6))::text end,
      'legacy_last_used_by', v_row->>'legacy_last_used_by',
      'raw_source', jsonb_build_object('import_batch_id', v_batch, 'file_name', p_file_name, 'row_number', v_row->'row', 'values', coalesce(v_row->'raw', '{}')));
    perform public.labventory_add_bottle(v_item, v_chem, auth.uid(), 'Spreadsheet import (opening balance)', v_batch::text);
  end loop;
  insert into public.inventory_import_batches (id, idempotency_key, file_name, file_sha256, imported_by, total_rows, imported_rows, rejected_rows, summary, kind)
  values (v_batch, p_idempotency_key, p_file_name, p_file_sha256, auth.uid(), jsonb_array_length(p_rows), v_new, 0,
          jsonb_build_object('new', v_new, 'existing', v_skipped, 'needs_review', v_review), 'SOLVENTS');
  insert into public.activity_log (actor_user_id, action_type, entity_type, entity_id, metadata)
  values (auth.uid(), 'INVENTORY_IMPORT', 'solvent_import', v_batch, jsonb_build_object('file_name', p_file_name, 'new', v_new, 'existing', v_skipped, 'needs_review', v_review));
  return jsonb_build_object('dry_run', false, 'batch_id', v_batch, 'new', v_new, 'existing', v_skipped, 'errors', 0, 'needs_review', v_review, 'rows', v_results);
end; $$;
revoke all on function public.import_solvent_batch(uuid, text, text, jsonb, boolean) from public, anon;
grant execute on function public.import_solvent_batch(uuid, text, text, jsonb, boolean) to authenticated;

-- Internal helpers are not callable from the API.
revoke all on function public.labventory_add_bottle(jsonb, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.labventory_chemical(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.labventory_location(text, text) from public, anon, authenticated;
revoke all on function public.labventory_supplier(text) from public, anon, authenticated;
revoke all on function public.guard_bottle_quantities() from public, anon, authenticated;

alter publication supabase_realtime add table public.chemical_order_requests, public.transaction_corrections;

notify pgrst, 'reload schema';
