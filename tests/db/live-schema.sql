-- Schema-only replica of the live public schema, generated from the live catalog by tests/db/catalog.sql.
-- No data. Regenerate before writing a migration: npm run test:schema
set check_function_bodies = off;

create type public.bottle_status as enum ('Available', 'Low Stock', 'Expired', 'Depleted', 'Quarantined', 'Disposed');

create type public.role_name as enum ('ADMIN', 'RESEARCHER');

create type public.transaction_type as enum ('STOCK_IN', 'USAGE', 'RETURN', 'ADJUSTMENT', 'TRANSFER', 'DISPOSAL', 'ARCHIVE', 'RESTORE');

create table public.activity_log (id uuid default gen_random_uuid() not null, actor_user_id uuid not null, action_type text not null, target_user_id uuid, entity_type text, entity_id uuid, chemical_id uuid, bottle_id uuid, transaction_id uuid, metadata jsonb default '{}'::jsonb not null, created_at timestamp with time zone default now() not null);

create table public.bottles (id uuid default gen_random_uuid() not null, bottle_id text not null, chemical_id uuid not null, supplier_id uuid, catalog_number text, batch_lot_number text, manufacturer text, bottle_size numeric, bottle_size_unit text, current_quantity numeric default 0 not null, initial_quantity numeric, quantity_unit text, purity text, grade text, purchase_date date, expiry_date date, low_stock_threshold numeric default 0, low_stock_threshold_unit text, location_id uuid, status bottle_status default 'Available'::bottle_status not null, qr_code text, notes text, raw_source jsonb, created_at timestamp with time zone default now() not null, updated_at timestamp with time zone default now() not null, created_by uuid, updated_by uuid, is_archived boolean default false not null);

create table public.chemicals (id uuid default gen_random_uuid() not null, name text not null, synonyms text[] default '{}'::text[] not null, cas_number text, molecular_formula text, molecular_weight numeric, pubchem_cid text, iupac_name text, canonical_smiles text, is_hazardous boolean default false not null, hazard_summary text, purity text, grade text, physical_state text, storage_temperature text, created_at timestamp with time zone default now() not null, updated_at timestamp with time zone default now() not null, created_by uuid, updated_by uuid, is_archived boolean default false not null);

create table public.documents (id uuid default gen_random_uuid() not null, chemical_id uuid not null, document_type text not null, file_name text not null, storage_path text not null, uploaded_by uuid not null, uploaded_at timestamp with time zone default now() not null, version integer default 1 not null, is_current boolean default true not null, is_archived boolean default false not null);

create table public.flash_bookings (id uuid default gen_random_uuid() not null, booking_group uuid not null, user_id uuid not null, booked_by_name text not null, slot_start timestamp with time zone not null, slot_end timestamp with time zone not null, purpose text, created_at timestamp with time zone default now() not null, cancelled_at timestamp with time zone, cancelled_by uuid);

create table public.flash_holidays (holiday_date date not null, name text not null, source text default 'google'::text not null, updated_at timestamp with time zone default now() not null);

create table public.inventory_import_batches (id uuid not null, idempotency_key uuid not null, file_name text not null, file_sha256 text not null, imported_by uuid not null, total_rows integer not null, imported_rows integer not null, rejected_rows integer not null, summary jsonb not null, created_at timestamp with time zone default now() not null);

create table public.locations (id uuid default gen_random_uuid() not null, parent_id uuid, room text not null, cabinet text, shelf text, tray text, source_value text, created_at timestamp with time zone default now() not null, is_archived boolean default false not null);

create table public.profiles (id uuid not null, full_name text not null, role role_name default 'RESEARCHER'::role_name not null, created_at timestamp with time zone default now() not null, email text, account_status text default 'active'::text not null, invited_at timestamp with time zone, invited_by uuid, updated_at timestamp with time zone default now() not null);

create table public.suppliers (id uuid default gen_random_uuid() not null, vendor_name text not null, normalized_name text not null, catalog_number text, contact_name text, email text, phone text, website text, notes text, created_at timestamp with time zone default now() not null, updated_at timestamp with time zone default now() not null, is_archived boolean default false not null);

create table public.system_settings (key text not null, value jsonb not null, updated_at timestamp with time zone default now() not null);

create table public.transactions (id uuid default gen_random_uuid() not null, bottle_id uuid not null, chemical_id uuid not null, user_id uuid not null, transaction_type transaction_type not null, quantity_before numeric not null, quantity_change numeric not null, quantity_after numeric not null, source_location_id uuid, destination_location_id uuid, reason text, notes text, reference_number text, created_at timestamp with time zone default now() not null);

CREATE OR REPLACE FUNCTION public.activate_invited_user()
 RETURNS profiles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare activated_profile public.profiles;
