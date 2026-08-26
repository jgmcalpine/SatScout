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

Expected in the current version: schema version 5, live booking/spend, simulated-spend, Signet-test-spend, Bitrefill-live-invoice, and Bitrefill-MCP-prepayment switches false, an explicit second live-cart acknowledgement requirement, statements that live spend is necessary but not sufficient for Wavelength Signet Send, that the Bitrefill live-invoice gate is necessary but not sufficient for an unpaid invoice, and that the MCP prepayment gate is necessary but not sufficient for prepaid-card prepayment and does not purchase.

## Test B — create and show a Mission and Permit

```sh
pnpm cli mission create --file ./examples/missions/campsite-example.json
pnpm cli permit create --file ./examples/permits/campsite-example.json
pnpm cli mission show example-campsite-2099
pnpm cli mission list
pnpm cli permit show example-campsite-2099
```

Expected: the validated records are printed with the fictional campground and sites, integer limits, and 2099 expiration. `examples/permits/campsite-example.json` is a legacy Permit v1 record; it remains readable for this walkthrough and cannot authorize under the v2 engine.

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

## Chunk 03 — verified Recreation.gov cart capture

These tests can create a temporary live cart hold. Use a clearly non-competitive campsite and ordinary future inventory. Close every SatScout Chromium window before each CLI browser operation. Never use scarce inventory merely to test this feature, and stop the test if the target becomes competitive or human verification appears.

Live Mission data, the SQLite database, and the dedicated authenticated browser profile must remain local and uncommitted. SatScout does not remove cart items; cleanup is manual.

### Test A — full regression

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
```

Expected: all checks pass. Normal automated and browser tests use mocks or local synthetic pages and create no real cart hold.

### Test B — choose local identifiers and create the test records

Choose dates for which every occupied night is visibly available. `TEST_DEPARTURE` is checkout day, not an occupied night. Set all values in the same terminal. Use a new Mission ID when the target or dates change, because persisted Missions are immutable. A “fresh attempt” means a newly created BookingAttempt in `WAITING`; it does not mean SatScout creates or infers a new Mission automatically.

```sh
export SATSCOUT_DB_PATH=./data/recreation-cart-local.sqlite
export REAL_CAMPGROUND_ID='<numeric-campground-id>'
export REAL_SITE_ID='<numeric-campsite-provider-id>'
export TEST_ARRIVAL='YYYY-MM-DD'
export TEST_DEPARTURE='YYYY-MM-DD'
export CART_MISSION_ID='recreation-cart-local-3'
export CART_ATTEMPT_ID='recreation-cart-attempt-3'
node --input-type=module -e 'import { writeFileSync } from "node:fs"; const now = new Date().toISOString(); writeFileSync("/tmp/satscout-cart-mission.json", JSON.stringify({id:process.env.CART_MISSION_ID,type:"book-campsite",campgroundId:process.env.REAL_CAMPGROUND_ID,siteIds:[process.env.REAL_SITE_ID],arrival:process.env.TEST_ARRIVAL,departure:process.env.TEST_DEPARTURE,createdAt:now,activatedAt:now,expiresAt:`${process.env.TEST_DEPARTURE}T23:59:59.000Z`,status:"ACTIVE"}, null, 2));'
pnpm cli init
pnpm cli mission create --file /tmp/satscout-cart-mission.json
pnpm cli attempt create "$CART_MISSION_ID" --id "$CART_ATTEMPT_ID"
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Expected: the Mission is `ACTIVE` and the attempt is `WAITING`. If either ID already exists, choose new IDs instead of reusing stale workflow state.

### Test C — observation remains read-only, then explicitly mark AVAILABLE

Close the manual browser before running the observer:

```sh
pnpm cli recreation observe --mission "$CART_MISSION_ID" --site "$REAL_SITE_ID" --attempt "$CART_ATTEMPT_ID" --json
pnpm cli attempt show "$CART_ATTEMPT_ID"
pnpm cli transition "$CART_ATTEMPT_ID" AVAILABLE
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Verify target, dates, and availability against the visible page. Observation must leave `WAITING`; only the explicit transition creates `AVAILABLE`. Seeing `WAITING -> AVAILABLE` does not add anything to Recreation.gov—it records that an external availability trigger has authorized this attempt to become eligible for capture.

### Test D — mandatory read-only capture readiness

First open the dedicated browser, confirm that you are logged in and that the cart is visibly empty, then close Chromium completely. Run the same read-only readiness path three times:

```sh
pnpm cli recreation cart readiness --mission "$CART_MISSION_ID" --attempt "$CART_ATTEMPT_ID" --site "$REAL_SITE_ID" --json
pnpm cli recreation cart readiness --mission "$CART_MISSION_ID" --attempt "$CART_ATTEMPT_ID" --site "$REAL_SITE_ID" --json
pnpm cli recreation cart readiness --mission "$CART_MISSION_ID" --attempt "$CART_ATTEMPT_ID" --site "$REAL_SITE_ID" --json
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Each result must report all of the following before live capture is attempted:

```text
ready: true
workflowState: AVAILABLE
authentication: AUTHENTICATED
observation.targetMatch: MATCH
observation.challenge: NONE
observation.availability.overall: AVAILABLE
cart.status: EMPTY
dateSelection.status: VERIFIED
```

Readiness performs no cart or workflow mutation. It observes the exact campsite and the browser's structured cart response in one persistent browser context, cross-checks the rendered cart state, opens `Enter Dates`, and proves the exact arrival/departure range can be selected. The date selection is transient page state; readiness never invokes Add to Cart. A `$0.00` subtotal alone is neither empty-cart evidence nor proof that dates were selected. Stop here if any readiness run reports `ready: false`, `LOADING`, `UNKNOWN`, `SKIPPED`, a conflict, or inconsistent evidence. Do not proceed to capture merely because the headed browser looked logged in.

