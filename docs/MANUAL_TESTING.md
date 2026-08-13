# Chunk 01 manual acceptance testing

Run these commands from the repository root with Node 24 and pnpm 11. All campground, campsite, merchant, and product identifiers in the examples are fictional test data.

Start with a dedicated database so no other local state is touched:

```sh
export SATSCOUT_DB_PATH=./data/manual-test.sqlite
```

## Test A — initialize cleanly

Remove only the dedicated manual-test database and its SQLite sidecars, then initialize it:

```sh
rm -f ./data/manual-test.sqlite ./data/manual-test.sqlite-shm ./data/manual-test.sqlite-wal
pnpm cli init
```

Expected: schema version 1, both live switches false, and an explicit statement that Chunk 01 has no booking or spending behavior.

## Test B — create and show a Mission and Permit

```sh
pnpm cli mission create --file ./examples/missions/campsite-example.json
pnpm cli permit create --file ./examples/permits/campsite-example.json
pnpm cli mission show example-campsite-2099
pnpm cli mission list
pnpm cli permit show example-campsite-2099
```

Expected: the validated records are printed with the fictional campground and sites, integer limits, and 2099 expiration.

## Test C — valid state transitions

Create an attempt with a stable ID. Creation persists `WAITING`; inspect the record after every step:

```sh
pnpm cli attempt create example-campsite-2099 --id manual-happy
pnpm cli attempt show manual-happy
pnpm cli transition manual-happy AVAILABLE
pnpm cli attempt show manual-happy
pnpm cli transition manual-happy CARTING
pnpm cli attempt show manual-happy
pnpm cli transition manual-happy CART_HELD
pnpm cli attempt show manual-happy
```

Expected: each transition reports `TRANSITIONED`, and each subsequent show reports the persisted new state.

## Test D — invalid transition

Use a fresh `WAITING` attempt and try to skip required states:

```sh
pnpm cli attempt create example-campsite-2099 --id manual-invalid
pnpm cli transition manual-invalid PAYMENT_AUTHORIZED
pnpm cli attempt show manual-invalid
pnpm cli audit example-campsite-2099
```

Expected: the transition exits unsuccessfully with `REJECTED`; the attempt remains `WAITING`; the audit contains `WORKFLOW_TRANSITION_REJECTED` with `ILLEGAL_TRANSITION` and the requested state.

## Test E — permitted purchase proposal

```sh
pnpm cli purchase evaluate --attempt manual-happy --merchant bitrefill --product prepaid-visa-usa --usd-cents 7300 --sats 110000 --fee-sats 50
```

Expected: `APPROVED`, followed by a statement that no state was mutated.

## Test F — independently denied proposals

```sh
pnpm cli purchase evaluate --attempt manual-happy --merchant bitrefill --product prepaid-visa-usa --usd-cents 10001 --sats 110000 --fee-sats 50
pnpm cli purchase evaluate --attempt manual-happy --merchant bitrefill --product prepaid-visa-usa --usd-cents 7300 --sats 175001 --fee-sats 50
pnpm cli purchase evaluate --attempt manual-happy --merchant bitrefill --product prepaid-visa-usa --usd-cents 7300 --sats 110000 --fee-sats 201
pnpm cli purchase evaluate --attempt manual-happy --merchant other-merchant --product prepaid-visa-usa --usd-cents 7300 --sats 110000 --fee-sats 50
pnpm cli purchase evaluate --attempt manual-happy --merchant bitrefill --product other-product --usd-cents 7300 --sats 110000 --fee-sats 50
```

Expected: each prints `DENIED` and exactly the relevant reason code: `USD_LIMIT_EXCEEDED`, `SAT_LIMIT_EXCEEDED`, `LIGHTNING_FEE_LIMIT_EXCEEDED`, `MERCHANT_NOT_ALLOWED`, or `PRODUCT_NOT_ALLOWED`.

An inactive historical Mission/Permit pair is included solely to demonstrate expiration denial:

```sh
pnpm cli mission create --file ./examples/missions/expired-permit-example.json
pnpm cli permit create --file ./examples/permits/expired-permit-example.json
pnpm cli attempt create example-expired-permit-mission --id manual-expired
pnpm cli purchase evaluate --attempt manual-expired --merchant bitrefill --product prepaid-visa-usa --usd-cents 7300 --sats 110000 --fee-sats 50
```

Expected: `DENIED` with `PERMIT_EXPIRED`. An already-expired Permit cannot be attached to an `ACTIVE` Mission; the fixture is intentionally `DRAFT` so the historical policy record can be evaluated safely.

## Test G — restart durability

Each `pnpm cli` invocation is a fresh process, so the preceding commands already exercise repeated close/reopen cycles. Simulate a later session by opening a new terminal, setting the same path, and running:

```sh
export SATSCOUT_DB_PATH=./data/manual-test.sqlite
pnpm cli mission show example-campsite-2099
pnpm cli permit show example-campsite-2099
pnpm cli attempt show manual-happy
```

Expected: the Mission and Permit remain present, and `manual-happy` remains in `CART_HELD`.

## Test H — audit review

```sh
pnpm cli audit example-campsite-2099
```

Expected: a sequence-ordered history containing Mission, Permit, and attempt creation; all accepted transitions with previous/new states; and the rejected transition with a human-readable reason.

## Automated verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
