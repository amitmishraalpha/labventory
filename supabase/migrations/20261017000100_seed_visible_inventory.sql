-- DEVELOPMENT ONLY: sample records for a separate development database.
-- Do not run this file against a production inventory database.
insert into public.suppliers (vendor_name, normalized_name)
select seed.vendor_name, seed.normalized_name
from (values ('Spectrochem', 'spectrochem'), ('SRL', 'srl'), ('Merck', 'merck'), ('Sigma-Aldrich', 'sigma-aldrich')) as seed(vendor_name, normalized_name)
where not exists (select 1 from public.suppliers s where s.normalized_name = seed.normalized_name);

insert into public.locations (room, cabinet, shelf, tray, source_value)
select seed.room, seed.cabinet, seed.shelf, seed.tray, seed.source_value
from (values
  ('R1', 'Cabinet A', 'Shelf 1', 'T1', 'R1 / Cabinet A / Shelf 1 / T1'),
  ('R2', 'Cabinet C', 'Shelf 2', 'T3', 'R2 / Cabinet C / Shelf 2 / T3'),
  ('R1', 'Cabinet B', 'Shelf 2', 'T2', 'R1 / Cabinet B / Shelf 2 / T2'),
  ('R8', 'Cabinet A', 'Shelf 4', 'T1', 'R8 / Cabinet A / Shelf 4 / T1')
) as seed(room, cabinet, shelf, tray, source_value)
where not exists (select 1 from public.locations existing where existing.source_value = seed.source_value);

insert into public.chemicals (name, cas_number, molecular_formula)
select seed.name, seed.cas_number, seed.molecular_formula
from (values
  ('2-Chloroacetophenone', '532-27-4', 'C8H7ClO'),
  ('Acetonitrile', '75-05-8', 'C2H3N'),
  ('Sodium borohydride', '16940-66-2', 'NaBH4'),
  ('Ethanol absolute', '64-17-5', 'C2H6O')
) as seed(name, cas_number, molecular_formula)
where not exists (select 1 from public.chemicals existing where existing.cas_number = seed.cas_number);

insert into public.bottles (bottle_id, chemical_id, supplier_id, manufacturer, bottle_size, bottle_size_unit, current_quantity, initial_quantity, quantity_unit, expiry_date, location_id, status, qr_code)
select values_table.bottle_id, c.id, s.id, values_table.manufacturer, values_table.bottle_size, values_table.quantity_unit, values_table.current_quantity, values_table.initial_quantity, values_table.quantity_unit, values_table.expiry_date::date, l.id, values_table.status::bottle_status, values_table.bottle_id
from (values
  ('BTL-000023', '2-Chloroacetophenone', 'Spectrochem', 25::numeric, 25::numeric, 'g', '2027-04-18', 'Available'),
  ('BTL-000021', '2-Chloroacetophenone', 'SRL', 25::numeric, 5::numeric, 'g', '2026-11-02', 'Low Stock'),
  ('BTL-000114', 'Acetonitrile', 'Merck', 2::numeric, 1.2::numeric, 'L', '2026-10-24', 'Low Stock'),
  ('BTL-000207', 'Sodium borohydride', 'Sigma-Aldrich', 100::numeric, 100::numeric, 'g', '2026-09-30', 'Expired'),
  ('BTL-000088', 'Ethanol absolute', 'Merck', 4::numeric, 3.4::numeric, 'L', '2028-01-12', 'Available')
) as values_table(bottle_id, chemical_name, manufacturer, bottle_size, current_quantity, quantity_unit, expiry_date, status)
join public.chemicals c on c.name = values_table.chemical_name
join public.suppliers s on s.normalized_name = lower(values_table.manufacturer)
join public.locations l on l.source_value = case values_table.bottle_id
  when 'BTL-000023' then 'R1 / Cabinet A / Shelf 1 / T1'
  when 'BTL-000021' then 'R1 / Cabinet A / Shelf 1 / T1'
  when 'BTL-000114' then 'R2 / Cabinet C / Shelf 2 / T3'
  when 'BTL-000207' then 'R1 / Cabinet B / Shelf 2 / T2'
  else 'R8 / Cabinet A / Shelf 4 / T1' end
where not exists (select 1 from public.bottles b where b.bottle_id = values_table.bottle_id);
