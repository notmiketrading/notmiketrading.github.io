-- =============================================================================
-- nmt-control state
--
-- Run this in the SQL Editor of nmt-control. Not Killzonda. Nothing in here
-- touches Killzonda, which stays read-only for the whole of this project.
--
-- The rundown needs memory, and that is the only reason these tables exist.
-- Three of its rules cannot be answered from customer data alone:
--
--   "second follow-ups due 10 days after the first was ACTUALLY SENT"
--       The clock starts when Mike sends, not when someone became eligible,
--       so the send has to be recorded somewhere.
--
--   "overdue follow-ups remain visible until Mike confirms sending them"
--       Something has to hold that confirmation.
--
--   "I track previously reported customers to avoid duplicates"
--       A rundown that forgets repeats itself every morning.
--
-- That memory belongs here rather than in Killzonda, because writing to
-- Killzonda is exactly what we agreed not to do.
--
-- RLS is on with no policies, deliberately. That is not an oversight: with
-- RLS enabled and nothing granted, the publishable key in the public page can
-- read none of it. Only the Edge Function, holding a secret key, can. The
-- browser has no business reading this and now cannot.
-- =============================================================================

-- Who has actually been emailed, and when ------------------------------------
create table if not exists nudge_log (
  id             bigint generated always as identity primary key,
  customer_email text        not null,
  stage          smallint    not null check (stage in (1, 2)),
  sent_at        timestamptz not null default now(),
  note           text,
  -- one row per person per stage: confirming twice is not two nudges
  unique (customer_email, stage)
);

comment on table nudge_log is
  'Follow-ups Mike has confirmed sending. sent_at starts the 10 day clock for stage 2.';

create index if not exists nudge_log_email_idx on nudge_log (customer_email);

-- Anyone who should never appear in a follow-up list --------------------------
create table if not exists exclusions (
  customer_email text primary key,
  reason         text        not null,
  added_at       timestamptz not null default now()
);

comment on table exclusions is
  'Test accounts, friends, duplicates, finished sequences. Excluded from follow-ups and from customer totals where the reason is test.';

-- What has already been reported, so no morning repeats itself ---------------
create table if not exists reported (
  customer_email text        not null,
  kind           text        not null check (kind in ('signup', 'premium', 'cancelled')),
  reported_at    timestamptz not null default now(),
  primary key (customer_email, kind)
);

comment on table reported is
  'A customer appears in a given section once. Keyed by kind so the same person can show up as a signup and later as premium.';

-- Lock all three to the server ------------------------------------------------
alter table nudge_log  enable row level security;
alter table exclusions enable row level security;
alter table reported   enable row level security;

-- No policies on purpose. Enabled RLS with zero policies denies everything
-- that is not using a key which bypasses it. The Edge Function holds such a
-- key; the public page holds a publishable one and gets nothing.

-- Seed the exclusions you already know about. Edit the addresses, or delete
-- these lines and add them from the dashboard later.
-- insert into exclusions (customer_email, reason) values
--   ('test@example.com', 'test'),
--   ('afriend@example.com', 'friend')
-- on conflict (customer_email) do nothing;
