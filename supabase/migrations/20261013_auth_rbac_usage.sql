-- Authentication, role, account lifecycle, activity, and atomic usage migration.
do $$ begin
  create type account_status as enum ('invited', 'active', 'suspended', 'removed');
exception when duplicate_object then null;
end $$;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists account_status account_status not null default 'active';
alter table public.profiles add column if not exists invited_by uuid references public.profiles(id);
alter table public.profiles add column if not exists invited_at timestamptz;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
update public.profiles set email = coalesce(email, '') where email is null;

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(), actor_user_id uuid not null references public.profiles(id), action_type text not null,
  target_user_id uuid references public.profiles(id), chemical_id uuid references public.chemicals(id), bottle_id uuid references public.bottles(id),
  transaction_id uuid references public.transactions(id), metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
alter table public.transactions add column if not exists quantity_unit text;
alter table public.transactions add column if not exists purpose text;
alter table public.transactions add column if not exists project_name text;
create index if not exists activity_log_actor_idx on public.activity_log(actor_user_id, created_at desc);
create index if not exists activity_log_action_idx on public.activity_log(action_type, created_at desc);
alter table public.activity_log enable row level security;

create or replace function public.is_active_user() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and account_status = 'active')
$$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'ADMIN' and account_status = 'active')
$$;

alter table public.profiles enable row level security;
create policy "users read own profile" on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists "admin reads profiles" on public.profiles;
create policy "admin reads profiles" on public.profiles for select to authenticated using (public.is_admin());
drop policy if exists "admin updates profiles" on public.profiles;
create policy "admin updates profiles" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.activate_invited_user()
returns public.profiles language plpgsql security definer set search_path = public
as $$
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
end; $$;
revoke all on function public.activate_invited_user() from public;
grant execute on function public.activate_invited_user() to authenticated;

-- Remove broad direct-write access: all quantity changes go through record_usage.
drop policy if exists "authenticated append transactions" on public.transactions;
create policy "active users can read transactions" on public.transactions for select to authenticated using (public.is_active_user());
drop policy if exists "active users append only own transactions" on public.transactions;
drop policy if exists "admins read activity" on public.activity_log;
create policy "admins read activity" on public.activity_log for select to authenticated using (public.is_admin());
drop policy if exists "active users append activity" on public.activity_log;
create policy "active users append activity" on public.activity_log for insert to authenticated with check (public.is_active_user() and actor_user_id = auth.uid());

create or replace function public.record_usage(p_bottle_id uuid, p_quantity numeric, p_quantity_unit text, p_purpose text default null, p_project_name text default null, p_notes text default null)
returns public.transactions language plpgsql security definer set search_path = public
as $$
declare bottle_row public.bottles; inserted_transaction public.transactions;
begin
  if not public.is_active_user() then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'QUANTITY_MUST_BE_POSITIVE'; end if;
  select * into bottle_row from public.bottles where id = p_bottle_id and not is_archived for update;
  if not found then raise exception 'BOTTLE_NOT_FOUND'; end if;
  if lower(trim(coalesce(p_quantity_unit, ''))) <> lower(trim(coalesce(bottle_row.quantity_unit, ''))) then raise exception 'UNIT_MISMATCH'; end if;
  if bottle_row.current_quantity < p_quantity then raise exception 'INSUFFICIENT_QUANTITY'; end if;
  update public.bottles set current_quantity = current_quantity - p_quantity, updated_at = now(), status = case when current_quantity - p_quantity <= coalesce(low_stock_threshold, 0) then 'Low Stock'::bottle_status else status end where id = p_bottle_id;
  insert into public.transactions (bottle_id, chemical_id, user_id, transaction_type, quantity_before, quantity_change, quantity_after, quantity_unit, purpose, project_name, notes)
  values (bottle_row.id, bottle_row.chemical_id, auth.uid(), 'USAGE', bottle_row.current_quantity, -p_quantity, bottle_row.current_quantity - p_quantity, p_quantity_unit, p_purpose, p_project_name, p_notes)
  returning * into inserted_transaction;
  insert into public.activity_log (actor_user_id, action_type, chemical_id, bottle_id, transaction_id, metadata)
  values (auth.uid(), 'CHEMICAL_USAGE', bottle_row.chemical_id, bottle_row.id, inserted_transaction.id, jsonb_build_object('quantity', p_quantity, 'unit', p_quantity_unit));
  return inserted_transaction;
end; $$;
revoke all on function public.record_usage(uuid, numeric, text, text, text, text) from public;
grant execute on function public.record_usage(uuid, numeric, text, text, text, text) to authenticated;

-- Exactly one designated administrator is provisioned out-of-band. This trigger prevents a second admin.
create table if not exists public.system_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
alter table public.system_settings enable row level security;
drop policy if exists "admins read settings" on public.system_settings;
create policy "admins read settings" on public.system_settings for select to authenticated using (public.is_admin());
create or replace function public.prevent_second_admin() returns trigger language plpgsql security definer set search_path = public as $$
declare designated_admin uuid;
begin
  select (value->>'user_id')::uuid into designated_admin from public.system_settings where key = 'designated_admin';
  if designated_admin is not null and new.id <> designated_admin and new.role = 'ADMIN' then raise exception 'ONLY_ONE_ADMIN_ALLOWED'; end if;
  if tg_op = 'UPDATE' and designated_admin is not null and old.id = designated_admin and (new.role <> 'ADMIN' or new.account_status <> 'active') then raise exception 'DESIGNATED_ADMIN_CANNOT_BE_REMOVED'; end if;
  return new;
end; $$;
drop trigger if exists enforce_one_admin on public.profiles;
create trigger enforce_one_admin before insert or update of role, account_status on public.profiles for each row execute function public.prevent_second_admin();
