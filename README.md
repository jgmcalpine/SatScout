# SatScout

SatScout is an open-source autonomous purchasing agent built around **bounded spending authority**. A human defines a Mission and a narrowly scoped Permit; orchestration may propose an economic action, but deterministic code—not an agent or language model—decides whether that action is authorized.

The first intended use case is eventually reserving a campsite and funding checkout through a prepaid card purchased with Bitcoin over Lightning. **SatScout cannot currently reserve a campsite.**

## Implemented: deterministic foundation and read-only observation

The repository provides:

- runtime-validated Mission, Permit, BookingAttempt, PurchaseIntent, Payment, and Reservation models;
- a single explicit workflow state machine with audited rejection and idempotency behavior;
- pure, multi-reason Permit evaluation over integer cents and satoshis;
- migration-managed SQLite persistence and append-only audit history;
- fail-closed live-feature switches and recursive structured-log redaction;
- a local CLI, fictional examples, and comprehensive automated tests;
- a narrow, read-only Recreation.gov observer backed by Playwright Chromium;
- a dedicated persistent browser profile for optional human-performed login;
- exact campsite, campground, and calendar-date inspection;
- explicit authentication, human-verification, target-match, and availability states;
- sanitized observation audit events that never transition workflow state.

Recreation.gov observation runs only when a human invokes a CLI command. It does not monitor in the background, use undocumented APIs, solve challenges, enter login credentials, change a reservation, or perform a transaction. There is no Camply integration, merchant adapter, wallet access, Lightning payment, real spending, or LLM/agent integration. Setting either live switch to `true` grants the observer no additional authority.

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

The two future-facing switches are optional and safely default to `false`:

```text
SATSCOUT_LIVE_BOOKING=false
SATSCOUT_LIVE_SPEND=false
```

Only exact lowercase `true` and `false` are accepted. A malformed value stops startup. Neither switch activates booking, spending, or any additional browser behavior.

## Recreation.gov browser and observation

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

The dedicated profile is single-process. Close every window opened by `recreation browser` before running `recreation observe`; otherwise SatScout reports `BROWSER_PROFILE_IN_USE` without attempting navigation.

Configuration is optional:

```text
SATSCOUT_BROWSER_PROFILE_DIR=./.local/browser/recreation-gov
SATSCOUT_BROWSER_HEADLESS=false
SATSCOUT_BROWSER_TIMEOUT_MS=30000
```

Headed mode is the default. An observation is one-shot, so its Chromium window closes after the bounded read completes. The observer waits for session and calendar signals to hydrate within `SATSCOUT_BROWSER_TIMEOUT_MS`, reports unresolved signals as `UNKNOWN`, and never tests availability by invoking a reservation control.

## Quality checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:browser
pnpm build
```

For an end-to-end local walkthrough, follow [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md). Architectural boundaries are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the deliberately staged plan is in [docs/ROADMAP.md](docs/ROADMAP.md).

## License

SatScout is available under the [MIT License](LICENSE).
