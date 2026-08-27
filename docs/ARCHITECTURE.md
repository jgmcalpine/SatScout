# Architecture

SatScout is one local application with explicit internal boundaries. The domain core knows nothing about SQLite, CLI parsing, networks, browsers, merchants, wallets, or language models.

```text
Mission (workflow type: book-campsite | acquire-digital-product)
   │
   ├── Permit (authority; grants, not Mission type)
   │      └── Authorization ledger (reserved usage)
   │
   ├── book-campsite → BookingAttempt
   │                      │
   │                      ├── workflow state
   │                      ├── PurchaseIntent   (legacy v1 diagnostic)
   │                      │       └── Payment
   │                      └── Reservation
   └── acquire-digital-product → gift-card acquisition (Chunk 07)
```

Economic control flow:

```text
                    HIGHER-RISK
                        │
                ActionRequest
                        │
                        ▼
                 Spend Controller
                        │
                 trusted resolver
                        │
                        ▼
                ResolvedAction
                        │
                        ▼
                   Permit Engine
                     /  |  \
                  DENY  INDETERMINATE  ALLOW
                                        │
                                        ▼
                                  Authorization
                                        │
                                   EXECUTING
```

Instrument acquisition (Chunks 06 and 07):

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
        │
        ├── Chunk 06: unpaid Lightning invoice only
        │
        └── Chunk 07 gift-card acquire:
              preview ALLOW → POST /invoices once
              → Wavelength PrepareSend
              → acquire Authorization (parent)
              → value.transfer Authorization (child)
              → EXECUTING → Send once
              → invoice + order reconcile
              → owner-only redemption secret
```

Funding (Chunk 05, Signet) remains a separate `value.transfer` path: PrepareSend → Authorization → EXECUTING → Send(intent) → InspectActivity. Chunk 07 reuses that funding model on **mainnet** only when it is the child of an exact Bitrefill gift-card acquire Authorization. Bitrefill is the instrument provider, not the Recreation.gov merchant. There is no generic mainnet-send command.

A Permit describes authority but does not itself grant access to funds. An Authorization reserves authority for one exact resolved action but is not itself a wallet credential. Wavelength is the first `FundingAdapter`. Bitrefill is the first `InstrumentAdapter`. Neither is part of Permit semantics. Provenance `PRODUCTION` means a real external service/evidence context, not Bitcoin mainnet.

## Security boundary

> A human grants software narrowly scoped economic authority for a specific Mission. The reasoning/orchestration layer may request actions, but only deterministic trusted code can resolve evidence, evaluate a Permit, reserve authority, and create an executable Authorization.

Permit evaluation is a pure function. Given a validated Permit v2, a validated ResolvedAction, evaluation timestamp, ledger-derived usage, and optional parent Authorization, it returns `ALLOW`, `DENY`, or `INDETERMINATE` with every applicable reason in stable order. It has no database write, clock side effect, network, or payment effect. Limits use integer USD cents and integer satoshis as independent dimensions. The engine does not convert fiat to bitcoin. Gift-card `payment-instrument.acquire` also binds the trusted Bitrefill purchase price and evaluates it against `maxPurchasePriceMinor`, independent of face value and of Lightning sat ceilings.

Preview evaluation mutates nothing. `authorize` is a separate `BEGIN IMMEDIATE` transaction that reloads the Permit and ledger, evaluates, reserves usage, and inserts the Authorization together. No Authorization exists without its reservation.

The CLI's legacy `purchase evaluate` command still constructs an in-memory v1 proposal and discards it. Permit v2 must be evaluated with `spend evaluate`. Cart capture is not a purchase and does not consult or consume Permit spending. `SATSCOUT_LIVE_SPEND` is necessary but not sufficient for Wavelength Signet Send. `SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE` is necessary but not sufficient for an unpaid Bitrefill invoice and does not authorize a payment.

Chunk 06 still shares one OS process. TypeScript modules are not a hard isolation boundary. See [docs/THREAT_MODEL.md](THREAT_MODEL.md).

## Layers

### Domain

`src/domain` owns runtime schemas, relationship invariants, the workflow transition table, Permit v2 grants, ActionRequest/ResolvedAction, three-state evaluation, and Authorization lifecycle. Zod validates every record entering through JSON, CLI construction, or SQLite rehydration. TypeScript runs with strict settings, but compile-time types are never treated as validation of external input.

Mission type is workflow context, not spending authority. `book-campsite` carries campground, allowed sites, and stay dates for the Recreation.gov adapter. `acquire-digital-product` is a minimal lifecycle record for generic digital-product acquisition (current MVP). Mission type does not authorize Bitrefill, Recreation.gov, a product, a provider, or any value. The Permit Engine references `missionId` and typed economic grants. It does not know what a campground or a gift card is.

`src/domain/workflow/workflow.ts` is the only authority for BookingAttempt transitions. The normal path is:

```text
WAITING -> AVAILABLE -> CARTING -> CART_HELD -> PAYMENT_REQUESTED
        -> PAYMENT_AUTHORIZED -> CARD_ACQUIRED -> CHECKOUT -> CONFIRMED