begin
  update public.profiles
     set account_status = 'active', updated_at = now()
   where id = auth.uid() and account_status = 'invited'
  returning * into activated_profile;
  if activated_profile.id is not null then
    insert into public.activity_log (actor_user_id, target_user_id, action_type, metadata)
    values (auth.uid(), auth.uid(), 'INVITATION_ACCEPTED', jsonb_build_object('email', activated_profile.email));
  end if;
  return activated_profile;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.book_flash_slots(p_date date, p_start_hour integer, p_slots integer, p_purpose text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  cfg jsonb := public.flash_config();
  v_tz text := cfg->>'timezone';
  v_open integer := (cfg->>'open_hour')::integer;
  v_close integer := (cfg->>'close_hour')::integer;
  v_start timestamptz;
  v_group uuid := gen_random_uuid();
  v_name text;
  v_holiday text;
  v_taken record;
  i integer;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  if p_date is null or p_start_hour is null then raise exception 'DATE_AND_TIME_REQUIRED'; end if;
  if p_slots is null or p_slots < 1 or p_slots > (cfg->>'max_slots')::integer then
    raise exception 'INVALID_DURATION: book 1 to % one-hour slots', cfg->>'max_slots';
  end if;
  if p_start_hour < v_open or p_start_hour + p_slots > v_close then
    raise exception 'OUTSIDE_LAB_HOURS: slots can be booked between %:00 and %:00', lpad(v_open::text, 2, '0'), lpad(v_close::text, 2, '0');
  end if;
  if length(coalesce(p_purpose, '')) > 200 then raise exception 'PURPOSE_TOO_LONG: maximum 200 characters'; end if;

  v_start := (p_date + make_time(p_start_hour, 0, 0)) at time zone v_tz;
  if v_start < now() then raise exception 'SLOT_IN_PAST: that time has already passed'; end if;
  if p_date > (now() at time zone v_tz)::date + (cfg->>'max_days_ahead')::integer then
    raise exception 'TOO_FAR_AHEAD: bookings open % days in advance', cfg->>'max_days_ahead';
  end if;

  select name into v_holiday from public.flash_holidays where holiday_date = p_date;
  if found then raise exception 'HOLIDAY: % is a holiday (%); the instrument cannot be booked', to_char(p_date, 'DD Mon YYYY'), v_holiday; end if;

  select to_char(b.slot_start at time zone v_tz, 'HH24:MI') as t, b.booked_by_name as who into v_taken
    from public.flash_bookings b
   where b.cancelled_at is null and b.slot_start >= v_start and b.slot_start < v_start + make_interval(hours => p_slots)
   order by b.slot_start limit 1;
  if found then raise exception 'SLOT_TAKEN: the % slot is already booked by %', v_taken.t, v_taken.who; end if;

  select coalesce(nullif(btrim(full_name), ''), email, 'Researcher') into v_name from public.profiles where id = auth.uid();
  begin
    for i in 0 .. p_slots - 1 loop
      insert into public.flash_bookings (booking_group, user_id, booked_by_name, slot_start, slot_end, purpose)
      values (v_group, auth.uid(), v_name, v_start + make_interval(hours => i), v_start + make_interval(hours => i + 1), nullif(btrim(coalesce(p_purpose, '')), ''));
    end loop;
  exception when unique_violation then
    -- Someone booked one of these hours between our check and insert.
    raise exception 'SLOT_TAKEN: one of these slots was just booked by someone else';
  end;

  insert into public.activity_log (actor_user_id, action_type, entity_type, entity_id, metadata)
  values (auth.uid(), 'FLASH_BOOKED', 'flash_booking', v_group, jsonb_build_object('date', p_date, 'start_hour', p_start_hour, 'slots', p_slots, 'purpose', nullif(btrim(coalesce(p_purpose, '')), '')));

  return jsonb_build_object('booking_group', v_group, 'start', v_start, 'end', v_start + make_interval(hours => p_slots), 'slots', p_slots);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_flash_booking(p_booking_group uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_owner uuid; v_first timestamptz; v_count integer;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  select min(user_id::text)::uuid, min(slot_start), count(*) into v_owner, v_first, v_count
    from public.flash_bookings where booking_group = p_booking_group and cancelled_at is null;
  if v_count = 0 then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_owner <> auth.uid() and not public.is_admin() then raise exception 'NOT_YOUR_BOOKING: only the person who booked or the Admin can cancel' using errcode = '42501'; end if;
  if v_first <= now() and not public.is_admin() then raise exception 'ALREADY_STARTED: a booking cannot be cancelled after it starts'; end if;
  update public.flash_bookings set cancelled_at = now(), cancelled_by = auth.uid() where booking_group = p_booking_group and cancelled_at is null;
  insert into public.activity_log (actor_user_id, action_type, entity_type, entity_id, target_user_id, metadata)
  values (auth.uid(), 'FLASH_CANCELLED', 'flash_booking', p_booking_group, v_owner, jsonb_build_object('start', v_first, 'slots', v_count));
  return jsonb_build_object('cancelled_slots', v_count);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.flash_config()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select jsonb_build_object('timezone', 'Asia/Kolkata', 'open_hour', 9, 'close_hour', 18, 'max_slots', 3, 'max_days_ahead', 60)
$function$
;

CREATE OR REPLACE FUNCTION public.import_inventory_batch(p_idempotency_key uuid, p_file_name text, p_file_sha256 text, p_rows jsonb, p_dry_run boolean DEFAULT true, p_skip_rejected boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_batch_id uuid := gen_random_uuid();
  v_existing public.inventory_import_batches;
  v_item record;
  v_row jsonb;
  v_row_number integer;
  v_errors text[];
  v_warnings text[];
  v_results jsonb := '[]'::jsonb;
  v_seen_bottle_ids text[] := '{}';
  v_status text;
  v_summary jsonb;
  v_total integer;
  v_imported integer := 0;
  v_rejected integer := 0;
  v_chem_matched integer := 0; v_chem_created integer := 0;
  v_sup_matched integer := 0; v_sup_created integer := 0;
  v_loc_matched integer := 0; v_loc_created integer := 0;
  -- per-row values
  v_name text; v_cas text; v_manufacturer text; v_supplier text; v_bottle_code text;
  v_size numeric; v_size_unit text; v_qty numeric; v_qty_unit text; v_initial numeric;
  v_room text; v_cabinet text; v_shelf text; v_tray text;
  v_expiry date; v_purchase date; v_text text;
  v_chem_id uuid; v_chem_action text; v_sup_id uuid; v_sup_action text; v_loc_id uuid; v_loc_action text;
  v_count integer; v_bottle_uuid uuid; v_bottle_status public.bottle_status; v_txn_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if not public.is_designated_admin() then
    raise exception 'ONLY_DESIGNATED_ADMIN_CAN_IMPORT' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if nullif(btrim(coalesce(p_file_name, '')), '') is null or length(p_file_name) > 255 then raise exception 'INVALID_FILE_NAME'; end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_FILE_HASH'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'ROWS_MUST_BE_AN_ARRAY'; end if;
  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then raise exception 'FILE_HAS_NO_ROWS'; end if;
  if v_total > 5000 then raise exception 'TOO_MANY_ROWS: maximum 5000 rows per import, got %', v_total; end if;

  -- Serialise imports so matching/creation cannot race another import.
  perform pg_advisory_xact_lock(hashtext('labventory.inventory_import'));

  select * into v_existing from public.inventory_import_batches where idempotency_key = p_idempotency_key;
  if found then
    -- Replayed submission (double click, retry after timeout): return the original result.
    return v_existing.summary || jsonb_build_object('status', 'already_imported');
  end if;
  select * into v_existing from public.inventory_import_batches where file_sha256 = p_file_sha256;
  if found then
    raise exception 'DUPLICATE_FILE: this exact file was already imported on % (batch %). No records were written.',
      to_char(v_existing.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), v_existing.id;
  end if;

  begin -- savepoint: dry runs and blocked batches roll back to here
    for v_item in select value, ordinality from jsonb_array_elements(p_rows) with ordinality loop
      v_row := v_item.value;
      v_errors := '{}'; v_warnings := '{}';
      v_chem_id := null; v_sup_id := null; v_loc_id := null;
      v_chem_action := null; v_sup_action := null; v_loc_action := null;
      v_row_number := coalesce(case when (v_row->>'row_number') ~ '^\d{1,7}$' then (v_row->>'row_number')::integer end, v_item.ordinality::integer + 1);

      if jsonb_typeof(v_row) <> 'object' then
        v_results := v_results || jsonb_build_array(jsonb_build_object('row', v_row_number, 'status', 'rejected', 'errors', jsonb_build_array('Row is not an object.'), 'warnings', '[]'::jsonb));
        v_rejected := v_rejected + 1;
        continue;
      end if;

      -- Problems found while reading the spreadsheet (e.g. "250 g X 2" with one quantity).
      if jsonb_typeof(v_row->'client_errors') = 'array' then
        v_errors := v_errors || array(select jsonb_array_elements_text(v_row->'client_errors'));
      end if;
      if jsonb_typeof(v_row->'client_warnings') = 'array' then
        v_warnings := v_warnings || array(select jsonb_array_elements_text(v_row->'client_warnings'));
      end if;

      v_name := nullif(regexp_replace(btrim(coalesce(v_row->>'chemical_name', '')), '\s+', ' ', 'g'), '');
      v_cas := nullif(upper(regexp_replace(coalesce(v_row->>'cas_number', ''), '\s', '', 'g')), '');
      v_manufacturer := nullif(btrim(coalesce(v_row->>'manufacturer', '')), '');
      v_supplier := nullif(regexp_replace(btrim(coalesce(v_row->>'supplier', '')), '\s+', ' ', 'g'), '');
      v_bottle_code := nullif(btrim(coalesce(v_row->>'bottle_id', '')), '');
      v_room := nullif(btrim(coalesce(v_row->>'room', '')), '');
      v_cabinet := nullif(btrim(coalesce(v_row->>'cabinet', '')), '');
      v_shelf := nullif(btrim(coalesce(v_row->>'shelf', '')), '');
      v_tray := nullif(btrim(coalesce(v_row->>'tray', '')), '');

      -- A row the sheet reader could not split into bottles is reported on its own,
      -- without follow-on errors from the unsplit values.
      if cardinality(v_errors) > 0 then
        v_rejected := v_rejected + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object('row', v_row_number, 'part', nullif(v_row->>'bottle_part', ''), 'status', 'rejected', 'bottle_id', null, 'chemical', v_name, 'errors', to_jsonb(v_errors), 'warnings', to_jsonb(v_warnings)));
        continue;
      end if;

      -- Required: chemical name
      if v_name is null then v_errors := v_errors || 'Chemical name is required.'::text; end if;
      if length(coalesce(v_name, '')) > 300 then v_errors := v_errors || 'Chemical name is longer than 300 characters.'::text; end if;

      -- CAS
      if v_cas is not null and not public.labventory_cas_valid(v_cas) then
        v_errors := v_errors || format('CAS number "%s" is not a valid CAS registry number.', v_cas);
      end if;

      -- Quantity (required, numeric, >= 0) and unit (required, known)
      v_text := nullif(btrim(coalesce(v_row->>'current_quantity', '')), '');
      v_qty := null;
      if v_text is null then v_errors := v_errors || 'Available quantity is required.'::text;
      elsif v_text !~ '^\d+(\.\d+)?$' then v_errors := v_errors || format('Available quantity "%s" is not a non-negative number.', v_text);
      else v_qty := v_text::numeric; end if;

      v_qty_unit := public.labventory_unit(v_row->>'quantity_unit');
      if nullif(btrim(coalesce(v_row->>'current_quantity', '')), '') is null then null; -- already reported as missing quantity
      elsif nullif(btrim(coalesce(v_row->>'quantity_unit', '')), '') is null then v_errors := v_errors || 'Quantity unit is required.'::text;
      elsif v_qty_unit is null then v_errors := v_errors || format('Quantity unit "%s" is not supported (use µg, mg, g, kg, µL, mL or L).', v_row->>'quantity_unit'); end if;

      -- Bottle size (optional, > 0, needs a unit)
      v_text := nullif(btrim(coalesce(v_row->>'bottle_size', '')), '');
      v_size := null; v_size_unit := null;
      if v_text is not null then
        if v_text !~ '^\d+(\.\d+)?$' or v_text::numeric <= 0 then v_errors := v_errors || format('Bottle size "%s" must be a positive number.', v_text);
        else v_size := v_text::numeric; end if;
        v_size_unit := public.labventory_unit(coalesce(nullif(btrim(coalesce(v_row->>'bottle_size_unit', '')), ''), v_row->>'quantity_unit'));
        if v_size_unit is null then v_errors := v_errors || 'Bottle size unit is missing or not supported.'::text; end if;
      end if;
      -- Compare within the same dimension (200 mg vs a 1 g bottle); values are stored as written.
      if v_size is not null and v_qty is not null and public.labventory_dimension(v_size_unit) = public.labventory_dimension(v_qty_unit)
         and v_qty * public.labventory_factor(v_qty_unit) > v_size * public.labventory_factor(v_size_unit) then
        v_errors := v_errors || format('Available quantity %s %s exceeds bottle size %s %s.', v_qty, v_qty_unit, v_size, v_size_unit);
      end if;
      if v_size_unit is not null and v_qty_unit is not null and public.labventory_dimension(v_size_unit) <> public.labventory_dimension(v_qty_unit) then
        v_warnings := v_warnings || format('Bottle size is in %s but the available quantity is in %s (mass vs volume); stored as written.', v_size_unit, v_qty_unit);
      end if;

      -- Initial quantity (optional)
      v_text := nullif(btrim(coalesce(v_row->>'initial_quantity', '')), '');
      v_initial := null;
      if v_text is not null then
        if v_text !~ '^\d+(\.\d+)?$' then v_errors := v_errors || format('Initial quantity "%s" is not a non-negative number.', v_text);
        else v_initial := v_text::numeric; end if;
        if v_initial is not null and v_qty is not null and v_initial < v_qty then
          v_errors := v_errors || 'Initial quantity is smaller than available quantity.'::text;
        end if;
      elsif v_size is not null and v_size_unit = v_qty_unit then
        v_initial := v_size;
      end if;

      -- Dates (ISO yyyy-mm-dd)
      v_expiry := null; v_purchase := null;
      v_text := nullif(btrim(coalesce(v_row->>'expiry_date', '')), '');
      if v_text is not null then
        if v_text ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(v_text, 'date') then v_expiry := v_text::date;
        else v_errors := v_errors || format('Expiry date "%s" is not a valid date (YYYY-MM-DD).', v_text); end if;
      end if;
      v_text := nullif(btrim(coalesce(v_row->>'purchase_date', '')), '');
      if v_text is not null then
        if v_text ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(v_text, 'date') then v_purchase := v_text::date;
        else v_errors := v_errors || format('Purchase date "%s" is not a valid date (YYYY-MM-DD).', v_text); end if;
      end if;

      -- Bottle ID: never overwrite an existing bottle
      if v_bottle_code is not null then
        if length(v_bottle_code) > 64 or v_bottle_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' then
          v_errors := v_errors || format('Bottle ID "%s" may contain only letters, digits, ".", "_", "/" and "-" (max 64).', v_bottle_code);
        elsif lower(v_bottle_code) = any (v_seen_bottle_ids) then
          v_errors := v_errors || format('Bottle ID "%s" appears more than once in this file.', v_bottle_code);
        elsif exists (select 1 from public.bottles b where lower(b.bottle_id) = lower(v_bottle_code)) then
          v_errors := v_errors || format('Bottle ID "%s" already exists in inventory; existing bottles are never overwritten.', v_bottle_code);
        end if;
        v_seen_bottle_ids := v_seen_bottle_ids || lower(v_bottle_code);
      end if;

      -- Location needs a room when any part is given
      if v_room is null and (v_cabinet is not null or v_shelf is not null or v_tray is not null) then
        v_errors := v_errors || 'Tray/cabinet/shelf was given without a location (room).'::text;
      end if;

      -- Chemical match (unambiguous only)
      if v_name is not null and (v_cas is null or public.labventory_cas_valid(v_cas)) then
        if v_cas is not null then
          select count(*), (array_agg(c.id))[1] into v_count, v_chem_id
            from public.chemicals c
           where not c.is_archived and upper(regexp_replace(coalesce(c.cas_number, ''), '\s', '', 'g')) = v_cas;
          if v_count > 1 then
            v_errors := v_errors || format('CAS %s matches %s existing chemicals; resolve the duplicates before importing.', v_cas, v_count); v_chem_id := null;
          elsif v_count = 1 then
            v_chem_action := 'matched';
            if not exists (select 1 from public.chemicals c where c.id = v_chem_id and public.labventory_norm(c.name) = public.labventory_norm(v_name)) then
              v_warnings := v_warnings || format('Matched existing chemical by CAS %s; the spreadsheet name "%s" differs from the stored name, which is kept.', v_cas, v_name);
            end if;
          else
            v_chem_id := null;
            if exists (select 1 from public.chemicals c where not c.is_archived and public.labventory_norm(c.name) = public.labventory_norm(v_name) and nullif(btrim(coalesce(c.cas_number, '')), '') is null) then
              v_errors := v_errors || format('A chemical named "%s" exists without a CAS number; it cannot be matched unambiguously to CAS %s.', v_name, v_cas);
            else
              v_chem_action := 'created';
              if exists (select 1 from public.chemicals c where not c.is_archived and public.labventory_norm(c.name) = public.labventory_norm(v_name)) then
                v_warnings := v_warnings || format('A chemical named "%s" exists with a different CAS; a separate chemical record will be created for CAS %s.', v_name, v_cas);
              end if;
            end if;
          end if;
        else
          select count(*), (array_agg(c.id))[1] into v_count, v_chem_id
            from public.chemicals c
           where not c.is_archived and public.labventory_norm(c.name) = public.labventory_norm(v_name);
          if v_count > 1 then
            v_errors := v_errors || format('Name "%s" matches %s existing chemicals; add a CAS number to choose one.', v_name, v_count); v_chem_id := null;
          elsif v_count = 1 then v_chem_action := 'matched';
          else v_chem_id := null; v_chem_action := 'created'; end if;
        end if;
      end if;

      -- Supplier match (unambiguous only)
      if v_supplier is not null then
        if length(v_supplier) > 200 then v_errors := v_errors || 'Supplier name is longer than 200 characters.'::text; end if;
        select count(*), (array_agg(s.id))[1] into v_count, v_sup_id
          from public.suppliers s
         where not s.is_archived and (public.labventory_norm(s.normalized_name) = public.labventory_norm(v_supplier) or public.labventory_norm(s.vendor_name) = public.labventory_norm(v_supplier));
        if v_count > 1 then
          v_errors := v_errors || format('Supplier "%s" matches %s existing suppliers; resolve the duplicates before importing.', v_supplier, v_count); v_sup_id := null;
        elsif v_count = 1 then v_sup_action := 'matched';
        else v_sup_id := null; v_sup_action := 'created'; end if;
      end if;

      -- Location match (all parts equal, case/space-insensitive)
      if v_room is not null then
        select count(*), (array_agg(l.id))[1] into v_count, v_loc_id
          from public.locations l
         where not l.is_archived
           and public.labventory_norm(l.room) = public.labventory_norm(v_room)
           and coalesce(public.labventory_norm(l.cabinet), '') = coalesce(public.labventory_norm(v_cabinet), '')
           and coalesce(public.labventory_norm(l.shelf), '') = coalesce(public.labventory_norm(v_shelf), '')
           and coalesce(public.labventory_norm(l.tray), '') = coalesce(public.labventory_norm(v_tray), '');
        if v_count > 1 then
          v_errors := v_errors || format('Location "%s" matches %s existing locations; resolve the duplicates before importing.', concat_ws(' / ', v_room, v_cabinet, v_shelf, v_tray), v_count); v_loc_id := null;
        elsif v_count = 1 then v_loc_action := 'matched';
        else v_loc_id := null; v_loc_action := 'created'; end if;
      end if;

      if cardinality(v_errors) > 0 then
        v_rejected := v_rejected + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object('row', v_row_number, 'part', nullif(v_row->>'bottle_part', ''), 'status', 'rejected', 'bottle_id', v_bottle_code, 'chemical', v_name, 'errors', to_jsonb(v_errors), 'warnings', to_jsonb(v_warnings)));
        continue;
      end if;

      -- Possible duplicate of an existing bottle without a bottle ID: warn, never merge.
      if v_bottle_code is null and v_chem_id is not null and exists (
        select 1 from public.bottles b
         where not b.is_archived and b.chemical_id = v_chem_id
           and b.supplier_id is not distinct from v_sup_id and b.location_id is not distinct from v_loc_id
           and b.current_quantity = v_qty and b.quantity_unit is not distinct from v_qty_unit
           and b.batch_lot_number is not distinct from nullif(btrim(coalesce(v_row->>'batch_lot_number', '')), '')
      ) then
        v_warnings := v_warnings || 'An existing bottle has the same chemical, supplier, location, lot and quantity; this row is imported as a separate physical bottle.'::text;
      end if;

      -- Writes (rolled back for dry runs)
      if v_chem_action = 'created' then
        insert into public.chemicals (name, cas_number, created_by, updated_by)
        values (v_name, v_cas, v_actor, v_actor) returning id into v_chem_id;
        v_chem_created := v_chem_created + 1;
      else v_chem_matched := v_chem_matched + 1; end if;

      if v_sup_action = 'created' then
        insert into public.suppliers (vendor_name, normalized_name)
        values (v_supplier, public.labventory_norm(v_supplier)) returning id into v_sup_id;
        v_sup_created := v_sup_created + 1;
      elsif v_sup_action = 'matched' then v_sup_matched := v_sup_matched + 1; end if;

      if v_loc_action = 'created' then
        insert into public.locations (room, cabinet, shelf, tray, source_value)
        values (v_room, v_cabinet, v_shelf, v_tray, concat_ws(' / ', v_room, v_cabinet, v_shelf, v_tray)) returning id into v_loc_id;
        v_loc_created := v_loc_created + 1;
      elsif v_loc_action = 'matched' then v_loc_matched := v_loc_matched + 1; end if;

      v_bottle_status := case
        when v_expiry is not null and v_expiry < current_date then 'Expired'
        when v_qty = 0 then 'Depleted'
        when v_size is not null and public.labventory_dimension(v_size_unit) = public.labventory_dimension(v_qty_unit)
             and v_qty * public.labventory_factor(v_qty_unit) < 0.2 * v_size * public.labventory_factor(v_size_unit) then 'Low Stock'
        else 'Available' end;

      insert into public.bottles (
        bottle_id, chemical_id, supplier_id, catalog_number, batch_lot_number, manufacturer,
        bottle_size, bottle_size_unit, current_quantity, initial_quantity, quantity_unit,
        purity, grade, purchase_date, expiry_date, location_id, status, notes, raw_source,
        created_by, updated_by
      ) values (
        coalesce(v_bottle_code, 'BTL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
        v_chem_id, v_sup_id,
        nullif(btrim(coalesce(v_row->>'catalog_number', '')), ''),
        nullif(btrim(coalesce(v_row->>'batch_lot_number', '')), ''),
        v_manufacturer, v_size, v_size_unit, v_qty, v_initial, v_qty_unit,
        nullif(btrim(coalesce(v_row->>'purity', '')), ''),
        nullif(btrim(coalesce(v_row->>'grade', '')), ''),
        v_purchase, v_expiry, v_loc_id, v_bottle_status,
        nullif(btrim(coalesce(v_row->>'notes', '')), ''),
        jsonb_build_object('import_batch_id', v_batch_id, 'file_name', p_file_name, 'row_number', v_row_number, 'values', coalesce(v_row->'raw', '{}'::jsonb)),
        v_actor, v_actor
      ) returning id, bottle_id into v_bottle_uuid, v_bottle_code;

      -- Stock-in record (not a usage transaction).
      insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after, destination_location_id, reason, reference_number)
      values (v_bottle_uuid, v_chem_id, v_actor, 'STOCK_IN', 0, v_qty, v_qty, v_loc_id, 'Spreadsheet import', v_batch_id::text)
      returning id into v_txn_id;

      v_imported := v_imported + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row', v_row_number, 'part', nullif(v_row->>'bottle_part', ''), 'status', case when p_dry_run then 'valid' else 'imported' end,
        'bottle_id', case when p_dry_run and nullif(btrim(coalesce(v_row->>'bottle_id', '')), '') is null then null else v_bottle_code end,
        'chemical', v_name, 'chemical_action', v_chem_action, 'supplier_action', v_sup_action, 'location_action', v_loc_action,
        'status_assigned', v_bottle_status, 'errors', '[]'::jsonb, 'warnings', to_jsonb(v_warnings)));
    end loop;

    v_summary := jsonb_build_object(
      'batch_id', v_batch_id, 'file_name', p_file_name, 'file_sha256', p_file_sha256,
      'total_rows', v_total, 'imported_rows', v_imported, 'rejected_rows', v_rejected,
      'chemicals', jsonb_build_object('matched', v_chem_matched, 'created', v_chem_created),
      'suppliers', jsonb_build_object('matched', v_sup_matched, 'created', v_sup_created),
      'locations', jsonb_build_object('matched', v_loc_matched, 'created', v_loc_created),
      'rows', v_results);

    if p_dry_run then
      raise exception using errcode = 'LVD01', message = 'dry run';
    end if;
    if v_imported = 0 or (v_rejected > 0 and not p_skip_rejected) then
      raise exception using errcode = 'LVB01', message = 'blocked';
    end if;

    insert into public.inventory_import_batches (id, idempotency_key, file_name, file_sha256, imported_by, total_rows, imported_rows, rejected_rows, summary)
    values (v_batch_id, p_idempotency_key, p_file_name, p_file_sha256, v_actor, v_total, v_imported, v_rejected,
            v_summary || jsonb_build_object('status', 'committed', 'imported_at', now(), 'imported_by', v_actor));

    insert into public.activity_log (actor_user_id, action_type, entity_type, entity_id, metadata)
    values (v_actor, 'INVENTORY_IMPORT', 'inventory_import_batch', v_batch_id, jsonb_build_object(
      'file_name', p_file_name, 'total_rows', v_total, 'imported_rows', v_imported, 'rejected_rows', v_rejected,
      'chemicals', v_summary->'chemicals', 'suppliers', v_summary->'suppliers', 'locations', v_summary->'locations'));

    v_status := 'committed';
  exception
    when sqlstate 'LVD01' then v_status := 'preview';
    when sqlstate 'LVB01' then v_status := 'blocked';
  end;

  -- Rolled-back runs: matched/created counts describe what WOULD happen.
  return v_summary || jsonb_build_object('status', v_status, 'dry_run', p_dry_run,
    'imported_at', case when v_status = 'committed' then now() end);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_active_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(select 1 from public.profiles where id = auth.uid() and account_status = 'active')
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'ADMIN' and account_status = 'active')
$function$
;

