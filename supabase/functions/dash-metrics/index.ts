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
  const DAY = 86400;
  const trialing = await stripe("subscriptions?status=trialing&limit=100");
  const active = await stripe("subscriptions?status=active&limit=100");
  const gone = await stripe("subscriptions?status=canceled&limit=100");

  const all = [...(trialing.data ?? []), ...(active.data ?? []), ...(gone.data ?? [])];

  const inTrial = (trialing.data ?? []).length;

  // An active subscription whose trial_end has passed converted.
  const converted = (active.data ?? [])
    .filter((x: { trial_end?: number }) => x.trial_end && x.trial_end < now).length;

  // Cancelled on or before the trial ended: they decided during the seven days.
  const lapsed = (gone.data ?? [])
    .filter((x: { trial_end?: number; canceled_at?: number }) =>
      x.trial_end && x.canceled_at && x.canceled_at <= x.trial_end).length;

  const decided = converted + lapsed;

  // Totals answer "how big", which barely moves day to day. Arrivals answer
  // "is it working", which is the question you actually open this for. Counted
  // over two windows because one day is noise and a week has a shape.
  const since = (n: number) => now - n * DAY;
  const startedIn = (n: number) =>
    all.filter((x: { created?: number }) => (x.created ?? 0) >= since(n)).length;
  const convertedIn = (n: number) =>
    (active.data ?? []).filter((x: { trial_end?: number }) =>
      x.trial_end && x.trial_end < now && x.trial_end >= since(n)).length;
  const lostIn = (n: number) =>
    (gone.data ?? []).filter((x: { canceled_at?: number }) =>
      (x.canceled_at ?? 0) >= since(n)).length;

  return {
    ok: true,
    data: {
      inTrial,
      converted,
      lapsed,
      everStarted: inTrial + converted + lapsed,
      conversion: decided ? converted / decided : null,
      accounts: null,
      accountsNote: "Accounts come from Killzonda, which is not connected yet.",
      newly: {
        startedDay: startedIn(1),
        startedWeek: startedIn(7),
        convertedDay: convertedIn(1),
        convertedWeek: convertedIn(7),
        lostDay: lostIn(1),
        lostWeek: lostIn(7),
      },
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

// ---------------------------------------------------------------- YouTube ---
// The only one of the three socials that needs nothing but an API key. Public
// channel statistics are public, so there is no OAuth dance, no app review and
// no token to refresh. Instagram and TikTok both want an app and an approval,
// which is why they are not here yet.
async function youtubePanel(): Promise<Panel> {
  const key = Deno.env.get("YOUTUBE_API_KEY") ?? "";
  const channel = Deno.env.get("YOUTUBE_CHANNEL_ID") ?? "";
  if (!key || !channel) {
    return waiting("Needs YOUTUBE_API_KEY and YOUTUBE_CHANNEL_ID in this function's secrets.");
  }

  const res = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=" +
      encodeURIComponent(channel) + "&key=" + encodeURIComponent(key),
  );
  if (!res.ok) {
    throw new Error("YouTube " + res.status + ": " + (await res.text()).slice(0, 140));
  }
  const body = await res.json();
  const item = (body.items ?? [])[0];
  if (!item) {
    throw new Error("No channel matched that id. YOUTUBE_CHANNEL_ID should start UC.");
  }

  const st = item.statistics ?? {};
  return {
    ok: true,
    data: {
      rows: [
        {
          name: item.snippet?.title ?? "YouTube",
          v: Number(st.subscriberCount ?? 0).toLocaleString("en-US") + " subs",
          s: Number(st.viewCount ?? 0).toLocaleString("en-US") + " views across " +
             Number(st.videoCount ?? 0).toLocaleString("en-US") + " videos",
        },
        {
          name: "Instagram",
          v: "not connected",
          s: "needs a Facebook app linked to the business account",
        },
        {
          name: "TikTok",
          v: "not connected",
          s: "needs a developer app and their approval",
        },
      ],
    },
  };
}

// ------------------------------------------------------------------- GA4 ---
// Reads the GA4 property that already exists on killzonda.com. Nothing about
// the tracking changes and no tag is added; this only asks Google for numbers
// it has already collected.
//
// A service account rather than an API key, because the Data API will not take
// a key. That means signing a JWT with the account's private key and trading
// it for an access token, which is the whole of gaToken below. Deno has
// WebCrypto, so this needs no library.
//
// Note for later: GA4_PROPERTY_ID is the numeric property id, not the
// G-XXXXXXX measurement id. They are different things on different screens and
// the API only accepts the number.
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function gaToken(saRaw: string): Promise<string> {
  let sa: { client_email?: string; private_key?: string };
  try { sa = JSON.parse(saRaw); }
  catch { throw new Error("GA_SERVICE_ACCOUNT is not valid JSON. Paste the whole downloaded file."); }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GA_SERVICE_ACCOUNT is missing client_email or private_key.");
  }

  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) =>
    b64url(new TextEncoder().encode(JSON.stringify(o)));

  const unsigned =
    enc({ alg: "RS256", typ: "JWT" }) + "." +
    enc({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });

  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned),
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + b64url(sig),
    }),
  });
  if (!res.ok) {
    throw new Error("Google refused the service account: " + (await res.text()).slice(0, 140));
  }
  return (await res.json()).access_token;
}