```

Nonterminal states may move to `PAUSED`, `FAILED`, `EXPIRED`, or `ABORTED` where explicitly listed. `PAUSED` can resume at `WAITING`. `CONFIRMED`, `FAILED`, `EXPIRED`, and `ABORTED` are terminal. Requesting the current state is an idempotent no-op; every other unlisted edge is rejected.

Authorization statuses are separate from BookingAttempt workflow:

```text
AUTHORIZED -> EXECUTING -> SUCCEEDED | FAILED_SAFE | AMBIGUOUS
AUTHORIZED -> RELEASED
FAILED_SAFE -> RELEASED
```

`AMBIGUOUS` may later reconcile to `SUCCEEDED` or `FAILED_SAFE`. Automatic release after `EXECUTING` is forbidden.

### Persistence and audit

`src/persistence` uses Node 24's built-in SQLite API. Versioned migrations create strict tables, foreign keys, indexes, and append-only triggers. Domain records are stored as validated JSON together with relational identity, lifecycle, and relationship columns. Schema version 2 adds Permit lifecycle columns and the Authorization ledger. Schema version 3 adds funding-execution records and a partial unique index on active payment identity. Usage is derived from Authorization rows, not mutable counters.

State updates and audit inserts share `BEGIN IMMEDIATE` transactions. An audit failure rolls back the state update. Audit rows receive monotonically increasing sequence numbers, are read in sequence order, and cannot be updated or deleted through SQLite without a trigger failure. Observation uses a separate append-only audit method and does not update BookingAttempt rows. Schema version 7 widens the Mission type CHECK to `book-campsite | acquire-digital-product` without rewriting existing campsite rows.

Cart capture has two specialized atomic persistence operations. `beginCartCapture` records the exact campground/site/date recovery target, changes `AVAILABLE` to `CARTING`, and appends the workflow and cart-action-started audit events in one transaction. The browser action is not invoked until that transaction returns. `completeCartCapture` records independent hold evidence and changes `CARTING` to `CART_HELD` atomically. A database or audit failure therefore cannot leave an unrecorded state transition that permits an unsafe retry.

Audit metadata is passed through the same recursive sensitive-field redactor used for structured logs. Observation events contain structured result states and non-sensitive reason codes, never cookies, tokens, HTML, credentials, or browser storage.

### CLI and configuration

`src/cli` translates human commands into store/domain/application calls. It contains no transition rules, Permit policy rules, or browser selectors. Every invocation opens, migrates, uses, and closes the configured database, which makes restart durability visible during ordinary manual testing.

`src/config` validates the database path, both live switches, simulated-spend, Signet-test-spend, the dedicated browser-profile path, headed/headless mode, the bounded browser timeout, and optional Wavelength loopback REST settings. Repository-local browser profiles are restricted to `.local/`; known normal Chrome/Chromium profile locations are rejected. `SATSCOUT_LIVE_BOOKING` is one required cart gate; an explicit per-command `--confirm-live-cart` acknowledgement is independently required. `SATSCOUT_LIVE_SPEND` is necessary but not sufficient for Send. `SATSCOUT_ALLOW_SIGNET_TEST_SPEND` and `--confirm-signet-spend` are additional Signet gates. `SATSCOUT_ALLOW_SIMULATED_SPEND` defaults to false and only enables labeled simulation evidence.

### Logging

`src/logging` emits JSON lines and recursively redacts keys such as passwords, secrets, tokens, authorization, cookies, card fields, private keys, macaroons, preimages, invoices, and seeds. The redactor handles nested objects and arrays and is also applied to audit metadata.

### Spend Controller and funding adapters

`src/application/spend-controller.ts` is the only application entry for economic authorization. Untrusted callers supply ActionRequests. The controller may create explicitly labeled simulation ResolvedActions, preview Permit decisions, request atomic Authorization, and manage Authorization lifecycle.

Wavelength Signet is implemented in `src/integrations/wavelength` and orchestrated by `src/application/wavelength-spend.ts`. It calls only:

```text
POST /v1/wallet/status
POST /v1/wallet/prepare-send
POST /v1/wallet/send
POST /v1/wallet/inspect/activity
```

Trusted `TEST_NETWORK` provenance with `adapterId = wavelength.signet` can be constructed only from a validated PrepareSend response and is accepted only through `previewWavelengthSignet` / `authorizeWavelengthSignet`. Public `preview` / `authorize` never accept it. CLI JSON cannot impersonate it. Send receives only the authorized prepared intent. `AUTHORIZED → EXECUTING` is persisted before Send. Send is invoked at most once and is never retried.

### Spend Controller and instrument adapters

Bitrefill Personal REST is implemented in `src/integrations/bitrefill` and orchestrated by `src/application/bitrefill-instrument.ts`. The public client exposes only:

```text
GET  /v2/ping
GET  /v2/products/search
GET  /v2/products/{id}
POST /v2/invoices
GET  /v2/invoices/{id}
GET  /v2/orders/{id}
```

Trusted `PRODUCTION` provenance with `adapterId = bitrefill.personal` can be constructed only from an authenticated product lookup and is accepted only through `previewBitrefillPersonal` / `authorizeBitrefillPersonal`. Public `preview` / `authorize` expose no accept flags. CLI JSON cannot impersonate it. `PRODUCTION` here is the Bitrefill service evidence context, not Bitcoin mainnet. Chunk 06 invoice creation requires Permit ALLOW, a durable `payment-instrument.acquire` Authorization, `AUTHORIZED → EXECUTING` persistence, Lightning-only payment method, quantity one, and explicit live-invoice gates. Chunk 07 gift-card acquire claims a `gift_card_acquisitions` row before `POST /invoices`, then authorizes acquire plus a parent-linked `value.transfer` before one Wavelength mainnet Send. Redemption secrets are stored under `.local/bitrefill/orders/` with mode `0600`, never in SQLite.

Chunk 06B adds `src/integrations/bitrefill/mcp` and `src/application/bitrefill-prepayment.ts`. The public adapter exposes `inspectProtocol` (initialize + `tools/list` only), `inspectPrepaymentProduct`, and `submitPrepaymentForm`. Callers cannot choose MCP tool names. The runtime business allowlist remains `get-product-details` and `submit-prepayment-step`; protocol introspection does not broaden it. `buy-products` and `search-products` are unreachable. Personal REST remains the path for ordinary search and REST instrument flows; it is not a prerequisite for MCP inspect. MCP `get-product-details` is the trusted resolver for the exact Permit/grant product on the MCP-prepayment path. REST and MCP product identifiers may differ. Production MCP requests go to exactly `https://api.bitrefill.com/mcp` with `Authorization: Bearer` from the owner-only MCP key file; the shut-down key-in-path URL is not used. MCP initialize/`tools/list` are protocol requirements, not application capabilities.

