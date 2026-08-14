# Architecture

SatScout is one local application with explicit internal boundaries. The domain core knows nothing about SQLite, CLI parsing, networks, browsers, merchants, wallets, or language models.

```text
Mission
   │
   ├── Permit
   │
   └── BookingAttempt
           │
           ├── workflow state
           ├── PurchaseIntent
           │       └── Payment
           └── Reservation
```

## Security boundary

> Reasoning/orchestration may request economic actions. Only deterministic Permit evaluation may authorize them.

Permit evaluation is a pure function. Given a validated Permit, validated PurchaseIntent, evaluation timestamp, and completed-purchase count, it returns an ordered decision with every denial reason. It has no database, clock, logging, network, or payment side effect. Limits use integer USD cents and integer satoshis.

The CLI's `purchase evaluate` command constructs an in-memory proposal, evaluates it, and discards it. Evaluation neither records approval nor consumes purchase count. A future controller must make authorization and durable mutation atomic before any transactional adapter is introduced.

## Layers

### Domain

`src/domain` owns runtime schemas, relationship invariants, the workflow transition table, and Permit evaluation. Zod validates every record entering through JSON, CLI construction, or SQLite rehydration. TypeScript runs with strict settings, but compile-time types are never treated as validation of external input.

`src/domain/workflow/workflow.ts` is the only authority for transitions. The normal path is:

```text
WAITING -> AVAILABLE -> CARTING -> CART_HELD -> PAYMENT_REQUESTED
        -> PAYMENT_AUTHORIZED -> CARD_ACQUIRED -> CHECKOUT -> CONFIRMED
```

Nonterminal states may move to `PAUSED`, `FAILED`, `EXPIRED`, or `ABORTED` where explicitly listed. `PAUSED` can resume at `WAITING`. `CONFIRMED`, `FAILED`, `EXPIRED`, and `ABORTED` are terminal. Requesting the current state is an idempotent no-op; every other unlisted edge is rejected.

### Persistence and audit

`src/persistence` uses Node 24's built-in SQLite API. Versioned migrations create strict tables, foreign keys, indexes, and append-only triggers. Domain records are stored as validated JSON together with relational identity, lifecycle, and relationship columns.

State updates and audit inserts share `BEGIN IMMEDIATE` transactions. An audit failure rolls back the state update. Audit rows receive monotonically increasing sequence numbers, are read in sequence order, and cannot be updated or deleted through SQLite without a trigger failure. Observation uses a separate append-only audit method and does not update BookingAttempt rows.

Audit metadata is passed through the same recursive sensitive-field redactor used for structured logs. Observation events contain structured result states and non-sensitive reason codes, never cookies, tokens, HTML, credentials, or browser storage.

### CLI and configuration

`src/cli` translates human commands into store/domain/application calls. It contains no transition rules, Permit policy rules, or browser selectors. Every invocation opens, migrates, uses, and closes the configured database, which makes restart durability visible during ordinary manual testing.

`src/config` validates the database path, both inert live switches, the dedicated browser-profile path, headed/headless mode, and the bounded browser timeout. Repository-local browser profiles are restricted to `.local/`; known normal Chrome/Chromium profile locations are rejected.

### Logging

`src/logging` emits JSON lines and recursively redacts keys such as passwords, secrets, tokens, authorization, cookies, card fields, private keys, macaroons, and preimages. The redactor handles nested objects and arrays and is also applied to audit metadata.

### Recreation.gov observation application boundary

```text
                  Mission / Permit
                        │
                        ▼
                Application layer
                        │
                        ▼
             RecreationGovObserver
                        │
                        ▼
                    Playwright
                        │
                        ▼
                Recreation.gov
```

`src/application/recreation-observation.ts` owns the narrow observation port and orchestration. It loads an `ACTIVE`, unexpired Mission, rejects a selected site that is not in `Mission.siteIds` before any browser launch, optionally validates the BookingAttempt relationship, invokes `observeMissionTarget`, and records sanitized audit events. It never calls the workflow transition function.

`src/integrations/recreation-gov` implements that port. Playwright types, Recreation.gov URLs, selectors, calendar interaction, session signals, and challenge signals remain inside the adapter. The domain has no Playwright dependency. The public observer surface has one operation; application code receives no generic click, fill, script, or form-submission capability.

The adapter constructs `https://www.recreation.gov/camping/campsites/<numeric-id>` itself. It reads a level-one site heading, the visible campground link and provider ID, and accessible per-date calendar status labels from semantic grid-cell or button elements. Session and calendar reads wait only within the configured browser timeout for client-rendered signals to hydrate. Calendar movement is limited to bounded `Previous` and `Next` controls. Unexpected origins, malformed IDs, ambiguous selectors, unfamiliar status text, and missing date cells fail closed.

> Observation and transaction execution are separate capabilities.

Chunk 02 provides observation capability only. The observer does not acquire transactional browser authority merely because it can inspect a page. Authentication and human-verification are detected as explicit states; challenges are never clicked or solved. Observation can append audit events but cannot move `WAITING` to `AVAILABLE` or perform any other workflow transition.

The dedicated persistent profile defaults to `.local/browser/recreation-gov`, is gitignored, and never enters SQLite, audit metadata, logs, traces, screenshots, HTML captures, or storage-state exports. The manual browser flow lets a human authenticate directly with Recreation.gov; SatScout does not accept login credentials.

## Future adapters

Future transactional, merchant, and wallet integrations belong outside the domain core and outside the observation adapter. Later chunks can call inward to request state transitions or policy decisions; they must not replicate, bypass, or weaken domain rules or broaden the observer.
