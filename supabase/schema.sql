-- Labventory foundation schema. Run with Supabase migrations.
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create type role_name as enum ('ADMIN', 'RESEARCHER');
create type bottle_status as enum ('Available', 'Low Stock', 'Expired', 'Depleted', 'Quarantined', 'Disposed');
create type transaction_type as enum ('STOCK_IN', 'USAGE', 'RETURN', 'ADJUSTMENT', 'TRANSFER', 'DISPOSAL', 'ARCHIVE', 'RESTORE');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role role_name not null default 'RESEARCHER',
  created_at timestamptz not null default now()
);
create table public.suppliers (
  id uuid primary key default gen_random_uuid(), vendor_name text not null, normalized_name text not null,
  catalog_number text, contact_name text, email text, phone text, website text, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), is_archived boolean not null default false
);
create table public.locations (
  id uuid primary key default gen_random_uuid(), parent_id uuid references public.locations(id), room text not null,
  cabinet text, shelf text, tray text, source_value text, created_at timestamptz not null default now(), is_archived boolean not null default false
);
create table public.chemicals (
  id uuid primary key default gen_random_uuid(), name text not null, synonyms text[] not null default '{}', cas_number text,
  molecular_formula text, molecular_weight numeric, pubchem_cid text, iupac_name text, canonical_smiles text,
  is_hazardous boolean not null default false, hazard_summary text, purity text, grade text, physical_state text,
  storage_temperature text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id), updated_by uuid references public.profiles(id), is_archived boolean not null default false
);
create table public.bottles (
  id uuid primary key default gen_random_uuid(), bottle_id text not null unique, chemical_id uuid not null references public.chemicals(id),
  supplier_id uuid references public.suppliers(id), catalog_number text, batch_lot_number text, manufacturer text,
  bottle_size numeric, bottle_size_unit text, current_quantity numeric not null default 0 check (current_quantity >= 0),
  initial_quantity numeric check (initial_quantity >= 0), quantity_unit text, purity text, grade text, purchase_date date,
  expiry_date date, low_stock_threshold numeric default 0, low_stock_threshold_unit text, location_id uuid references public.locations(id),
  status bottle_status not null default 'Available', qr_code text unique, notes text, raw_source jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id), is_archived boolean not null default false
);
create table public.transactions (
  id uuid primary key default gen_random_uuid(), bottle_id uuid not null references public.bottles(id), chemical_id uuid not null references public.chemicals(id),
  user_id uuid not null references public.profiles(id), transaction_type transaction_type not null, quantity_before numeric not null check (quantity_before >= 0),
  quantity_change numeric not null, quantity_after numeric not null check (quantity_after >= 0), source_location_id uuid references public.locations(id),
  destination_location_id uuid references public.locations(id), reason text, notes text, reference_number text, created_at timestamptz not null default now()
);
create table public.documents (
  id uuid primary key default gen_random_uuid(), chemical_id uuid not null references public.chemicals(id), document_type text not null,
  file_name text not null, storage_path text not null, uploaded_by uuid not null references public.profiles(id), uploaded_at timestamptz not null default now(), version integer not null default 1, is_current boolean not null default true, is_archived boolean not null default false
);
create index chemicals_cas_idx on public.chemicals(cas_number); create index chemicals_name_trgm_idx on public.chemicals using gin (name gin_trgm_ops); create index chemicals_formula_idx on public.chemicals(molecular_formula);
create index bottles_chemical_idx on public.bottles(chemical_id); create index bottles_location_idx on public.bottles(location_id); create index bottles_expiry_idx on public.bottles(expiry_date); create index bottles_status_idx on public.bottles(status); create index transactions_bottle_idx on public.transactions(bottle_id); create index transactions_time_idx on public.transactions(created_at desc);

alter table public.profiles enable row level security; alter table public.chemicals enable row level security; alter table public.bottles enable row level security; alter table public.locations enable row level security; alter table public.suppliers enable row level security; alter table public.transactions enable row level security; alter table public.documents enable row level security;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from profiles where id = auth.uid() and role = 'ADMIN') $$;
create policy "authenticated can read chemicals" on public.chemicals for select to authenticated using (not is_archived); create policy "admins write chemicals" on public.chemicals for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated can read bottles" on public.bottles for select to authenticated using (not is_archived); create policy "admins write bottles" on public.bottles for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated can read locations" on public.locations for select to authenticated using (not is_archived); create policy "admins write locations" on public.locations for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated can read suppliers" on public.suppliers for select to authenticated using (not is_archived); create policy "admins write suppliers" on public.suppliers for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated can read transactions" on public.transactions for select to authenticated using (true); create policy "authenticated append transactions" on public.transactions for insert to authenticated with check (user_id = auth.uid());
create policy "authenticated can read documents" on public.documents for select to authenticated using (not is_archived); create policy "admins manage documents" on public.documents for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- Quantity changes must use a SECURITY DEFINER RPC that locks the bottle row, validates current_quantity >= requested usage, updates the bottle, and inserts one immutable transaction.