The MCP boundary distinguishes transport/connectivity failures (`BITREFILL_MCP_UNAVAILABLE` / `BITREFILL_TIMEOUT`), JSON-RPC or SDK protocol failures (`BITREFILL_MCP_PROTOCOL_ERROR`), valid `CallToolResult.isError=true` tool failures (`BITREFILL_MCP_TOOL_ERROR`), and successful tool results whose business payload is malformed (`MALFORMED_RESPONSE`). A mutating tool error remains ambiguous and is never retried. Interactive diagnostics may show one bounded, value-aware-redacted remote explanation. Audit stores only normalized tool code/category, content block types, and a SHA-256 message digest—not remote prose or the raw result. Durable `instrument_prepayments` rows store only the SHA-256 digest of `bill_payment_id` plus safe economic facts. Raw `bill_payment_id` and cardholder names stay in owner-only `.local/bitrefill/` files. A READY binding can produce a Permit preview via `previewBitrefillMcpPrepayment` and does not consume an execution slot. Public `preview` / `authorize` deny `bitrefill.mcp-prepayment` provenance.

Merchant adapters remain type-only. There is no Recreation.gov checkout path and no generic Bitrefill MCP purchasing path.

### Recreation.gov observation and cart boundaries

```text
                    Mission
                       │
             Application layer
                /             \
               ▼               ▼
       RecreationGovObserver  RecreationGovCartCapture
             READ ONLY        ONE NARROW WRITE
                                  │
                                  ▼
                               Cart
                                  │
                                  X
                         later reservation steps
```

`src/application/recreation-observation.ts` owns the narrow observation port and orchestration. It loads an `ACTIVE`, unexpired `book-campsite` Mission, rejects any other Mission type before browser launch, rejects a selected site that is not in `Mission.siteIds` before any browser launch, optionally validates the BookingAttempt relationship, invokes `observeMissionTarget`, and records sanitized audit events. It never calls the workflow transition function.

`src/integrations/recreation-gov` implements that port. Playwright types, Recreation.gov URLs, selectors, calendar interaction, session signals, and challenge signals remain inside the adapter. The domain has no Playwright dependency. The public observer surface has one operation; application code receives no generic click, fill, script, or form-submission capability.

