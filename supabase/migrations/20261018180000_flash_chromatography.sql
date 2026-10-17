-- Labventory: Flash chromatography slot booking.
--
-- * flash_bookings: one row per 1-hour slot. A booking of 2-3 hours is 2-3 rows that
--   share booking_group. A partial unique index allows only one live (not cancelled)
--   booking per slot, so two people can never hold the same hour, even when they click
--   at the same moment.
-- * flash_holidays: dates on which the instrument cannot be booked. Filled from Google
--   Calendar's public Indian holidays ("Public holiday" entries only) by the
--   sync-flash-holidays Edge Function, plus lab closures added by the Admin.
-- * Every active user can see all bookings and holidays. Nobody writes the tables
--   directly: booking, cancelling and holiday changes go through the functions below.
-- Requires 20261018090000 (is_active_user, is_admin, activity_log).

-- Single source of truth for the booking rules (the app reads the same values).
create or replace function public.flash_config() returns jsonb
language sql immutable as $$
  select jsonb_build_object('timezone', 'Asia/Kolkata', 'open_hour', 9, 'close_hour', 18, 'max_slots', 3, 'max_days_ahead', 60)
$$;
grant execute on function public.flash_config() to authenticated;

create table if not exists public.flash_holidays (
  holiday_date date primary key,
  name text not null,
  source text not null default 'google' check (source in ('google', 'admin')),
  updated_at timestamptz not null default now()
);

create table if not exists public.flash_bookings (
  id uuid primary key default gen_random_uuid(),
  booking_group uuid not null,
  user_id uuid not null references public.profiles(id),
  booked_by_name text not null,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  purpose text,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  constraint flash_slot_is_one_hour check (slot_end = slot_start + interval '1 hour'),
  -- Whole hours in lab time (IST is UTC+05:30, so this must not use the session time zone).
  constraint flash_slot_on_the_hour check (date_trunc('hour', slot_start at time zone 'Asia/Kolkata') = slot_start at time zone 'Asia/Kolkata')
);
create unique index if not exists flash_bookings_one_per_slot on public.flash_bookings (slot_start) where cancelled_at is null;
create index if not exists flash_bookings_user_idx on public.flash_bookings (user_id, slot_start);
create index if not exists flash_bookings_group_idx on public.flash_bookings (booking_group);

alter table public.flash_bookings enable row level security;
alter table public.flash_holidays enable row level security;
drop policy if exists "active users read flash bookings" on public.flash_bookings;
create policy "active users read flash bookings" on public.flash_bookings for select to authenticated using (public.is_active_user());
drop policy if exists "active users read flash holidays" on public.flash_holidays;
create policy "active users read flash holidays" on public.flash_holidays for select to authenticated using (public.is_active_user());
revoke all on public.flash_bookings, public.flash_holidays from anon;
revoke insert, update, delete, truncate on public.flash_bookings, public.flash_holidays from authenticated;
grant select on public.flash_bookings, public.flash_holidays to authenticated;

-- Book 1-3 consecutive one-hour slots starting at p_start_hour (lab time) on p_date.
create or replace function public.book_flash_slots(p_date date, p_start_hour integer, p_slots integer, p_purpose text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
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
$$;
revoke all on function public.book_flash_slots(date, integer, integer, text) from public, anon;
grant execute on function public.book_flash_slots(date, integer, integer, text) to authenticated;

-- Cancel a whole booking. The booker can cancel before it starts; the Admin can cancel any.
create or replace function public.cancel_flash_booking(p_booking_group uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
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
$$;
revoke all on function public.cancel_flash_booking(uuid) from public, anon;
grant execute on function public.cancel_flash_booking(uuid) to authenticated;

-- Admin lab closures (source 'admin' rows are never touched by the Google sync).
create or replace function public.set_flash_holiday(p_date date, p_name text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'ONLY_ADMIN' using errcode = '42501'; end if;
  if p_date is null or nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'DATE_AND_NAME_REQUIRED'; end if;
  insert into public.flash_holidays (holiday_date, name, source) values (p_date, btrim(p_name), 'admin')
  on conflict (holiday_date) do update set name = excluded.name, source = 'admin', updated_at = now();
  insert into public.activity_log (actor_user_id, action_type, metadata) values (auth.uid(), 'FLASH_HOLIDAY_SET', jsonb_build_object('date', p_date, 'name', btrim(p_name)));
end;
$$;
create or replace function public.remove_flash_holiday(p_date date)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'ONLY_ADMIN' using errcode = '42501'; end if;
  delete from public.flash_holidays where holiday_date = p_date;
  insert into public.activity_log (actor_user_id, action_type, metadata) values (auth.uid(), 'FLASH_HOLIDAY_REMOVED', jsonb_build_object('date', p_date));
end;
$$;
revoke all on function public.set_flash_holiday(date, text), public.remove_flash_holiday(date) from public, anon;
grant execute on function public.set_flash_holiday(date, text), public.remove_flash_holiday(date) to authenticated;

-- Called by the sync-flash-holidays Edge Function (service role) with the parsed Google
-- Calendar public holidays: [{"date":"2026-10-20","name":"Dussehra"}, ...]. Replaces the
-- Google-sourced rows from p_from onwards; Admin closures are kept.
create or replace function public.replace_google_holidays(p_rows jsonb, p_from date, p_actor uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
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
$$;
revoke all on function public.replace_google_holidays(jsonb, date, uuid) from public, anon, authenticated;
grant execute on function public.replace_google_holidays(jsonb, date, uuid) to service_role;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['flash_bookings', 'flash_holidays'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

notify pgrst, 'reload schema';
