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

Chunk 06 uses Personal REST for ping, search, ordinary exact product facts, unpaid Lightning invoices, and reconciliation.

Personal REST and Bitrefill MCP **do not share a guaranteed product catalog**. Live Personal REST may 404 or 403 an identifier that MCP documentation or the Bitrefill storefront still uses. Search may return a physical prepaid card while the Digital Prepaid Visa is absent from Personal REST. Therefore MCP prepayment **must not** require a successful REST `GET /v2/products/{id}` before inspection.

For the narrow MCP-prepayment path, Permit/grant selection is still exact (`provider=bitrefill`, one allowed product, currency, requested face value, quantity 1). The already-allowlisted `get-product-details` tool is the trusted resolver for that exact product. Callers cannot use MCP to discover or substitute products. `search-products` remains unreachable. Returned MCP identity, currency, denomination/range, requested face value, and prepayment requirements are validated deterministically and fail closed on mismatch.

A protocol-successful `get-product-details` result may still contain an application-level Bitrefill error. An explicit product-not-found payload is `PRODUCT_NOT_FOUND`, not `MALFORMED_PRODUCT`. Suggested slugs/names may be shown to the operator for manual review. SatScout does not auto-select a suggestion, retry `get-product-details`, mutate the Permit, or call `search-products`. Product identity remains Permit-controlled.

Chunk 06B adds a **narrow programmatic MCP client** for the prepaid-card prepayment workflow that Personal REST does not document. Bitrefill MCP is an implementation dependency of that trusted adapter. It is **not**:

- an MCP server exposed to the agent
- an MCP server configured in Claude/Cursor/ChatGPT for this workflow
- an LLM tool
- a generic commerce API
- a generic tool-calling surface

```text
Agent / browser
      X
      X cannot access Bitrefill MCP
      X
      ▼
Spend Controller
      │
      ▼
Narrow Bitrefill Prepayment Adapter
      │
      ├── get-product-details
      └── submit-prepayment-step
              │
              ▼
        bill_payment_id
              │
              X
              X STOP IN CHUNK 06B
              X
        buy-products
```

The adapter may invoke exactly two tools: `get-product-details` and `submit-prepayment-step`. Attempts to invoke `buy-products`, `search-products`, `list-invoices`, `get-invoice-by-id`, or `update-order` fail locally before any remote MCP request. Ordinary product search and REST instrument flows remain REST-only. There is no production method that calls `buy-products`.

MCP output is untrusted external data. Tool descriptions, TOON/text, remote errors, and `agent_instructions` are never fed to an LLM and never become privileged application instructions.

MCP result categories are deliberately separate:

| Boundary | SatScout category |
| --- | --- |
| Network/connectivity or closed transport | `BITREFILL_MCP_UNAVAILABLE` |
| Request timeout | `BITREFILL_TIMEOUT` |
| MCP/JSON-RPC or SDK protocol validation failure | `BITREFILL_MCP_PROTOCOL_ERROR` |
| Valid `CallToolResult` with `isError=true` | `BITREFILL_MCP_TOOL_ERROR` |
| Successful result with malformed business data | `MALFORMED_RESPONSE` |

For a tool error, the interactive CLI may print one short sanitized explanation. The sanitizer knows the API credential and every form value already submitted in that MCP session, and also removes Bearer headers, URLs, and `bill_payment_id`. The error object carries only the tool name, `tool-error` result kind, token-safe structured code/category, sanitized short message, content block types, and SHA-256 message digest. Audit omits the message and stores only the normalized structural fields plus the digest. Raw MCP results are never persisted. A tool error from `submit-prepayment-step` is conservatively `AMBIGUOUS` and is never retried.

## Prepaid Visa / payment-card prepayment