async function trafficPanel(): Promise<Panel> {
  const sa = Deno.env.get("GA_SERVICE_ACCOUNT") ?? "";
  const prop = (Deno.env.get("GA4_PROPERTY_ID") ?? "").trim();
  if (!sa || !prop) {
    return waiting("Needs GA_SERVICE_ACCOUNT and GA4_PROPERTY_ID in this function's secrets.");
  }
  if (/^G-/i.test(prop)) {
    return waiting("GA4_PROPERTY_ID is the numeric property id, not the G-XXXXXXX measurement id.");
  }

  const token = await gaToken(sa);
  const res = await fetch(
    "https://analyticsdata.googleapis.com/v1beta/properties/" + prop + ":runReport",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: "28daysAgo", endDate: "today" }],
        dimensions: [{ name: "sessionSource" }],
        metrics: [{ name: "sessions" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 8,
      }),
    },
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 180);
    if (res.status === 403) {
      throw new Error("The service account has no access to that property. Add its email as a Viewer in GA4 Admin.");
    }
    throw new Error("GA4 " + res.status + ": " + body);
  }

  const body = await res.json();
  const rows = (body.rows ?? []).map((r: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }) => ({
    src: r.dimensionValues?.[0]?.value || "(none)",
    n: Number(r.metricValues?.[0]?.value ?? 0),
  }));

  return {
    ok: true,
    data: { sessions: rows.reduce((a: number, r: { n: number }) => a + r.n, 0), rows },
  };
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
  let totalError: string | null = null;
  try {
    const t = await totalRevenue();
    total = t.cents / 100;
    totalComplete = t.complete;
  } catch (e) {
    // Keep the reason. Swallowing it here is what turned a missing Stripe
    // permission into an unexplained "not connected" on the tile, which tells
    // you something is wrong and nothing about what.
    const raw = e instanceof Error ? e.message : String(e);
    totalError = /charge/i.test(raw) || /permission/i.test(raw) || /\b403\b/.test(raw)
      ? "Stripe key needs Charges: Read"
      : raw.slice(0, 90);
  }

  return {
    ok: true,
    data: {
      mrr: cents / 100,
      total,
      totalComplete,
      totalError,
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
      gather("traffic", trafficPanel),
      // Four platforms, not five. X is left out on purpose: reading your own
      // analytics there needs their paid tier, and a panel that silently shows
      // nothing is worse than one that was never promised.
      gather("social", youtubePanel),
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