### Test E — live booking disabled

```sh
SATSCOUT_LIVE_BOOKING=false pnpm cli recreation cart capture \
  --mission "$CART_MISSION_ID" \
  --attempt "$CART_ATTEMPT_ID" \
  --site "$REAL_SITE_ID" \
  --confirm-live-cart
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Expected: `LIVE_BOOKING_DISABLED`, no transactional browser action, unchanged cart, and attempt still `AVAILABLE`.

### Test F — explicit acknowledgement missing

```sh
SATSCOUT_LIVE_BOOKING=true pnpm cli recreation cart capture \
  --mission "$CART_MISSION_ID" \
  --attempt "$CART_ATTEMPT_ID" \
  --site "$REAL_SITE_ID"
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Expected: `LIVE_CONFIRMATION_REQUIRED`, no Add-to-Cart action, and attempt still `AVAILABLE`.

### Test G — one successful real cart capture

Proceed only if Test D was stable. The capture command opens one browser context and repeats the same target, availability, authentication, challenge, and empty-cart readiness checks. The application must durably commit `AVAILABLE -> CARTING` before the adapter can invoke Add to Cart. It then rechecks the cart, selects the exact range, invokes Add to Cart at most once, and verifies a fresh structured cart response plus rendered UI.

```sh
SATSCOUT_LIVE_BOOKING=true pnpm cli recreation cart capture \
  --mission "$CART_MISSION_ID" \
  --attempt "$CART_ATTEMPT_ID" \
  --site "$REAL_SITE_ID" \
  --confirm-live-cart
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Watch the headed browser. Verify the correct campground, exact site, exact arrival, and exact departure are selected; Add to Cart is invoked once; and the resulting exact hold is reported as `CART_HELD`.

Most importantly, verify SatScout stops after cart verification. It must not invoke any control that advances beyond the cart, accept rules, fill reservation/contact/traveler details, display or fill a payment form, or complete a reservation.

If the result is ambiguous, do not rerun capture. The attempt must remain `CARTING`; first inspect it read-only:

```sh
pnpm cli recreation cart inspect --mission "$CART_MISSION_ID" --attempt "$CART_ATTEMPT_ID" --json
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Only when inspection independently reports the exact cart item should you run:

```sh
pnpm cli recreation cart reconcile --mission "$CART_MISSION_ID" --attempt "$CART_ATTEMPT_ID"
```

Only an independently exact cart may reconcile to `CART_HELD`. Empty, mismatched, multiple, challenged, unauthenticated, or unknown results must remain `CARTING` without another Add-to-Cart action.

For a pre-action failure, the capture result and audit record show `actionAttempted: false`. If a subsequent independent inspection also reports `EMPTY`, Add to Cart did not run. Do not reuse or reset that attempt, and do not expect empty-cart reconciliation to move it. Keep it in `CARTING` as the durable failure record. After the underlying pre-action issue is fixed, continue with a fresh BookingAttempt:

```sh
export CART_ATTEMPT_ID='recreation-cart-attempt-next'
pnpm cli attempt create "$CART_MISSION_ID" --id "$CART_ATTEMPT_ID"
pnpm cli transition "$CART_ATTEMPT_ID" AVAILABLE
pnpm cli recreation cart readiness --mission "$CART_MISSION_ID" --attempt "$CART_ATTEMPT_ID" --site "$REAL_SITE_ID" --json
```

Reuse the existing Mission only when its immutable campground, allowed site set, arrival, and departure are unchanged. Create a new Mission when any of those target fields changes. If `actionAttempted` is true or uncertain, do not create a replacement attempt until the external cart state has been resolved manually or by exact reconciliation.

### Test H — compare verification with the visible cart

```sh
pnpm cli recreation browser
```

Compare the visible hold to the prior CLI output: campground ID/name, site provider ID/name, arrival, departure, and night count. For example, `Sep 4 -> Sep 7` is exactly three occupied nights: Sep 4, Sep 5, and Sep 6. Sep 7 is departure. Close the browser without advancing the reservation.

### Test I — duplicate protection

With the exact item still held and the attempt in `CART_HELD`, run:

```sh
SATSCOUT_LIVE_BOOKING=true pnpm cli recreation cart capture \
  --mission "$CART_MISSION_ID" \
  --attempt "$CART_ATTEMPT_ID" \
  --site "$REAL_SITE_ID" \
  --confirm-live-cart
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Expected: `INVALID_ATTEMPT_STATE`, no browser cart mutation, no second Add-to-Cart action, and state still `CART_HELD`.

### Test J — read-only inspection

```sh
pnpm cli recreation cart inspect \
  --mission "$CART_MISSION_ID" \
  --attempt "$CART_ATTEMPT_ID"
pnpm cli recreation cart inspect \
  --mission "$CART_MISSION_ID" \
  --attempt "$CART_ATTEMPT_ID" \
  --json
pnpm cli attempt show "$CART_ATTEMPT_ID"
```

Expected: exact structured evidence where Recreation.gov exposes it, no Add-to-Cart action, no cart change, and no workflow change.

### Test K — unrelated cart conflict

After manually removing the prior test item or allowing it to expire, manually place one different non-competitive campsite/date range in the Recreation.gov cart. Create another local Mission and `AVAILABLE` attempt for the original exact target, then run its capture command with both live gates.

Expected: `CART_NOT_EMPTY` or `CART_CONFLICT`; no Add-to-Cart action; no modification or removal of the unrelated item; and the new attempt remains `AVAILABLE`. Remove the manually created unrelated test item yourself afterward.

### Test L — disallowed site

Use a numeric campsite provider ID that is not in the Mission:

```sh
SATSCOUT_LIVE_BOOKING=true pnpm cli recreation cart capture \
  --mission "$CART_MISSION_ID" \
  --attempt "$CART_ATTEMPT_ID" \
  --site 99999999999999999999 \
  --confirm-live-cart
