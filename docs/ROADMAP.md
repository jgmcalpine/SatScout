# Roadmap

SatScout is split into ten deliberately bounded chunks. Only the first is implemented in this repository state.

1. **Foundation — complete.** Validated domain records, explicit workflow, deterministic Permit evaluation, SQLite persistence, audit history, safe configuration/logging, CLI, tests, and documentation.
2. **Recreation.gov observation — not started.** Observe availability without carting or purchasing.
3. **Cart capture — not started.** Introduce bounded cart acquisition and hold-state behavior.
4. **Permit/spend controller hardening — not started.** Harden authorization, accounting, idempotency, and failure recovery around economic actions.
5. **Wavelength Signet — not started.** Integrate a test-network wallet path only after controller boundaries are proven.
6. **Bitrefill adapter — not started.** Add a merchant adapter behind the deterministic controller.
7. **First real bounded purchase — not started.** Exercise a narrowly supervised real purchase with explicit safeguards.
8. **Recreation.gov checkout preparation — not started.** Prepare checkout data and recovery behavior without autonomous completion.
9. **Supervised end-to-end booking — not started.** Connect the bounded flow under human supervision.
10. **Camply trigger + hardening — not started.** Add event triggers, operational hardening, and production-oriented recovery.

Later chunks must continue honoring `SATSCOUT_LIVE_BOOKING` and `SATSCOUT_LIVE_SPEND`. A switch value alone must never bypass Permit evaluation or other deterministic safety boundaries.
