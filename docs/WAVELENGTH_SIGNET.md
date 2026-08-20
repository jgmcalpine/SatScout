# Wavelength Signet (Chunk 05)

SatScout's first funding adapter talks to a **standalone `waved` daemon** over local REST. It does not embed the Wavelength SDK, does not call `wavecli`, and does not create, unlock, or fund a wallet.

```text
SatScout
    │
    │ local authenticated REST (loopback only)
    ▼
waved WalletService
    │
    ▼
dedicated Signet Wavelength wallet
```

The WalletService API is versioned with the daemon. Record the exact `waved` version or git commit used for a live acceptance run.

## Dedicated wallet

Use a **dedicated SatScout Signet data directory**. Do not share that wallet with unrelated applications.

A human, outside SatScout:

1. Installs/builds `waved` with the wallet RPC surface.
2. Creates the wallet and securely backs up the seed.
3. Starts and unlocks `waved`.
4. Funds it with a small amount of Signet sats.
5. Points SatScout at the loopback REST URL and macaroon file.

SatScout never receives a mnemonic, seed, wallet password, or seed passphrase. There are no configuration fields for those secrets.

## Build `waved` with WalletService

Default `waved` builds omit `WalletService`. Build with both `wavewalletrpc` and `swapruntime` tags:

```sh
make build-wavewalletrpc
```

If Status/`PrepareSend` returns `Unimplemented`, the running binary does not include the wallet RPC surface. Rebuild; do not work around it in SatScout.

Keep gRPC and REST listeners on loopback. Keep macaroons enabled.

Typical REST listener: `http://127.0.0.1:10031`.

## Configuration

```text
SATSCOUT_WAVELENGTH_REST_URL=http://127.0.0.1:10031
SATSCOUT_WAVELENGTH_MACAROON_PATH=/absolute/path/to/admin.macaroon
SATSCOUT_WAVELENGTH_HTTP_TIMEOUT_MS=30000
SATSCOUT_WAVELENGTH_INTENT_MIN_TTL_MS=15000
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=false
SATSCOUT_LIVE_SPEND=false
```

REST URL rules:

- `http` only (plaintext because the endpoint must be loopback)
- literal `127.0.0.1` or `::1` only
- no hostnames, remote IPs, embedded credentials, query strings, or paths

Authenticated requests never follow redirects. A 3xx response fails closed.

Macaroon:

- required; there is no unauthenticated mode
- read from a local file and sent as the REST `macaroon` header (hex)
- group/world-readable files are rejected
- never printed, logged, or stored in SQLite

## Spend path

The only permitted outbound path is:

```text
PrepareSend → trusted quote → ResolvedAction → Permit Engine → Authorization
    → EXECUTING (durable) → Send(prepared intent only) → InspectActivity
```

There is no invoice→Send shortcut, no Wavelength convenience `send()`, and no automatic Send retry.

Chunk 05 authorizes only:

- Signet (`Status.network == signet`, hard-coded)
- `ready == true`
- amount-bearing BOLT11 Lightning invoices
- `quote_status == COMPLETE`
- known fee and known total outflow
- rail `LIGHTNING`

`LOCAL_ONLY`, unknown fee/total, and `OFFCHAIN_UNKNOWN` are `INDETERMINATE`. Definite non-Lightning rails (`IN_ARK`, `ONCHAIN`, `CREDIT`, `MIXED`) are `DENY`.

## Safety gates for a real Send

All three are required before `AUTHORIZED → EXECUTING` and before Send:

```text
SATSCOUT_LIVE_SPEND=true
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=true
--confirm-signet-spend
```

`SATSCOUT_LIVE_SPEND=true` is necessary and **not sufficient**.

## Invoice handling

Pass invoices with `--invoice-file /tmp/satscout-signet-invoice` (or `-` for stdin). Do not pass a raw BOLT11 as a normal CLI argument.

SatScout does not persist the invoice, send intent, preimage, or macaroon. Delete temporary invoice files after testing.

## Manual status check

```sh
pnpm cli wavelength status
```

Expected: `ready=true`, `network=signet`, a small confirmed balance. No credentials.

## Non-spending prepare

```sh
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=true \
pnpm cli wavelength prepare-signet \
  --mission <id> \
  --permit <id> \
  --grant grant-signet-transfer \
  --invoice-file /tmp/satscout-signet-invoice \
  --json
```

No authority is reserved. No funds move. The prepared intent is discarded.

## Live execute

```sh
SATSCOUT_LIVE_SPEND=true \
SATSCOUT_ALLOW_SIGNET_TEST_SPEND=true \
pnpm cli wavelength execute-signet \
  --mission <id> \
  --permit <id> \
  --grant grant-signet-transfer \
  --invoice-file /tmp/satscout-signet-invoice \
  --idempotency-key <key> \
  --confirm-signet-spend
```

## Reconcile (read-only)

```sh
pnpm cli wavelength reconcile --authorization <auth-id>
```

This command never calls Send.

## Conservative failure policy

After `EXECUTING`, Wavelength `FAILED`, not-found, malformed, or economically mismatched results become `AMBIGUOUS` (or remain `EXECUTING` while pending). Authority is not released automatically. Lower actual fee/outflow than the authorized ceiling may be accepted when principal and payment hash match exactly.

If an Authorization is explicitly `RELEASED` **before** `EXECUTING` (no Send), a later prepare of the same invoice is permitted. After `EXECUTING`, the payment identity remains blocked. Do not reuse ambiguous Authorizations.
