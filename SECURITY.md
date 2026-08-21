# Security Policy

SatScout is experimental software for **bounded economic authority** and Recreation.gov observation/cart capture. It is under active development. Treat all releases as pre-production unless explicitly stated otherwise.

## Reporting a vulnerability

If you believe you have found a security issue in this repository, please report it privately.

**Email:** [j.g.mcalpine@gmail.com](mailto:j.g.mcalpine@gmail.com)

Please include:

- A clear description of the issue and why you believe it is a security problem
- Steps to reproduce, including SatScout version or commit hash
- Impact you believe it has (confidentiality, integrity, availability, or economic authority)
- Any proof-of-concept you can share safely (no real credentials, invoices, card data, or live financial account details)

Do not open a public GitHub issue for undisclosed security vulnerabilities.

### What we need from you

- Good-faith reports that describe a reproducible flaw in SatScout itself
- Reports that distinguish **bug** vs **intended fail-closed behavior** (see below)
- Patience while the report is triaged; this is a small open-source project

### Out of scope

The following are generally **not** treated as SatScout vulnerabilities:

- Issues in third-party sites (Recreation.gov, merchant checkout pages, wallet daemons not yet integrated)
- Social engineering, phishing, or physical access to a user's machine
- Misconfiguration by the operator (for example, committing `.local/browser/`, SQLite databases, or `/tmp` test artifacts)
- Expected fail-closed outcomes documented in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), such as `DENY`, `INDETERMINATE`, rejected workflow transitions, or refusal to release authority after `EXECUTING`
- Absence of paying a Bitrefill invoice, prepaid-card delivery, or Recreation.gov checkout (Chunk 06 stops at an unpaid invoice)
- Bitrefill Personal REST not documenting the MCP prepaid-Visa prepayment/`bill_payment_id` flow (reported, not bypassed)
- Findings that require the reporter to already control the same OS user account and process as SatScout (TypeScript module boundaries are not a hard isolation boundary today)
- The Wavelength daemon macaroon granting broader wallet RPCs than SatScout's four-route client (dedicated Signet wallet + small balance is the blast-radius ceiling)
- The Bitrefill Personal API key granting purchase creation independently of SatScout policy if used outside this adapter (owner-only key file + unpaid-invoice gate is the blast-radius ceiling)

Reports about **future** wallet or payment adapters should describe a concrete flaw in current code paths or contracts that would make a later integration unsafe by default.

## Response

You should receive an acknowledgment within a reasonable time. Critical issues affecting confidentiality of operator data or incorrect economic authorization will be prioritized. We will work with you on verification, fix, and coordinated disclosure when appropriate.

There is no bug bounty program at this time.

## Supported versions

Only the latest commit on the default branch receives security fixes. Earlier tagged releases may not be maintained.

## Security model (summary)

SatScout separates **untrusted intent** from **trusted authorization**:

```text
ActionRequest   (untrusted; never executable)
      →
Spend Controller
      →
ResolvedAction  (trusted or explicitly simulated evidence)
      →
Permit Engine   (ALLOW / DENY / INDETERMINATE)
      →
Authorization   (reserves authority; not a wallet credential)
```

Important properties:

- A **Permit** describes authority; it does not grant access to funds.
- An **Authorization** reserves authority for one exact resolved action; it is not a payment credential.
- Preview evaluation does not reserve authority.
- `SATSCOUT_LIVE_SPEND` is necessary but not sufficient for a Wavelength Signet Send.
- `SATSCOUT_ALLOW_SIMULATED_SPEND` enables labeled simulation only; it still moves no money.
- `SATSCOUT_ALLOW_SIGNET_TEST_SPEND` and `--confirm-signet-spend` are additional Send gates.
- `SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE` and `--confirm-bitrefill-invoice` are additional unpaid-invoice gates; they do not pay.

Full trust zones, threat list, and safe-release rules: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).  
Architecture boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Operator responsibilities

SatScout stores sensitive local state on disk. Operators are responsible for:

| Asset | Location (default) | Guidance |
| --- | --- | --- |
| Recreation.gov session | `./.local/browser/recreation-gov` | Gitignored; contains cookies/session state. Never commit or share. |
| Mission / Permit / Authorization data | `./data/satscout.sqlite` (or `SATSCOUT_DB_PATH`) | Local-only; may contain mission identifiers and authorization history. |
| Audit logs | Same SQLite database | Sanitized, but treat as sensitive operational evidence. |
| Wavelength macaroon | `SATSCOUT_WAVELENGTH_MACAROON_PATH` | Local file; never commit. Restrict permissions to owner-only. |
| Signet invoice files | `/tmp` (operator-chosen) | Delete after testing. Do not pass invoices as shell arguments. |
| Bitrefill Personal API key | `SATSCOUT_BITREFILL_API_KEY_PATH` (recommend `./.local/bitrefill/api-key`) | Purchasing authority. Gitignored. Owner-only permissions. Never CLI arguments, logs, or audit. |

SatScout rejects normal personal Chrome/Chromium profile paths and restricts repository-local browser profiles to `.local/`. Do not point SatScout at a profile you use for everyday browsing.

Live cart capture requires explicit operator gates (`SATSCOUT_LIVE_BOOKING=true` and `--confirm-live-cart`). SatScout does not enter credentials on Recreation.gov; login is manual in a dedicated browser window.

## Safe disclosure when testing

When reproducing issues:

- Use fictional Mission/Permit examples from `examples/`
- Do not include real invoices, BOLT11 strings, card numbers, macaroons, seeds, Bitrefill API keys, redemption codes, or personal form values in reports or public issues
- Do not test against production Recreation.gov inventory you do not own or against Bitcoin mainnet

## Automated dependency review

Dependencies are pinned in `pnpm-lock.yaml`. Run `pnpm audit` locally and report supply-chain issues that affect SatScout's runtime or install scripts. The project uses pnpm lifecycle-script protections; do not request disabling them without a documented reason.
