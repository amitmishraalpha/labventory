-- Labventory: import the laboratory chemicals register format.
--
-- Replaces two functions from 20261018090000 (no tables or data change):
--  * a missing available quantity is reported once (not also "unit required").
--  * rows with client_errors are reported with only those errors.
--  * labventory_unit: also accepts "Lit".
--  * size checks (exceeds bottle, Low Stock < 20%) compare within mass or volume
--    (200 mg in a 1 g bottle); values and units are still stored exactly as written.
--  * import_inventory_batch: one spreadsheet row may describe several bottles
--    ("25 g X2" / "5 g + 15 g"). The app sends one payload row per bottle with
--    bottle_part ("1 of 2") and any problems found while reading the sheet
--    (client_errors / client_warnings). Those are reported per row and a row with
--    client_errors is rejected exactly like a row failing server validation.
--    Authorization, matching, atomicity and duplicate protection are unchanged.

create or replace function public.labventory_dimension(p_unit text) returns text
language sql immutable as $$
  select case when p_unit in ('µg', 'mg', 'g', 'kg') then 'mass' when p_unit in ('µL', 'mL', 'L') then 'volume' end
$$;

create or replace function public.labventory_factor(p_unit text) returns numeric
language sql immutable as $$
  select case p_unit when 'µg' then 0.000001 when 'mg' then 0.001 when 'g' then 1 when 'kg' then 1000
                     when 'µL' then 0.001 when 'mL' then 1 when 'L' then 1000 end
$$;

create or replace function public.labventory_unit(p text) returns text
language sql immutable as $$
  select case lower(regexp_replace(btrim(coalesce(p, '')), '\s+', '', 'g'))
    when 'µg' then 'µg' when 'μg' then 'µg' when 'ug' then 'µg' when 'mcg' then 'µg'
    when 'mg' then 'mg'
    when 'g' then 'g' when 'gm' then 'g' when 'gram' then 'g' when 'grams' then 'g'
    when 'kg' then 'kg'
    when 'µl' then 'µL' when 'μl' then 'µL' when 'ul' then 'µL'
    when 'ml' then 'mL'
    when 'l' then 'L' when 'lit' then 'L' when 'ltr' then 'L' when 'litre' then 'L' when 'liter' then 'L' when 'litres' then 'L' when 'liters' then 'L'
    else null end
$$;

create or replace function public.import_inventory_batch(
  p_idempotency_key uuid,
  p_file_name text,
  p_file_sha256 text,
  p_rows jsonb,
  p_dry_run boolean default true,
  p_skip_rejected boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
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
$$;

revoke all on function public.import_inventory_batch(uuid, text, text, jsonb, boolean, boolean) from public, anon;
grant execute on function public.import_inventory_batch(uuid, text, text, jsonb, boolean, boolean) to authenticated;

notify pgrst, 'reload schema';
