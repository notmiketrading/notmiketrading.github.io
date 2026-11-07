-- =============================================================================
-- sent_log
--
-- Run this in the SQL Editor of nmt-control. Not Killzonda.
--
-- nudge_log already exists for the two-stage sequence aimed at free signups.
-- This is a different thing and deserves its own table rather than a widened
-- constraint on that one: these are one-off emails prompted by something that
-- happened in Stripe, and a person can legitimately need the same kind twice.
-- Somebody whose card fails in March and again in August is owed two emails,
-- not one, so idempotency is keyed on the Stripe object the email was about
-- rather than on the person.
--
--   ref   the subscription id the email concerns. Two past_due events on the
--         same subscription are the same event as far as this is concerned;
--         two different subscriptions are not.
--   via   'manual' when Mike pressed the button, 'auto' when a sender did it.
--         Worth keeping apart: if automatic sending ever misbehaves, this is
--         the column that says how much of it was automatic.
--
-- RLS on with no policies, same as every other table here. The publishable key
-- in the browser can read none of it; only a function holding a secret key can.
-- =============================================================================

create table if not exists sent_log (
  id             bigint generated always as identity primary key,
  customer_email text        not null,
  kind           text        not null,
  ref            text        not null default '',
  sent_at        timestamptz not null default now(),
  via            text        not null default 'manual' check (via in ('manual', 'auto')),
  note           text,
  -- one row per person per kind per Stripe object
  unique (customer_email, kind, ref)
);

comment on table sent_log is
  'Follow-ups prompted by Stripe that have gone out. The dashboard subtracts these from the needs-sending list.';

create index if not exists sent_log_sent_at_idx on sent_log (sent_at desc);

alter table sent_log enable row level security;

-- No policies, deliberately. Enabled RLS with none denies everything that is
-- not using a key which bypasses it.
