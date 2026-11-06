// =============================================================================
// dash-metrics
//
// Everything the dashboard knows comes through here. The page cannot read a
// table on its own, so this function is the only place that decides access.
//
// It runs in nmt-control, a Supabase project of its own. Killzonda is not
// referenced in this file and is not touched by it. When Killzonda data is
// added later it will be read through a credential held in the secrets below,
// a read-only database user that can select and nothing else.
//
// The gate is the ADMIN_EMAIL check in the handler. It runs on the server,
// reads a secret the browser never receives, and refuses before a single
// figure is gathered. An unset ADMIN_EMAIL returns an error rather than
// letting everyone through, because a missing secret must never read as
// "allow".
//
// No imports, on purpose. The first version pulled the Supabase SDK from JSR
// and built a client from SUPABASE_ANON_KEY, and every call came back as a
// bare 500: a project on the newer sb_publishable key format does not
// necessarily get that variable injected, so the client threw before the
// handler ever ran. Checking who is calling is one HTTP request, so it is done
// with fetch and this file now has no dependencies to go stale or disappear.
//
// Deploy: Supabase dashboard -> Edge Functions -> Deploy a new function ->
// via Editor. Name it exactly "dash-metrics". Leave the index.ts the editor
// creates where it is and paste over its contents.
//
// Secrets (Edge Functions -> Secrets). None of these reach the browser:
//   ADMIN_EMAIL             the email you log in with
//   STRIPE_RESTRICTED_KEY   a restricted, read-only key. Optional until added.
// =============================================================================

const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") ?? "").trim().toLowerCase();
const STRIPE_KEY = Deno.env.get("STRIPE_RESTRICTED_KEY") ?? "";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");

const ALLOWED_ORIGINS = [
  "https://notmiketrading.com",
  "https://www.notmiketrading.com",
  "http://localhost:8917",
];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

// A panel either has data or says plainly why it does not. It never guesses,
// and one broken source never takes the others down with it.
type Panel = { ok: true; data: unknown } | { ok: false; reason: string };
const waiting = (reason: string): Panel => ({ ok: false, reason });

