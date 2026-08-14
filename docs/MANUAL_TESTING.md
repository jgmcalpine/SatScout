# Manual acceptance testing

## Chunk 01 deterministic-foundation walkthrough

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

## Chunk 02 — read-only Recreation.gov observation

Run these tests deliberately from the repository root. Do not use a highly competitive campsite, repeatedly reload Recreation.gov, try to provoke a challenge, or invoke any reservation-changing control. Live Mission records and authenticated browser state are local-only data and must not be committed.

### Test A — regression baseline

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
```

Expected: every Chunk 01 and Chunk 02 check passes. The browser suite uses synthetic content only and makes no request to Recreation.gov.

### Test B — install Chromium

```sh
git status --short
pnpm browser:install
git status --short
```

Expected: only the Chromium browser engine and Playwright's required support binaries are installed in the user cache, and the install creates no git change.

### Test C — dedicated persistent browser profile

```sh
unset SATSCOUT_BROWSER_PROFILE_DIR
pnpm cli recreation browser
```

Verify that a separate Chromium window opens at Recreation.gov without normal personal Chrome tabs, history, or extensions. Close the entire Chromium window, then run the command again. The dedicated profile at `./.local/browser/recreation-gov` should persist and remain ignored:

```sh
test -d ./.local/browser/recreation-gov
git check-ignore -v ./.local/browser/recreation-gov
pnpm cli recreation browser
```

This directory contains sensitive authenticated browser state. Never share or commit it.

### Test D — manual Recreation.gov login

```sh
pnpm cli recreation browser
```

Log in directly in the visible Recreation.gov page, then close Chromium completely. SatScout must never prompt for a username or password. Reopen it:

```sh
pnpm cli recreation browser
git status --short
```

Verify the session persists if Recreation.gov permits it, no credential appears in terminal output, no tracked session file appears, and no browser state appears under `data/`. If Recreation.gov expires the session, record that behavior rather than weakening profile isolation.

### Test E — create a real local observation Mission

From a public Recreation.gov campground page, take the numeric campground ID from `/camping/campgrounds/<campground-id>`. Open a specific campsite and take its numeric provider ID from `/camping/campsites/<site-id>`; the displayed site number is not necessarily the provider ID. Choose future dates visible in that site's availability calendar and avoid highly competitive inventory.

Set local-only values and generate the Mission under `/tmp`, not in the repository:

```sh
export SATSCOUT_DB_PATH=./data/recreation-observation.sqlite
export REAL_CAMPGROUND_ID='<numeric-campground-id>'
export REAL_SITE_ID='<numeric-campsite-id>'
export TEST_ARRIVAL='YYYY-MM-DD'
export TEST_DEPARTURE='YYYY-MM-DD'
node --input-type=module -e 'import { writeFileSync } from "node:fs"; const now = new Date().toISOString(); writeFileSync("/tmp/satscout-recreation-mission.json", JSON.stringify({id:"recreation-observation-local",type:"book-campsite",campgroundId:process.env.REAL_CAMPGROUND_ID,siteIds:[process.env.REAL_SITE_ID],arrival:process.env.TEST_ARRIVAL,departure:process.env.TEST_DEPARTURE,createdAt:now,activatedAt:now,expiresAt:`${process.env.TEST_DEPARTURE}T23:59:59.000Z`,status:"ACTIVE"}, null, 2));'
pnpm cli init
pnpm cli mission create --file /tmp/satscout-recreation-mission.json
pnpm cli attempt create recreation-observation-local --id recreation-observation-attempt
```

Expected: only the local ignored SQLite database contains the live Mission.

### Test F — successful exact-target observation

First close every Chromium window opened by `pnpm cli recreation browser`. The dedicated persistent profile is single-process; observation now reports `BROWSER_PROFILE_IN_USE` explicitly if the manual browser is still open.

```sh
pnpm cli recreation observe --mission recreation-observation-local --site "$REAL_SITE_ID" --attempt recreation-observation-attempt
pnpm cli recreation observe --mission recreation-observation-local --site "$REAL_SITE_ID" --attempt recreation-observation-attempt --json
pnpm cli attempt show recreation-observation-attempt
```

Compare browser content and CLI output. Verify the campsite, campground, and requested dates agree where the site exposes them; session state is plausible; challenge state is explicit; and availability agrees with the date cells or is `UNKNOWN`. No reservation-changing action occurs, and the attempt remains `WAITING`.

The visible Chromium window is one-shot and closes after observation finishes. Before closing, SatScout waits up to `SATSCOUT_BROWSER_TIMEOUT_MS` for the account header and requested date-status labels to hydrate. A detected human-verification challenge ends the read immediately without interaction and produces `HUMAN_VERIFICATION_REQUIRED`.

### Test G — wrong site rejected before browser action

```sh
pnpm cli recreation observe --mission recreation-observation-local --site 99999999999999999999
```

Expected: `SITE_NOT_ALLOWED`, with no browser launch or navigation.

### Test H — deliberate campground mismatch

Create a second local-only Mission pairing the allowed site with a different, syntactically valid campground ID:

```sh
node --input-type=module -e 'import { writeFileSync } from "node:fs"; const now = new Date().toISOString(); writeFileSync("/tmp/satscout-recreation-mismatch.json", JSON.stringify({id:"recreation-observation-mismatch",type:"book-campsite",campgroundId:"1",siteIds:[process.env.REAL_SITE_ID],arrival:process.env.TEST_ARRIVAL,departure:process.env.TEST_DEPARTURE,createdAt:now,activatedAt:now,expiresAt:`${process.env.TEST_DEPARTURE}T23:59:59.000Z`,status:"ACTIVE"}, null, 2));'
pnpm cli mission create --file /tmp/satscout-recreation-mismatch.json
pnpm cli recreation observe --mission recreation-observation-mismatch --site "$REAL_SITE_ID"
pnpm cli audit recreation-observation-mismatch
```

Expected: `MISMATCH` with a campground mismatch, no silent correction, an audit mismatch event, unknown availability because identity was not confirmed, and no workflow transition.

### Test I — session persistence

Close every SatScout Chromium window, then run:

```sh
pnpm cli recreation observe --mission recreation-observation-local --site "$REAL_SITE_ID"
```

Expected: the dedicated authenticated session is reused if Recreation.gov has not expired it.

### Test J — logout behavior

```sh
pnpm cli recreation browser
```

Log out manually and close Chromium. Then run:

```sh
pnpm cli recreation observe --mission recreation-observation-local --site "$REAL_SITE_ID"
```

Expected: `NOT_AUTHENTICATED`, or `UNKNOWN` if the current page does not provide one unambiguous signal—never a false authenticated result.

### Test K — audit and public-repository review

```sh
pnpm cli audit recreation-observation-local
pnpm cli attempt show recreation-observation-attempt
git status --short
git ls-files .local data
```

Expected: ordered start/completion and applicable auth/challenge/mismatch events; no cookies, tokens, HTML, credentials, usernames, or personal profile data; the attempt is still `WAITING`; and no browser state or live database is tracked.

### Test L — live switches remain inert

```sh
SATSCOUT_LIVE_BOOKING=true SATSCOUT_LIVE_SPEND=true pnpm cli recreation observe --mission recreation-observation-local --site "$REAL_SITE_ID" --attempt recreation-observation-attempt
pnpm cli attempt show recreation-observation-attempt
```

Expected: the same read-only observation and unchanged `WAITING` state. The switches expose no additional browser operation.

### Natural challenge behavior only

Do not intentionally provoke anti-bot systems. Synthetic tests cover challenge detection. If Recreation.gov naturally presents human verification, verify the CLI reports `HUMAN_VERIFICATION_REQUIRED` and performs no further interaction. A human may handle the page manually in the dedicated browser if desired.
