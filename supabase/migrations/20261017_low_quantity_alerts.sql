
create table if not exists public.low_quantity_alerts (
  bottle_id uuid primary key references public.bottles(id) on delete cascade,
  threshold_percent numeric not null default 20
    check (threshold_percent > 0 and threshold_percent < 100),
  remaining_percentage numeric,
  is_active boolean not null default false,
  first_triggered_at timestamptz,
  last_triggered_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);
-- Persistent low-quantity alerts. No inventory records are seeded or modified.
-- Run after 20261013_auth_rbac_usage.sql.

create table if not exists public.low_quantity_alerts (
  bottle_id uuid primary key references public.bottles(id) on delete cascade,
  threshold_percent numeric not null default 20
    check (threshold_percent > 0 and threshold_percent < 100),
  crossing_generation integer not null default 0,
  remaining_percentage numeric,
  is_active boolean not null default false,
  first_triggered_at timestamptz,
  last_triggered_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.low_quantity_alerts
  add column if not exists crossing_generation integer not null default 0;

create table if not exists public.low_quantity_alert_events (
  id uuid primary key default gen_random_uuid(),
  bottle_id uuid not null references public.bottles(id) on delete cascade,
  crossing_generation integer not null default 1,
  remaining_quantity numeric not null,
  quantity_unit text,
  capacity numeric not null,
  capacity_unit text,
  remaining_percentage numeric not null,
  created_at timestamptz not null default now()
);

alter table public.low_quantity_alert_events
  add column if not exists crossing_generation integer;

update public.low_quantity_alert_events e
set crossing_generation = numbered.generation
from (
  select id,
         row_number() over (partition by bottle_id order by created_at, id)::integer as generation
  from public.low_quantity_alert_events
  where crossing_generation is null
) numbered
where e.id = numbered.id;

alter table public.low_quantity_alert_events
  alter column crossing_generation set default 1;

update public.low_quantity_alerts a
set crossing_generation = greatest(
  a.crossing_generation,
  coalesce((
    select max(e.crossing_generation)
    from public.low_quantity_alert_events e
    where e.bottle_id = a.bottle_id
  ), 0)
);

create index if not exists low_quantity_alerts_active_idx
  on public.low_quantity_alerts (is_active);
create index if not exists low_quantity_alert_events_bottle_idx
  on public.low_quantity_alert_events (bottle_id, created_at desc);

alter table public.low_quantity_alerts enable row level security;
alter table public.low_quantity_alert_events enable row level security;

drop policy if exists "active users read low quantity alerts" on public.low_quantity_alerts;
create policy "active users read low quantity alerts"
on public.low_quantity_alerts
for select to authenticated
using (
  public.is_active_user()
  and exists (
    select 1 from public.bottles b
    where b.id = low_quantity_alerts.bottle_id
      and b.is_archived = false
  )
);

drop policy if exists "active users read low quantity alert events" on public.low_quantity_alert_events;
create policy "active users read low quantity alert events"
on public.low_quantity_alert_events
for select to authenticated
using (
  public.is_active_user()
  and exists (
    select 1 from public.bottles b
    where b.id = low_quantity_alert_events.bottle_id
      and b.is_archived = false
  )
);

grant select on public.low_quantity_alerts, public.low_quantity_alert_events to authenticated;
revoke insert, update, delete on public.low_quantity_alerts from anon, authenticated;
revoke insert, update, delete on public.low_quantity_alert_events from anon, authenticated;

create or replace function public.sync_low_quantity_alert(p_bottle_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bottle_row public.bottles;
  previous_active boolean;
  threshold numeric;
  remaining_percent numeric;
  capacity_is_valid boolean;
  current_active boolean;
  next_generation integer;
begin
  select * into bottle_row
  from public.bottles
  where id = p_bottle_id
  for update;

  if not found then
    return;
  end if;

  insert into public.low_quantity_alerts (bottle_id)
  values (bottle_row.id)
  on conflict (bottle_id) do nothing;

  select is_active, threshold_percent
  into previous_active, threshold
  from public.low_quantity_alerts
  where bottle_id = bottle_row.id
  for update;

  capacity_is_valid :=
    bottle_row.is_archived = false
    and bottle_row.bottle_size is not null
    and bottle_row.bottle_size > 0
    and bottle_row.current_quantity is not null
    and bottle_row.current_quantity >= 0
    and bottle_row.quantity_unit is not null
    and bottle_row.bottle_size_unit is not null
    and lower(trim(bottle_row.quantity_unit)) = lower(trim(bottle_row.bottle_size_unit));

  if capacity_is_valid then
    remaining_percent := (bottle_row.current_quantity / bottle_row.bottle_size) * 100;
  else
    remaining_percent := null;
  end if;

  current_active := capacity_is_valid and remaining_percent < threshold;

  if current_active and not coalesce(previous_active, false) then
    select crossing_generation + 1 into next_generation
    from public.low_quantity_alerts
    where bottle_id = bottle_row.id
    for update;

    insert into public.low_quantity_alert_events (
      bottle_id, crossing_generation, remaining_quantity, quantity_unit,
      capacity, capacity_unit, remaining_percentage
    )
    values (
      bottle_row.id, next_generation, bottle_row.current_quantity,
      bottle_row.quantity_unit, bottle_row.bottle_size,
      bottle_row.bottle_size_unit, remaining_percent
    )
    on conflict do nothing;

    update public.low_quantity_alerts
    set crossing_generation = next_generation,
        remaining_percentage = remaining_percent,
        is_active = true,
        first_triggered_at = coalesce(first_triggered_at, now()),
        last_triggered_at = now(),
        resolved_at = null,
        updated_at = now()
    where bottle_id = bottle_row.id;
  elsif not current_active then
    update public.low_quantity_alerts
    set remaining_percentage = remaining_percent,
        is_active = false,
        resolved_at = case when coalesce(previous_active, false) then now() else resolved_at end,
        updated_at = now()
    where bottle_id = bottle_row.id;
  else
    update public.low_quantity_alerts
    set remaining_percentage = remaining_percent,
        updated_at = now()
    where bottle_id = bottle_row.id;
  end if;
end;
$$;

create or replace function public.refresh_low_quantity_alert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sync_low_quantity_alert(new.id);
  return new;
end;
$$;

revoke all on function public.sync_low_quantity_alert(uuid) from public, anon, authenticated;
revoke all on function public.refresh_low_quantity_alert() from public, anon, authenticated;

drop trigger if exists bottles_refresh_low_quantity_alert on public.bottles;
create trigger bottles_refresh_low_quantity_alert
after insert or update of current_quantity, bottle_size, bottle_size_unit, quantity_unit, is_archived
on public.bottles
for each row
execute function public.refresh_low_quantity_alert();

-- Backfill alert state for existing real bottles without updating bottles.
do $$
declare
  existing_bottle_id uuid;
begin
  for existing_bottle_id in select id from public.bottles loop
    perform public.sync_low_quantity_alert(existing_bottle_id);
  end loop;
end;
$$;

create table if not exists public.low_quantity_alert_events (
  id uuid primary key default gen_random_uuid(),
  bottle_id uuid not null references public.bottles(id) on delete cascade,
  remaining_quantity numeric not null,
  quantity_unit text,
  capacity numeric not null,
  capacity_unit text,
  remaining_percentage numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists low_quantity_alerts_active_idx
  on public.low_quantity_alerts (is_active);
create index if not exists low_quantity_alert_events_bottle_idx
  on public.low_quantity_alert_events (bottle_id, created_at desc);

alter table public.low_quantity_alerts enable row level security;
alter table public.low_quantity_alert_events enable row level security;

drop policy if exists "active users read low quantity alerts" on public.low_quantity_alerts;
create policy "active users read low quantity alerts"
on public.low_quantity_alerts
for select
to authenticated
using (
  public.is_active_user()
  and exists (
    select 1 from public.bottles b
    where b.id = low_quantity_alerts.bottle_id
      and b.is_archived = false
  )
);

drop policy if exists "active users read low quantity alert events" on public.low_quantity_alert_events;
create policy "active users read low quantity alert events"
on public.low_quantity_alert_events
for select
to authenticated
using (
  public.is_active_user()
  and exists (
    select 1 from public.bottles b
    where b.id = low_quantity_alert_events.bottle_id
      and b.is_archived = false
  )
);

revoke insert, update, delete on public.low_quantity_alerts from anon, authenticated;
revoke insert, update, delete on public.low_quantity_alert_events from anon, authenticated;

create or replace function public.refresh_low_quantity_alert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  previous_active boolean;
  current_active boolean;
  remaining_percent numeric;
  capacity_is_valid boolean;
  alert_threshold numeric;
begin
  insert into public.low_quantity_alerts (bottle_id, updated_at)
  values (new.id, now())
  on conflict (bottle_id) do nothing;

  select is_active, threshold_percent
  into previous_active, alert_threshold
  from public.low_quantity_alerts
  where bottle_id = new.id
  for update;

  capacity_is_valid :=
    new.is_archived = false
    and new.bottle_size is not null
    and new.bottle_size > 0
    and new.current_quantity is not null
    and new.current_quantity >= 0
    and new.quantity_unit is not null
    and new.bottle_size_unit is not null
    and lower(trim(new.quantity_unit)) = lower(trim(new.bottle_size_unit));

  if capacity_is_valid then
    remaining_percent := (new.current_quantity / new.bottle_size) * 100;
  else
    remaining_percent := null;
  end if;

  current_active := capacity_is_valid and remaining_percent < alert_threshold;

  if current_active and not coalesce(previous_active, false) then
    insert into public.low_quantity_alert_events (
      bottle_id, remaining_quantity, quantity_unit, capacity,
      capacity_unit, remaining_percentage
    )
    values (
      new.id, new.current_quantity, new.quantity_unit, new.bottle_size,
      new.bottle_size_unit, remaining_percent
    );

    update public.low_quantity_alerts
    set remaining_percentage = remaining_percent,
        is_active = true,
        first_triggered_at = coalesce(first_triggered_at, now()),
        last_triggered_at = now(),
        resolved_at = null,
        updated_at = now()
    where bottle_id = new.id;
  elsif not current_active then
    update public.low_quantity_alerts
    set remaining_percentage = remaining_percent,
        is_active = false,
        resolved_at = case when coalesce(previous_active, false) then now() else resolved_at end,
        updated_at = now()
    where bottle_id = new.id;
  else
    update public.low_quantity_alerts
    set remaining_percentage = remaining_percent,
        updated_at = now()
    where bottle_id = new.id;
  end if;

  return new;
end;
$$;

revoke all on function public.refresh_low_quantity_alert() from public, anon, authenticated;

drop trigger if exists bottles_refresh_low_quantity_alert on public.bottles;
create trigger bottles_refresh_low_quantity_alert
after insert or update of current_quantity, bottle_size, bottle_size_unit, quantity_unit, is_archived
on public.bottles
for each row
execute function public.refresh_low_quantity_alert();

-- Initialize alert state for existing real bottles without changing inventory values.
update public.bottles
set current_quantity = current_quantity
where is_archived = false;
