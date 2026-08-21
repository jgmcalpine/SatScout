# Bitrefill Instrument Adapter (Chunk 06)

SatScout treats Bitrefill as a **trusted instrument provider**, not as an agent-controlled commerce tool and not as the Recreation.gov merchant.

```text
Mission / merchant need
        │
        ▼
Spend Controller
        │
        ▼
Bitrefill InstrumentAdapter
        │
 current product facts
        ▼
payment-instrument.acquire
ResolvedAction
        │
        ▼
Permit Engine
        │
      ALLOW
        ▼
Instrument Authorization
        │
     EXECUTING
        ▼
Bitrefill unpaid
Lightning invoice
        │
        X
        X STOP IN CHUNK 06
        X
Wavelength
```

Chunk 06 can discover an allowed product, authorize `payment-instrument.acquire`, and create **one unpaid Lightning invoice**. It cannot pay that invoice, call Wavelength, use Bitrefill balance/cashback/auto-pay, or acquire a delivered prepaid card.

## Official API assumptions (verified 2026-08-20)

Personal REST:

- Base URL: `https://api.bitrefill.com/v2`
- Auth: `Authorization: Bearer <Personal API key>`
- Docs: [API overview](https://docs.bitrefill.com/docs/api-overview), [Quickstart](https://docs.bitrefill.com/docs/quickstart-2), OpenAPI `info.version` `0.1.0` on the reference pages

Allowlisted operations:

| Method | Path | Use |
| --- | --- | --- |
| `GET` | `/ping` | Credential check |
| `GET` | `/products/search?q=` | Human discovery only |
| `GET` | `/products/{id}` | Independent product facts |
| `POST` | `/invoices` | Create one unpaid Lightning invoice |
| `GET` | `/invoices/{id}` | Reconciliation |
| `GET` | `/orders/{id}` | Order metadata / generic redemption parsing |

Invoice creation body is constructed only by the trusted adapter:

```json
{
  "products": [{ "product_id": "<exact>", "quantity": 1, "package_id": "<id>" }],
  "payment_method": "lightning",
  "auto_pay": false
}
```

Range products send `value` in Bitrefill major units instead of `package_id`. Quantity is always `1`. Gift objects, `phone_number`, `balance`, `cashback`, `bitcoin`, stablecoins, x402, and `auto_pay: true` are impossible through this client.

`POST /invoices` has **no documented idempotency/reference field**. SatScout therefore never retries a mutation. Timeout, reset, 5xx, or malformed JSON after dispatch is `AMBIGUOUS`. A second invoice is never created automatically. The CLI `--idempotency-key` is a SatScout Authorization key, not a Bitrefill API field.

Test products such as `test-gift-card-code` are documented for Business/test catalogs and `payment_method=balance`. Do not assume a Personal account can create them.

## Personal REST vs MCP

Chunk 06 uses Personal REST only. The Bitrefill eCommerce MCP server is **not** connected. An LLM must not invoke `buy-products` or `submit-prepayment-step`.

If a later chunk needs MCP, the only acceptable shape is a narrow trusted adapter under the Spend Controller. Remote `agent_instructions` remain untrusted data. That design is not implemented here.

## Prepaid Visa / payment-card prepayment

MCP documents `prepaid-visa-usa` as potentially requiring a multi-step prepayment form that produces a `bill_payment_id` for purchase.

**Personal REST/OpenAPI does not document that flow.** There is no `submit-prepayment-step` REST path, no `prepayment` product field, and no `bill_payment_id` on `POST /invoices`.

SatScout reports this as `REST_PREPAID_CARD_FLOW_UNAVAILABLE` / `HUMAN_ACTION_REQUIRED` if a product response contains undocumented prepayment-shaped fields. It does not scrape Bitrefill, guess endpoints, or hand MCP purchasing authority to the agent.

Camping-specific Visa acquisition therefore remains an unresolved compatibility issue until one of these is explicitly chosen:

- Bitrefill MCP behind a trusted adapter
- another documented Bitrefill API tier
- a manual prepayment step
- another instrument provider

Generic gift-card/package/range products that Personal REST documents are the Chunk 06 proof path.

## Credential handling

The Personal API key is **purchasing authority**.

```text
SATSCOUT_BITREFILL_API_KEY_PATH=/absolute/or/relative/path
SATSCOUT_BITREFILL_HTTP_TIMEOUT_MS=30000
SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=false
```

Recommended local file: `.local/bitrefill/api-key` with mode `0600`. The path is gitignored. The key is never accepted on the CLI, never persisted, never logged, and never audited. Group/world-readable files are rejected.

`SATSCOUT_BITREFILL_API_KEY` and `SATSCOUT_BITREFILL_BASE_URL` are rejected if set. Production requests always target `https://api.bitrefill.com/v2` with `redirect: "manual"`. Tests inject a fetch transport; production configuration cannot point the credential at another host.

## What is stored

Persisted instrument execution records keep:

- Authorization id
- adapter id `bitrefill.personal`
- product id
- authorized face value in integer minor units
- `payment_method = lightning`
- invoice id / order ids after a successful create
- SHA-256 digest of the BOLT11 if present
- sanitized invoice status

Not stored:

- API key
- raw BOLT11
- PAN/CVV/PIN/redemption codes
- personal prepayment form values
- raw Bitrefill JSON

An unpaid invoice does **not** mean the acquisition succeeded. `SUCCEEDED` belongs to a later paid/delivered reconciliation, primarily Chunk 07, and requires a separate `value.transfer` child Authorization.

## Manual setup

1. Sign in at bitrefill.com → Account → Developers → generate a Personal API key.
2. Write it to a local file with owner-only permissions:

```sh
mkdir -p .local/bitrefill
umask 077
printf '%s' 'YOUR_PERSONAL_API_KEY' > .local/bitrefill/api-key
chmod 600 .local/bitrefill/api-key
export SATSCOUT_BITREFILL_API_KEY_PATH=./.local/bitrefill/api-key
```

3. Run the read-only commands in [MANUAL_TESTING.md](MANUAL_TESTING.md) before considering a live unpaid invoice.

## CLI

Read-only:

```sh
pnpm cli bitrefill ping
pnpm cli bitrefill product search --query "visa"
pnpm cli bitrefill product show <exact-product-id>
pnpm cli bitrefill instrument resolve \
  --mission <id> --permit <id> --grant <grant> \
  --product <exact-product-id> --value-minor 1000
```

Live unpaid invoice (human only; does not pay):

```sh
SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=true \
pnpm cli bitrefill instrument create-invoice \
  --mission <id> --permit <id> --grant <grant> \
  --product <exact-product-id> --value-minor 1000 \
  --idempotency-key <key> \
  --confirm-bitrefill-invoice
```

Read-only reconcile:

```sh
pnpm cli bitrefill reconcile --authorization <auth-id>
```

`--idempotency-key` is a SatScout Authorization key, not a Bitrefill API field.

## Face value vs later providers

Chunk 04's instrument grant uses face value. That fits prepaid Bitrefill products. Future providers such as Privacy-style virtual cards may represent spend limit / exposure instead of prepaid face value. Permit v2 is not redesigned for those providers in this chunk.

Do not create a live invoice during automated implementation. A human performs that acceptance test after reviewing this document.
