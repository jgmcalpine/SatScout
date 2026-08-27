# Wavelength mainnet (Chunks 06C and 07)

Chunk 06C makes `wavelength.mainnet` a trusted, prepare-first `FundingAdapter`. It can read daemon and wallet state, validate a prepared Lightning quote, construct trusted `PRODUCTION` provenance, and evaluate a Permit.

Chunk 07 may call Wavelength `Send` **only** through the integrated Bitrefill gift-card acquisition path after Permit, parent/child Authorization, SatScout ceilings, and every live gate. That path uses an `acquire-digital-product` Mission as workflow context; Mission type still does not authorize the Send. There is no generic mainnet-send CLI or public adapter method for an arbitrary BOLT11.

## Supported build and readiness policy

Mainnet is pinned to the official Wavelength `0.1.2-rc4` release. The tested daemon reports commit `94cf9a0`. SatScout uses an explicit version allowlist: `0.1.2-rc4` is accepted; `0.1.99`, `0.1.2-rc3`, other prereleases, and missing or unparseable versions are rejected. Updating the allowlist requires a code change and new compatibility tests.

Mainnet readiness requires all of the following trusted Wavelength observations:

- both `DaemonService.GetInfo` and `WalletService.Status` report `mainnet`;
- wallet API readiness is true and `wallet_state` is `WALLET_STATE_READY`;
- `server_connected` is true;
- `identity_pubkey` is present and well formed;
- `server_info` is present;
- every required operator amount parses as an exact safe integer number of sats;
- the Wavelength version is explicitly approved;
- wallet balance data is complete and non-negative; and
- the confirmed balance does not exceed SatScout's mainnet-use ceiling.

A trusted network contradiction is `DENY`. Missing, malformed, disconnected, locked, or otherwise unknown readiness data is `INDETERMINATE`; unknown state never becomes `ALLOW`.

The parsed operator constraints are `dust_limit`, `min_boarding_amount`, `max_vtxo_amount`, `min_operator_fee`, `min_vtxo_amount_sat`, and `max_user_balance`, plus the published exit delays, minimum confirmations, and free-refresh window. These fields describe provider feasibility only. They never increase Permit authority, and SatScout does not infer speculative VTXO composition from them. A definitive complete `PrepareSend` quote remains the trusted feasibility result for a Lightning outflow.

## Independent SatScout ceilings

The initial hard maxima are:

- wallet balance SatScout will use: `100000` sats;
- one mainnet Lightning principal: `25000` sats;
- fee: `2000` sats; and
- total outflow: `27000` sats.

Trusted operator configuration can only tighten these values with `SATSCOUT_WAVELENGTH_MAINNET_MAX_WALLET_BALANCE_SAT`, `SATSCOUT_WAVELENGTH_MAINNET_MAX_PRINCIPAL_SAT`, `SATSCOUT_WAVELENGTH_MAINNET_MAX_FEE_SAT`, and `SATSCOUT_WAVELENGTH_MAINNET_MAX_TOTAL_OUTFLOW_SAT`. Values above the compiled maxima fail configuration validation. Neither an ActionRequest nor a Permit can raise a ceiling.

Use a deliberately low-balance, dedicated wallet for initial testing. Wavelength's advertised `max_user_balance` is a provider limit, not a recommended operating balance.

## Execution gates

Generic mainnet Send remains blocked with `WAVELENGTH_MAINNET_EXECUTION_NOT_IMPLEMENTED`.

The bounded gift-card acquire path may Send once when **all** of the following are true:

1. `SATSCOUT_LIVE_SPEND=true`
2. `SATSCOUT_ALLOW_MAINNET_SPEND=true`
3. `SATSCOUT_ALLOW_BITREFILL_PURCHASE=true`
4. `--confirm-real-purchase`
5. Authorization is `EXECUTING` `value.transfer` with a `payment-instrument.acquire` parent and `wavelength.mainnet` provenance
6. exact prepared-operation digest, payment hash, principal, fee, and total outflow bind the Bitrefill invoice

Agent-provided request data cannot set these gates. `--confirm-mainnet-spend` is not a public generic execute command.

No unattended mainnet use is approved. Stage A in [MANUAL_TESTING.md](MANUAL_TESTING.md) is read-only. Do not run Stage B until the implementation is accepted.

