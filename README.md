# Invoice Cash Agent

An agent that turns a pasted invoice into money in the account: it reads the document,
decides whether the numbers are safe to bill, sends a real PayPal invoice, hands the client
a one-tap payment link, captures the payment, and writes every decision to a hash chain you
can audit afterwards.

The point is not that a model can write an invoice. The point is that **a model is never
allowed to invent an amount**, and **a blocked invoice cannot be argued past the policy**.

```
paste invoice text
      |
      v
 parse  ->  policy  ->  PayPal Invoicing v2 (create + send)
                  \-->  PayPal Orders v2 (create + capture)  ->  receipt note
      |
      v
 hash-chained decision trail (every step commits to the one before it)
```

## Why it is built this way

| Risk | What the agent does |
| --- | --- |
| Model hallucinates a total | Amounts are parsed deterministically; the computed total is compared with the total printed on the document and a mismatch is a finding, not a rounding note |
| Model is talked into sending a bad invoice | `decide()` runs **before** any PayPal call. Score >= 40 is a hard block, returned as HTTP 409, and no request leaves the process |
| Nobody can explain what happened later | Each step is appended to a SHA-256 chain; editing one record breaks verification from that point on |
| Chasing late payers by hand | `nudgeMessage()` picks the tone from days late: gentle, direct, final notice |

The deterministic core is plain JavaScript with no dependencies. An LLM, if you add one,
only rewrites prose - it never touches a number and never touches the policy result.

## PayPal integration

Two modes, same interface:

* `PAYPAL_MODE=mock` (default) - no credentials, answers with the documented sandbox
  request/response shapes so the flow can be run and reviewed offline.
* `PAYPAL_MODE=sandbox` - real calls to `https://api-m.sandbox.paypal.com`:
  * `POST /v1/oauth2/token` (client credentials, cached)
  * `POST /v2/invoicing/invoices` then `POST /v2/invoicing/invoices/{id}/send`
  * `POST /v2/checkout/orders` (intent `CAPTURE`) then `POST /v2/checkout/orders/{id}/capture`
  * `POST /v1/notifications/verify-webhook-signature` before any notification is believed

```bash
PAYPAL_MODE=sandbox PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm start
```

The rest of the app never knows which mode it is in.

## Run it

```bash
npm test     # 12 tests, no network, no credentials
npm run demo # starts the server, drives the whole flow, prints every step
npm start    # http://127.0.0.1:8788
```

Demo output (abridged):

```
== 1. read the invoice
   line           : 1 x Design sprint @ 1200.00
   line           : 2 x Landing page copy @ 450.00
   computed total : 2100.00
   printed total  : 2100.00
   matches        : true
   verdict        : SEND (score 0)

== 2. a document that must not be billed
   verdict        : BLOCK (score 70)
   reason         : no client email - the invoice cannot be delivered
   reason         : line items add up to 900.00 but the document says 1200.00
   POST /api/invoice -> 409 blocked by policy

== 5. capture the payment
   status         : COMPLETED
   capture id     : CAP-MOCK-ORDER-MOCK-ACME-1042
```

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | single-page UI |
| GET | `/api/health` | mode + trail verification |
| GET | `/api/trail` | full decision trail and its verification result |
| POST | `/api/extract` | `{ text }` -> parsed invoice, policy decision, draft messages |
| POST | `/api/invoice` | create + send the PayPal invoice for the last parsed document |
| POST | `/api/order` | create the payment link |
| POST | `/api/capture` | `{ orderId }` -> capture and produce the receipt note |
| POST | `/api/webhook` | PayPal notification -> signature check, then record the payment in the trail |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8788` | HTTP port |
| `PAYPAL_MODE` | `mock` | `mock` or `sandbox` |
| `PAYPAL_CLIENT_ID` | - | required when mode is `sandbox` |
| `PAYPAL_CLIENT_SECRET` | - | required when mode is `sandbox` |
| `PAYPAL_WEBHOOK_ID` | - | required to verify webhook signatures in `sandbox` |
| `DATA_DIR` | `./data` | where the trail is written (`trail.jsonl`) |

## Limits, stated plainly

* The trail is a single append-only file on one machine. It survives a restart (the demo
  shows this), but it is not replicated, and two processes writing the same file would
  interleave - running one instance is the supported shape.
* The parser reads the common line shapes (label + amount, optional `N x` quantity, `Net N`
  terms, one total). It is deliberately conservative: a line it cannot read is skipped rather
  than guessed, and the printed-vs-computed mismatch check catches the fallout.
* Reconciliation covers capture plus signed webhooks. A notification is only believed after
  PayPal's `verify-webhook-signature` answers `SUCCESS`; in `mock` mode that check is
  short-circuited, which is the one place the two modes behave differently.
* Single currency per document.

## Licence

MIT - see `LICENSE`.
