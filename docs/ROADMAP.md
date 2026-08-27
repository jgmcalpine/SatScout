# Roadmap

SatScout is split into ten deliberately bounded chunks. Mission type is workflow context (`book-campsite` or `acquire-digital-product`); Permit grants remain the only economic authority.

- [x] 01 Foundation
- [x] 02 Recreation.gov observation
- [x] 03 Verified cart capture
- [x] 04 Generic Permit + Authorization Engine
- [x] 05 Wavelength Signet
- [x] 06 Bitrefill REST Instrument Adapter
- [x] 06B Narrow Bitrefill MCP Prepayment Adapter
- [x] 06C Wavelength mainnet hardening
- [x] 07 Bounded Bitrefill gift-card acquisition
- [ ] 08 Recreation.gov checkout preparation
- [ ] 09 Supervised end-to-end booking
- [ ] 10 Camply trigger + hardening

**Completed:** campsite observation/cart (Chunks 01–03), generic Permit engine (04), Wavelength Signet (05), Bitrefill instrument integration (06), Wavelength mainnet prepare (06C), and bounded gift-card acquisition (07).

**Current MVP:** supervised bounded digital-product purchase (`acquire-digital-product` + Permit grants + Bitrefill Personal REST + one Wavelength mainnet Send).

**Parked:** prepaid Visa MCP prepayment (06B).

**Later demonstration:** Recreation.gov checkout/booking (`book-campsite` MerchantAdapter; Chunks 08–10).

Chunk 03 preserves deliberate, read-only observation and adds one separately authorized write: add the exact freshly verified Mission target to an empty Recreation.gov cart and independently verify the temporary hold. A combined read-only readiness command checks observation plus structured cart evidence. Live capture repeats those checks in one browser session, crosses an application-owned durable `CARTING` commit barrier before Add to Cart, and verifies a fresh structured cart response against rendered UI. Ambiguous outcomes are never blindly retried, and read-only reconciliation is available after a restart.

Chunk 03 does not advance beyond the cart, complete a reservation, remove cart items, handle payment information, evaluate Permit spending, or activate `SATSCOUT_LIVE_SPEND`. Later chunks must preserve these boundaries unless their own explicitly reviewed scope changes them.

Chunk 04 adds the reusable bounded-authority model: Permit v2 with typed economic grants, ActionRequest vs ResolvedAction, three-state Permit evaluation, atomic Authorization with a ledger-derived usage reservation, and a Spend Controller boundary. Simulation is flag-gated and labeled.

Chunk 05 adds the first real funding adapter: a loopback-only Wavelength Signet REST client. SatScout can move Signet value only after PrepareSend, Permit ALLOW, atomic Authorization, a durable EXECUTING transition, and a single intent-only Send. Mainnet, Bitrefill, prepaid cards, and Recreation.gov checkout remain out of scope.

Chunk 06 adds the first `InstrumentAdapter`: a Personal REST Bitrefill client that independently resolves product facts, authorizes `payment-instrument.acquire`, and can create one unpaid Lightning invoice. It does not pay, call Wavelength, use Bitrefill balance, or complete Recreation.gov checkout. Personal REST does not document the prepaid-Visa prepayment/`bill_payment_id` flow described by MCP; that gap is reported rather than bypassed.

Chunk 06B adds a **narrow** programmatic Bitrefill eCommerce MCP client under the Spend Controller. It may invoke only `get-product-details` and `submit-prepayment-step` to produce a tightly bound `InstrumentPrepaymentBinding`. It is not an MCP server exposed to the agent, not a generic commerce API, and it cannot call `buy-products` or `search-products`. Product selection remains Permit-bound. MCP `get-product-details` is authoritative for that exact product because Personal REST and MCP catalogs may differ. Production MCP uses Bearer auth at exactly `https://api.bitrefill.com/mcp`. No product is purchased. No Bitcoin moves. Prepayment does not consume a Permit execution slot. **Chunk 06B remains parked.** The current MVP does not use prepaid Visa, MCP prepayment, or `buy-products`.

Chunk 06C hardens Wavelength **mainnet** as a trusted, prepare-first `FundingAdapter`. Readiness requires official `0.1.2-rc4` (commit `94cf9a0`), `network=mainnet`, `WALLET_STATE_READY`, `server_connected=true`, trusted `server_info`, and SatScout hard ceilings (wallet 100k / principal 25k / fee 2k / total outflow 27k sats). Generic CLI/agent mainnet Send remains unavailable.

Chunk 07 is the **current MVP**: an agent may autonomously acquire **one exact merchant-specific digital gift card** with real Bitcoin, only inside narrowly bounded Permit authority. The first real-world proof is no longer Recreation.gov campsite booking or prepaid Visa. Ordinary Bitrefill gift cards use Personal REST (`GET /products/{id}`, `POST /invoices` with `payment_method=lightning` and `auto_pay=false`, `GET /invoices/{id}`, `GET /orders/{id}`). SatScout evaluates `payment-instrument.acquire` before creating an invoice, binds the exact Lightning payment, authorizes a parent acquire plus a child `value.transfer`, and may call Wavelength mainnet Send **once** only through that integrated path. Face value, Bitrefill price, Lightning principal, fee, and total outflow stay independent integer dimensions. Campsite booking remains a future MerchantAdapter demonstration.

Rationale for the pivot: it isolates Permit's economic-authority model, is cheaper to test with real money, has fewer external workflow variables, and has no card-entry/browser or prepaid-Visa prepayment dependency.