CREATE OR REPLACE FUNCTION public.is_designated_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.is_admin() and exists(
    select 1 from public.system_settings
    where key = 'designated_admin' and value->>'user_id' = auth.uid()::text
  )
$function$
;

CREATE OR REPLACE FUNCTION public.labventory_cas_valid(p text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare digits text; total integer := 0; i integer; n integer;
begin
  if p is null or p !~ '^\d{2,7}-\d{2}-\d$' then return false; end if;
  digits := replace(p, '-', '');
  n := length(digits);
  for i in 1..n - 1 loop
    total := total + substr(digits, n - i, 1)::integer * i;
  end loop;
  return total % 10 = substr(digits, n, 1)::integer;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.labventory_dimension(p_unit text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when p_unit in ('µg', 'mg', 'g', 'kg') then 'mass' when p_unit in ('µL', 'mL', 'L') then 'volume' end
$function$
;

CREATE OR REPLACE FUNCTION public.labventory_factor(p_unit text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_unit when 'µg' then 0.000001 when 'mg' then 0.001 when 'g' then 1 when 'kg' then 1000
                     when 'µL' then 0.001 when 'mL' then 1 when 'L' then 1000 end
$function$
;

CREATE OR REPLACE FUNCTION public.labventory_norm(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')), '')
$function$
;

CREATE OR REPLACE FUNCTION public.labventory_unit(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case lower(regexp_replace(btrim(coalesce(p, '')), '\s+', '', 'g'))
    when 'µg' then 'µg' when 'μg' then 'µg' when 'ug' then 'µg' when 'mcg' then 'µg'
    when 'mg' then 'mg'
    when 'g' then 'g' when 'gm' then 'g' when 'gram' then 'g' when 'grams' then 'g'
    when 'kg' then 'kg'
    when 'µl' then 'µL' when 'μl' then 'µL' when 'ul' then 'µL'
    when 'ml' then 'mL'
    when 'l' then 'L' when 'lit' then 'L' when 'ltr' then 'L' when 'litre' then 'L' when 'liter' then 'L' when 'litres' then 'L' when 'liters' then 'L'
    else null end
$function$
;

CREATE OR REPLACE FUNCTION public.prevent_activity_log_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'ACTIVITY_LOG_IS_APPEND_ONLY';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_usage(p_bottle_id uuid, p_quantity numeric, p_quantity_unit text, p_purpose text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.remove_flash_holiday(p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not public.is_admin() then raise exception 'ONLY_ADMIN' using errcode = '42501'; end if;
  delete from public.flash_holidays where holiday_date = p_date;
  insert into public.activity_log (actor_user_id, action_type, metadata) values (auth.uid(), 'FLASH_HOLIDAY_REMOVED', jsonb_build_object('date', p_date));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.replace_google_holidays(p_rows jsonb, p_from date, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_count integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'ROWS_MUST_BE_AN_ARRAY'; end if;
  delete from public.flash_holidays where source = 'google' and holiday_date >= p_from;
  insert into public.flash_holidays (holiday_date, name, source)
  select (r->>'date')::date, string_agg(distinct r->>'name', ' / '), 'google'
    from jsonb_array_elements(p_rows) r
   where (r->>'date')::date >= p_from
   group by (r->>'date')::date
  on conflict (holiday_date) do nothing; -- an Admin closure on the same date wins
  get diagnostics v_count = row_count;
  if p_actor is not null then
    insert into public.activity_log (actor_user_id, action_type, metadata) values (p_actor, 'FLASH_HOLIDAYS_SYNCED', jsonb_build_object('holidays', v_count, 'from', p_from));
  end if;
  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_flash_holiday(p_date date, p_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not public.is_admin() then raise exception 'ONLY_ADMIN' using errcode = '42501'; end if;
  if p_date is null or nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'DATE_AND_NAME_REQUIRED'; end if;
  insert into public.flash_holidays (holiday_date, name, source) values (p_date, btrim(p_name), 'admin')
  on conflict (holiday_date) do update set name = excluded.name, source = 'admin', updated_at = now();
  insert into public.activity_log (actor_user_id, action_type, metadata) values (auth.uid(), 'FLASH_HOLIDAY_SET', jsonb_build_object('date', p_date, 'name', btrim(p_name)));
end;
$function$
;

alter table public.activity_log add constraint activity_log_pkey PRIMARY KEY (id);

alter table public.bottles add constraint bottles_bottle_id_key UNIQUE (bottle_id);

alter table public.bottles add constraint bottles_current_quantity_check CHECK ((current_quantity >= (0)::numeric));

alter table public.bottles add constraint bottles_initial_quantity_check CHECK ((initial_quantity >= (0)::numeric));

alter table public.bottles add constraint bottles_pkey PRIMARY KEY (id);

alter table public.bottles add constraint bottles_qr_code_key UNIQUE (qr_code);

alter table public.chemicals add constraint chemicals_pkey PRIMARY KEY (id);

alter table public.documents add constraint documents_pkey PRIMARY KEY (id);

alter table public.flash_bookings add constraint flash_bookings_pkey PRIMARY KEY (id);

alter table public.flash_holidays add constraint flash_holidays_pkey PRIMARY KEY (holiday_date);

alter table public.flash_holidays add constraint flash_holidays_source_check CHECK ((source = ANY (ARRAY['google'::text, 'admin'::text])));

alter table public.flash_bookings add constraint flash_slot_is_one_hour CHECK ((slot_end = (slot_start + '01:00:00'::interval)));

alter table public.flash_bookings add constraint flash_slot_on_the_hour CHECK ((date_trunc('hour'::text, (slot_start AT TIME ZONE 'Asia/Kolkata'::text)) = (slot_start AT TIME ZONE 'Asia/Kolkata'::text)));

alter table public.inventory_import_batches add constraint inventory_import_batches_file_sha256_check CHECK ((file_sha256 ~ '^[0-9a-f]{64}$'::text));

alter table public.inventory_import_batches add constraint inventory_import_batches_file_sha256_key UNIQUE (file_sha256);

alter table public.inventory_import_batches add constraint inventory_import_batches_idempotency_key_key UNIQUE (idempotency_key);

alter table public.inventory_import_batches add constraint inventory_import_batches_pkey PRIMARY KEY (id);

alter table public.locations add constraint locations_pkey PRIMARY KEY (id);

alter table public.profiles add constraint profiles_pkey PRIMARY KEY (id);

alter table public.suppliers add constraint suppliers_pkey PRIMARY KEY (id);

alter table public.system_settings add constraint system_settings_pkey PRIMARY KEY (key);

alter table public.transactions add constraint transactions_pkey PRIMARY KEY (id);

alter table public.transactions add constraint transactions_quantity_after_check CHECK ((quantity_after >= (0)::numeric));

alter table public.transactions add constraint transactions_quantity_before_check CHECK ((quantity_before >= (0)::numeric));

alter table public.activity_log add constraint activity_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES profiles(id);

alter table public.activity_log add constraint activity_log_bottle_id_fkey FOREIGN KEY (bottle_id) REFERENCES bottles(id);

alter table public.activity_log add constraint activity_log_chemical_id_fkey FOREIGN KEY (chemical_id) REFERENCES chemicals(id);

alter table public.activity_log add constraint activity_log_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES profiles(id);

alter table public.activity_log add constraint activity_log_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id);

alter table public.bottles add constraint bottles_chemical_id_fkey FOREIGN KEY (chemical_id) REFERENCES chemicals(id);

alter table public.bottles add constraint bottles_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

alter table public.bottles add constraint bottles_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);

alter table public.bottles add constraint bottles_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id);

alter table public.bottles add constraint bottles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES profiles(id);

alter table public.chemicals add constraint chemicals_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

alter table public.chemicals add constraint chemicals_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES profiles(id);

alter table public.documents add constraint documents_chemical_id_fkey FOREIGN KEY (chemical_id) REFERENCES chemicals(id);

alter table public.documents add constraint documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);

alter table public.flash_bookings add constraint flash_bookings_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES profiles(id);

alter table public.flash_bookings add constraint flash_bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);

alter table public.inventory_import_batches add constraint inventory_import_batches_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES profiles(id);

alter table public.locations add constraint locations_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES locations(id);

alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.profiles add constraint profiles_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES profiles(id);

alter table public.transactions add constraint transactions_bottle_id_fkey FOREIGN KEY (bottle_id) REFERENCES bottles(id);

alter table public.transactions add constraint transactions_chemical_id_fkey FOREIGN KEY (chemical_id) REFERENCES chemicals(id);

alter table public.transactions add constraint transactions_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES locations(id);

alter table public.transactions add constraint transactions_source_location_id_fkey FOREIGN KEY (source_location_id) REFERENCES locations(id);

alter table public.transactions add constraint transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);

CREATE INDEX activity_log_action_idx ON public.activity_log USING btree (action_type, created_at DESC);

CREATE INDEX activity_log_actor_idx ON public.activity_log USING btree (actor_user_id, created_at DESC);

CREATE INDEX activity_log_created_idx ON public.activity_log USING btree (created_at DESC);

CREATE INDEX bottles_chemical_idx ON public.bottles USING btree (chemical_id);

CREATE INDEX bottles_expiry_idx ON public.bottles USING btree (expiry_date);

CREATE INDEX bottles_location_idx ON public.bottles USING btree (location_id);

CREATE INDEX bottles_status_idx ON public.bottles USING btree (status);

CREATE INDEX chemicals_cas_idx ON public.chemicals USING btree (cas_number);

CREATE INDEX chemicals_formula_idx ON public.chemicals USING btree (molecular_formula);

CREATE INDEX chemicals_name_trgm_idx ON public.chemicals USING gin (name gin_trgm_ops);

CREATE INDEX flash_bookings_group_idx ON public.flash_bookings USING btree (booking_group);

CREATE UNIQUE INDEX flash_bookings_one_per_slot ON public.flash_bookings USING btree (slot_start) WHERE (cancelled_at IS NULL);

CREATE INDEX flash_bookings_user_idx ON public.flash_bookings USING btree (user_id, slot_start);

CREATE INDEX transactions_bottle_idx ON public.transactions USING btree (bottle_id);

CREATE INDEX transactions_time_idx ON public.transactions USING btree (created_at DESC);

alter table public.activity_log enable row level security;

alter table public.bottles enable row level security;

alter table public.chemicals enable row level security;

alter table public.documents enable row level security;

alter table public.flash_bookings enable row level security;

alter table public.flash_holidays enable row level security;

alter table public.inventory_import_batches enable row level security;

alter table public.locations enable row level security;

alter table public.profiles enable row level security;

alter table public.suppliers enable row level security;

alter table public.system_settings enable row level security;

alter table public.transactions enable row level security;

create policy "Users can read their own profile" on public.profiles as PERMISSIVE for SELECT to authenticated using ((id = auth.uid()));

create policy "active users read flash bookings" on public.flash_bookings as PERMISSIVE for SELECT to authenticated using (is_active_user());

create policy "active users read flash holidays" on public.flash_holidays as PERMISSIVE for SELECT to authenticated using (is_active_user());

create policy "admin appends own activity" on public.activity_log as PERMISSIVE for INSERT to authenticated with check ((is_admin() AND (actor_user_id = auth.uid())));

create policy "admin reads profiles" on public.profiles as PERMISSIVE for SELECT to authenticated using (is_admin());

create policy "admin updates researcher profiles" on public.profiles as PERMISSIVE for UPDATE to authenticated using ((is_admin() AND (role = 'RESEARCHER'::role_name))) with check ((is_admin() AND (role = 'RESEARCHER'::role_name)));

create policy "admins manage documents" on public.documents as PERMISSIVE for ALL to authenticated using (is_admin()) with check (is_admin());

create policy "admins read activity" on public.activity_log as PERMISSIVE for SELECT to authenticated using (is_admin());

create policy "admins read import batches" on public.inventory_import_batches as PERMISSIVE for SELECT to authenticated using (is_admin());

create policy "admins write bottles" on public.bottles as PERMISSIVE for ALL to authenticated using (is_admin()) with check (is_admin());

create policy "admins write chemicals" on public.chemicals as PERMISSIVE for ALL to authenticated using (is_admin()) with check (is_admin());

create policy "admins write locations" on public.locations as PERMISSIVE for ALL to authenticated using (is_admin()) with check (is_admin());

create policy "admins write suppliers" on public.suppliers as PERMISSIVE for ALL to authenticated using (is_admin()) with check (is_admin());

create policy "authenticated can read bottles" on public.bottles as PERMISSIVE for SELECT to authenticated using ((NOT is_archived));

create policy "authenticated can read chemicals" on public.chemicals as PERMISSIVE for SELECT to authenticated using ((NOT is_archived));

create policy "authenticated can read documents" on public.documents as PERMISSIVE for SELECT to authenticated using ((NOT is_archived));

create policy "authenticated can read locations" on public.locations as PERMISSIVE for SELECT to authenticated using ((NOT is_archived));

create policy "authenticated can read suppliers" on public.suppliers as PERMISSIVE for SELECT to authenticated using ((NOT is_archived));

create policy "authenticated can read transactions" on public.transactions as PERMISSIVE for SELECT to authenticated using (true);

CREATE TRIGGER activity_log_append_only BEFORE DELETE OR UPDATE ON public.activity_log FOR EACH ROW EXECUTE FUNCTION prevent_activity_log_mutation();

grant TRIGGER, INSERT, SELECT, REFERENCES on public.activity_log to authenticated;

grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on public.activity_log to service_role;

grant INSERT, TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT on public.bottles to anon;

grant INSERT, TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT on public.bottles to authenticated;

grant INSERT, TRUNCATE, REFERENCES, TRIGGER, DELETE, UPDATE, SELECT on public.bottles to service_role;

grant TRUNCATE, TRIGGER, INSERT, SELECT, UPDATE, DELETE, REFERENCES on public.chemicals to service_role;

grant REFERENCES, TRIGGER, INSERT, SELECT, UPDATE, DELETE, TRUNCATE on public.chemicals to anon;

grant TRUNCATE, TRIGGER, INSERT, SELECT, UPDATE, DELETE, REFERENCES on public.chemicals to authenticated;

grant DELETE, TRIGGER, REFERENCES, TRUNCATE, UPDATE, SELECT, INSERT on public.documents to anon;

grant UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES, INSERT, SELECT on public.documents to authenticated;

grant DELETE, REFERENCES, TRIGGER, INSERT, SELECT, UPDATE, TRUNCATE on public.documents to service_role;

grant REFERENCES, SELECT, TRIGGER on public.flash_bookings to authenticated;

grant REFERENCES, INSERT, TRIGGER, TRUNCATE, DELETE, UPDATE, SELECT on public.flash_bookings to service_role;

grant REFERENCES, SELECT, TRIGGER on public.flash_holidays to authenticated;

grant TRUNCATE, TRIGGER, DELETE, UPDATE, SELECT, INSERT, REFERENCES on public.flash_holidays to service_role;

grant SELECT, TRIGGER, REFERENCES on public.inventory_import_batches to authenticated;

grant TRIGGER, INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES on public.inventory_import_batches to service_role;

grant INSERT, TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT on public.locations to anon;

grant SELECT, TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, INSERT on public.locations to authenticated;

grant INSERT, TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT on public.locations to service_role;

grant INSERT, TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT on public.profiles to service_role;

grant INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on public.profiles to anon;

grant TRIGGER, INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES on public.profiles to authenticated;

grant REFERENCES, INSERT, SELECT, UPDATE, DELETE, TRUNCATE, TRIGGER on public.suppliers to anon;

grant INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on public.suppliers to authenticated;

grant INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on public.suppliers to service_role;

grant SELECT, UPDATE, DELETE, INSERT, TRIGGER, REFERENCES, TRUNCATE on public.system_settings to anon;

grant UPDATE, REFERENCES, TRIGGER, DELETE, TRUNCATE, SELECT, INSERT on public.system_settings to authenticated;

grant TRUNCATE, REFERENCES, TRIGGER, INSERT, SELECT, UPDATE, DELETE on public.system_settings to service_role;

grant SELECT, REFERENCES, TRIGGER on public.transactions to anon;

grant TRIGGER, REFERENCES, SELECT on public.transactions to authenticated;

grant DELETE, UPDATE, TRUNCATE, INSERT, SELECT, REFERENCES, TRIGGER on public.transactions to service_role;

revoke all on function public.activate_invited_user() from public, anon, authenticated;

revoke all on function public.book_flash_slots(p_date date, p_start_hour integer, p_slots integer, p_purpose text) from public, anon, authenticated;

revoke all on function public.cancel_flash_booking(p_booking_group uuid) from public, anon, authenticated;

revoke all on function public.flash_config() from public, anon, authenticated;

revoke all on function public.import_inventory_batch(p_idempotency_key uuid, p_file_name text, p_file_sha256 text, p_rows jsonb, p_dry_run boolean, p_skip_rejected boolean) from public, anon, authenticated;

revoke all on function public.is_active_user() from public, anon, authenticated;

revoke all on function public.is_admin() from public, anon, authenticated;

revoke all on function public.is_designated_admin() from public, anon, authenticated;

revoke all on function public.labventory_cas_valid(p text) from public, anon, authenticated;

revoke all on function public.labventory_dimension(p_unit text) from public, anon, authenticated;

revoke all on function public.labventory_factor(p_unit text) from public, anon, authenticated;

revoke all on function public.labventory_norm(p text) from public, anon, authenticated;

revoke all on function public.labventory_unit(p text) from public, anon, authenticated;

revoke all on function public.prevent_activity_log_mutation() from public, anon, authenticated;

revoke all on function public.record_usage(p_bottle_id uuid, p_quantity numeric, p_quantity_unit text, p_purpose text, p_notes text) from public, anon, authenticated;

revoke all on function public.remove_flash_holiday(p_date date) from public, anon, authenticated;

revoke all on function public.replace_google_holidays(p_rows jsonb, p_from date, p_actor uuid) from public, anon, authenticated;

revoke all on function public.set_flash_holiday(p_date date, p_name text) from public, anon, authenticated;

grant execute on function public.activate_invited_user() to authenticated;

grant execute on function public.activate_invited_user() to service_role;

grant execute on function public.book_flash_slots(p_date date, p_start_hour integer, p_slots integer, p_purpose text) to service_role;

grant execute on function public.book_flash_slots(p_date date, p_start_hour integer, p_slots integer, p_purpose text) to authenticated;

grant execute on function public.cancel_flash_booking(p_booking_group uuid) to service_role;

grant execute on function public.cancel_flash_booking(p_booking_group uuid) to authenticated;

grant execute on function public.flash_config() to service_role;

grant execute on function public.flash_config() to authenticated;

grant execute on function public.flash_config() to anon;

grant execute on function public.import_inventory_batch(p_idempotency_key uuid, p_file_name text, p_file_sha256 text, p_rows jsonb, p_dry_run boolean, p_skip_rejected boolean) to service_role;

grant execute on function public.import_inventory_batch(p_idempotency_key uuid, p_file_name text, p_file_sha256 text, p_rows jsonb, p_dry_run boolean, p_skip_rejected boolean) to authenticated;

grant execute on function public.is_active_user() to authenticated;

grant execute on function public.is_active_user() to service_role;

grant execute on function public.is_admin() to service_role;

grant execute on function public.is_admin() to authenticated;

grant execute on function public.is_designated_admin() to authenticated;

grant execute on function public.is_designated_admin() to service_role;

grant execute on function public.labventory_cas_valid(p text) to anon;

grant execute on function public.labventory_cas_valid(p text) to service_role;

grant execute on function public.labventory_cas_valid(p text) to authenticated;

grant execute on function public.labventory_dimension(p_unit text) to authenticated;

grant execute on function public.labventory_dimension(p_unit text) to service_role;

grant execute on function public.labventory_dimension(p_unit text) to anon;

grant execute on function public.labventory_factor(p_unit text) to anon;

grant execute on function public.labventory_factor(p_unit text) to authenticated;

grant execute on function public.labventory_factor(p_unit text) to service_role;

grant execute on function public.labventory_norm(p text) to authenticated;

grant execute on function public.labventory_norm(p text) to service_role;

grant execute on function public.labventory_norm(p text) to anon;

grant execute on function public.labventory_unit(p text) to authenticated;

grant execute on function public.labventory_unit(p text) to service_role;

grant execute on function public.labventory_unit(p text) to anon;

grant execute on function public.prevent_activity_log_mutation() to service_role;

grant execute on function public.prevent_activity_log_mutation() to anon;

grant execute on function public.prevent_activity_log_mutation() to authenticated;

grant execute on function public.record_usage(p_bottle_id uuid, p_quantity numeric, p_quantity_unit text, p_purpose text, p_notes text) to authenticated;

grant execute on function public.record_usage(p_bottle_id uuid, p_quantity numeric, p_quantity_unit text, p_purpose text, p_notes text) to service_role;

grant execute on function public.remove_flash_holiday(p_date date) to authenticated;

grant execute on function public.remove_flash_holiday(p_date date) to service_role;

grant execute on function public.replace_google_holidays(p_rows jsonb, p_from date, p_actor uuid) to service_role;

grant execute on function public.set_flash_holiday(p_date date, p_name text) to service_role;

grant execute on function public.set_flash_holiday(p_date date, p_name text) to authenticated;

alter publication supabase_realtime add table public.activity_log;

alter publication supabase_realtime add table public.bottles;

alter publication supabase_realtime add table public.chemicals;

alter publication supabase_realtime add table public.flash_bookings;

alter publication supabase_realtime add table public.flash_holidays;

alter publication supabase_realtime add table public.locations;

alter publication supabase_realtime add table public.suppliers;

alter publication supabase_realtime add table public.transactions;