```

Expected: `SITE_NOT_ALLOWED` before transactional navigation/action. Use a fresh `AVAILABLE` attempt for this test if the Test G attempt already reached `CART_HELD`.

### Test M — ordered sanitized audit

```sh
pnpm cli audit "$CART_MISSION_ID"
```

For a successful capture, verify the sequence shows capture requested, preflight passed, the workflow transition to `CARTING`, cart action started, hold verified, and the workflow transition to `CART_HELD`. Confirm there are no cookies, tokens, browser storage, HTML, screenshots, account data, or personal details.

### Test N — live spend remains irrelevant

```sh
SATSCOUT_LIVE_SPEND=true pnpm cli recreation cart inspect \
  --mission "$CART_MISSION_ID" \
  --attempt "$CART_ATTEMPT_ID"
```

Expected: ordinary read-only inspection. `SATSCOUT_LIVE_SPEND` exposes no additional operation and does not enable reservation completion or payment behavior.

### Manual cleanup and public-repository check

SatScout intentionally has no cart-removal capability. Open the dedicated browser and manually remove test items, or let holds expire naturally:

```sh
pnpm cli recreation browser
```

Then review the repository:

```sh
git status --short
git check-ignore -v ./.local/browser/recreation-gov
git ls-files .local data
```

No live Mission JSON, SQLite file, browser profile, cookie, storage export, screenshot, trace, HAR, or HTML capture should be tracked.

### Live-site assumptions to record during acceptance

The live adapter deliberately fails closed if Recreation.gov changes its frontend contract. Current assumptions are: a numeric campsite URL; one visible level-one `Site:` heading; one visible campground link; accessible calendar grids and date controls with full English date/status labels; one enabled `Add to Cart` button after exact range selection; `/cart` issuing a same-origin `GET /api/cart/shoppingcart` response with account and reservation arrays; and rendered `.cart-empty-page` or `.cart-item` state agreeing with that structured response. SatScout observes the response produced by the authenticated browser; it does not extract or persist browser credentials or issue a direct mutating cart request. Record any mismatch as `LOADING`, `UNKNOWN`, or ambiguous. Do not broaden selectors or weaken verification merely to make a live test pass.

## Chunk 04 — generic Permit and Authorization engine

These tests move no money. They exercise bounded economic authority with labeled simulation evidence only. Use a dedicated database. Identifiers in the examples are fictional.

```sh
export SATSCOUT_DB_PATH=./data/manual-permit.sqlite
export SATSCOUT_ALLOW_SIMULATED_SPEND=true
rm -f ./data/manual-permit.sqlite ./data/manual-permit.sqlite-shm ./data/manual-permit.sqlite-wal
pnpm cli init
```

Expected: schema version 5, simulated-spend true for this shell, live spend still false unless explicitly set. `SATSCOUT_LIVE_SPEND=true` still does not enable a Send by itself. Generic `PRODUCTION` provenance remains denied; Bitrefill `PRODUCTION` / `bitrefill.personal` can only be constructed by the in-process adapter.

### 1–5. Mission, DRAFT Permit, activation, immutability

```sh
pnpm cli mission create --file ./examples/missions/campsite-example.json
pnpm cli permit create --file ./examples/permits/campsite-v2-example.json
pnpm cli permit show example-campsite-v2-permit-2099
pnpm cli spend resolve simulate --file ./examples/actions/merchant-purchase-request.json --json > /tmp/satscout-merchant-resolved.json
pnpm cli spend evaluate --file /tmp/satscout-merchant-resolved.json
```

Expected: Permit is `DRAFT`. Evaluate prints `DENY` with `PERMIT_NOT_ACTIVE` and `No authority was reserved.`

```sh
pnpm cli permit activate example-campsite-v2-permit-2099
pnpm cli permit create --file ./examples/permits/campsite-v2-example.json
```

Expected: activation succeeds and the Permit is immutable. Creating the same id again fails. There is no in-place edit command for an ACTIVE Permit.

### 6–14. Preview ALLOW, DENY, and INDETERMINATE

```sh
pnpm cli spend evaluate --file /tmp/satscout-merchant-resolved.json
```

Expected: `ALLOW` and `No authority was reserved.`

Create over-limit, wrong-identity, and incomplete evidence files:

```sh
node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const base = JSON.parse(readFileSync("/tmp/satscout-merchant-resolved.json","utf8")); writeFileSync("/tmp/satscout-over.json", JSON.stringify({...base, amount: 8001})); writeFileSync("/tmp/satscout-wrong-mission.json", JSON.stringify({...base, missionId:"other-mission"})); writeFileSync("/tmp/satscout-wrong-merchant.json", JSON.stringify({...base, counterparty:"other-merchant"}));'
pnpm cli spend evaluate --file /tmp/satscout-over.json
pnpm cli spend evaluate --file /tmp/satscout-wrong-mission.json
pnpm cli spend evaluate --file /tmp/satscout-wrong-merchant.json
pnpm cli spend resolve simulate --file ./examples/actions/instrument-acquire-request.json --json > /tmp/satscout-instrument-resolved.json
node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const base = JSON.parse(readFileSync("/tmp/satscout-instrument-resolved.json","utf8")); writeFileSync("/tmp/satscout-wrong-provider.json", JSON.stringify({...base, provider:"other-provider"})); writeFileSync("/tmp/satscout-wrong-product.json", JSON.stringify({...base, product:"other-product"}));'
pnpm cli spend evaluate --file /tmp/satscout-wrong-provider.json
pnpm cli spend evaluate --file /tmp/satscout-wrong-product.json
pnpm cli spend resolve simulate --file ./examples/actions/value-transfer-request.json --json > /tmp/satscout-transfer-incomplete.json
```

The example transfer request has no parent Authorization, so evaluate it as-is, then with a wrong rail, high fee, and omitted fee/outflow:

```sh
pnpm cli spend evaluate --file /tmp/satscout-transfer-incomplete.json
node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const base = JSON.parse(readFileSync("/tmp/satscout-transfer-incomplete.json","utf8")); writeFileSync("/tmp/satscout-wrong-rail.json", JSON.stringify({...base, rail:"ach"})); writeFileSync("/tmp/satscout-high-fee.json", JSON.stringify({...base, fee:201, totalOutflow:112592})); const {fee, ...noFee} = base; writeFileSync("/tmp/satscout-unknown-fee.json", JSON.stringify(noFee)); const {totalOutflow, ...noOut} = base; writeFileSync("/tmp/satscout-unknown-outflow.json", JSON.stringify(noOut));'
pnpm cli spend evaluate --file /tmp/satscout-wrong-rail.json
pnpm cli spend evaluate --file /tmp/satscout-high-fee.json
pnpm cli spend evaluate --file /tmp/satscout-unknown-fee.json
pnpm cli spend evaluate --file /tmp/satscout-unknown-outflow.json
```

Expected reason codes include `AMOUNT_LIMIT_EXCEEDED`, `MISSION_MISMATCH`, `COUNTERPARTY_NOT_ALLOWED`, `PROVIDER_NOT_ALLOWED`, `PRODUCT_NOT_ALLOWED`, `MISSING_PARENT_AUTHORIZATION` (`INDETERMINATE`), `RAIL_NOT_ALLOWED`, `FEE_LIMIT_EXCEEDED`, `MISSING_FEE`, and `MISSING_TOTAL_OUTFLOW`. Every preview ends with `No authority was reserved.`

### 15–19. Authorize, usage, second-execution DENY, restart, release

```sh
pnpm cli spend authorize --file /tmp/satscout-merchant-resolved.json
pnpm cli permit usage example-campsite-v2-permit-2099
pnpm cli spend authorize --file /tmp/satscout-merchant-resolved.json
```

Expected: first command prints `AUTHORIZED`, an Authorization id, `Authority is now reserved.`, and `No external payment was made.` Usage shows one reserved merchant execution. The second authorize is `DENY` / `EXECUTION_LIMIT_REACHED`.

Restart the process by opening a new terminal with the same `SATSCOUT_DB_PATH` and `SATSCOUT_ALLOW_SIMULATED_SPEND=true`:

```sh
pnpm cli permit usage example-campsite-v2-permit-2099
pnpm cli authorization list --mission example-campsite-2099
```

Expected: reservation persists. Copy the Authorization id, then:

```sh
pnpm cli authorization release <authorization-id>
pnpm cli permit usage example-campsite-v2-permit-2099
```

Expected: `RELEASED` and remaining executions return to 1.

### 20–26. EXECUTING, forbidden release, AMBIGUOUS, restart, exhausted retry

```sh
pnpm cli spend authorize --file /tmp/satscout-merchant-resolved.json
pnpm cli authorization execute-simulated <authorization-id>
pnpm cli authorization release <authorization-id>
pnpm cli authorization mark-ambiguous <authorization-id>
pnpm cli permit usage example-campsite-v2-permit-2099
```

Expected: `execute-simulated` prints `EXECUTING` and `externalActionAttempted=true`. Release is forbidden. `AMBIGUOUS` keeps authority reserved.

Restart again and confirm ambiguity persists, then:

```sh
pnpm cli spend authorize --file /tmp/satscout-merchant-resolved.json
```

Expected: `DENY` / `EXECUTION_LIMIT_REACHED`. Do not retry automatically.

### 27–33. Revoke, history, replacement, cross-Mission, parent linkage, audit

```sh
pnpm cli permit revoke example-campsite-v2-permit-2099
pnpm cli spend authorize --file /tmp/satscout-merchant-resolved.json
pnpm cli authorization show <authorization-id>
```

Expected: no new Authorization; the historical Authorization is unchanged.

Create a replacement Permit rather than mutating the revoked one. Use a new Permit id:

```sh
node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const permit = JSON.parse(readFileSync("./examples/permits/campsite-v2-example.json","utf8")); permit.id = "example-campsite-v2-permit-replacement"; writeFileSync("/tmp/satscout-permit-replacement.json", JSON.stringify(permit, null, 2));'
pnpm cli permit create --file /tmp/satscout-permit-replacement.json
pnpm cli permit activate example-campsite-v2-permit-replacement
```

Cross-Mission: a second Mission cannot consume the first Permit. Parent linkage: authorize the instrument grant first, then evaluate a value-transfer ResolvedAction with a missing, wrong-Mission, wrong-kind, or released parent.

```sh
pnpm cli spend resolve simulate --file ./examples/actions/instrument-acquire-request.json --json > /tmp/satscout-instrument-resolved.json
pnpm cli spend authorize --file /tmp/satscout-instrument-resolved.json
pnpm cli spend evaluate --file /tmp/satscout-transfer-incomplete.json
pnpm cli audit example-campsite-2099
```

Expected: transfer preview is `INDETERMINATE` until a valid same-Mission instrument Authorization id is copied into `parentAuthorizationId`. Audit contains Permit create/activate/revoke and Authorization create/execute/ambiguous/release events, with no secrets.

### Concurrency

From the repository root, with the same dedicated database after releasing or using a fresh Permit with `maxExecutions: 1`:

```sh
pnpm test tests/spend-concurrency.test.ts
```

Expected: two independent Node processes compete; exactly one receives an Authorization; the other fails closed. Aggregate-budget races behave the same way.

### Simulated spend remains isolated; live spend is not sufficient authorization

```sh
unset SATSCOUT_ALLOW_SIMULATED_SPEND
pnpm cli spend resolve simulate --file ./examples/actions/merchant-purchase-request.json
SATSCOUT_LIVE_SPEND=true pnpm cli spend evaluate --file /tmp/satscout-merchant-resolved.json
```

Expected: simulated resolve refuses when the flag is unset/false. `SATSCOUT_LIVE_SPEND=true` still does not enable production provenance and is not sufficient for a Wavelength Send.

### Public-repository check

```sh
git status --short
git ls-files data
```

Do not commit the manual-test database or `/tmp` ResolvedAction files. No credentials, invoices, cards, or wallet material should appear.

## Chunk 05 — Wavelength Signet

Do not perform a real Signet payment until the implementation has been reviewed. Automated tests use a synthetic local HTTP server only.

Operational setup: [docs/WAVELENGTH_SIGNET.md](WAVELENGTH_SIGNET.md).

### Manual setup

1. Build `waved` with `make build-wavewalletrpc` (needs `wavewalletrpc` and `swapruntime`). Record `waved --version` or the git commit.
2. Use a dedicated SatScout Signet data directory. Do not share it with other apps.
3. Create the wallet with `wavecli` (human only). Back up the seed outside SatScout.
4. Unlock/start `waved` on loopback. Keep macaroons enabled.
5. Restrict macaroon file permissions (`chmod 600`).
6. Fund a small Signet balance.
7. Set:

```text
SATSCOUT_WAVELENGTH_REST_URL=http://127.0.0.1:10031
SATSCOUT_WAVELENGTH_MACAROON_PATH=<macaroon-path>
```

If Status returns `Unimplemented`, rebuild `waved` with the wallet RPC surface.

Create a local-only Mission and a conservative Permit from `examples/permits/signet-wavelength-example.json` (a few thousand sats principal, small fee cap, `maxExecutions: 1`, `allowedProvenanceAdapterIds: ["wavelength.signet"]`). Store live test data only in the ignored local database.

Generate a small amount-bearing BOLT11 from a **controlled Signet Lightning receiver**. Store it at `/tmp/satscout-signet-invoice` with restrictive permissions. Delete it after testing. Do not commit invoice files.

### Test A — regression

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
```

