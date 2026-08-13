# Architecture

Chunk 01 is one local application with explicit internal boundaries. The domain core knows nothing about SQLite, CLI parsing, networks, browsers, merchants, wallets, or language models.

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

The CLI's `purchase evaluate` command constructs an in-memory proposal, evaluates it, and discards it. Evaluation neither records approval nor consumes purchase count. A future controller must make authorization and durable mutation atomic before any external adapter is introduced.

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

State updates and audit inserts share `BEGIN IMMEDIATE` transactions. An audit failure rolls back the state update. Audit rows receive monotonically increasing sequence numbers, are read in sequence order, and cannot be updated or deleted through SQLite without a trigger failure. Accepted, duplicate, and rejected workflow requests have distinct event types.

Audit metadata is passed through the same recursive sensitive-field redactor used for structured logs. Audit records explain the Mission, Permit or attempt involved; previous and requested/new workflow states; and sanitized policy-relevant metadata.

### CLI and configuration

`src/cli` translates human commands into store/domain calls. It contains no transition rules and no Permit policy rules. Every invocation opens, migrates, uses, and closes the configured database, which makes restart durability visible during ordinary manual testing.

`src/config` defaults both live switches to false and accepts only exact `true`/`false` strings. A true value is represented in validated configuration for future chunks but has no behavioral effect now.

### Logging

`src/logging` emits JSON lines and recursively redacts keys such as passwords, secrets, tokens, authorization, cookies, card fields, private keys, macaroons, and preimages. The redactor handles nested objects and arrays and is also applied to audit metadata.

## Future adapters

Observation, carting, checkout, merchant, and wallet integrations belong outside the domain core. Later chunks can call inward to request state transitions or policy decisions; they must not replicate, bypass, or weaken the domain rules. No such adapter exists in Chunk 01.
