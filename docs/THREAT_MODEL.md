# Threat model

SatScout's economic design is **bounded authority**, not a wallet. A human grants software narrowly scoped economic permission for one Mission. Reasoning and orchestration may request actions. Only deterministic trusted code may resolve evidence, evaluate a Permit, reserve authority, and create an Authorization.

Chunk 05 implements that model with one Signet-only Wavelength funding adapter. Mainnet spending is not a configuration change.

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
InstrumentAdapter / MerchantAdapter (not implemented)
wallet seed/password  (never enter SatScout)
```

TypeScript types, module boundaries, and provenance strings provide **domain guarantees**. They are not a process-level isolation boundary. The untrusted CLI, Spend Controller, Permit Engine, SQLite store, and Wavelength REST client still share one OS process.

The Wavelength daemon macaroon may possess broader wallet authority than SatScout's four-route adapter surface. TypeScript module boundaries do not stop arbitrary code execution in the SatScout process. A dedicated Signet wallet with a small balance limits blast radius. Before unattended mainnet, process/OS isolation for the funding adapter should be evaluated. The current adapter is **not** a cryptographic capability boundary against total process compromise.

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

`adapterId` text is **not** a security boundary by itself. The Spend Controller denies `PRODUCTION` provenance. `TEST_NETWORK` / `wavelength.signet` provenance may be authorized only when constructed in-process from a validated Wavelength PrepareSend on a Signet daemon. CLI JSON cannot impersonate it. Simulation provenance is accepted only when `SATSCOUT_ALLOW_SIMULATED_SPEND=true`, and it is labeled `cli.simulation`.

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
| Mainnet escape hatch | Network is hard-coded to Signet from Wavelength Status. No config override. |
| Macaroon / invoice leakage | Recursive redaction; invoices read from a file; macaroon never printed or persisted. |
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

The Permit Engine may constrain `allowedRails`. It does not choose a rail, convert USD to BTC, or implement Lightning, cards, ACH, NWC, or on-chain Bitcoin. Chunk 05's Wavelength adapter admits only a complete Lightning quote on Signet.

## Out of scope in Chunk 05

No mainnet, LND, Core Lightning, Breez, NWC, Bitrefill, prepaid cards, Recreation.gov checkout, Camply, LLM integration, wallet create/unlock, or `wavecli` from application code.