Official eCommerce MCP docs (verified 2026-08-21): [ecommerce-mcp](https://docs.bitrefill.com/docs/ecommerce-mcp).

Live MCP authentication (observed 2026-08-21, not a permanent assumption): connecting to `https://api.bitrefill.com/mcp/<API_KEY>` returned that the key-in-path endpoint has been shut down and that clients must connect to `/mcp` with `Authorization: Bearer <api key>`. Currently published Bitrefill MCP docs still describe API-key-in-path authentication. SatScout follows the live server: production MCP is exactly `https://api.bitrefill.com/mcp` with Bearer auth via the MCP SDK `requestInit` headers. There is no fallback to `/mcp/<API_KEY>`.

Documented prepaid Visa flow:

```text
get-product-details
        ↓
prepayment form
        ↓
submit-prepayment-step
        ↓
possibly additional steps
        ↓
step = final
        ↓
bill_payment_id
        ↓
buy-products   ← unreachable in Chunk 06B
```

Current live observation (2026-08-24), confirmed with read-only inspect plus human-gated prepayment attempts:

- `get-product-details(prepaid-visa-usa)` currently returns an explicit product-not-found payload. Informational suggestions may include `virtual-prepaid-visa-usa`. SatScout reports `PRODUCT_NOT_FOUND` and does not auto-select a suggestion.
- `get-product-details(virtual-prepaid-visa-usa)` currently resolves. The observed prepayment schema is:

```text
prepayment:
  first_form:
    - id: bill_amount
      label: Enter amount
      type: text
      required: true
      max_length: null
```

- `bill_amount` is supported only as that first-step `first_form` field when `required` is true and `type` is `"text"`. SatScout derives the value from the Permit-bound `payment-instrument.acquire` face value using integer minor-unit conversion (`2500` → `"25.00"`). Callers, agents, and the local profile cannot supply or override `bill_amount`.
- `first_name` / `last_name` remain profile-sourced only if a later structured prepayment form actually returns them. They are not inferred from product instructions or descriptions such as "We'll ask for the first and last name...".
- After submitting step 1 `bill_amount`, the live server currently returns `step=1` with `first_name` and `last_name` text inputs plus `label` and `confirmButton` UI elements. Only the two text inputs become fields. The same-numbered different input form advances internal `nextStep` to 2. Step 2 sends `product_id=virtual-prepaid-visa-usa`, integer `step_number=2`, and `form_data` with exactly the string-valued keys `first_name` and `last_name`; presentation/control values are not sent.
- A subsequent live step-2 response was a valid MCP `CallToolResult` with `isError=true`. Earlier SatScout versions discarded its contents and mislabeled it `BITREFILL_MCP_UNAVAILABLE`. It is now `BITREFILL_MCP_TOOL_ERROR`; the binding remains `AMBIGUOUS`, the mutation is not retried, and only the safe diagnostic envelope described above may be surfaced.
- After `submit-prepayment-step`, the returned form is parsed before interpreting `response.step`. `step = submittedStep + 1` with an explicit next form is normal progression. `step = submittedStep` with an explicit next form whose normalized field IDs differ from the form just submitted (from SatScout's current prepayment state, not CLI input) is treated as acknowledgement; internal `nextStep = submittedStep + 1`. The same field IDs at the same step, ignoring order, are a repeat: `PREPAYMENT_STEP_MISMATCH`, never automatically resubmitted. `step < submittedStep` or `step > submittedStep + 1` remains invalid. `step="final"` still requires `bill_payment_id`.
- After a dispatched prepayment response, audit may record `responseStep`, safely parsed field IDs/types, and `returnedFormSchema`. The schema diagnostic contains only each entry's array index and `string` / `object` / `other` kind; object entries add key names, each key's value type, and token-safe string values for structural `id` / `type` keys only. It never records strings from string entries, other object values (including `label`, `placeholder`, and `buttonText`), form values, cardholder names, `bill_payment_id`, raw payloads, instructions, Authorization headers, or API keys.
- Authorized legacy face-value aliases remain `value`, `amount`, `package_value`, and `face_value`.
- Unknown fields (address, SSN, terms, KYC, phone, checkboxes) → `HUMAN_ACTION_REQUIRED`
- conservative maximum of 5 steps

Read-only `pnpm cli bitrefill mcp tools --json` performs initialization and `tools/list` only. Observed 2026-08-24: protocol `2025-11-25`; tool-list change notifications supported; `submit-prepayment-step` requires `product_id` string, `step_number` integer (minimum 1), and `form_data` object; `bill_payment_id` is optional; no output schema is advertised; invocation metadata marks it non-read-only, non-idempotent, open-world, and task-forbidden. This diagnostic never executes a business tool and does not broaden the allowlist.

Product facts are validated before the form is accepted: exact product id, `USD`, requested face value within the returned range and step, quantity 1, and the same Mission/Permit/grant binding. Inspect never calls `submit-prepayment-step`. Returned `instructions` / `description` text is untrusted and is not privileged application behavior.

Personal REST 404 for `prepaid-visa-usa` or 403 for `virtual-prepaid-visa-usa` must not block MCP inspect. REST HTTP 403 is `BITREFILL_FORBIDDEN`, not `AUTH_FAILED`; HTTP 401 remains `AUTH_FAILED`.

Personal REST still reports `REST_PREPAID_CARD_FLOW_UNAVAILABLE` for undocumented prepayment-shaped product fields. Chunk 06B does **not** fall back to `POST /v2/invoices` for prepaid Visa. If MCP prepayment cannot be completed safely, stop.

Prepayment is preparation, not economic authority. Completing the form does not create or consume a `payment-instrument.acquire` Authorization. A READY `InstrumentPrepaymentBinding` can produce a Permit **preview**. The default live flow does not authorize.

Raw `bill_payment_id` is sensitive execution material. SQLite stores only `SHA256(bill_payment_id)`. The raw value lives in an owner-only file under `.local/bitrefill/prepayments/<binding-id>`. Cardholder names come from `.local/bitrefill/prepayment-profile.json`, never from Mission/Permit/CLI arguments/audit.

## Credential handling

The Personal API key is **purchasing authority**.

```text
SATSCOUT_BITREFILL_API_KEY_PATH=/absolute/or/relative/path
SATSCOUT_BITREFILL_HTTP_TIMEOUT_MS=30000
SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=false
SATSCOUT_BITREFILL_MCP_API_KEY_PATH=/absolute/or/relative/path
SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=false
```

Recommended REST key file: `.local/bitrefill/api-key` with mode `0600`. Prefer a **separate** MCP API key at `.local/bitrefill/mcp-api-key`. Both paths are gitignored. Keys are never accepted on the CLI, never persisted, never logged, and never audited. Group/world-readable files are rejected.

`SATSCOUT_BITREFILL_API_KEY`, `SATSCOUT_BITREFILL_BASE_URL`, `SATSCOUT_BITREFILL_MCP_API_KEY`, and `SATSCOUT_BITREFILL_MCP_URL` are rejected if set. Production REST always targets `https://api.bitrefill.com/v2`. Production MCP always targets exactly `https://api.bitrefill.com/mcp` and authenticates with `Authorization: Bearer <key>` from `SATSCOUT_BITREFILL_MCP_API_KEY_PATH`. The API key is never placed in the URL, never logged, audited, persisted, included in thrown errors, accepted as a CLI argument, or exposed to the agent. Redirects use `manual` and fail closed. Tests inject a local MCP transport; production configuration cannot point MCP at another host. Repository-local prepayment secret directories must stay under `.local/`.

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
- Authorization header
- authenticated MCP URL
- raw BOLT11
- PAN/CVV/PIN/redemption codes
- personal prepayment form values
- raw `bill_payment_id`
- raw Bitrefill JSON or MCP payloads

`instrument_prepayments` stores only safe facts plus `SHA256(bill_payment_id)`. The raw id lives in `.local/bitrefill/prepayments/<binding-id>`.

An unpaid invoice from Chunk 06 does **not** mean the acquisition succeeded. A READY prepayment binding is **not** a purchase. Chunk 07 `SUCCEEDED` requires Wavelength payment confirmation, Bitrefill invoice `complete`, the exact order `delivered`, and a securely stored redemption secret. Funding uses a separate `value.transfer` child Authorization whose parent is the acquire Authorization.

## Chunk 07 bounded gift-card acquisition

Ordinary merchant gift cards use the Personal REST invoice flow, not MCP and not prepaid Visa. The Chunk 07 Mission type is `acquire-digital-product`. That type is workflow context only: Permit grants still decide provider, product, face value, and Lightning ceilings.

```text
exact Permit product + requested denomination
        │
        ▼
GET /v2/products/{id}
        │
        ▼
payment-instrument.acquire preview ALLOW
        │
        ▼
claim gift_card_acquisitions row
        │
        ▼
POST /v2/invoices  (once; lightning; auto_pay false; quantity 1)
        │
        ▼
Wavelength PrepareSend (rc4 mainnet readiness + ceilings)
        │
        ▼
authorize exact provider/product/package-or-range/value/quantity (parent)
        + exact principal/fee/total value.transfer (child)
        │
        ▼
EXECUTING, then Send exactly once
        │
        ▼
GET invoice + GET order
        │
        ▼
store redemption secret in .local/bitrefill/orders/<acquisition-id> (0600)
```

Bitrefill's catalog `packages[].price` and `price_rate` fields have no documented fiat-minor-unit semantics for this workflow. SatScout therefore ignores them: it does not convert `packages[].price` to `maxPurchasePriceMinor`, display it as a fiat purchase price, or infer an FX rate. The generic Permit domain retains optional `maxPurchasePriceMinor` for workflows with a safely sourced fiat purchase price, but the Chunk 07 gift-card example does not set or evaluate it.

The acquisition Authorization instead binds provider, exact product id, denomination kind, exact package id for a fixed package (or the exact range face value), currency, face value, and quantity `1`. Immediately before Send, SatScout re-fetches product facts and rejects a changed package id. The child `value.transfer` Authorization binds Wavelength's exact principal sats, fee sats, total-outflow sats, payment hash, and prepared-operation digest. Its Permit limits are the hard economic outflow bound: a higher invoice amount or fee that exceeds `maxPrincipal`, `maxFee`, or `maxTotalOutflow` is `DENY` before Send. Permit cannot widen SatScout ceilings. Once Wavelength confirms the Lightning payment, that `value.transfer` authority stays consumed even if Bitrefill later reports failure, refund, or an unknown delivery result. Missing Bitrefill invoice expiry is allowed only when Wavelength's prepared payment supplies a trusted expiry; otherwise the path is INDETERMINATE and does not Send.

Redemption code/PIN/link never enter SQLite, Authorization, Permit, Mission, logs, or default CLI output. The database stores only safe metadata plus a redemption-secret digest.

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

3. For prepaid-card MCP prepayment, generate a **separate** API key if the account supports multiple keys:

```sh
umask 077
printf '%s' 'YOUR_MCP_API_KEY' > .local/bitrefill/mcp-api-key
chmod 600 .local/bitrefill/mcp-api-key
export SATSCOUT_BITREFILL_MCP_API_KEY_PATH=./.local/bitrefill/mcp-api-key
```

4. Copy `examples/bitrefill/prepayment-profile.example.json` to `.local/bitrefill/prepayment-profile.json`, replace `REDACTED` with the real first and last name, and `chmod 600` the profile. Do not commit it.

5. Run the read-only commands in [MANUAL_TESTING.md](MANUAL_TESTING.md) before considering live prepayment. Do not purchase anything in Chunk 06B.

## CLI

Read-only:

```sh
pnpm cli bitrefill ping
pnpm cli bitrefill product search --query "visa"
pnpm cli bitrefill product show <exact-product-id>
pnpm cli bitrefill mcp tools --json
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

`--idempotency-key` is a SatScout Authorization/acquisition key, not a Bitrefill API field.

Gift-card inspect (read-only; no invoice):

```sh
pnpm cli bitrefill gift-card inspect \
  --mission <id> --permit <id> --grant <grant> \
  --product <exact-product-id> --value-minor 500
```

Integrated live purchase (human only; pays Lightning once):

```sh
SATSCOUT_LIVE_SPEND=true \
SATSCOUT_ALLOW_MAINNET_SPEND=true \
SATSCOUT_ALLOW_BITREFILL_PURCHASE=true \
pnpm cli bitrefill gift-card acquire \
  --mission <id> --permit <id> --grant <grant> \
  --transfer-grant <transfer-grant> \
  --product <exact-product-id> --value-minor 500 \
  --idempotency-key <key> \
  --confirm-real-purchase
```

Do not pass quantity, payment method, raw invoice JSON, or an arbitrary BOLT11. CLI success output is safe metadata only.

Read-only MCP prepayment inspect (calls only `get-product-details`):

```sh
pnpm cli bitrefill mcp prepayment inspect \
  --mission <id> --permit <id> --grant <grant> \
  --product prepaid-visa-usa --value-minor 5000
```

`prepaid-visa-usa` currently returns `PRODUCT_NOT_FOUND`. The live resolving product is:

```sh
pnpm cli bitrefill mcp prepayment inspect \
  --mission <id> --permit <id> --grant <grant> \
  --product virtual-prepaid-visa-usa --value-minor 2500
```

Live prepayment (human only; does not purchase):

```sh
SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=true \
pnpm cli bitrefill mcp prepayment prepare \
  --mission <id> --permit <id> --grant <grant> \
  --product virtual-prepaid-visa-usa --value-minor 2500 \
  --profile-file .local/bitrefill/prepayment-profile.json \
  --confirm-prepayment
```

Invalidate an unused binding:

```sh
pnpm cli bitrefill mcp prepayment invalidate --binding <binding-id>
```

Ambiguous bindings require `--acknowledge-ambiguous`.

## Face value vs later providers

Chunk 04's instrument grant uses face value. That fits prepaid Bitrefill products. Future providers such as Privacy-style virtual cards may represent spend limit / exposure instead of prepaid face value. Permit v2 is not redesigned for those providers in this chunk.

Do not create a live invoice or a live MCP prepayment during automated implementation. A human performs those acceptance tests after reviewing this document. Chunk 06B must never call `buy-products`.