The adapter constructs `https://www.recreation.gov/camping/campsites/<numeric-id>` itself. It reads a level-one site heading, the visible campground link and provider ID, and accessible per-date calendar status labels from semantic grid-cell or button elements. Session and calendar reads wait only within the configured browser timeout for client-rendered signals to hydrate. Calendar movement is limited to bounded `Previous` and `Next` controls. Unexpected origins, malformed IDs, ambiguous selectors, unfamiliar status text, and missing date cells fail closed.

> Observation and transaction execution are separate capabilities.

The observer does not acquire transactional browser authority merely because it can inspect a page. Authentication and human-verification are detected as explicit states; challenges are never clicked or solved. Observation can append audit events but cannot move `WAITING` to `AVAILABLE` or perform any other workflow transition.

`src/application/recreation-cart.ts` owns the separate cart port. Its application-visible surface contains only `inspectCart(target)`, `inspectReadiness(missionId, target)`, and `captureVerifiedCart(missionId, target, authorizeAction)`. It exposes no generic click, navigation, script, form-fill, submission, removal, reservation-completion, or payment operation. Inspection and readiness are externally read-only. Capture can select only the exact target passed from a validated Mission and can invoke only the exact Add-to-Cart control.

Readiness and capture use one scoped persistent-browser context per invocation. The adapter reuses the existing observation implementation on the exact campsite page, then navigates that same page to `/cart`. It observes the same-origin structured `GET /api/cart/shoppingcart` response produced by Recreation.gov's frontend and cross-checks it against the rendered empty or item state. Once the authenticated cart is independently empty, readiness returns to the exact campsite and proves the UI can prepare the exact arrival/departure range. This may change transient page selection only; it cannot invoke Add to Cart or mutate workflow state. The structured response is primary evidence for authenticated account state and reservation identity; visible account and cart UI remain independent diagnostic/cross-check signals. SatScout never reads browser storage or credentials, persists response bodies, or issues a direct mutating cart request.

The capture service requires the attempt to be exactly `AVAILABLE`; it never infers availability or creates that state. Immediately before capture, the single session must prove that the Mission is active and unexpired, the site is allowed, structured account evidence is `AUTHENTICATED`, challenge is `NONE`, target and dates exactly match, every occupied night is `AVAILABLE`, the cart is `EMPTY`, and exact date-range preparation is `VERIFIED`. Calendar controls are awaited within the configured hydration timeout, and an already exact selected range is accepted idempotently. An exact existing target is reported without claiming SatScout created it; unrelated, multiple, loading, contradictory, and unknown contents fail closed.

The adapter passes this evidence to a synchronous application-owned authorization callback. That callback revalidates the evidence and atomically persists the exact target plus `CARTING`. The adapter cannot invoke Add to Cart unless the callback returns successfully. After the durable commit, the same session rechecks the cart, navigates to the exact campsite, verifies availability and selected dates again, and invokes Add to Cart at most once. It then performs a fresh structured cart read plus rendered UI cross-check. The result includes campground/site identity, exact dates, departure-exclusive night count, hold state, and optional price. Only one independently exact item moves the attempt to `CART_HELD`.

> Once an external cart action may have occurred, SatScout never repeats it until the external state is reconciled.

An exception, timeout, navigation failure, late challenge, wrong target, wrong dates, conflicting item, or incomplete cart evidence leaves the attempt in `CARTING`. A repeated capture command is rejected before browser mutation. Read-only reconciliation can move `CARTING` to `CART_HELD` only when the persisted exact target is independently present; every other result leaves `CARTING` unchanged. When durable evidence says `actionAttempted: false` and independent inspection says `EMPTY`, the stranded attempt remains the immutable failure record; a later retry uses a fresh BookingAttempt for the same unchanged Mission. If the action may have run, no replacement attempt is safe until the external cart state is resolved. There is no automatic `CARTING -> AVAILABLE` path and no automated cart cleanup.

The dedicated persistent profile defaults to `.local/browser/recreation-gov`, is gitignored, and never enters SQLite, audit metadata, logs, traces, screenshots, HTML captures, or storage-state exports. The manual browser flow lets a human authenticate directly with Recreation.gov; SatScout does not accept login credentials.

## Future adapters

Future reservation-step, merchant, and additional wallet integrations belong outside the domain core, observation adapter, and cart-capture surface. Later chunks can call inward through the Spend Controller to request state transitions or policy decisions; they must not replicate, bypass, or weaken domain rules, broaden the observer, or reuse the cart adapter as a generic browser controller. Wavelength remains a FundingAdapter. Bitrefill remains an InstrumentAdapter. The Permit Engine stays provider-agnostic.
