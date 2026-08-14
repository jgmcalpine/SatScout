# Threat model

SatScout's economic design is **bounded authority**, not a wallet. A human grants software narrowly scoped economic permission for one Mission. Reasoning and orchestration may request actions. Only deterministic trusted code may resolve evidence, evaluate a Permit, reserve authority, and create an Authorization.

Chunk 04 implements that model without connecting a wallet or moving money.

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

FUTURE EXECUTION ADAPTERS

FundingAdapter / InstrumentAdapter / MerchantAdapter
wallet credentials, invoices, cards  (not present in Chunk 04)
```

TypeScript types, module boundaries, and provenance strings provide **domain guarantees**. They are not a process-level isolation boundary. In Chunk 04 the untrusted CLI, Spend Controller, Permit Engine, and SQLite store still share one OS process.

Before mainnet unattended spending, SatScout should reevaluate separating wallet and financial credentials from browser/agent execution at a process or OS boundary. Do not treat TypeScript modules as protection against arbitrary-code execution in the same process.

## What each object is allowed to do

| Object | Can move money? | Can reserve authority? |
| --- | --- | --- |
| ActionRequest | No. Untrusted intent only. | No. |
| Permit | No. Describes authority. | No. A Permit is not a wallet credential. |
| ResolvedAction | No. Trusted-looking evidence only. | No. |
| Preview evaluation | No. | No. Side-effect free. |
| Authorization | No. | Yes. Reserves a ledger slot for one exact resolved action. |
| SATSCOUT_LIVE_SPEND | No. Inert in Chunk 04. | No. |
| SATSCOUT_ALLOW_SIMULATED_SPEND | No. Enables simulated evidence only. | Yes, for simulation Authorizations only. |

An Authorization reserves authority for one exact resolved action. It is not a wallet credential, payment, invoice, or card.

## Provenance

ResolvedAction carries explicit provenance:

```text
environment: PRODUCTION | SIMULATION
source: trusted-adapter | simulation
adapterId
referenceId
resolvedAt
```

`adapterId` text is **not** a security boundary by itself. Production adapters must eventually hold credentials behind the Spend Controller. Chunk 04 has no production adapters. The Spend Controller denies `PRODUCTION` provenance. Simulation provenance is accepted only when `SATSCOUT_ALLOW_SIMULATED_SPEND=true`, and it is labeled `cli.simulation`.

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
| Integer overflow / invalid values | Safe-integer arithmetic. Overflow and inconsistent outflow `DENY`. |
| Secret leakage through audit | Recursive redaction of tokens, invoices, card data, seeds, macaroons, preimages. |
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

The Permit Engine may constrain `allowedRails`. It does not choose a rail, convert USD to BTC, or implement Lightning, cards, ACH, NWC, or on-chain Bitcoin. Route selection belongs to the Spend Controller in a later chunk.

## Out of scope in Chunk 04

No Wavelength, LND, Core Lightning, Breez, NWC, Bitrefill, prepaid cards, invoices, Lightning payments, Recreation.gov checkout, Camply, LLM integration, or external economic network calls.
