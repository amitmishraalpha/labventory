-- Specialized glassware/plasticware inventory and category-aware procurement fields.
alter table public.chemical_order_requests
  add column if not exists item_category text not null default 'CHEMICAL',
  add column if not exists catalogue_number text,
  add column if not exists price numeric check (price is null or price >= 0),
  add column if not exists currency text not null default 'INR',
  add column if not exists item_name text,
  add column if not exists manufacturer text,
  add column if not exists size text,
  add column if not exists dimensions text;

update public.chemical_order_requests
set item_category = case when category = 'GLASSWARE' then 'GLASSWARE' else 'CHEMICAL' end,
    item_name = chemical_name,
    price = unit_price
where item_name is null or item_category = 'CHEMICAL';

alter table public.chemical_order_requests drop constraint if exists chemical_order_requests_category_check;
alter table public.chemical_order_requests add constraint chemical_order_requests_category_check
  check (category in ('CHEMICAL', 'COMMERCIAL_SOLVENT', 'NMR_SOLVENT', 'GLASSWARE'));
alter table public.chemical_order_requests add constraint order_item_category_check
  check (item_category in ('CHEMICAL', 'GLASSWARE'));
alter table public.chemical_order_requests add constraint order_category_fields_check
  check (
    (item_category = 'CHEMICAL' and length(btrim(coalesce(item_name, chemical_name))) > 0)
    or (item_category = 'GLASSWARE' and length(btrim(coalesce(item_name, chemical_name))) > 0
      and length(btrim(coalesce(manufacturer, preferred_supplier))) > 0
      and length(btrim(coalesce(size, preferred_pack_size))) > 0)
  );
create index if not exists order_requests_item_category_idx on public.chemical_order_requests (item_category, requested_at desc);

create table if not exists public.specialized_labware (
  id uuid primary key default gen_random_uuid(),
  item_name text not null check (length(btrim(item_name)) between 1 and 200),
  manufacturer text not null check (length(btrim(manufacturer)) between 1 and 200),
  size text not null check (length(btrim(size)) between 1 and 100),
  dimensions text,
  available_quantity integer not null default 0 check (available_quantity >= 0),
  price numeric check (price is null or price >= 0),
  currency text not null default 'INR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  is_archived boolean not null default false
);
create index if not exists specialized_labware_name_idx on public.specialized_labware using gin (item_name gin_trgm_ops);
create index if not exists specialized_labware_manufacturer_idx on public.specialized_labware using gin (manufacturer gin_trgm_ops);
alter table public.specialized_labware enable row level security;
create policy "authenticated read specialized labware" on public.specialized_labware for select to authenticated using (not is_archived);
create policy "admins write specialized labware" on public.specialized_labware for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Keep old clients functional while storing the new category-specific representation.
create or replace function public.submit_order_request(p jsonb, p_allow_duplicate boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_category text := coalesce(nullif(p->>'item_category', ''), nullif(p->>'category', ''), 'CHEMICAL');
  v_name text := public.labventory_text(p, case when v_category = 'GLASSWARE' then 'item_name' else 'chemical_name' end, 200);
  v_manufacturer text := public.labventory_text(p, 'manufacturer', 200);
  v_size text := public.labventory_text(p, 'size', 100);
  v_qty numeric := public.labventory_number(p, 'requested_quantity');
  v_unit text := case when v_category = 'GLASSWARE' then coalesce(nullif(p->>'quantity_unit', ''), 'item') else public.labventory_unit(p->>'quantity_unit') end;
  v_id uuid; v_dup public.chemical_order_requests;
begin
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  if v_category not in ('CHEMICAL', 'GLASSWARE') then raise exception 'INVALID_ITEM_CATEGORY'; end if;
  if v_name is null then raise exception 'ITEM_NAME_REQUIRED'; end if;
  if v_category = 'GLASSWARE' and (v_manufacturer is null or v_size is null) then raise exception 'GLASSWARE_FIELDS_REQUIRED'; end if;
  if v_qty is null or v_qty <= 0 or (v_category = 'GLASSWARE' and v_qty <> trunc(v_qty)) then raise exception 'QUANTITY_MUST_BE_POSITIVE'; end if;
  if v_category = 'CHEMICAL' and public.labventory_unit(p->>'quantity_unit') is null then raise exception 'UNIT_NOT_SUPPORTED'; end if;
  if coalesce(p->>'priority', 'Normal') not in ('Low', 'Normal', 'High', 'Urgent') then raise exception 'INVALID_PRIORITY'; end if;
  select * into v_dup from public.chemical_order_requests
    where public.order_is_open(status) and item_category = v_category
      and public.labventory_norm(coalesce(item_name, chemical_name)) = public.labventory_norm(v_name)
    order by requested_at desc limit 1;
  if found and not coalesce(p_allow_duplicate, false) then
    raise exception 'DUPLICATE_OPEN_REQUEST: % is already on the order list (status %, requested %). Submit again to add it anyway.',
      v_dup.chemical_name, v_dup.status, to_char(v_dup.requested_at at time zone 'Asia/Kolkata', 'DD Mon YYYY');
  end if;
  insert into public.chemical_order_requests
    (chemical_id, source_bottle_id, chemical_name, cas_number, molecular_formula, category, item_category, catalogue_number,
     price, currency, item_name, manufacturer, size, dimensions, requested_quantity, quantity_unit, preferred_pack_size,
     preferred_supplier, reason, experiment, priority, notes, requested_by)
  values
    (nullif(p->>'chemical_id', '')::uuid, nullif(p->>'source_bottle_id', '')::uuid,
     coalesce(v_name, 'Item'), nullif(p->>'cas_number', ''), nullif(p->>'molecular_formula', ''),
     case when v_category = 'GLASSWARE' then 'GLASSWARE' else coalesce(nullif(p->>'category', ''), 'CHEMICAL') end,
     v_category, nullif(p->>'catalogue_number', ''), public.labventory_number(p, 'price'), coalesce(nullif(p->>'currency', ''), 'INR'),
     v_name, v_manufacturer, v_size, nullif(p->>'dimensions', ''), v_qty, v_unit, nullif(p->>'preferred_pack_size', ''),
     coalesce(v_manufacturer, nullif(p->>'preferred_supplier', '')), nullif(p->>'reason', ''), nullif(p->>'experiment', ''),
     coalesce(nullif(p->>'priority', ''), 'Normal'), nullif(p->>'notes', ''), auth.uid())
  returning id into v_id;
  insert into public.order_request_history (request_id, to_status, changed_by, details)
    values (v_id, 'Requested', auth.uid(), jsonb_build_object('item_category', v_category, 'duplicate_of', v_dup.id));
  insert into public.activity_log (actor_user_id, action_type, entity_type, entity_id, metadata)
    values (auth.uid(), 'ORDER_REQUESTED', 'order_request', v_id, jsonb_build_object('item', v_name, 'category', v_category, 'quantity', v_qty));
  return jsonb_build_object('id', v_id);
end; $$;
revoke all on function public.submit_order_request(jsonb, boolean) from public, anon;
grant execute on function public.submit_order_request(jsonb, boolean) to authenticated;