Chunks 01–04 remain green. Wavelength tests use only loopback synthetic servers.

### Test B — status

```sh
pnpm cli wavelength status
```

Expected: `ready = true`, `network = signet`, expected small balance. No macaroon, seed, or password printed. No new tracked files.

### Test C — non-spending prepare

```sh
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=true \
pnpm cli wavelength prepare-signet \
  --mission <id> \
  --permit <id> \
  --grant grant-signet-transfer \
  --invoice-file /tmp/satscout-signet-invoice \
  --json
```

Expected: COMPLETE, LIGHTNING, principal/fee/total/payment hash/expiry, Permit decision. No authority reserved. No funds moved. Invoice and send intent absent from output, audit, and SQLite.

### Test D — policy rejection

Use a Permit limit below the prepared principal or fee. Expected: `DENY`, Send never invoked, wallet unchanged.

### Test E — live-spend gate disabled

```sh
SATSCOUT_LIVE_SPEND=false \
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=true \
pnpm cli wavelength execute-signet \
  --mission <id> --permit <id> --grant grant-signet-transfer \
  --invoice-file /tmp/satscout-signet-invoice \
  --idempotency-key gate-e \
  --confirm-signet-spend
```

Expected: `LIVE_SPEND_DISABLED`. No Send. No EXECUTING.

