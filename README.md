# SatScout

SatScout is an open-source autonomous purchasing agent built around **bounded spending authority**. A human defines a Mission and a narrowly scoped Permit; orchestration may propose an economic action, but deterministic code—not an agent or language model—decides whether that action is authorized.

The first intended use case is eventually reserving a campsite and funding checkout through a prepaid card purchased with Bitcoin over Lightning. This repository does **not** do that yet.

## Chunk 01: deterministic foundation

This chunk provides:

- runtime-validated Mission, Permit, BookingAttempt, PurchaseIntent, Payment, and Reservation models;
- a single explicit workflow state machine with audited rejection and idempotency behavior;
- pure, multi-reason Permit evaluation over integer cents and satoshis;
- migration-managed SQLite persistence and append-only audit history;
- fail-closed live-feature switches;
- recursive structured-log redaction;
- a local CLI, fictional examples, and comprehensive automated tests.

There are no network calls, browser automation, Recreation.gov or Camply integrations, merchant adapters, wallet access, Lightning payments, real spending, or LLM/agent integration. Setting either live switch to `true` changes no behavior in Chunk 01.

## Requirements and setup

Use Node.js 24 (pinned to 24.18.0 in `.node-version` and `.nvmrc`) and pnpm 11. The project uses Node's built-in SQLite module and has only two runtime packages: Zod and Commander.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The CLI defaults to `./data/satscout.sqlite`. Override it with the task-specific `SATSCOUT_DB_PATH` environment variable:

```sh
export SATSCOUT_DB_PATH=./data/my-local-test.sqlite
pnpm cli init
pnpm cli mission list
```

The two future-facing switches are optional and safely default to `false`:

```text
SATSCOUT_LIVE_BOOKING=false
SATSCOUT_LIVE_SPEND=false
```

Only exact lowercase `true` and `false` are accepted. A malformed value stops startup. Neither switch activates any external behavior in this chunk.

## Quality checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For an end-to-end local walkthrough, follow [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md). Architectural boundaries are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the deliberately staged plan is in [docs/ROADMAP.md](docs/ROADMAP.md).

## License

SatScout is available under the [MIT License](LICENSE).
