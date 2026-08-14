# Roadmap

SatScout is split into ten deliberately bounded chunks.

- [x] 01 Foundation
- [x] 02 Recreation.gov observation
- [x] 03 Verified cart capture
- [x] 04 Generic Permit + Authorization Engine
- [ ] 05 Wavelength Signet
- [ ] 06 Bitrefill adapter
- [ ] 07 First real bounded purchase
- [ ] 08 Recreation.gov checkout preparation
- [ ] 09 Supervised end-to-end booking
- [ ] 10 Camply trigger + hardening

Chunk 03 preserves deliberate, read-only observation and adds one separately authorized write: add the exact freshly verified Mission target to an empty Recreation.gov cart and independently verify the temporary hold. A combined read-only readiness command checks observation plus structured cart evidence. Live capture repeats those checks in one browser session, crosses an application-owned durable `CARTING` commit barrier before Add to Cart, and verifies a fresh structured cart response against rendered UI. Ambiguous outcomes are never blindly retried, and read-only reconciliation is available after a restart.

Chunk 03 does not advance beyond the cart, complete a reservation, remove cart items, handle payment information, evaluate Permit spending, or activate `SATSCOUT_LIVE_SPEND`. Later chunks must preserve these boundaries unless their own explicitly reviewed scope changes them.

Chunk 04 adds the reusable bounded-authority model: Permit v2 with typed economic grants, ActionRequest vs ResolvedAction, three-state Permit evaluation, atomic Authorization with a ledger-derived usage reservation, and a Spend Controller boundary. Simulation is flag-gated and labeled. No wallet, invoice, card, or payment execution exists. Chunk 05 must not begin until this model is accepted.