### Test F — Signet-test gate disabled

```sh
SATSCOUT_LIVE_SPEND=true \
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=false \
pnpm cli wavelength execute-signet \
  --mission <id> --permit <id> --grant grant-signet-transfer \
  --invoice-file /tmp/satscout-signet-invoice \
  --idempotency-key gate-f \
  --confirm-signet-spend
```

Expected: `SIGNET_TEST_SPEND_DISABLED`. No Send.

### Test G — confirmation missing

Set both env gates true and omit `--confirm-signet-spend`. Expected: `SIGNET_SPEND_CONFIRMATION_REQUIRED`. No Send.

### Test H — one real bounded Signet payment

Generate a fresh small controlled invoice. Run execute with both env gates and `--confirm-signet-spend`. Expected path: Status signet → PrepareSend → Permit ALLOW → Authorization → EXECUTING → one Send → reconciliation. `SUCCEEDED` only with strong evidence. Confirm recipient settlement. Compare payment hash, principal, fee, total outflow. No raw credentials anywhere.

### Test I — duplicate protection

Retry the already-paid invoice/payment identity. SatScout must block a second Send without relying on Lightning.

### Test J — audit

```sh
pnpm cli audit <mission-id>
pnpm cli authorization show <auth-id>
pnpm cli permit usage <permit-id>
```

Expected sequence similar to prepare → ALLOW → AUTHORIZATION_CREATED → EXECUTING → Send dispatched → reconciled SUCCEEDED. No invoice, intent, macaroon, preimage, password, or seed.

### Test K — restart/reconciliation

```sh
pnpm cli wavelength reconcile --authorization <id>
```

Uses durable payment identity only. Does not Send. Crash-before-Send cases are covered by synthetic tests rather than interrupting a live Signet payment.

### Cleanup

Delete `/tmp/satscout-signet-invoice`. Leave Signet authorization/audit history intact. Do not reuse ambiguous Authorizations. Keep the dedicated wallet balance small.

```sh
git status --short
git diff --check
```

