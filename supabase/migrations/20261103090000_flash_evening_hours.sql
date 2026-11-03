-- Labventory: extend Flash chromatography booking hours from 09:00-18:00 to 09:00-22:00 (IST).
--
-- Only the closing hour changes. book_flash_slots reads close_hour from flash_config(), so it now
-- accepts slots up to 21:00-22:00 and still rejects anything starting before 09:00 or ending after
-- 22:00. Slot length (1 hour), max 3 consecutive slots, 60 days ahead, the one-booking-per-slot
-- index and existing bookings are untouched. `create or replace` keeps the function's grants.
-- Requires 20261018180000_flash_chromatography.sql.

create or replace function public.flash_config() returns jsonb
language sql immutable as $$
  select jsonb_build_object('timezone', 'Asia/Kolkata', 'open_hour', 9, 'close_hour', 22, 'max_slots', 3, 'max_days_ahead', 60)
$$;
