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

Expected in the current version: schema version 1, both live switches false, an explicit second live-cart acknowledgement requirement, and statements that SatScout has no reservation-completion, wallet, or spending behavior and that live spend is inert.

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
