-- =============================================================================
-- Killzonda discovery
--
-- Run this in the SQL Editor of KILLZONDA. It is entirely read-only: it reads
-- the catalogue that describes your tables, not a single row of customer data.
-- Nothing is created, altered or deleted. Safe to run on production.
--
-- Paste the output back to Claude. It answers the questions the rundown cannot
-- be written without: which table holds accounts, what the signup timestamp is
-- called, how a free account is told apart from a premium one, and whether
-- trading activity is recorded anywhere.
--
-- No customer emails or names come back from this. Only structure.
-- =============================================================================

-- 1. every table and column in the public schema
select
  c.table_name,
  c.column_name,
  c.data_type,
  c.is_nullable
from information_schema.columns c
join information_schema.tables t
  on  t.table_schema = c.table_schema
  and t.table_name   = c.table_name
where c.table_schema = 'public'
  and t.table_type   = 'BASE TABLE'
order by c.table_name, c.ordinal_position;


-- 2. roughly how big each table is, so the account table is obvious
--    (reltuples is the planner's estimate, so this reads no rows either)
select
  relname as table_name,
  case when reltuples < 0 then null else reltuples::bigint end as approx_rows
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r'
order by reltuples desc;


-- 3. does auth.users line up with a profile table, and how many accounts exist
select count(*) as auth_users from auth.users;
