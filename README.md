# SatScout

SatScout is an open-source autonomous purchasing agent built around **bounded spending authority**. A human defines a Mission and a narrowly scoped Permit; orchestration may propose an economic action, but deterministic code—not an agent or language model—decides whether that action is authorized.

Mission type is workflow context, not permission: `acquire-digital-product` is the current MVP path, and `book-campsite` remains the Recreation.gov observation/cart workflow. Permit grants are the only spending authority.

The first intended use case is eventually reserving a campsite and funding checkout through a prepaid card purchased with Bitcoin over Lightning. **The current MVP is different:** an agent may autonomously acquire **one exact merchant-specific digital gift card** (Bitrefill Personal REST + Wavelength mainnet Lightning) inside narrowly bounded Permit authority. Campsite booking remains a future MerchantAdapter demonstration. Prepaid-Visa MCP prepayment remains experimental and parked.

**SatScout can currently observe Recreation.gov, capture a verified cart hold, authorize bounded economic actions, move Signet sats through Wavelength when one exact prepared payment has been permitted, create an unpaid Bitrefill Lightning invoice under a `payment-instrument.acquire` Authorization, complete Bitrefill prepaid-card **prepayment** (not purchase) through a parked MCP adapter, prepare Wavelength mainnet payments, and—only through the integrated gift-card acquire command with every live gate—pay exactly one Permit-bound Lightning invoice and store redemption secrets outside SQLite.** There is no generic mainnet-send command, no agent-selected product substitution, and no Recreation.gov checkout.

## Implemented: deterministic foundation, observation, verified cart capture, bounded economic authority, Wavelength Signet, Bitrefill instrument acquisition, Wavelength mainnet prepare, and bounded gift-card purchase

The repository provides:

- runtime-validated Mission (`book-campsite` or `acquire-digital-product`), Permit v2, ActionRequest, ResolvedAction, Authorization, BookingAttempt, PurchaseIntent, Payment, and Reservation models;
- a single explicit workflow state machine with audited rejection and idempotency behavior;
- a generic Permit Engine with three typed grant kinds, three-state `ALLOW` / `DENY` / `INDETERMINATE` evaluation, and integer cents/satoshis;
- atomic Authorization creation with a ledger-derived usage reservation and crash-safe release rules;
- a Spend Controller application boundary, a Wavelength Signet `FundingAdapter` over local REST, a Bitrefill Personal REST `InstrumentAdapter`, and a narrow Bitrefill MCP prepayment adapter;
- migration-managed SQLite persistence and append-only audit history;
- fail-closed live-feature switches, a separate simulated-spend switch, and recursive structured-log redaction;
- a local CLI, fictional examples, and comprehensive automated tests;
- a narrow, read-only Recreation.gov observer backed by Playwright Chromium;
- a dedicated persistent browser profile for optional human-performed login;
- exact campsite, campground, and calendar-date inspection;
- explicit authentication, human-verification, target-match, and availability states;
- sanitized observation audit events that never transition workflow state;
- a separate, narrowly scoped Recreation.gov cart adapter with cart inspection, combined read-only readiness, and exact-target capture operations;
- single-session preflight/capture, structured cart-response evidence with rendered UI cross-checks, explicit live confirmation, durable `CARTING` crash recovery, exact hold verification, and read-only reconciliation.

A Permit describes authority but does not itself grant access to funds. An Authorization reserves authority for one exact resolved action but is not itself a wallet credential. Recreation.gov observation remains read-only and runs only when a human invokes a CLI command. Cart capture is a separate capability. It may add only the independently verified Mission site and date range to an empty cart, then stops as soon as the exact hold is verified. It does not advance beyond the cart, remove cart items, fill reservation or traveler details, complete a reservation, or handle payment data.

Wavelength Signet is the first real funding adapter. SatScout does not create or unlock the wallet, handle the seed or password, or send on mainnet. The only spend path is `PrepareSend → ResolvedAction → Permit → Authorization → EXECUTING → Send(intent) → InspectActivity`. See [docs/WAVELENGTH_SIGNET.md](docs/WAVELENGTH_SIGNET.md).