## RPC credentials and remaining boundary

SatScout accepts only a literal loopback HTTP REST gateway, sends the Wavelength macaroon in the local `macaroon` header, refuses redirects, and requires the macaroon file not to be group- or world-readable. It never accepts a macaroon value or wallet password in configuration, never puts a password in argv, and redacts invoices, macaroons, prepared intent IDs, preimages, seeds, and passwords from logs and audit metadata. The Wavelength mainnet daemon must retain its normal TLS and macaroon protection on its gRPC listener; the loopback REST gateway is the local plaintext proxy described by Wavelength's rc4 API.

Wavelength rc4 has per-entity macaroon permissions, but both `WalletService.PrepareSend` and `WalletService.Send` require the same `onchain:write` permission. A macaroon that can prepare cannot cryptographically exclude send, so there is no practical supported prepare-only macaroon for SatScout to adopt in this release. Continue using the current owner-only daemon credential and treat a narrower permission split as a remaining hardening item; do not invent an undocumented caveat or token format.

TypeScript and the four/five-route REST client are defense-in-depth boundaries, not OS isolation. If SatScout and Wavelength run under the same compromised OS user or process environment, that attacker may be able to read the credential or bypass application-level restrictions. OS-user/process isolation remains outside Chunk 06C.

The earlier locally built Wavelength binary lacked the `wavewalletrpc` build tag. The official rc4 build successfully unlocked the existing mainnet wallet and connected to the operator.

## One safe manual acceptance procedure

This procedure performs version and readiness reads only. It does not request an address, receive, board, prepare a payment, create a VTXO, or call `Send`. Set the four path/address variables to the already-running official rc4 daemon; do not put a wallet password in any variable or argument.

```bash
export WAVE_RPCSERVER='127.0.0.1:11029'
export WAVE_TLS_CERT='/absolute/path/to/tls.cert'
export WAVE_MACAROON='/absolute/path/to/admin.macaroon'
export WAVE_REST_URL='http://127.0.0.1:10031'

wavecli --version
wavecli \
  --rpcserver "$WAVE_RPCSERVER" \
  --network mainnet \
  --tlscertpath "$WAVE_TLS_CERT" \
  --macaroonpath "$WAVE_MACAROON" \
  --json --no-input getinfo |
  jq -e '
    .version == "0.1.2-rc4" and
    .commit == "94cf9a0" and
    .network == "mainnet" and
    .wallet_state == "WALLET_STATE_READY" and
    .server_connected == true and
    .identity_pubkey == "02e224b845f89d2f3c23ec12855071f4ca08c960c858193ee8df08d705f32c9c75"
  '

SATSCOUT_WAVELENGTH_REST_URL="$WAVE_REST_URL" \
SATSCOUT_WAVELENGTH_MACAROON_PATH="$WAVE_MACAROON" \
SATSCOUT_LIVE_SPEND=false \
SATSCOUT_ALLOW_MAINNET_SPEND=false \
pnpm cli wavelength status --network mainnet --json |
  jq -e '
    .readiness == "READY" and
    .version == "0.1.2-rc4" and
    .commit == "94cf9a0" and
    .network == "mainnet" and
    .walletState == "WALLET_STATE_READY" and
    .serverConnected == true and
    .identityPubkey == "02e224b845f89d2f3c23ec12855071f4ca08c960c858193ee8df08d705f32c9c75" and
    .operatorConstraints.dustLimitSat == 1000 and
    .operatorConstraints.minBoardingAmountSat == 1000 and
    .operatorConstraints.maxVtxoAmountSat == 50000 and
    .operatorConstraints.minOperatorFeeSat == 1000 and
    .operatorConstraints.minVtxoAmountSat == 1000 and
    .operatorConstraints.maxUserBalanceSat == 300000
  '
```

Expected: `wavecli --version` reports `0.1.2-rc4`; both `jq` checks exit zero; SatScout reports `READY`; the wallet's balances and activity remain unchanged; and no `PrepareSend` or `Send` request appears in the Wavelength logs. This remains the read-only 06C/Stage A Wavelength check. Gift-card inspect may repeat it; it still must not create a Bitrefill invoice or call `Send`.
