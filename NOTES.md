# OpenEvidence → Illness Script — Design Notes

Captured 2026-08-10. Verbatim record of the concept + architecture conversation.

---

## The idea

One takes the verbose convoluted output of OpenEvidence when you ask it what to do, and
condenses it into a succinct, clean, logical linear "this is what's happening pathophys
and what to do" — almost Illness Scripts style.

I really want to charge for this — people pay me to access my ppq.ai account, but I upsell
to make a tiny profit (or just to run a server).

---

## App 1: OpenEvidence → Illness Script

**Core constraint that makes it trustworthy: extraction-and-restructure only, never
augmentation.** The model gets the OE output as the sole corpus and is forbidden from
adding facts. Anything the source didn't address renders as an explicit gap line. That's
your entire quality moat — if it hallucinates once, a physician stops paying.

### Fixed output schema (deterministic renderer, model returns JSON)

- **One-liner** — the clinical question restated as a decision
- **Pathophys spine** — 2–4 sentences, causal chain only
- **Discriminating features** — what makes this entity and not its neighbors
- **Thresholds/triggers** — the actual numbers buried in OE prose
- **Do this** — ordered, imperative, dose/route/timing where given
- **Changes the plan** — the conditionals
- **Not addressed in source** — explicit gaps
- **Citations** — preserved verbatim from OE, never re-attributed

### Monetization mechanics

Credit-per-condense, not subscription, since your cost is per-call. Hash the input and
cache — repeat pastes of the same OE output cost you nothing and feel instant. Cap output
tokens hard; the schema does that naturally. Offer a BYOK tier at near-zero price to keep
the low-margin users off your key while the convenience tier carries the server.

---

## How PPQ actually works

It's an OpenAI-compatible gateway. `base_url="https://api.ppq.ai/v1"`,
`Authorization: Bearer sk-...`, and you swap the model string. Users top up a balance;
each call deducts by token usage. Registration is genuinely optional, and top-ups start at
10 cents.

Three endpoints matter for what you're building:

- `POST /keys` — mints a scoped key with `usage_limit_usd`, `reset_period`, and
  `expire_at`. Returns the key value once.
- `GET /queries/history` — per-key usage with `price_in_usd`, filterable by `api_key_id`.
- `POST /credits/balance` — balance check by `credit_id`.

Key management is account-level and uses `x-credit-id`, not the bearer token.

---

## The gap

PPQ collects money *from you*, not from your users. Their own fiat rail is Stripe on their
website; crypto top-ups are Lightning, BTC, XMR, LTC. They also support L402 accountless
pay-per-request, but only on data enrichment, image, and video endpoints — **not chat
completions** — so you can't wire pay-per-condense directly at the inference layer.

So "PPQ handles billing" only holds if the user has their own PPQ account. The moment you
want margin, you need a separate collector.

---

## Three architectures

**BYOK.** User makes their own PPQ account, pastes the key, it lives in browser storage.
Zero inference cost, zero payment infra, zero margin. PPQ already solved anonymous signup
for you here.

**Scoped key resale.** You mint a $10-cap key from your balance and sell it for $15. This
is what you're already doing informally, just automated and blast-radius-capped. Caveat:
that key works against all of PPQ, so a user can point it at Claude Code and burn the cap
on anything.

**Metered proxy.** Users buy credits from you, your server holds one PPQ key, you track
usage per user. Full margin control, needs a collector and a small DB.

**Recommendation:** ship BYOK first, since it's the whole app minus the billing surface
and proves the rubric works. Add the metered proxy as the paid tier. Skip key resale — it
leaks value outside your app and you can't stop it.

---

## Collecting money without Stripe

Use a merchant of record so you're not the one processing cards: Gumroad, Lemon Squeezy,
or Polar. They take payment, handle sales tax and VAT, and pay you out. You never touch
card data and never open a Stripe account.

Regardless of rail, use a **redemption code** as the seam. Payment produces a code, the
code redeems into credit on your server. That decouples the collector from the app, lets
you swap rails without touching the client, and keeps users anonymous — no email required,
just a code. It also makes manual sales work identically: Venmo or Zelle, you generate a
code by hand, done. At ten users that's the entire billing system.

Lightning is available and fits PPQ's grain, but your buyers are physicians. Most won't
have a wallet.

---

## Pricing reality

An OE output is roughly 1500–3000 tokens in, and your schema caps output near 800. That's
under two cents on a mid-tier model. Don't price per token — the margin is invisible at
that scale. Price as "$12 for 200 condenses," where the number is generous and the price
reflects the rubric, not the compute. Cache on input hash so repeat pastes cost you
nothing.

---

## One flag

If a user pastes an OE output built from a real vignette, identifiers can ride along.
Under BYOK that's their account and their problem; under your proxy it's your key and your
logs. A paste-time warning plus a no-retention posture covers it. PPQ's TEE models would
be the strong answer, but they need a local Node proxy, so they don't work from a browser
client.

---

## Build target

Cloudflare Worker.