No wallet, macaroon, or invoice files should be tracked.

## Chunk 06 — Bitrefill instrument adapter

Do not create a live invoice until the read-only product inspection and Permit rejection tests are understood. Automated implementation must not mutate a real Bitrefill account. A human performs the unpaid-invoice acceptance test.

Use a dedicated database:

```sh
export SATSCOUT_DB_PATH=./data/manual-bitrefill.sqlite
export SATSCOUT_BITREFILL_API_KEY_PATH=./.local/bitrefill/api-key
rm -f ./data/manual-bitrefill.sqlite ./data/manual-bitrefill.sqlite-shm ./data/manual-bitrefill.sqlite-wal
pnpm cli init
```

Expected: schema version 5, `Bitrefill live invoice switch: false`, `Bitrefill MCP prepayment switch: false`.

### Credential setup

```sh
mkdir -p .local/bitrefill
umask 077
printf '%s' 'YOUR_PERSONAL_API_KEY' > .local/bitrefill/api-key
chmod 600 .local/bitrefill/api-key
```

The key is purchasing authority. Do not pass it on the CLI. Do not commit the file. Details: [BITREFILL.md](BITREFILL.md).

### Test A — regression baseline

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
```

Expected: Chunk 01–06 automated checks pass. Bitrefill tests use a synthetic local transport only.

### Test B — read-only ping and product inspection

```sh
pnpm cli bitrefill ping
pnpm cli bitrefill product search --query "visa"
pnpm cli bitrefill product show <exact-product-id>
```

Record the current product id, currency, packages or range, in-stock status, and whether the output reports human action / `REST_PREPAID_CARD_FLOW_UNAVAILABLE`. Personal REST does not document the MCP prepaid-Visa `bill_payment_id` prepayment flow. Do not create an invoice yet.

Search is discovery only. Do not treat the first search hit as an execution identity.

### Test C — Permit ALLOW / DENY without an invoice

Create a conservative Mission plus a v2 Permit whose `payment-instrument.acquire` grant allows provider `bitrefill` and the **exact** product id from Test B, with a small `maxFaceValue` in integer minor units. Activate the Permit.

```sh
pnpm cli bitrefill instrument resolve \
  --mission <id> \
  --permit <id> \
  --grant grant-instrument-bitrefill \
  --product <exact-product-id> \
  --value-minor <allowed-minor>
```

Expected: product/currency/value, Permit `ALLOW`, and:

```text
No authority reserved.
No invoice created.
No money moved.
```

Then independently:

- `--value-minor` one cent over `maxFaceValue` → `DENY`
- a different exact product id → `DENY`

No invoice. No Authorization in `EXECUTING`.

### Test D — live-invoice gate disabled

```sh
SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=false \
pnpm cli bitrefill instrument create-invoice \
  --mission <id> --permit <id> --grant grant-instrument-bitrefill \
  --product <exact-product-id> --value-minor <allowed-minor> \
  --idempotency-key gate-d \
  --confirm-bitrefill-invoice
```

Expected: no POST `/invoices`. No Authorization enters `EXECUTING` merely because confirmation was passed.

### Test E — confirmation missing

```sh
SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=true \
pnpm cli bitrefill instrument create-invoice \
  --mission <id> --permit <id> --grant grant-instrument-bitrefill \
  --product <exact-product-id> --value-minor <allowed-minor> \
  --idempotency-key gate-e
```

Expected: no POST `/invoices`. No `EXECUTING`.

### Test F — one unpaid Lightning invoice (human only)

Only after reviewing product facts and gates. Prefer a documented test product if the Personal account actually has access; otherwise the lowest-risk, lowest-value documented product that does not complete merely from invoice creation. Do not assume test-product access exists.

```sh
SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=true \
pnpm cli bitrefill instrument create-invoice \
  --mission <id> \
  --permit <id> \
  --grant grant-instrument-bitrefill \
  --product <exact-product-id> \
  --value-minor <allowed-minor> \
  --idempotency-key live-unpaid-1 \
  --confirm-bitrefill-invoice
```

Expected:

```text
Bitrefill invoice created.
No Lightning payment was sent.
No product was purchased yet.
```

BOLT11 is not printed by default. Confirm invoice exists, `payment_method = lightning`, payment outstanding, Wavelength wallet unchanged, Bitrefill account balance unchanged, no delivered product. Do not pay it.

### Test G — read-only reconcile

```sh
pnpm cli bitrefill reconcile --authorization <auth-id>
```

Expected: unpaid → acquisition remains `EXECUTING`. No second invoice. No Wavelength call.

### Test H — no Wavelength interaction

During the entire real Chunk 06 flow, audit must contain no Wavelength `PrepareSend` or `Send` events caused by Bitrefill.

```sh
pnpm cli audit <mission-id>
pnpm cli authorization show <auth-id>
```

### Cleanup

Leave the unpaid invoice to expire if appropriate. Do not pay it. Do not commit `.local/bitrefill/`, SQLite databases, or live invoice identifiers.

```sh
git status --short
git diff --check
```

## Chunk 06B — Narrow Bitrefill MCP prepayment adapter

Do not purchase a product. Do not call `buy-products`. Do not move Bitcoin. Automated implementation must not mutate a real Bitrefill account; a human performs the live prepayment acceptance test.

Use a dedicated database:

```sh
export SATSCOUT_DB_PATH=./data/manual-bitrefill-mcp.sqlite
export SATSCOUT_BITREFILL_API_KEY_PATH=./.local/bitrefill/api-key
export SATSCOUT_BITREFILL_MCP_API_KEY_PATH=./.local/bitrefill/mcp-api-key
rm -f ./data/manual-bitrefill-mcp.sqlite ./data/manual-bitrefill-mcp.sqlite-shm ./data/manual-bitrefill-mcp.sqlite-wal
pnpm cli init
```

Expected: schema version 5, `Bitrefill MCP prepayment switch: false`.

### 1. Regression suite

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
```