Bitrefill is the first real instrument adapter. Product facts are retrieved independently from the official Personal REST API. Search results are never trusted authority. Invoice creation requires Permit preview ALLOW, durable local claim before `POST /invoices`, Lightning-only payment method, quantity one, and explicit live gates. Chunk 06's `instrument create-invoice` command still stops at an unpaid invoice. Chunk 07's `bitrefill gift-card acquire` command is the integrated purchase path: exact product/package/face value/quantity → invoice → Wavelength PrepareSend → parent `payment-instrument.acquire` plus exact-satoshi child `value.transfer` Authorization → one mainnet Send → invoice/order reconciliation → owner-only redemption secret file. Undocumented Bitrefill catalog `price` / `price_rate` fields are not fiat authority and are ignored. Chunk 06B prepaid-Visa MCP remains parked and is not part of this flow. See [docs/BITREFILL.md](docs/BITREFILL.md) and [docs/WAVELENGTH_MAINNET.md](docs/WAVELENGTH_MAINNET.md).

SatScout does not monitor in the background, call a direct mutating reservation API, solve challenges, enter login credentials, choose alternatives, or blindly retry an ambiguous external action. It observes the same-origin read-only cart response loaded by Recreation.gov's frontend, without extracting credentials or persisting response bodies. There is no Camply integration, Recreation.gov checkout, LLM/agent integration, or generic Bitrefill MCP purchasing path.

## Requirements and setup

Use Node.js 24 (pinned to 24.18.0 in `.node-version` and `.nvmrc`) and pnpm 11. The project uses Node's built-in SQLite module, Zod, Commander, and Playwright.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm browser:install
pnpm build
```

The CLI defaults to `./data/satscout.sqlite`. Override it with `SATSCOUT_DB_PATH`:

```sh
export SATSCOUT_DB_PATH=./data/my-local-test.sqlite
pnpm cli init
pnpm cli mission list
```

Both switches safely default to `false`:

```text
SATSCOUT_LIVE_BOOKING=false
SATSCOUT_LIVE_SPEND=false
SATSCOUT_ALLOW_SIMULATED_SPEND=false
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=false
SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=false
SATSCOUT_ALLOW_BITREFILL_PURCHASE=false
SATSCOUT_ALLOW_MAINNET_SPEND=false
SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=false
```

Only exact lowercase `true` and `false` are accepted. A malformed value stops startup. `SATSCOUT_LIVE_BOOKING=true` is necessary—but not sufficient—for the explicit cart-capture command. `SATSCOUT_LIVE_SPEND=true` is necessary—but not sufficient—for a Wavelength Signet Send; `SATSCOUT_ALLOW_SIGNET_TEST_SPEND=true` and `--confirm-signet-spend` are also required. `SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=true` is necessary—but not sufficient—for an unpaid Bitrefill invoice; `--confirm-bitrefill-invoice` is also required, and no Lightning payment is sent. A real gift-card purchase requires `SATSCOUT_LIVE_SPEND=true`, `SATSCOUT_ALLOW_MAINNET_SPEND=true`, `SATSCOUT_ALLOW_BITREFILL_PURCHASE=true`, `--confirm-real-purchase`, Permit, and Authorization. There is no generic mainnet-send command. `SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=true` is necessary—but not sufficient—for parked prepaid-card prepayment; `--confirm-prepayment` and an owner-only local profile are also required, and no product is purchased. `SATSCOUT_ALLOW_SIMULATED_SPEND=true` only enables labeled simulation of Permit evaluation and Authorization lifecycle; it still moves no money.

## Recreation.gov browser, observation, and cart hold

The default dedicated profile is `./.local/browser/recreation-gov`. It is gitignored and created with restrictive permissions. It contains sensitive cookies and authenticated session state: never commit, share, or point it at a normal personal Chrome/Chromium profile.

Open a visible browser and log in manually if desired:

```sh
pnpm cli recreation browser
```

SatScout never requests or fills a username or password. Close the Chromium window to exit. Observe an `ACTIVE`, unexpired Mission using an allowed numeric Recreation.gov campsite ID:

```sh
pnpm cli recreation observe --mission <mission-id> --site <site-id>
pnpm cli recreation observe --mission <mission-id> --site <site-id> --attempt <attempt-id> --json
```

Inspect the expected cart without changing it or workflow state:

```sh
pnpm cli recreation cart inspect --mission <mission-id> --attempt <attempt-id> --site <site-id>
```

Before live capture, run the combined read-only readiness path. It checks the exact target, dates, full availability, challenge state, authenticated structured cart response, rendered empty-cart state, and the UI's ability to prepare the exact date range in one browser context:

```sh
pnpm cli recreation cart readiness \
  --mission <mission-id> \
  --attempt <attempt-id> \
  --site <site-id>
