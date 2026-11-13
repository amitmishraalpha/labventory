-- Allow same-day retrospective Flash bookings while preserving atomic conflicts.
alter table public.flash_bookings
  add column if not exists booking_type text not null default 'ADVANCE'
  check (booking_type in ('ADVANCE', 'RETROSPECTIVE'));

create index if not exists flash_bookings_type_idx on public.flash_bookings (booking_type, slot_start);

create or replace function public.book_flash_slots(p_date date, p_start_hour integer, p_slots integer, p_purpose text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  cfg jsonb := public.flash_config();
  v_tz text := cfg->>'timezone';
  v_open integer := (cfg->>'open_hour')::integer;
  v_close integer := (cfg->>'close_hour')::integer;
  v_start timestamptz;
  v_type text;
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
  if p_date < (now() at time zone v_tz)::date then raise exception 'DATE_IN_PAST: retrospective booking is limited to today'; end if;
  if p_date > (now() at time zone v_tz)::date + (cfg->>'max_days_ahead')::integer then
    raise exception 'TOO_FAR_AHEAD: bookings open % days in advance', cfg->>'max_days_ahead';
  end if;

  v_start := (p_date + make_time(p_start_hour, 0, 0)) at time zone v_tz;
  v_type := case when v_start < now() then 'RETROSPECTIVE' else 'ADVANCE' end;

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
      insert into public.flash_bookings (booking_group, user_id, booked_by_name, slot_start, slot_end, purpose, booking_type)
      values (v_group, auth.uid(), v_name, v_start + make_interval(hours => i), v_start + make_interval(hours => i + 1), nullif(btrim(coalesce(p_purpose, '')), ''), v_type);
    end loop;
  exception when unique_violation then
    raise exception 'SLOT_TAKEN: one of these slots was just booked by someone else';
  end;

  insert into public.activity_log (actor_user_id, action_type, entity_type, entity_id, metadata)
  values (auth.uid(), 'FLASH_BOOKED', 'flash_booking', v_group,
    jsonb_build_object('date', p_date, 'start_hour', p_start_hour, 'slots', p_slots, 'purpose', nullif(btrim(coalesce(p_purpose, '')), ''), 'booking_type', v_type));
  return jsonb_build_object('booking_group', v_group, 'start', v_start, 'end', v_start + make_interval(hours => p_slots), 'slots', p_slots, 'booking_type', v_type);
end;
$$;
revoke all on function public.book_flash_slots(date, integer, integer, text) from public, anon;
grant execute on function public.book_flash_slots(date, integer, integer, text) to authenticated;

notify pgrst, 'reload schema';