Expected: Chunk 01–06B automated checks pass. MCP tests use a synthetic local transport only. CI never contacts Bitrefill.

### 2. Separate MCP API key file

Prefer a dedicated Bitrefill API key for MCP rather than reusing the REST key, if the account supports multiple keys.

```sh
mkdir -p .local/bitrefill
umask 077
printf '%s' 'YOUR_MCP_API_KEY' > .local/bitrefill/mcp-api-key
chmod 600 .local/bitrefill/mcp-api-key
```

Do not pass the key on the CLI. Do not commit the file. Do not set `SATSCOUT_BITREFILL_MCP_API_KEY` or `SATSCOUT_BITREFILL_MCP_URL`.

### 3. Owner-only local prepayment profile

```sh
cp examples/bitrefill/prepayment-profile.example.json .local/bitrefill/prepayment-profile.json
chmod 600 .local/bitrefill/prepayment-profile.json
```

Replace `REDACTED` with the real first and last name in the local file only. Do not put real values in git.

### 4. Read-only inspect prepaid-visa-usa

Create a conservative Mission plus a v2 Permit whose `payment-instrument.acquire` grant allows provider `bitrefill` and product `prepaid-visa-usa`, with a small `maxFaceValue` in integer minor units. Activate the Permit.

```sh
pnpm cli bitrefill mcp prepayment inspect \
  --mission <id> \
  --permit <id> \
  --grant grant-instrument-bitrefill \
  --product prepaid-visa-usa \
  --value-minor <allowed-minor>
```

Expected: product, currency, value/range, prepayment required, number/type of supported required fields, whether SatScout can satisfy them, Permit preview, and:

```text
No prepayment data was submitted.
No authority was reserved.
No invoice was created.
No payment was made.
```

This inspect must still run when Personal REST cannot retrieve `prepaid-visa-usa` (live 404) or `virtual-prepaid-visa-usa` (live 403). Do not change the Permit to another product for this test. The question is whether MCP `get-product-details(prepaid-visa-usa)` currently resolves the product described in Bitrefill's MCP docs. REST HTTP 403 must be classified as `BITREFILL_FORBIDDEN`, not `AUTH_FAILED`.

If MCP returns a protocol-valid product-not-found payload (observed 2026-08-21 for `prepaid-visa-usa`, with informational suggestions such as `virtual-prepaid-visa-usa` / Digital Prepaid Visa USA), expect `PRODUCT_NOT_FOUND`, not `MALFORMED_PRODUCT`. Do not change the Permit to a suggested product. Do not retry inspect against a suggestion.

Live MCP authentication observed 2026-08-21: the server requires `https://api.bitrefill.com/mcp` with `Authorization: Bearer <key>`, and the key-in-path URL is shut down. Currently published Bitrefill MCP docs still describe key-in-path auth. Treat that as a live compatibility observation, not a permanent assumption. Inspect must not print the API key, Authorization header, or any `/mcp/<key>` URL.

Do not print remote free-form instructions.

### 4b. Read-only inspect virtual-prepaid-visa-usa

Create a separate v2 Permit whose `payment-instrument.acquire` grant allows provider `bitrefill` and product `virtual-prepaid-visa-usa`, with a small `maxFaceValue` in integer minor units that includes `2500`. Activate that Permit. Do not reuse the `prepaid-visa-usa` Permit.

```sh
pnpm cli bitrefill mcp prepayment inspect \
  --mission <id> \
  --permit <id> \
  --grant grant-instrument-bitrefill \
  --product virtual-prepaid-visa-usa \
  --value-minor 2500
```

Observed live schema (2026-08-21): the product resolves. Prepayment is required. The first structured form is:

```text
prepayment.first_form:
  - id: bill_amount
    label: Enter amount
    type: text
    required: true
    max_length: null
```

Expected: SatScout reports `bill_amount` as a supported required field and can satisfy it from the Permit-bound face value. Inspect must convert `2500` to `"25.00"` internally and must not accept a caller-supplied `bill_amount`. Permit preview `ALLOW` at `2500` when that value is within the returned range and step. Also:

```text
No prepayment data was submitted.
No authority was reserved.
No invoice was created.
No payment was made.
```

Do not call `submit-prepayment-step`. Do not infer `first_name` / `last_name` from instructions or descriptions such as "We'll ask for the first and last name...". Privileged fields come only from the structured form. Returned instructions/descriptions are untrusted text.

If the requested face value is below the returned range, above the returned range, or not an allowed step, inspect must fail closed (`VALUE_OUT_OF_RANGE` or `INVALID_STEP`) and must not submit. A returned product id or currency other than `virtual-prepaid-visa-usa` / `USD` must fail closed.

### 5. Confirm the exact current prepayment schema

Record required field names and step count from inspect. For `virtual-prepaid-visa-usa`, the currently observed first step is `bill_amount` via `prepayment.first_form`. Do not assume the next form. If a later structured form returns only `first_name` / `last_name`, those may be filled from the local profile. If fields other than those approved fields plus authorized face-value aliases (`value`, `amount`, `package_value`, `face_value`) appear, stop with `HUMAN_ACTION_REQUIRED` or `BITREFILL_MCP_SCHEMA_UNSUPPORTED`. Do not auto-fill address, SSN, terms, KYC, or checkboxes. Do not parse prose in `instructions` or `description`.

### 6. Confirm Permit preview ALLOW

Inspect `virtual-prepaid-visa-usa` at `2500` should report Permit preview `ALLOW` when that value is within the returned range and step. Independently, a value over `maxFaceValue` should `DENY`. A different product id should fail closed.