```

Proceed only when it reports `Ready: YES` and `Date range: VERIFIED`. Readiness may leave the exact dates transiently selected in the browser page, but it never invokes Add to Cart, changes cart contents, or changes workflow state. The `--site` option is unnecessary once an exact target has been persisted on a `CARTING` or `CART_HELD` attempt. Live capture requires an `AVAILABLE` attempt, the same fresh readiness checks repeated inside its single browser session, and both gates:

```sh
SATSCOUT_LIVE_BOOKING=true pnpm cli recreation cart capture \
  --mission <mission-id> \
  --attempt <attempt-id> \
  --site <site-id> \
  --confirm-live-cart
```

SatScout hands the single-session readiness evidence to an application-owned commit barrier, which persists `CARTING` and the exact recovery target before the adapter is permitted to invoke Add to Cart. A failed commit permits no action. Only a fresh structured cart result that agrees with the rendered UI advances to `CART_HELD`. An exception, timeout, wrong item, wrong dates, multiple items, or unreadable cart remains `CARTING` and is never retried automatically. Inspect that state read-only, and reconcile only when inspection independently finds the exact item:

```sh
pnpm cli recreation cart inspect --mission <mission-id> --attempt <attempt-id> --json
pnpm cli recreation cart reconcile --mission <mission-id> --attempt <attempt-id>
```

If the failed result records `actionAttempted: false` and independent inspection reports `EMPTY`, Add to Cart did not run. Keep that attempt in `CARTING` as the durable failure record; reconciliation is not expected to change it. After correcting the pre-action failure, create a fresh BookingAttempt for the same unchanged Mission and explicitly transition the new attempt from `WAITING` to `AVAILABLE`. Create a new Mission only when the immutable campground, site set, arrival, or departure changes. If the action may have run, do not create another attempt until the external cart state has been resolved.

The dedicated profile is single-process. Close every window opened by `recreation browser` before running observation or cart commands; otherwise SatScout reports `BROWSER_PROFILE_IN_USE` without intentionally changing external state.

Configuration is optional:

```text
SATSCOUT_BROWSER_PROFILE_DIR=./.local/browser/recreation-gov
SATSCOUT_BROWSER_HEADLESS=false
SATSCOUT_BROWSER_TIMEOUT_MS=30000
```

Headed mode is the default. Each browser operation is bounded and closes its Chromium context when finished. The observer waits for calendar and visible account signals to hydrate within `SATSCOUT_BROWSER_TIMEOUT_MS`. Cart readiness distinguishes a still-loading cart from unknown or contradictory structure and uses the authenticated cart response as the primary session signal. Cart capture does not use a hard-coded hold duration and records price only when the structured response exposes it unambiguously.

## Permit v2 and simulated spend

A Permit describes authority but does not grant access to funds. Preview evaluation never reserves authority. Authorization is atomic with reservation and still moves no money.

```sh
export SATSCOUT_ALLOW_SIMULATED_SPEND=true
pnpm cli permit create --file ./examples/permits/campsite-v2-example.json
pnpm cli permit activate example-campsite-v2-permit-2099
pnpm cli spend resolve simulate --file ./examples/actions/merchant-purchase-request.json --json
pnpm cli spend evaluate --file /tmp/resolved.json
pnpm cli spend authorize --file /tmp/resolved.json
```

Simulation provenance is labeled `SIMULATION` / `cli.simulation`. CLI JSON cannot forge `trusted-adapter` provenance for Wavelength or Bitrefill. Wavelength Signet provenance is `TEST_NETWORK` / `wavelength.signet` and can only be constructed by the in-process adapter after a validated PrepareSend. Bitrefill product provenance is `PRODUCTION` / `bitrefill.personal` and can only be constructed by the in-process adapter after an authenticated product lookup. `PRODUCTION` here is the external-service evidence context, not Bitcoin mainnet. The full adversarial walkthrough is in [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md).

## Wavelength Signet

Configure a dedicated loopback `waved` daemon and macaroon. Do not commit wallet data.

```sh
pnpm cli wavelength status
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=true pnpm cli wavelength prepare-signet \
  --mission <id> --permit <id> --grant grant-signet-transfer \
  --invoice-file /tmp/satscout-signet-invoice --json
