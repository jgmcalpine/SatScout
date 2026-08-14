# Roadmap

SatScout is split into ten deliberately bounded chunks.

- [x] 01 Foundation
- [x] 02 Recreation.gov observation
- [ ] 03 Cart capture
- [ ] 04 Permit/spend controller hardening
- [ ] 05 Wavelength Signet
- [ ] 06 Bitrefill adapter
- [ ] 07 First real bounded purchase
- [ ] 08 Recreation.gov checkout preparation
- [ ] 09 Supervised end-to-end booking
- [ ] 10 Camply trigger + hardening

Chunk 02 adds deliberate, read-only campsite observation, manual session setup, fail-closed target/date/availability interpretation, challenge detection, and sanitized auditing. It does not add reservation-changing behavior.

Later chunks must continue honoring `SATSCOUT_LIVE_BOOKING` and `SATSCOUT_LIVE_SPEND`. A switch value alone must never bypass Permit evaluation or other deterministic safety boundaries.
