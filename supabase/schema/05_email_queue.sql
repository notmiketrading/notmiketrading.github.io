-- =============================================================================
-- email_queue
--
-- Run this in the SQL Editor of nmt-control. Not Killzonda.
--
-- The handoff between the dashboard and the sender. Mike reads a draft and
-- presses send; that writes one row here. A GitHub Action picks it up within
-- the quarter hour, sends it through Hostinger, and marks it.
--
-- Nothing composes a row on its own. A row existing here means a person read
-- the text and approved it, which is the whole reason this table sits between
-- the two halves rather than the sender reading the follow-up list directly.
--
-- Note what is NOT here: there is no 'draft' state. A draft that nobody has
-- approved is just the template plus the customer, and the function can
-- rebuild that from the follow-up list any time. Storing it would add a state
-- that can go stale and a second place for the same text to live.
--
--   approved  waiting for the sender
--   sending   a run has claimed it and is talking to Hostinger
--   sent      Hostinger accepted it
--   failed    three attempts, all refused. last_error says why.
--
-- 'sending' exists because the alternative is worse. The sender claims a row
-- by moving it out of 'approved' before it opens the connection, so two runs
-- overlapping cannot both send the same email. If a run dies mid-send the row
-- stays claimed and never goes out, which is the right direction to fail in:
-- a follow-up that silently did not send is a nuisance, and one that silently
-- sent twice is a customer wondering who else has their address.
--
-- RLS on with no policies, as everywhere else here. The browser cannot read
-- this; the Edge Function and the Action both hold secret keys.
-- =============================================================================

create table if not exists email_queue (
  id             bigint generated always as identity primary key,
  customer_email text        not null,
  customer_name  text,
  kind           text        not null,
  ref            text        not null default '',
  subject        text        not null,
  body           text        not null,
  status         text        not null default 'approved'
                   check (status in ('approved', 'sending', 'sent', 'failed')),
  approved_at    timestamptz not null default now(),
  sent_at        timestamptz,
  attempts       smallint    not null default 0,
  last_error     text,
  -- The same guarantee as sent_log, one layer earlier: approving twice is one
  -- email. Without this, a double click is two messages to a real customer.
  unique (customer_email, kind, ref)
);

comment on table email_queue is
  'Follow-ups Mike has read and approved. The GitHub Action drains status=approved and sends them.';

-- The sender's only query.
create index if not exists email_queue_pending_idx
  on email_queue (status, approved_at) where status = 'approved';

alter table email_queue enable row level security;

-- No policies, deliberately. Enabled RLS with none denies everything that is
-- not using a key which bypasses it.
