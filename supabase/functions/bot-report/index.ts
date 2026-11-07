// =============================================================================
// bot-report
//
// The endpoint Mike's bots POST to. One row per call, into bot_reports in
// nmt-control. Killzonda is not involved.
//
// IMPORTANT, and it will not work without this: turn OFF "Verify JWT" for this
// function in its Settings. That setting expects a Supabase user token, and a
// trading bot has no user. Authentication here is the shared secret below,
// checked before anything is read or written. With Verify JWT on, the platform
// rejects every call before this file runs and the bots get a 401 that has
// nothing to do with their key.
//
// Deploy: Edge Functions -> Deploy a new function -> via Editor, named exactly
// "bot-report". Leave the index.ts the editor makes and paste over it.
//
// Secrets:
//   BOT_INGEST_KEY       a long random string you invent. The bots send it.
//   CONTROL_SECRET_KEY   a secret key from this project's API Keys page, so
//                        this function can write past RLS.
//
// ----------------------------------------------------------------------------
// The contract, for whoever writes the bot side:
//
//   POST https://mfthmscibqvylkcuxyyd.supabase.co/functions/v1/bot-report
//   Authorization: Bearer <BOT_INGEST_KEY>
//   Content-Type: application/json
//
//   { "bot": "scalper-1",
//     "status": "ok",                       // ok | warn | error, free text allowed
//     "metrics": { "signals_today": 18,     // any keys you like, numbers or strings
//                  "win_rate_30d": 0.61,
//                  "open_positions": 2 },
//     "note": "optional one-liner" }
//
//   Only "bot" is required. Call it on a schedule even when nothing happened:
//   silence is the signal the dashboard is watching for, and a bot that only
//   reports when it has news is indistinguishable from one that has died.
// =============================================================================

const INGEST_KEY = Deno.env.get("BOT_INGEST_KEY") ?? "";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SECRET_KEY = Deno.env.get("CONTROL_SECRET_KEY") ?? "";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Compares in constant time. The difference is unmeasurable at this scale, but
// a string compare that returns early on the first wrong character is a bad
// habit to write down next to the word "key".
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    // Refuse to run rather than run open. An unset key must never mean "allow".
    if (!INGEST_KEY) return json({ error: "BOT_INGEST_KEY is not set on this function." }, 500);
    if (!SECRET_KEY) return json({ error: "CONTROL_SECRET_KEY is not set on this function." }, 500);

    const offered = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!sameSecret(offered, INGEST_KEY)) return json({ error: "bad key" }, 401);

    let body: { bot?: string; status?: string; metrics?: unknown; note?: string };
    try { body = await req.json(); }
    catch { return json({ error: "body must be JSON" }, 400); }

    const bot = (body.bot ?? "").toString().trim();
    if (!bot) return json({ error: "bot is required" }, 400);

    const row = {
      bot,
      status: (body.status ?? "ok").toString().slice(0, 40),
      metrics: body.metrics && typeof body.metrics === "object" ? body.metrics : {},
      note: body.note ? body.note.toString().slice(0, 400) : null,
    };

    const res = await fetch(SUPABASE_URL + "/rest/v1/bot_reports", {
      method: "POST",
      headers: {
        apikey: SECRET_KEY,
        Authorization: "Bearer " + SECRET_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      // Hand back what Postgres actually said. Writing "insert failed" here
      // would repeat the mistake this project has made five times already.
      return json({ error: "insert failed", detail: (await res.text()).slice(0, 200) }, 500);
    }

    return json({ ok: true, bot, at: new Date().toISOString() }, 200);
  } catch (e) {
    return json({ error: "unhandled", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});
