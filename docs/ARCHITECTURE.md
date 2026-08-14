# Architecture

SatScout is one local application with explicit internal boundaries. The domain core knows nothing about SQLite, CLI parsing, networks, browsers, merchants, wallets, or language models.

```text
Mission
   │
   ├── Permit (authority)
   │      └── Authorization ledger (reserved usage)
   │
   └── BookingAttempt
           │
           ├── workflow state
           ├── PurchaseIntent   (legacy v1 diagnostic)
           │       └── Payment
           └── Reservation
```

Economic control flow:

```text
Agent / Orchestrator
        │
  ActionRequest          (untrusted; never executable)
        ▼
  Spend Controller
        │
  ResolvedAction         (trusted or explicitly simulated evidence)
        ▼
   Permit Engine
   /     |      \
DENY  INDETERMINATE  ALLOW
                      │
                      ▼
                Authorization
                      │
                future adapter
```

A Permit describes authority but does not itself grant access to funds. An Authorization reserves authority for one exact resolved action but is not itself a wallet credential.

## Security boundary

> A human grants software narrowly scoped economic authority for a specific Mission. The reasoning/orchestration layer may request actions, but only deterministic trusted code can resolve evidence, evaluate a Permit, reserve authority, and create an executable Authorization.

Permit evaluation is a pure function. Given a validated Permit v2, a validated ResolvedAction, evaluation timestamp, ledger-derived usage, and optional parent Authorization, it returns `ALLOW`, `DENY`, or `INDETERMINATE` with every applicable reason in stable order. It has no database write, clock side effect, network, or payment effect. Limits use integer USD cents and integer satoshis as independent dimensions. The engine does not convert fiat to bitcoin.

Preview evaluation mutates nothing. `authorize` is a separate `BEGIN IMMEDIATE` transaction that reloads the Permit and ledger, evaluates, reserves usage, and inserts the Authorization together. No Authorization exists without its reservation.

The CLI's legacy `purchase evaluate` command still constructs an in-memory v1 proposal and discards it. Permit v2 must be evaluated with `spend evaluate`. Cart capture is not a purchase and does not consult or consume Permit spending. `SATSCOUT_LIVE_SPEND` remains inert.

Chunk 04 still shares one OS process. TypeScript modules are not a hard isolation boundary. See [docs/THREAT_MODEL.md](THREAT_MODEL.md).

## Layers

### Domain

`src/domain` owns runtime schemas, relationship invariants, the workflow transition table, Permit v2 grants, ActionRequest/ResolvedAction, three-state evaluation, and Authorization lifecycle. Zod validates every record entering through JSON, CLI construction, or SQLite rehydration. TypeScript runs with strict settings, but compile-time types are never treated as validation of external input.

Mission remains responsible for task-specific constraints such as `book-campsite`, campground, allowed sites, and dates. The Permit Engine references `missionId` and typed economic grants. It does not know what a campground is.

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

`src/persistence` uses Node 24's built-in SQLite API. Versioned migrations create strict tables, foreign keys, indexes, and append-only triggers. Domain records are stored as validated JSON together with relational identity, lifecycle, and relationship columns. Schema version 2 adds Permit lifecycle columns and the Authorization ledger. Usage is derived from Authorization rows, not mutable counters.

State updates and audit inserts share `BEGIN IMMEDIATE` transactions. An audit failure rolls back the state update. Audit rows receive monotonically increasing sequence numbers, are read in sequence order, and cannot be updated or deleted through SQLite without a trigger failure. Observation uses a separate append-only audit method and does not update BookingAttempt rows.

Cart capture has two specialized atomic persistence operations. `beginCartCapture` records the exact campground/site/date recovery target, changes `AVAILABLE` to `CARTING`, and appends the workflow and cart-action-started audit events in one transaction. The browser action is not invoked until that transaction returns. `completeCartCapture` records independent hold evidence and changes `CARTING` to `CART_HELD` atomically. A database or audit failure therefore cannot leave an unrecorded state transition that permits an unsafe retry.

Audit metadata is passed through the same recursive sensitive-field redactor used for structured logs. Observation events contain structured result states and non-sensitive reason codes, never cookies, tokens, HTML, credentials, or browser storage.

### CLI and configuration

`src/cli` translates human commands into store/domain/application calls. It contains no transition rules, Permit policy rules, or browser selectors. Every invocation opens, migrates, uses, and closes the configured database, which makes restart durability visible during ordinary manual testing.

`src/config` validates the database path, both live switches, simulated-spend, the dedicated browser-profile path, headed/headless mode, and the bounded browser timeout. Repository-local browser profiles are restricted to `.local/`; known normal Chrome/Chromium profile locations are rejected. `SATSCOUT_LIVE_BOOKING` is one required cart gate; an explicit per-command `--confirm-live-cart` acknowledgement is independently required. `SATSCOUT_LIVE_SPEND` is inert. `SATSCOUT_ALLOW_SIMULATED_SPEND` defaults to false and only enables labeled simulation evidence; it still moves no money.

### Logging

`src/logging` emits JSON lines and recursively redacts keys such as passwords, secrets, tokens, authorization, cookies, card fields, private keys, macaroons, preimages, invoices, and seeds. The redactor handles nested objects and arrays and is also applied to audit metadata.

### Spend Controller and future adapters

`src/application/spend-controller.ts` is the only application entry for economic authorization. Untrusted callers supply ActionRequests. The controller may create explicitly labeled simulation ResolvedActions, preview Permit decisions, request atomic Authorization, and manage Authorization lifecycle. It executes no real external operations.

Future execution components are type-only contracts in `src/domain/economy/adapters.ts`:

```text
FundingAdapter      prepare / executeAuthorized / reconcile
InstrumentAdapter   resolve / acquireAuthorized / reconcile
MerchantAdapter     resolvePurchase / executeAuthorized / reconcile
```

They expose no generic `executeAnything`, `sendMoney`, `payInvoice`, or `click`. No adapter implementation performs network I/O in Chunk 04. Payment-rail selection is a future Spend Controller concern constrained by Permit `allowedRails`; the Permit Engine does not choose a rail.

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

`src/application/recreation-observation.ts` owns the narrow observation port and orchestration. It loads an `ACTIVE`, unexpired Mission, rejects a selected site that is not in `Mission.siteIds` before any browser launch, optionally validates the BookingAttempt relationship, invokes `observeMissionTarget`, and records sanitized audit events. It never calls the workflow transition function.

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

Future reservation-step, merchant, and wallet integrations belong outside the domain core, observation adapter, and cart-capture surface. Later chunks can call inward through the Spend Controller to request state transitions or policy decisions; they must not replicate, bypass, or weaken domain rules, broaden the observer, or reuse the cart adapter as a generic browser controller.
