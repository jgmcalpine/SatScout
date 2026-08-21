# Threat model

SatScout's economic design is **bounded authority**, not a wallet. A human grants software narrowly scoped economic permission for one Mission. Reasoning and orchestration may request actions. Only deterministic trusted code may resolve evidence, evaluate a Permit, reserve authority, and create an Authorization.

Chunk 05 implements funding with one Signet-only Wavelength adapter. Chunk 06 adds Bitrefill as a trusted instrument provider. Mainnet spending is not a configuration change. Paying a Bitrefill invoice is not a Chunk 06 configuration change.

## Trust zones

```text
HIGHER-RISK / UNTRUSTED

Agent / orchestrator / LLM (future)
browser
merchant page content
ActionRequest fields
external website values
CLI JSON supplied as an ActionRequest

         │
         │  ActionRequest is never itself executable
         ▼

TRUSTED ECONOMIC CORE

Spend Controller
simulated resolvers (explicitly labeled; flag-gated)
Permit Engine
Authorization ledger
SQLite persistence and append-only audit

         │
         │  Authorization is not a credential and moves no money
         ▼

FUTURE / CURRENT EXECUTION ADAPTERS

Wavelength Signet FundingAdapter (loopback REST, macaroon)
Bitrefill Personal InstrumentAdapter (fixed HTTPS host, API key file)
MerchantAdapter (not implemented)
wallet seed/password  (never enter SatScout)
```

The TypeScript module boundaries, provenance strings, and adapter allowlists provide **domain guarantees**. They are not a process-level isolation boundary. The untrusted CLI, Spend Controller, Permit Engine, SQLite store, Wavelength REST client, and Bitrefill REST client still share one OS process.

The Wavelength daemon macaroon may possess broader wallet authority than SatScout's four-route adapter surface. The Bitrefill Personal API key can create purchases independently of SatScout policy if stolen or used outside this adapter. TypeScript module boundaries do not stop arbitrary code execution in the SatScout process. A dedicated Signet wallet with a small balance, an owner-only API key file, and the unpaid-invoice gate limit blast radius. Before unattended real-money operation, process/OS isolation for Bitrefill and Wavelength credentials should remain under review. The current adapters are **not** a cryptographic capability boundary against total process compromise.

## What each object is allowed to do

| Object | Can move money? | Can reserve authority? |
| --- | --- | --- |
| ActionRequest | No. Untrusted intent only. | No. |
| Permit | No. Describes authority. | No. A Permit is not a wallet credential. |
| ResolvedAction | No. Trusted-looking evidence only. | No. |
| Preview evaluation | No. | No. Side-effect free. |
| Authorization | No. | Yes. Reserves a ledger slot for one exact resolved action. |
| SATSCOUT_LIVE_SPEND | No, by itself. Necessary but not sufficient for Signet Send. | No. |
| SATSCOUT_ALLOW_SIGNET_TEST_SPEND | No, by itself. | No. |
| SATSCOUT_ALLOW_SIMULATED_SPEND | No. Enables simulated evidence only. | Yes, for simulation Authorizations only. |
| SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE | No. Necessary but not sufficient for one unpaid invoice. Does not pay. | No, by itself. |

An Authorization reserves authority for one exact resolved action. It is not a wallet credential, payment, invoice, or card.

## Provenance

ResolvedAction carries explicit provenance:

```text
environment: PRODUCTION | TEST_NETWORK | SIMULATION
source: trusted-adapter | simulation
adapterId
referenceId
resolvedAt
```

`adapterId` text is **not** a security boundary by itself. The Spend Controller denies generic `PRODUCTION` provenance. `PRODUCTION` / `bitrefill.personal` may be authorized only when constructed in-process from an authenticated Bitrefill product lookup, and only for `payment-instrument.acquire`. `TEST_NETWORK` / `wavelength.signet` provenance may be authorized only when constructed in-process from a validated Wavelength PrepareSend on a Signet daemon. CLI JSON cannot impersonate either trusted adapter. Simulation provenance is accepted only when `SATSCOUT_ALLOW_SIMULATED_SPEND=true`, and it is labeled `cli.simulation`. `PRODUCTION` describes the external-service evidence context, not Bitcoin mainnet.

## Threats and defenses