```

A real Send also requires `SATSCOUT_LIVE_SPEND=true` and `--confirm-signet-spend`. Setup and acceptance steps: [docs/WAVELENGTH_SIGNET.md](docs/WAVELENGTH_SIGNET.md) and [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md).

## Wavelength mainnet readiness

`wavelength.mainnet` is available only as a trusted, prepare-only adapter pinned to the official Wavelength `0.1.2-rc4` build. It validates daemon and operator readiness, applies independent small SatScout ceilings, constructs trusted evidence, evaluates the Permit, and stops. Mainnet `Send` is not implemented or approved in this chunk. See [docs/WAVELENGTH_MAINNET.md](docs/WAVELENGTH_MAINNET.md) for the version policy, gates, credential limitations, and read-only acceptance procedure.

## Bitrefill instrument adapter

Configure a Personal API key file. Do not pass the key on the CLI.

```sh
export SATSCOUT_BITREFILL_API_KEY_PATH=./.local/bitrefill/api-key
pnpm cli bitrefill ping
pnpm cli bitrefill product search --query "visa"
pnpm cli bitrefill product show <exact-product-id>
pnpm cli bitrefill instrument resolve \
  --mission <id> --permit <id> --grant <grant> \
  --product <exact-product-id> --value-minor 1000
```

Creating an unpaid Lightning invoice also requires `SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=true` and `--confirm-bitrefill-invoice`. That gate does not pay.

Read-only gift-card inspect (no invoice, no payment):

```sh
pnpm cli bitrefill gift-card inspect \
  --mission <id> --permit <id> --grant <grant> \
  --product <exact-product-id> --value-minor 500
```

A real purchase is a separate command and requires every live gate plus `--confirm-real-purchase`. Do not run it until Stage B in [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md) is accepted. There is no generic Wavelength mainnet-send command.

Inspect an existing acquisition through the local, sanitized presentation surface:

```sh
pnpm cli acquisition show <acquisition-id>
pnpm cli acquisition show <acquisition-id> --json
```

`acquisition show` is an observational projection of already-persisted acquisition, Permit, Authorization, funding-execution, and audit state. It opens the existing SQLite database in read-only mode and does not initialize or migrate it, reconcile external state, call Bitrefill or Wavelength, load integration credentials, reserve Permit authority, update timestamps, or read the owner-only redemption-secret file. The output deliberately omits invoice/payment identities, digests, and redemption material. Run `pnpm cli init` separately before using it with a new database.

Prepaid-card prepayment uses a separate MCP API key file and never purchases:

```sh
export SATSCOUT_BITREFILL_MCP_API_KEY_PATH=./.local/bitrefill/mcp-api-key
pnpm cli bitrefill mcp tools --json
pnpm cli bitrefill mcp prepayment inspect \
  --mission <id> --permit <id> --grant <grant> \
  --product prepaid-visa-usa --value-minor 5000
```

Live prepayment also requires `SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=true` and `--confirm-prepayment`. Details: [docs/BITREFILL.md](docs/BITREFILL.md).

## Quality checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:browser
pnpm build
```

For an end-to-end local walkthrough, follow [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md). Architectural boundaries are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the economic threat model is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), Bitrefill is in [docs/BITREFILL.md](docs/BITREFILL.md), and the deliberately staged plan is in [docs/ROADMAP.md](docs/ROADMAP.md).

## License

SatScout is available under the [MIT License](LICENSE).
