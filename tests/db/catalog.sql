-- Builds a schema-only replica script of the live public schema (no data). Run via supabase db query.
with
enums as (
  select 0 ord, t.typname nm, format('create type public.%I as enum (%s);', t.typname, string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder)) ddl
  from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' group by t.typname),
tabs as (
  select 1 ord, c.relname nm, format('create table public.%I (%s);', c.relname, string_agg(format('%I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
    case when d.adbin is not null then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end, case when a.attnotnull then ' not null' else '' end), ', ' order by a.attnum)) ddl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind = 'r' group by c.relname),
funcs as (
  select 2 ord, p.proname nm, pg_get_functiondef(p.oid) || ';' ddl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and not exists (select 1 from pg_depend dp where dp.objid = p.oid and dp.deptype = 'e')),
cons as (
  select case when co.contype = 'f' then 4 else 3 end ord, co.conname nm, format('alter table public.%I add constraint %I %s;', c.relname, co.conname, pg_get_constraintdef(co.oid)) ddl
  from pg_constraint co join pg_class c on c.oid = co.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and co.contype in ('p','u','f','c')),
idx as (
  select 5 ord, i.indexname nm, i.indexdef || ';' ddl from pg_indexes i where i.schemaname = 'public'
  and not exists (select 1 from pg_constraint co where co.conname = i.indexname)),
views as (
  select 6 ord, c.relname nm, format('create view public.%I %s as %s', c.relname, coalesce('with (' || array_to_string(c.reloptions, ',') || ')', ''), pg_get_viewdef(c.oid)) ddl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v'),
rls as (
  select 7 ord, c.relname nm, format('alter table public.%I enable row level security;', c.relname) ddl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity),
pols as (
  select 8 ord, p.policyname nm, format('create policy %I on public.%I as %s for %s to %s%s%s;', p.policyname, p.tablename, p.permissive, p.cmd, array_to_string(p.roles, ','),
    coalesce(' using (' || p.qual || ')', ''), coalesce(' with check (' || p.with_check || ')', '')) ddl from pg_policies p where p.schemaname = 'public'),
trg as (
  select 9 ord, t.tgname nm, pg_get_triggerdef(t.oid) || ';' ddl from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal),
tgrants as (
  select 10 ord, table_name nm, format('grant %s on public.%I to %s;', string_agg(privilege_type, ', '), table_name, grantee) ddl
  from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role') group by table_name, grantee),
frevoke as (
  select 11 ord, p.proname nm, format('revoke all on function public.%I(%s) from public, anon, authenticated;', p.proname, pg_get_function_identity_arguments(p.oid)) ddl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and not exists (select 1 from pg_depend dp where dp.objid = p.oid and dp.deptype = 'e')),
fgrants as (
  select 12 ord, p.proname nm, format('grant execute on function public.%I(%s) to %s;', p.proname, pg_get_function_identity_arguments(p.oid), r.rolname) ddl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join pg_roles r
  where n.nspname = 'public' and p.prokind = 'f' and r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.oid, p.oid, 'execute')
  and not exists (select 1 from pg_depend dp where dp.objid = p.oid and dp.deptype = 'e')),
pubs as (
  select 13 ord, tablename nm, format('alter publication supabase_realtime add table public.%I;', tablename) ddl from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public')
select ord, nm, ddl from (select * from enums union all select * from tabs union all select * from funcs union all select * from cons union all select * from idx union all select * from views
  union all select * from rls union all select * from pols union all select * from trg union all select * from tgrants union all select * from frevoke union all select * from fgrants union all select * from pubs) x order by ord, nm;
