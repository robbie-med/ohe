# Ohe

**OE is soe verboes....cut to the chase!**

Paste a verbose OpenEvidence answer, get back the call: verdict, ordered
actions with doses, what not to do, and anything it left open.

```
Likely fluid overload — stop IV fluids, give furosemide 80-100 mg IV bolus.
  800 mL/day (0.47 mL/kg/hr) on ongoing NS with no diuretic on board.

DO NOW
  1. Stop all IVF now
  2. Furosemide 80-100 mg IV bolus
       higher dose needed at CrCl 17; monitor UOP at 2h and 6h as a stress test
  3. Check urine lytes (UNa, FENa) on next void
       UNa >40 or FENa >1% supports ATN

DON'T
  x RRT — no refractory hyperkalemia (K 4.7), acidosis improving, still making urine
```

Two constraints that pull against each other, and both matter:

**Be decisive.** OE lists every possibility with equal weight and buries the
recommendation in paragraph four. When it ranks — "most likely", "simplest,
highest-yield", "practical move right now" — that ranking *is* the answer, and
it leads.

**Never add a fact.** The pasted text is the sole corpus. No dose OE didn't
give, no trend it didn't state (one CrCl value is not "rising creatinine"), no
syndrome it didn't name. Anything left open lands under Unresolved instead of
being quietly filled in. That's the whole moat — one invented dose in front of
a physician and it's over.

These coexist because OE almost always *contains* the answer. The job is
finding it, not supplying it.

The rubric that enforces this is `src/prompt.js` — that file is the product.

Design rationale and the pricing/billing reasoning: `NOTES.md`.

## Shape

```
public/index.html   UI + deterministic renderer (the model returns JSON, not prose)
src/prompt.js       The rubric — system prompt + output schema
src/index.js        Cloudflare Worker: PPQ proxy, input-hash cache, credits
test.mjs            Self-check for the parser (`npm test`)
wrangler.toml       Config
```

One Worker serves both the static page and the API. No build step, no framework,
no external requests from the page.

## Two tiers

**BYOK.** User makes their own [ppq.ai](https://ppq.ai) account, pastes their key
into Settings. It lives in `localStorage` and rides on the `x-ppq-key` header;
the server forwards it and stores nothing. Zero inference cost to you, zero
billing infrastructure, zero margin. Works with no secrets configured.

**Metered.** You hold one PPQ key server-side. Users buy a redemption code
however you like, redeem it in the app for an anonymous access token, and each
condense decrements one credit. Enabled by setting the `PPQ_KEY` secret.

Redemption codes are the seam between payment and product. Gumroad, Lemon
Squeezy, Polar, Venmo, cash — the app never knows which. You mint a code, they
type it in.

## Deploy

```sh
npm install
npx wrangler login

# Create the KV namespace, then paste the returned id into wrangler.toml
npx wrangler kv namespace create STORE

npx wrangler deploy
```

That's the whole BYOK app, live.

To turn on the paid tier:

```sh
npx wrangler secret put PPQ_KEY     # your ppq.ai key
npx wrangler secret put ADMIN_KEY   # any long random string
```

Mint codes:

```sh
curl -X POST https://<your-worker>/api/admin/codes \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"count": 5, "credits": 200}'
```

Local: `npm run dev`.

## Cost control

- **Input-hash cache.** SHA-256 of `model + text` keys a 30-day KV entry. A
  repeat paste costs nothing and returns instantly, and the cache write happens
  *before* the credit decrement, so nobody is charged twice for the same input.
- **No `max_tokens`.** Reasoning models spend part of the budget thinking before
  the first character of JSON, so any cap low enough to matter truncates the
  script mid-object. The schema is what keeps output short.
- **Input cap.** 60,000 characters, rejected at the edge.

Trade-off of no cap: PPQ pre-authorises a request against the model's *maximum*
output, so a low account balance can bounce an expensive model with "Payment
Required" even though real spend is a fraction of the estimate. Keep a working
balance, or set a `max_tokens` well above 4,000 if you'd rather cap.

### Measured cost per condense

One real OpenEvidence answer (5.2 KB in), same rubric, no cap:

| Model              | Latency | Cost    | Per 200 | Gaps flagged |
| ------------------ | ------- | ------- | ------- | ------------ |
| `gpt-5.4-mini`     | 10s     | $0.0098 | $1.96   | 11           |
| `claude-haiku-4.5` | 21s     | $0.0129 | $2.58   | 8            |
| `claude-sonnet-5`  | 44s     | $0.0484 | $9.69   | 6            |

`claude-haiku-4.5` is the default. Sonnet was the strictest — it alone refused
to build a pathophys spine from a source that only contained a differential,
and flagged that as a gap — but at $9.69/200 it leaves nothing on a "$12 for
200 condenses" price. Neither cheap model was caught inventing content.

Price the rubric, not the compute.

## Model selection

`MODEL` in `wrangler.toml` sets the default. Settings has a free-text model
field to override it per-request. Verify your default is a string PPQ actually
serves before deploying — a wrong id fails at the first condense.

## Privacy

An OE answer built from a real vignette can carry identifiers. Under BYOK that's
the user's own PPQ account. Under the metered tier it's your key and PPQ's logs.
The app stores only a hash of the input alongside the structured output, and the
paste box carries a warning — but the honest posture is no-retention plus that
warning, not a technical guarantee. PPQ's TEE models would be the strong answer;
they need a local Node proxy and don't work from a browser client.
