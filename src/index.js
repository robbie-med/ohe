import { SYSTEM_PROMPT, userPrompt, MAX_INPUT_CHARS } from "./prompt.js";

const DEFAULT_PPQ_BASE = "https://api.ppq.ai";
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
const DEFAULT_MODEL = "gpt-4.1-mini";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const bad = (message, status = 400) => json({ error: message }, status);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    // `return await` matters: without it the handler's promise escapes this
    // try block and a rejection becomes a stack trace in the client's face.
    try {
      if (pathname === "/api/condense") return await handleCondense(request, env);
      if (pathname === "/api/redeem") return await handleRedeem(request, env);
      if (pathname === "/api/admin/codes")
        return await handleMintCodes(request, env);
      return bad("not found", 404);
    } catch (err) {
      return bad(err.message || "internal error", 502);
    }
  },
};

// --- PPQ auth resolution ----------------------------------------------

// Two tiers. BYOK: the browser sends the user's own PPQ key, we never store it.
// Metered: the browser sends an access token we issued, we spend our key and
// decrement their credit. Anything else is unauthenticated.
async function resolveAuth(request, env) {
  const byok = request.headers.get("x-ppq-key");
  if (byok) return { key: byok, tier: "byok" };

  const token = request.headers.get("x-access-token");
  if (token && env.PPQ_KEY) {
    const account = await getAccount(env, token);
    if (!account) return { error: "unknown access token" };
    if (account.credits <= 0) return { error: "out of credits" };
    return { key: env.PPQ_KEY, tier: "metered", token, account };
  }

  return { error: "no PPQ key or access token supplied" };
}

const accountKey = (token) => `tok:${token}`;

async function getAccount(env, token) {
  return env.STORE.get(accountKey(token), "json");
}

// --- condense ----------------------------------------------------------

async function handleCondense(request, env) {
  if (request.method !== "POST") return bad("POST only", 405);

  const auth = await resolveAuth(request, env);
  if (auth.error) return bad(auth.error, 401);

  const body = await request.json().catch(() => null);
  const text = body?.text?.trim();
  if (!text) return bad("no text supplied");
  if (text.length > MAX_INPUT_CHARS)
    return bad(`input over ${MAX_INPUT_CHARS} characters`, 413);

  const model = body.model || env.MODEL || DEFAULT_MODEL;
  const cacheKey = `oe:${await sha256(`${model}\n${text}`)}`;

  const hit = await env.STORE.get(cacheKey, "json");
  if (hit) return json({ ...hit, cached: true, credits: auth.account?.credits });

  const script = await callPPQ(ppqBase(env), auth.key, model, text);

  // Cache before charging — a repeat paste should never cost the user twice.
  await env.STORE.put(cacheKey, JSON.stringify(script), {
    expirationTtl: CACHE_TTL,
  });

  let credits;
  if (auth.tier === "metered") {
    credits = Math.max(0, auth.account.credits - 1);
    await env.STORE.put(
      accountKey(auth.token),
      JSON.stringify({ ...auth.account, credits }),
    );
  }

  return json({ ...script, cached: false, credits });
}

// Overridable so the request path can be exercised against a stub.
const ppqBase = (env) => env.PPQ_BASE || DEFAULT_PPQ_BASE;

async function callPPQ(base, key, model, text) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      // No max_tokens on purpose. Reasoning models spend part of the budget
      // thinking before the first character of JSON appears, so any cap low
      // enough to matter truncates the script mid-object and fails to parse.
      // The schema is what keeps output short; the input cap bounds cost.
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(text) },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`PPQ returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error("PPQ returned no content");
  // Say so plainly rather than letting it surface as a parse failure.
  if (choice.finish_reason === "length")
    throw new Error("model hit the token cap mid-script — try a shorter paste");

  return { script: parseScript(content), model: data.model || model };
}

// Models wrap JSON in fences or a sentence of preamble often enough that
// bare JSON.parse is not worth defending. Exported for test.mjs.
export function parseScript(raw) {
  const stripped = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("model did not return JSON");

  const parsed = JSON.parse(stripped.slice(start, end + 1));
  return {
    bottom_line: str(parsed.bottom_line),
    because: str(parsed.because),
    do_now: arr(parsed.do_now),
    avoid: arr(parsed.avoid),
    unresolved: arr(parsed.unresolved),
  };
}

const str = (v) => (typeof v === "string" ? v : "");
const arr = (v) => (Array.isArray(v) ? v : []);

async function sha256(input) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- credits -----------------------------------------------------------

// The redemption code is the seam between however you took the money and the
// app. Gumroad, Lemon Squeezy, Venmo, cash — all of them just produce a code.
async function handleRedeem(request, env) {
  if (request.method !== "POST") return bad("POST only", 405);
  if (!env.PPQ_KEY) return bad("metered tier not configured", 503);

  const body = await request.json().catch(() => null);
  const code = body?.code?.trim().toUpperCase();
  if (!code) return bad("no code supplied");

  const record = await env.STORE.get(`code:${code}`, "json");
  if (!record) return bad("unknown code", 404);
  if (record.redeemed_by) return bad("code already redeemed", 409);

  // Redeeming onto an existing token tops it up; otherwise mint a new one.
  const token = body.token || crypto.randomUUID().replace(/-/g, "");
  const existing = (await getAccount(env, token)) || { credits: 0 };
  const credits = existing.credits + record.credits;

  await env.STORE.put(
    accountKey(token),
    JSON.stringify({ credits, created: existing.created || Date.now() }),
  );
  await env.STORE.put(
    `code:${code}`,
    JSON.stringify({ ...record, redeemed_by: token, redeemed_at: Date.now() }),
  );

  return json({ token, credits });
}

// --- admin -------------------------------------------------------------

// Mint codes by hand. At ten users this is the entire billing back office.
//   curl -X POST .../api/admin/codes -H "x-admin-key: ..." \
//        -d '{"count":5,"credits":200}'
async function handleMintCodes(request, env) {
  if (request.method !== "POST") return bad("POST only", 405);
  if (!env.ADMIN_KEY) return bad("admin not configured", 503);
  if (request.headers.get("x-admin-key") !== env.ADMIN_KEY)
    return bad("forbidden", 403);

  const body = await request.json().catch(() => ({}));
  const count = Math.min(Number(body.count) || 1, 100);
  const credits = Number(body.credits) || 200;

  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = randomCode();
    await env.STORE.put(
      `code:${code}`,
      JSON.stringify({ credits, created: Date.now(), redeemed_by: null }),
    );
    codes.push(code);
  }
  return json({ codes, credits });
}

function randomCode() {
  // No 0/O/1/I — these get read aloud and typed by hand.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}