| Threat | Defense |
| --- | --- |
| Agent requests arbitrary payment | ActionRequest cannot authorize. Only a matching ResolvedAction plus an ACTIVE Permit can. |
| Agent lies about merchant/provider | Permit Engine matches resolved identity against typed grants. Wrong counterparty/provider/product/rail is `DENY`. |
| Invoice or destination swapped after approval | Authorization is bound to a SHA-256 digest of the canonical ResolvedAction. A different action cannot reuse it. |
| Permit modified after activation | ACTIVE Permits are immutable. Material change requires revoke + new Permit + activate. |
| Permit from Mission A used by Mission B | `MISSION_MISMATCH` `DENY`. Parent Authorizations must belong to the same Mission. |
| Double authorization race | `BEGIN IMMEDIATE` plus ledger-derived usage. Concurrent callers cannot oversubscribe max executions or aggregate budget. |
| Same Authorization reused for a different action | Digest mismatch and idempotency-key conflict `DENY`. |
| Expired or not-yet-valid Permit | `DENY`. |
| Revoked Permit | No new Authorizations. Historical Authorizations remain intact. |
| Unknown fee or total outflow | `INDETERMINATE`, fail-closed. Execution must not proceed. |
| Missing trusted provenance | `INDETERMINATE`. |
| Forged parent linkage | Missing parent is `INDETERMINATE`. Wrong Mission/kind/released parent is `DENY`. |
| Crash before execution | `AUTHORIZED` with `externalActionAttempted=false` may be released. |
| Crash after execution may begin | `AUTHORIZED → EXECUTING` is recorded first. Automatic release is forbidden. |
| Ambiguous external outcome | `AMBIGUOUS` keeps authority reserved. No timeout→release→retry. |
| Duplicate Lightning payment hash | Partial unique index plus authorize-time check. RELEASED-before-execution may allow a fresh prepare of the same invoice. |
| Wavelength Send timeout/5xx | Exactly one Send. Result is `AMBIGUOUS` until reconciliation. No automatic retry. |
| Forged Wavelength provenance via CLI JSON | Spend Controller denies `TEST_NETWORK` / `wavelength.signet` unless the in-process adapter path set `acceptTestNetwork`. |
| Forged Bitrefill provenance via CLI JSON | Spend Controller denies `PRODUCTION` / `bitrefill.personal` unless the in-process adapter path set `acceptBitrefillPersonal`. |
| Mainnet escape hatch | Network is hard-coded to Signet from Wavelength Status. No config override. |
| Macaroon / invoice leakage | Recursive redaction; invoices read from a file; macaroon never printed or persisted. |
| Bitrefill API key is purchasing authority | Key is read from an owner-only file. Never accepted on the CLI, logged, audited, or persisted. Group/world-readable files are rejected. |
| Token sent to an attacker-controlled host | Production origin is fixed to `https://api.bitrefill.com`. `SATSCOUT_BITREFILL_BASE_URL` is rejected. Redirects use `manual` and fail closed. |
| Agent/browser possesses the Bitrefill token | Token stays in the trusted core. No Bitrefill MCP and no LLM tools. |
| Caller supplies product facts as authority | Adapter independently GETs current product details. Search cannot auto-select. Ambiguous packages are `PRODUCT_SELECTION_AMBIGUOUS`. |
| Catalog changed since earlier resolution | Product is re-fetched before Authorization/invoice. Currency, denomination, type, availability, or undocumented prepayment changes fail closed. |
| Duplicate Bitrefill invoice | `POST /invoices` is never retried. EXECUTING is durable first. Duplicate Authorization reuses the existing invoice identity. |
| Timeout after POST /invoices | Ambiguous external operation. Authority stays reserved. No second invoice. |
| Unexpected paid/complete invoice | Audit `BITREFILL_UNEXPECTED_PAYMENT_STATE`. Do not claim SatScout paid it. Do not auto-release. |
| Fulfillment / card data leakage | Allowlisted invoice/order parsing. PAN/CVV/PIN/redemption/`extra_fields` redacted. Raw BOLT11 is digested and discarded, not persisted or audited. |
| Remote API text treated as instructions | Product copy, MCP `agent_instructions`, and error messages are untrusted data. Permit Engine stays Bitrefill-agnostic. |
| Undocumented prepaid-Visa REST flow | Reported as `REST_PREPAID_CARD_FLOW_UNAVAILABLE`. No scraping, guessed endpoints, or MCP bypass. |
| Integer overflow / invalid values | Safe-integer arithmetic. Overflow and inconsistent outflow `DENY`. Strict decimal parsing for Bitrefill major units. |
| Secret leakage through audit | Recursive redaction of tokens, invoices, card data, seeds, macaroons, preimages, personal form fields, and redemption data. |
| Legacy Permit accidentally widened | v1 records remain readable and non-authorizable. Replacement must be an explicit v2 Permit. |

## Evaluation semantics

```text
ALLOW          every required rule is satisfied by trusted resolved evidence
DENY           known evidence violates the Permit
INDETERMINATE  required evidence is missing or cannot be trusted
```

`INDETERMINATE` is fail-closed. It is diagnostic: SatScout cannot safely prove permission. It is not a license to retry, guess, or execute.

## Safe release

Release is allowed only when SatScout can prove no irreversible external action began:

```text
AUTHORIZED → RELEASED     allowed
FAILED_SAFE → RELEASED    allowed after independent proof the action did not occur
EXECUTING → RELEASED      forbidden
AMBIGUOUS → RELEASED      forbidden
SUCCEEDED → RELEASED      forbidden
```

There is no `timeout → release → retry` path. This is the financial equivalent of the `CARTING` rule.

## Payment-rail selection

The Permit Engine may constrain `allowedRails`. It does not choose a rail, convert USD to BTC, or implement Lightning, cards, ACH, NWC, or on-chain Bitcoin. Chunk 05's Wavelength adapter admits only a complete Lightning quote on Signet.

Permit limits remain primary authorization. Provider-side Bitrefill restrictions (Lightning-only, quantity one, `auto_pay=false`) are defense in depth.

## Out of scope in Chunk 06

No Wavelength PrepareSend/Send from the Bitrefill path, no paying a Bitrefill invoice, no Bitrefill balance/cashback/auto-pay, no mainnet, no MCP purchasing tools, no Recreation.gov checkout, no Camply, no LLM integration, and no wallet create/unlock. An unpaid invoice is not a completed instrument acquisition.
