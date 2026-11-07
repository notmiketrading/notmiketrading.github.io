-- =============================================================================
-- bot_reports
--
-- Run this in the SQL Editor of nmt-control. Not Killzonda.
--
-- The bots currently record nothing, so there is nothing for a dashboard to
-- read. This is the place they report into. Each row is one bot saying what it
-- is doing at a moment in time; the dashboard reads the most recent row per
-- bot and works out whether anything has gone quiet.
--
-- metrics is jsonb on purpose. What a trading bot wants to report will change,
-- and a fixed set of columns would mean a migration every time a bot learns to
-- count something new. The dashboard renders whatever keys it finds.
--
-- RLS on with no policies, same as the other tables here: the publishable key
-- in the public page can read none of it, and only the Edge Functions, which
-- hold a secret key, can.
-- =============================================================================

create table if not exists bot_reports (
  id       bigint generated always as identity primary key,
  bot      text        not null,
  at       timestamptz not null default now(),
  status   text        not null default 'ok',
  metrics  jsonb       not null default '{}'::jsonb,
  note     text
);

comment on table bot_reports is
  'One row per bot heartbeat. The dashboard reads the latest per bot and flags silence.';

-- The only query the dashboard makes is "latest row per bot", so index for it.
create index if not exists bot_reports_bot_at_idx on bot_reports (bot, at desc);

-- A bot reporting every minute is -500k rows a year, which is pointless to
-- keep. Nothing deletes automatically; this is here for when it matters.
--   delete from bot_reports where at < now() - interval '30 days';

alter table bot_reports enable row level security;

-- No policies, deliberately. Enabled RLS with none denies everything that is
-- not using a key which bypasses it.
