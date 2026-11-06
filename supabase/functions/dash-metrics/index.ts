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

  return {
    ok: true,
    data: {
      mrr: cents / 100,
      subs,
      trials: (trialing.data ?? []).length,
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
      gather("funnel", async () =>
        waiting("Tell Claude your Killzonda table names for users, trials and subscriptions.")),
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
