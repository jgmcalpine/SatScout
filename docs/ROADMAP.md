# Roadmap

SatScout is split into ten deliberately bounded chunks.

- [x] 01 Foundation
- [x] 02 Recreation.gov observation
- [x] 03 Verified cart capture
- [x] 04 Generic Permit + Authorization Engine
- [x] 05 Wavelength Signet
- [x] 06 Bitrefill REST Instrument Adapter
- [x] 06B Narrow Bitrefill MCP Prepayment Adapter
- [ ] 06C Wavelength mainnet hardening
- [ ] 07 First real bounded purchase
- [ ] 08 Recreation.gov checkout preparation
- [ ] 09 Supervised end-to-end booking
- [ ] 10 Camply trigger + hardening

Chunk 03 preserves deliberate, read-only observation and adds one separately authorized write: add the exact freshly verified Mission target to an empty Recreation.gov cart and independently verify the temporary hold. A combined read-only readiness command checks observation plus structured cart evidence. Live capture repeats those checks in one browser session, crosses an application-owned durable `CARTING` commit barrier before Add to Cart, and verifies a fresh structured cart response against rendered UI. Ambiguous outcomes are never blindly retried, and read-only reconciliation is available after a restart.

Chunk 03 does not advance beyond the cart, complete a reservation, remove cart items, handle payment information, evaluate Permit spending, or activate `SATSCOUT_LIVE_SPEND`. Later chunks must preserve these boundaries unless their own explicitly reviewed scope changes them.

Chunk 04 adds the reusable bounded-authority model: Permit v2 with typed economic grants, ActionRequest vs ResolvedAction, three-state Permit evaluation, atomic Authorization with a ledger-derived usage reservation, and a Spend Controller boundary. Simulation is flag-gated and labeled.

Chunk 05 adds the first real funding adapter: a loopback-only Wavelength Signet REST client. SatScout can move Signet value only after PrepareSend, Permit ALLOW, atomic Authorization, a durable EXECUTING transition, and a single intent-only Send. Mainnet, Bitrefill, prepaid cards, and Recreation.gov checkout remain out of scope.

Chunk 06 adds the first `InstrumentAdapter`: a Personal REST Bitrefill client that independently resolves product facts, authorizes `payment-instrument.acquire`, and can create one unpaid Lightning invoice. It does not pay, call Wavelength, use Bitrefill balance, or complete Recreation.gov checkout. Personal REST does not document the prepaid-Visa prepayment/`bill_payment_id` flow described by MCP; that gap is reported rather than bypassed.

Chunk 06B adds a **narrow** programmatic Bitrefill eCommerce MCP client under the Spend Controller. It may invoke only `get-product-details` and `submit-prepayment-step` to produce a tightly bound `InstrumentPrepaymentBinding`. It is not an MCP server exposed to the agent, not a generic commerce API, and it cannot call `buy-products` or `search-products`. Product selection remains Permit-bound. MCP `get-product-details` is authoritative for that exact product because Personal REST and MCP catalogs may differ. Production MCP uses Bearer auth at exactly `https://api.bitrefill.com/mcp`. No product is purchased. No Bitcoin moves. Prepayment does not consume a Permit execution slot. Chunk 07 will create the acquisition Authorization immediately before any purchase.