// ---------------------------------------------------------------- Stripe ---
async function stripe(path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

// Stripe states an interval and an amount; MRR needs one common unit.
function monthly(price: { unit_amount?: number; recurring?: { interval?: string; interval_count?: number } }) {
  const cents = price.unit_amount ?? 0;
  const n = price.recurring?.interval_count ?? 1;
  switch (price.recurring?.interval) {
    case "year": return cents / (12 * n);
    case "week": return (cents * 52) / (12 * n);
    case "day": return (cents * 365) / (12 * n);
    default: return cents / n;
  }
}

async function couponRedemptions(): Promise<number | null> {
  try {
    const list = await stripe("promotion_codes?code=NMT&limit=1");
    const pc = (list.data ?? [])[0];
    return pc ? (pc.times_redeemed ?? 0) : null;
  } catch { return null; }
}

// ----------------------------------------------------------- trial funnel ---
// Killzonda's trial takes a card at the start, so "signed up" and "started a
// trial" are two different events with a real gap between them. That gap is
// the number worth watching, and Stripe can only see the second one: a person
// who made an account and never entered a card has no Stripe record at all.
// So accounts come from Killzonda and the rest comes from here.
async function trialPanel(): Promise<Panel> {
  if (!STRIPE_KEY) return waiting("Add STRIPE_RESTRICTED_KEY to this function's secrets.");

  const now = Math.floor(Date.now() / 1000);
  const trialing = await stripe("subscriptions?status=trialing&limit=100");
  const active = await stripe("subscriptions?status=active&limit=100");
  const gone = await stripe("subscriptions?status=canceled&limit=100");

  const inTrial = (trialing.data ?? []).length;

  // An active subscription whose trial_end has passed converted.
  const converted = (active.data ?? [])
    .filter((x: { trial_end?: number }) => x.trial_end && x.trial_end < now).length;

  // Cancelled on or before the trial ended: they decided during the seven days.
  // canceled_at is when they asked, which is the decision we care about, not
  // ended_at, which is usually just trial_end for these.
  const lapsed = (gone.data ?? [])
    .filter((x: { trial_end?: number; canceled_at?: number }) =>
      x.trial_end && x.canceled_at && x.canceled_at <= x.trial_end).length;

  const decided = converted + lapsed;

  return {
    ok: true,
    data: {
      inTrial,
      converted,
      lapsed,
      everStarted: inTrial + converted + lapsed,
      // Only over people whose seven days are actually up. Counting those still
      // inside their trial as failures would understate this every single day.
      conversion: decided ? converted / decided : null,
      accounts: null,
      accountsNote: "Accounts come from Killzonda, which is not connected yet.",
    },
  };
}

// Lifetime revenue. MRR is what recurs; this is what has actually arrived, so
// it comes from charges rather than subscriptions and needs Charges: Read on
// the restricted key. Refunds are subtracted. Stripe pages at 100, so this
// walks them, with a ceiling: at some volume this stops being a thing you do
// on a dashboard request, and reporting a truncated figure as if it were the
// whole would be worse than saying so.
async function totalRevenue(): Promise<{ cents: number; complete: boolean }> {
  let cents = 0;
  let after: string | null = null;
  let complete = false;

  for (let page = 0; page < 20; page++) {
    const q: string = "charges?limit=100" + (after ? "&starting_after=" + after : "");
    const batch = await stripe(q);
    const rows = batch.data ?? [];

    for (const c of rows) {
      if (c.status === "succeeded" && c.paid) {
        cents += (c.amount ?? 0) - (c.amount_refunded ?? 0);
      }
    }

    if (!batch.has_more || rows.length === 0) { complete = true; break; }
    after = rows[rows.length - 1].id;
  }

  return { cents, complete };
}

async function revenuePanel(): Promise<Panel> {
  if (!STRIPE_KEY) return waiting("Add STRIPE_RESTRICTED_KEY to this function's secrets.");

  const active = await stripe("subscriptions?status=active&limit=100&expand[]=data.items.data.price");
  const trialing = await stripe("subscriptions?status=trialing&limit=100");

  let cents = 0;
  for (const sub of active.data ?? []) {
    for (const item of sub.items?.data ?? []) cents += monthly(item.price) * (item.quantity ?? 1);
  }

  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const gone = await stripe(`subscriptions?status=canceled&limit=100&created[gte]=${since}`);
  const lost = (gone.data ?? []).length;
  const subs = (active.data ?? []).length;
  const base = subs + lost;

  // Lifetime revenue is a separate question from MRR and a separate Stripe
  // permission. If the key cannot read charges, say so on that figure alone
  // rather than failing the whole panel.
  let total: number | null = null;
  let totalComplete = true;
  try {
    const t = await totalRevenue();
    total = t.cents / 100;
    totalComplete = t.complete;
  } catch {
    total = null;
  }

  return {
    ok: true,
    data: {
      mrr: cents / 100,
      total,
      totalComplete,
      subs,
      trials: (trialing.data ?? []).length,
      // Kept in the payload though the panel no longer shows them: the
      // playbook reads churn, and dropping it from the display should not
      // quietly disable a rule.
      arpu: subs ? cents / 100 / subs : null,
      churn: base ? lost / base : null,
      coupon: await couponRedemptions(),
    },
  };
}

// ------------------------------------------------------------------ main ---
Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");

  // Everything is wrapped. A throw in here used to surface as a bare 500 with
  // no body, which tells you nothing about what actually broke.
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

    if (!ADMIN_EMAIL) {
      return json({ error: "ADMIN_EMAIL is not set in this function's secrets." }, 500, origin);
    }
    if (!SUPABASE_URL) {
      return json({ error: "SUPABASE_URL is not available to this function." }, 500, origin);
    }

    // Who is calling? One request to the auth server using the caller's own
    // token. The gateway has already validated the apikey by this point.
    const apikey = req.headers.get("apikey") ?? "";
    const authz = req.headers.get("Authorization") ?? "";
    if (!authz) return json({ error: "not signed in" }, 401, origin);

    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey, Authorization: authz },
    });
    if (!who.ok) {
      return json({ error: "not signed in", detail: `auth said ${who.status}` }, 401, origin);
    }
    const user = await who.json();

    // The gate. Everything above this line is identity; this line is permission.
    if ((user?.email ?? "").toLowerCase() !== ADMIN_EMAIL) {
      return json({ error: "forbidden" }, 403, origin);
    }

    // Each source is gathered independently so one outage degrades one panel.
    const panels: Record<string, Panel> = {};
    const gather = async (name: string, fn: () => Promise<Panel>) => {
      try { panels[name] = await fn(); }
      catch (e) { panels[name] = waiting(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    };

    await Promise.all([
      gather("revenue", revenuePanel),
      gather("funnel", trialPanel),
      gather("traffic", async () =>
        waiting("Needs a GA4 service account and GA4_PROPERTY_ID in this function's secrets.")),
      // Four platforms, not five. X is left out on purpose: reading your own
      // analytics there needs their paid tier, and a panel that silently shows
      // nothing is worse than one that was never promised.
      gather("social", async () =>
        waiting("Needs YouTube, Instagram and TikTok API tokens in this function's secrets.")),
      gather("grok", async () =>
        waiting("Needs somewhere the bots write to. Nothing can be read until something is recorded.")),
      gather("outbox", async () =>
        waiting("Needs Stripe plus the Killzonda tables, to work out who is waiting on an email.")),
    ]);

    return json({ ok: true, at: new Date().toISOString(), panels }, 200, origin);
  } catch (e) {
    return json({ error: "unhandled", detail: e instanceof Error ? e.message : String(e) }, 500, origin);
  }
});
