// =============================================================================
// send-followups
//
// Drains email_queue in nmt-control and sends through Hostinger. Runs from a
// GitHub Action, not from Supabase: Supabase documents outgoing ports 25, 465
// and 587 as blocked for Edge Functions, so SMTP does not reliably work there.
// A runner has no such restriction.
//
// It composes nothing and decides nothing. Every row it sends is one Mike read
// and approved in the dashboard; this only carries it the last step.
//
// Environment (all from GitHub Actions secrets):
//   SUPABASE_URL        https://<ref>.supabase.co   (nmt-control, not Killzonda)
//   CONTROL_SECRET_KEY  sb_secret_... for nmt-control
//   SMTP_USER           support@killzonda.com
//   SMTP_PASS           that mailbox's password
//   DRY_RUN             'true' to do everything except hand it to the server
// =============================================================================

import nodemailer from "nodemailer";

const {
  SUPABASE_URL = "",
  CONTROL_SECRET_KEY = "",
  SMTP_USER = "",
  SMTP_PASS = "",
  DRY_RUN = "",
} = process.env;

// A blast radius. If something ever goes wrong upstream and a thousand rows
// appear, this run sends twenty of them and the next run is fifteen minutes
// away, which is enough time for a person to notice and turn it off.
const MAX_PER_RUN = 20;
const MAX_ATTEMPTS = 3;

const dry = DRY_RUN.toLowerCase() === "true";
const base = SUPABASE_URL.replace(/\/$/, "");

for (const [k, v] of Object.entries({ SUPABASE_URL, CONTROL_SECRET_KEY, SMTP_USER, SMTP_PASS })) {
  if (!v) {
    console.error(`${k} is not set. Add it to this repository's Actions secrets.`);
    process.exit(1);
  }
}

const rest = (path, init = {}) =>
  fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: CONTROL_SECRET_KEY,
      Authorization: `Bearer ${CONTROL_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const fail = async (res, what) => {
  const detail = (await res.text()).slice(0, 300);
  throw new Error(`${what}: ${res.status} ${detail}`);
};

// ---- what is waiting --------------------------------------------------------
const listed = await rest(
  `email_queue?status=eq.approved&order=approved_at.asc&limit=${MAX_PER_RUN}` +
    `&select=id,customer_email,customer_name,kind,ref,subject,body,attempts`,
);
if (!listed.ok) await fail(listed, "could not read email_queue");
const queue = await listed.json();

if (queue.length === 0) {
  console.log("Nothing approved. Exiting.");
  process.exit(0);
}
console.log(`${queue.length} approved${dry ? " (DRY RUN: nothing will be sent)" : ""}`);

// ---- the connection ---------------------------------------------------------
// 465 with SSL is Hostinger's documented default. 587 with STARTTLS is their
// own fallback for encryption errors, so it is worth one retry rather than a
// failed run and a confused look at the log.
const makeTransport = (port) =>
  nodemailer.createTransport({
    host: "smtp.hostinger.com",
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

let transport = makeTransport(465);
if (!dry) {
  try {
    await transport.verify();
    console.log("SMTP ready on 465");
  } catch (e) {
    console.log(`465 refused (${e.message}); trying 587`);
    transport = makeTransport(587);
    await transport.verify();
    console.log("SMTP ready on 587");
  }
}

// ---- send ------------------------------------------------------------------
let sent = 0, failed = 0, skipped = 0;

for (const row of queue) {
  // Claim it first. A PATCH filtered on status=eq.approved is atomic: if a
  // second run got here first, this updates nothing and returns an empty
  // array, and we leave it alone rather than sending it twice.
  const claim = await rest(`email_queue?id=eq.${row.id}&status=eq.approved`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "sending" }),
  });
  if (!claim.ok) await fail(claim, `could not claim row ${row.id}`);
  if ((await claim.json()).length === 0) {
    console.log(`#${row.id} already claimed by another run, leaving it`);
    skipped++;
    continue;
  }

  const to = row.customer_name
    ? `"${row.customer_name.replace(/"/g, "")}" <${row.customer_email}>`
    : row.customer_email;

  try {
    if (dry) {
      console.log(`DRY RUN would send to ${row.customer_email}: ${row.subject}`);
    } else {
      await transport.sendMail({
        from: `"Killzonda" <${SMTP_USER}>`,
        to,
        replyTo: SMTP_USER,
        subject: row.subject,
        text: row.body,
      });
    }

    await rest(`email_queue?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: dry ? "approved" : "sent",
        sent_at: dry ? null : new Date().toISOString(),
        // A dry run must not spend an attempt, or three rehearsals would push
        // a perfectly good row towards 'failed' without anything being wrong.
        attempts: dry ? row.attempts : row.attempts + 1,
        last_error: null,
      }),
    });

    // The dashboard's follow-up list filters on sent_log, so this is what
    // actually makes the row disappear from it.
    if (!dry) {
      await rest("sent_log?on_conflict=customer_email,kind,ref", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          customer_email: row.customer_email,
          kind: row.kind,
          ref: row.ref ?? "",
          via: "auto",
          note: row.subject,
        }),
      });
    }

    sent++;
    console.log(`sent #${row.id} to ${row.customer_email}`);
  } catch (e) {
    const attempts = row.attempts + 1;
    const done = attempts >= MAX_ATTEMPTS;
    await rest(`email_queue?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        // Back to approved so the next run retries, until it has had enough
        // goes to be a real problem rather than a blip.
        status: done ? "failed" : "approved",
        attempts,
        last_error: String(e.message ?? e).slice(0, 400),
      }),
    });
    failed++;
    console.error(`FAILED #${row.id} (attempt ${attempts}${done ? ", giving up" : ""}): ${e.message}`);
  }
}

console.log(`done: ${sent} sent, ${failed} failed, ${skipped} skipped`);
// A failure here is worth a red tick in the Actions tab rather than a silent
// green one. The whole point of this project has been errors that announce
// themselves.
if (failed > 0) process.exit(1);
