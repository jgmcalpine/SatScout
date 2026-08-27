import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DatabaseSync } from "node:sqlite";

import { DomainValidationError } from "../src/domain/validation.js";
import { migrations } from "../src/persistence/migrations.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { fixedNow, validAcquisitionMission, validMission, validPermit } from "./fixtures.js";

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-test-"));
  return { directory, path: join(directory, "state.sqlite") };
}

function openStore(path: string): SatScoutStore {
  const store = new SatScoutStore(path, { clock: () => fixedNow });
  store.initialize();
  return store;
}

describe("SQLite persistence and audit history", () => {
  it("survives a complete close and reopen with workflow state intact", () => {
    const temporary = temporaryDatabase();
    let store = openStore(temporary.path);
    try {
      store.createMission(validMission());
      store.createPermit(validPermit());
      store.createAttempt("mission-1", "attempt-1");
      store.transitionAttempt("attempt-1", "AVAILABLE");
      store.close();

      store = openStore(temporary.path);
      expect(store.getMission("mission-1")).toEqual(validMission());
      expect(store.getPermitForMission("mission-1")).toEqual(validPermit());
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
      expect(store.getAuditEvents("mission-1").map((event) => event.type)).toEqual([
        "MISSION_CREATED",
        "PERMIT_CREATED",
        "ATTEMPT_CREATED",
        "WORKFLOW_TRANSITIONED",
      ]);
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("orders a complete history including rejected transitions without corrupting state", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      store.createMission(validMission());
      store.createPermit(validPermit());
      store.createAttempt("mission-1", "attempt-1");
      store.transitionAttempt("attempt-1", "AVAILABLE");
      store.transitionAttempt("attempt-1", "CARTING");
      const rejection = store.transitionAttempt("attempt-1", "PAYMENT_AUTHORIZED");

      expect(rejection.outcome).toBe("rejected");
      expect(store.getAttempt("attempt-1")?.state).toBe("CARTING");
      const events = store.getAuditEvents("mission-1");
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(events.at(-1)).toMatchObject({
        type: "WORKFLOW_TRANSITION_REJECTED",
        previousState: "CARTING",
        newState: "PAYMENT_AUTHORIZED",
        metadata: { code: "ILLEGAL_TRANSITION" },
      });
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("records duplicate transition delivery as an audited idempotent no-op", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      store.createMission(validMission());
      store.createAttempt("mission-1", "attempt-1");
      store.transitionAttempt("attempt-1", "AVAILABLE");
      const duplicate = store.transitionAttempt("attempt-1", "AVAILABLE");

      expect(duplicate.outcome).toBe("idempotent");
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
      expect(store.getAuditEvents("mission-1").at(-1)?.type).toBe(
        "WORKFLOW_TRANSITION_DUPLICATE",
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("rolls state back if its audit event cannot be inserted", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      store.createMission(validMission(), { auditEventId: "forced-collision" });
      store.createAttempt("mission-1", "attempt-1");

      expect(() =>
        store.transitionAttempt("attempt-1", "AVAILABLE", {
          auditEventId: "forced-collision",
        }),
      ).toThrow(/UNIQUE constraint failed/iu);
      expect(store.getAttempt("attempt-1")?.state).toBe("WAITING");
      expect(store.getAuditEvents("mission-1")).toHaveLength(2);
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("persists the exact cart reconciliation target with CARTING", () => {
    const temporary = temporaryDatabase();
    let store = openStore(temporary.path);
    try {
      store.createMission(validMission());
      store.createAttempt("mission-1", "attempt-1");
      store.transitionAttempt("attempt-1", "AVAILABLE");
      store.beginCartCapture(
        "attempt-1",
        {
          provider: "RECREATION_GOV",
          campgroundId: "fictional-campground",
          siteId: "site-47",
          arrival: "2027-09-04",
          departure: "2027-09-07",
        },
        { selectedSiteId: "site-47" },
      );
      store.close();

      store = openStore(temporary.path);
      expect(store.getAttempt("attempt-1")).toMatchObject({
        state: "CARTING",
        cartTarget: {
          provider: "RECREATION_GOV",
          campgroundId: "fictional-campground",
          siteId: "site-47",
          arrival: "2027-09-04",
          departure: "2027-09-07",
        },
      });
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("rolls CARTING and its target back when the cart-start audit insert fails", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      store.createMission(validMission(), { auditEventId: "forced-collision" });
      store.createAttempt("mission-1", "attempt-1");
      store.transitionAttempt("attempt-1", "AVAILABLE");
      expect(() =>
        store.beginCartCapture(
          "attempt-1",
          {
            provider: "RECREATION_GOV",
            campgroundId: "fictional-campground",
            siteId: "site-47",
            arrival: "2027-09-04",
            departure: "2027-09-07",
          },
          {},
          { cartAuditEventId: "forced-collision" },
        ),
      ).toThrow(/UNIQUE constraint failed/iu);
      expect(store.getAttempt("attempt-1")).toMatchObject({
        state: "AVAILABLE",
      });
      expect(store.getAttempt("attempt-1")?.cartTarget).toBeUndefined();
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("keeps CARTING when the hold-verification audit transaction fails", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      store.createMission(validMission(), { auditEventId: "forced-collision" });
      store.createAttempt("mission-1", "attempt-1");
      store.transitionAttempt("attempt-1", "AVAILABLE");
      store.beginCartCapture(
        "attempt-1",
        {
          provider: "RECREATION_GOV",
          campgroundId: "fictional-campground",
          siteId: "site-47",
          arrival: "2027-09-04",
          departure: "2027-09-07",
        },
        {},
      );
      expect(() =>
        store.completeCartCapture(
          "attempt-1",
          { status: "EXACT_MATCH" },
          false,
          { verifiedAuditEventId: "forced-collision" },
        ),
      ).toThrow(/UNIQUE constraint failed/iu);
      expect(store.getAttempt("attempt-1")?.state).toBe("CARTING");
      expect(store.getAuditEvents("mission-1").at(-1)?.type).toBe(
        "RECREATION_CART_ACTION_STARTED",
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("enforces uniqueness without adding an orphan audit event", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      store.createMission(validMission());
      expect(() => store.createMission(validMission())).toThrow(/UNIQUE constraint failed/iu);
      expect(store.getAuditEvents("mission-1")).toHaveLength(1);
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("rejects an expired Permit for an active Mission", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      store.createMission(validMission());
      expect(() =>
        store.createPermit(
          validPermit({
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: fixedNow,
          }),
        ),
      ).toThrow(DomainValidationError);
      expect(store.getPermitForMission("mission-1")).toBeUndefined();
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("rejects creation of a Mission that is active but already expired", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      expect(() =>
        store.createMission(
          validMission({
            createdAt: "2026-08-01T00:00:00.000Z",
            activatedAt: "2026-08-01T00:01:00.000Z",
            expiresAt: fixedNow,
          }),
        ),
      ).toThrow(DomainValidationError);
      expect(store.getMission("mission-1")).toBeUndefined();
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("persists PurchaseIntent, Payment, and Reservation records with relationships", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      store.createMission(validMission());
      store.createAttempt("mission-1", "attempt-1");
      const intent = {
        id: "intent-1",
        missionId: "mission-1",
        attemptId: "attempt-1",
        merchant: "bitrefill",
        product: "prepaid-visa-usa",
        requestedUsdCents: 7_300,
        expectedSats: 110_000,
        expectedFeeSats: 50,
        status: "APPROVED",
        createdAt: fixedNow,
      } as const;
      const payment = {
        id: "payment-1",
        missionId: "mission-1",
        attemptId: "attempt-1",
        purchaseIntentId: "intent-1",
        status: "PREPARED",
        amountSats: 110_000,
        feeSats: 50,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      } as const;
      const reservation = {
        id: "reservation-1",
        missionId: "mission-1",
        attemptId: "attempt-1",
        provider: "fictional-provider",
        status: "PENDING",
        createdAt: fixedNow,
        updatedAt: fixedNow,
      } as const;

      store.createPurchaseIntent(intent);
      store.createPayment(payment);
      store.createReservation(reservation);

      expect(store.getPurchaseIntent("intent-1")).toEqual(intent);
      expect(store.getPayment("payment-1")).toEqual(payment);
      expect(store.getReservation("reservation-1")).toEqual(reservation);
      expect(store.countApprovedPurchaseIntents("mission-1")).toBe(1);
      expect(store.getAuditEvents("mission-1").slice(-3).map((event) => event.type)).toEqual([
        "PURCHASE_INTENT_CREATED",
        "PAYMENT_CREATED",
        "RESERVATION_CREATED",
      ]);
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("round-trips both Mission types and keeps existing book-campsite rows readable", () => {
    const temporary = temporaryDatabase();
    const store = openStore(temporary.path);
    try {
      expect(store.schemaVersion()).toBe(7);
      store.createMission(validMission());
      store.createMission(validAcquisitionMission({ id: "mission-acquire" }));
      expect(store.getMission("mission-1")).toEqual(validMission());
      expect(store.getMission("mission-acquire")).toEqual(
        validAcquisitionMission({ id: "mission-acquire" }),
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("migrates a schema-6 book-campsite row without rewriting its type", () => {
    const temporary = temporaryDatabase();
    const database = new DatabaseSync(temporary.path);
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
      for (const migration of migrations) {
        if (migration.version > 6) {
          continue;
        }
        database.exec(migration.sql);
        database
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, fixedNow);
      }
      const mission = validMission();
      database
        .prepare(
          `INSERT INTO missions
            (id, type, status, created_at, activated_at, expires_at, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mission.id,
          mission.type,
          mission.status,
          mission.createdAt,
          mission.activatedAt ?? null,
          mission.expiresAt,
          JSON.stringify(mission),
        );
    } finally {
      database.close();
    }

    const store = openStore(temporary.path);
    try {
      expect(store.schemaVersion()).toBe(7);
      expect(store.getMission("mission-1")).toEqual(validMission());
      store.createMission(validAcquisitionMission({ id: "mission-acquire" }));
      expect(store.getMission("mission-acquire")?.type).toBe("acquire-digital-product");
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});
