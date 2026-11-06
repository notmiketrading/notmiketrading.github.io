// =============================================================================
// dash-metrics
//
// The only thing standing between a Killzonda customer and Mike's revenue
// figures. Killzonda's own users live in this same Supabase project, so any
// customer can sign in and get a genuine session. That is fine and expected:
// authentication proves who you are, it does not say what you may see.
//
// The gate is the ADMIN_EMAIL check below. It runs on the server, reads a
// secret the browser never receives, and happens before a single byte of data
// is gathered. The dashboard page never queries a table directly, so this
// function is the one place that decides access. One check, one file.
//
// Deploy: Supabase dashboard -> Edge Functions -> Deploy a new function,
// name it exactly "dash-metrics", paste this file, deploy.
//
// Secrets it reads (Edge Functions -> Secrets). None of these ever reach the
// browser:
//   ADMIN_EMAIL             your email, lower case
//   STRIPE_RESTRICTED_KEY   a restricted key, read-only. Optional until added.
// SUPABASE_URL and SUPABASE_ANON_KEY are injected by Supabase automatically.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") ?? "").trim().toLowerCase();
const STRIPE_KEY = Deno.env.get("STRIPE_RESTRICTED_KEY") ?? "";

// The dashboard is served from the apex domain. Nothing else may call this.
const ALLOWED_ORIGINS = [
  "https://notmiketrading.com",
  "https://www.notmiketrading.com",
  "http://localhost:8917",
];

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

// A panel either has data or says plainly why it does not. It never guesses,
// and one broken source never takes the others down with it.
type Panel = { ok: true; data: unknown } | { ok: false; reason: string };
const waiting = (reason: string): Panel => ({ ok: false, reason });

// ---------------------------------------------------------------- Stripe ---
// Plain REST rather than the SDK: four endpoints, no dependency to keep current.
async function stripe(path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Stripe states an interval and an amount; MRR needs one common unit.
function monthlyAmount(price: { unit_amount?: number; recurring?: { interval?: string; interval_count?: number } }) {
  const cents = price.unit_amount ?? 0;
  const n = price.recurring?.interval_count ?? 1;
  switch (price.recurring?.interval) {
    case "year": return cents / (12 * n);
    case "week": return (cents * 52) / (12 * n);
    case "day": return (cents * 365) / (12 * n);
    default: return cents / n;
  }
}

async function revenuePanel(): Promise<Panel> {
  if (!STRIPE_KEY) return waiting("Add STRIPE_RESTRICTED_KEY to this function's secrets.");

  const active = await stripe("subscriptions?status=active&limit=100&expand[]=data.items.data.price");
  const trialing = await stripe("subscriptions?status=trialing&limit=100");

  let mrrCents = 0;
  for (const sub of active.data ?? []) {
    for (const item of sub.items?.data ?? []) {
      mrrCents += monthlyAmount(item.price) * (item.quantity ?? 1);
    }
  }

  // Cancellations in the last 30 days, against the base at the start of it.
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const canceled = await stripe(`subscriptions?status=canceled&limit=100&created[gte]=${since}`);
  const lost = (canceled.data ?? []).length;
  const base = (active.data ?? []).length + lost;

  const subs = (active.data ?? []).length;
  return {
    ok: true,
    data: {
      mrr: mrrCents / 100,
      subs,
      trials: (trialing.data ?? []).length,
      arpu: subs ? mrrCents / 100 / subs : null,
      churn: base ? lost / base : null,
      // Redemptions of the code the link page advertises. If this is 0 long
      // after the code went up, the coupon is probably not reaching checkout.
      coupon: await couponRedemptions(),
    },
  };
}

async function couponRedemptions(): Promise<number | null> {
  try {
    const list = await stripe("promotion_codes?code=NMT&limit=1");
    const pc = (list.data ?? [])[0];
    return pc ? (pc.times_redeemed ?? 0) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ main ---
Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  // Refuse to run at all rather than run wide open: an unset ADMIN_EMAIL must
  // never mean "let everyone through".
  if (!ADMIN_EMAIL) {
    return json({ error: "ADMIN_EMAIL is not set on this function." }, 500, origin);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user } } = await sb.auth.getUser();

  // The gate. Everything above this line is identity; this line is permission.
  if (!user || (user.email ?? "").toLowerCase() !== ADMIN_EMAIL) {
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
    gather("funnel", async () =>
      waiting("Tell Claude your Supabase table names for users, trials and subscriptions.")),
    gather("traffic", async () =>
      waiting("Needs a GA4 service account and GA4_PROPERTY_ID in this function's secrets.")),
    gather("grok", async () =>
      waiting("Needs GrokBot's API details.")),
  ]);

  return json({ ok: true, at: new Date().toISOString(), panels }, 200, origin);
});