### 7. Live-prepayment gate disabled → no submit

```sh
SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=false \
pnpm cli bitrefill mcp prepayment prepare \
  --mission <id> --permit <id> --grant grant-instrument-bitrefill \
  --product virtual-prepaid-visa-usa --value-minor 2500 \
  --profile-file .local/bitrefill/prepayment-profile.json \
  --confirm-prepayment
```

Expected: no `submit-prepayment-step`. No Authorization. No invoice. There is no caller `--bill-amount` flag.

### 8. Gate enabled but missing confirmation → no submit

```sh
SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=true \
pnpm cli bitrefill mcp prepayment prepare \
  --mission <id> --permit <id> --grant grant-instrument-bitrefill \
  --product virtual-prepaid-visa-usa --value-minor 2500 \
  --profile-file .local/bitrefill/prepayment-profile.json
```

Expected: no `submit-prepayment-step`.

### Read-only MCP protocol/schema inspection

```sh
pnpm cli bitrefill mcp tools --json
```

This performs only initialize plus `tools/list`. Expected: the sanitized schemas for exactly `get-product-details` and `submit-prepayment-step`, protocol/invocation metadata, and no business tool execution. For `submit-prepayment-step`, confirm required `product_id` string, integer `step_number`, and object `form_data`; record whether an output schema is present. This command does not broaden the business allowlist.

### 9–11. One real prepayment chain (human only)

Only after reviewing the inspect schema and gates. Do not purchase. Do not assume the next form after `bill_amount`. If a later structured form returns only approved fields (`first_name` / `last_name` or an authorized face-value alias), it may proceed. Any unknown field or schema must stop with `HUMAN_ACTION_REQUIRED` or `BITREFILL_MCP_SCHEMA_UNSUPPORTED`.

Observed live (2026-08-21): the first `submit-prepayment-step` for `virtual-prepaid-visa-usa` was dispatched and the binding became `AMBIGUOUS` with `last_step=1` because the parser treated `response.step === 1` as a repeat before reading the returned form. Leave that existing live `AMBIGUOUS` binding unchanged. Do not invalidate, delete, or reconcile it as part of this correction. A later same-numbered response with a different explicit form (for example `first_name` / `last_name` after submitting `bill_amount`) is now treated as acknowledgement and internal `nextStep=2`. The same field IDs at the same step remain a repeat and are never resubmitted. After a dispatched response, audit may include `responseStep`, safely parsed field IDs/types, and `returnedFormSchema`. The latter contains only array indexes, entry kinds, object key names, per-key value types, and token-safe string values for structural `id` / `type` keys — never string-entry content, `label`, `placeholder`, `buttonText`, other object values, form values, cardholder names, `bill_payment_id`, raw payloads, instructions, Authorization headers, or API keys.

Observed live (2026-08-24): step 1 `bill_amount` returned a same-numbered next form with `first_name` and `last_name` text inputs plus `label` and `confirmButton` UI entries. SatScout advanced internally to step 2 and dispatched exactly `product_id`, integer `step_number=2`, and `form_data` containing only `first_name` and `last_name`. The server returned `CallToolResult.isError=true`. This is now `BITREFILL_MCP_TOOL_ERROR`, not transport unavailability. The binding remains `AMBIGUOUS`; do not retry or invalidate it automatically. Audit may store normalized error code/category, content block types, and a message digest, but never remote message text or the raw result.

```sh
SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=true \
pnpm cli bitrefill mcp prepayment prepare \
  --mission <id> \
  --permit <id> \
  --grant grant-instrument-bitrefill \
  --product virtual-prepaid-visa-usa \
  --value-minor 2500 \
  --profile-file .local/bitrefill/prepayment-profile.json \
  --confirm-prepayment
```

Expected:

```text
BITREFILL PREPAYMENT READY
...
bill_payment_id:   [not displayed]
No Authorization was created.
No invoice was created.
No product was purchased.
No Lightning payment was requested.
No funds moved.
```

### 12. Private local binding file

Confirm `.local/bitrefill/prepayments/<binding-id>` exists with mode `0600`. The filename is the binding id, not the raw `bill_payment_id`.

### 13. SQLite contains only digest/safe facts

Inspect the `instrument_prepayments` row. It must contain product, currency, face value, status `READY`, and `bill_payment_id_digest`. It must not contain the raw id, first name, last name, or form values.

### 14. Review audit for zero PII

```sh
pnpm cli audit <mission-id>
```

Expected events may include `BITREFILL_MCP_PRODUCT_INSPECTED`, `BITREFILL_PREPAYMENT_STARTED`, step start/complete, `BITREFILL_PREPAYMENT_AMBIGUOUS`, and `BITREFILL_PREPAYMENT_READY`. They must not contain API keys, Authorization headers, cardholder names, form values, `bill_payment_id`, string-entry content, labels, placeholders, button text, or raw MCP payloads. Sanitized `responseStep`, returned field IDs/types, and `returnedFormSchema` (entry indexes/kinds, object keys/value types, and token-safe structural `id` / `type` values) are allowed.

### 15. No Bitrefill invoice

Confirm in the Bitrefill account that SatScout never created an invoice because it never called `buy-products`.

### 16. No Wavelength calls

Audit must contain no Wavelength `PrepareSend` or `Send` events caused by this flow.

### 17. Restart and reload the READY binding

```sh
pnpm cli init
```

The READY binding must still load. Digest verification of the private file must succeed. Do not create an Authorization.

### 18. Do not purchase anything

Do not start Chunk 06C or 07. Leave the prepayment unused. Do not commit `.local/bitrefill/`, SQLite databases, profile files, or raw `bill_payment_id` files.

```sh
git status --short
git diff --check
```
