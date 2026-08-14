import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AuditEvent, AuditEventType } from "../audit/audit-event.js";
import { parseAuditEvent } from "../audit/audit-event.js";
import type { BookingAttempt } from "../domain/booking/booking-attempt.js";
import { parseBookingAttempt } from "../domain/booking/booking-attempt.js";
import type { Mission } from "../domain/mission/mission.js";
import {
  assertActiveMissionIsNotExpired,
  assertMissionCanAcceptPermit,
  parseMission,
} from "../domain/mission/mission.js";
import type { Payment } from "../domain/payment/payment.js";
import { parsePayment } from "../domain/payment/payment.js";
import type { Permit } from "../domain/permit/permit.js";
import { assertPermitMatchesMission, parsePermit } from "../domain/permit/permit.js";
import type { PurchaseIntent } from "../domain/purchase/purchase-intent.js";
import { parsePurchaseIntent } from "../domain/purchase/purchase-intent.js";
import type { Reservation } from "../domain/reservation/reservation.js";
import { parseReservation } from "../domain/reservation/reservation.js";
import type { WorkflowState, WorkflowTransitionResult } from "../domain/workflow/workflow.js";
import { transitionWorkflow } from "../domain/workflow/workflow.js";
import { redactSensitive } from "../logging/redaction.js";
import { migrations } from "./migrations.js";

interface JsonRow {
  readonly data_json: string;
}

interface AuditRow {
  readonly sequence: number;
  readonly id: string;
  readonly timestamp: string;
  readonly type: string;
  readonly mission_id: string;
  readonly attempt_id: string | null;
  readonly previous_state: string | null;
  readonly new_state: string | null;
  readonly metadata_json: string;
}

export interface StoreOptions {
  readonly clock?: () => string;
  readonly idFactory?: () => string;
}

export interface AuditOptions {
  readonly auditEventId?: string;
}

export class EntityNotFoundError extends Error {
  public constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`);
    this.name = "EntityNotFoundError";
  }
}

export class SatScoutStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => string;
  readonly #idFactory: () => string;

  public constructor(databasePath: string, options: StoreOptions = {}) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    if (databasePath !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#database.exec("PRAGMA synchronous = FULL;");
    }
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  public initialize(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const current = this.#database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { readonly version: number };

    for (const migration of migrations) {
      if (migration.version <= current.version) {
        continue;
      }
      this.#transaction(() => {
        this.#database.exec(migration.sql);
        this.#database
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, this.#clock());
      });
    }
  }

  public close(): void {
    this.#database.close();
  }

  public schemaVersion(): number {
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { readonly version: number };
    return row.version;
  }

  public createMission(input: unknown, options: AuditOptions = {}): Mission {
    const mission = parseMission(input);
    const timestamp = this.#clock();
    assertActiveMissionIsNotExpired(mission, timestamp);
    this.#transaction(() => {
      this.#database
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
      this.#appendAudit({
        id: options.auditEventId ?? this.#idFactory(),
        timestamp,
        type: "MISSION_CREATED",
        missionId: mission.id,
        metadata: { missionType: mission.type, status: mission.status },
      });
    });
    return mission;
  }

  public getMission(id: string): Mission | undefined {
    return this.#getJson("SELECT data_json FROM missions WHERE id = ?", id, parseMission);
  }

  public listMissions(): readonly Mission[] {
    return this.#allJson(
      "SELECT data_json FROM missions ORDER BY created_at ASC, id ASC",
      parseMission,
    );
  }

  public createPermit(input: unknown, options: AuditOptions = {}): Permit {
    const permit = parsePermit(input);
    const mission = this.getMission(permit.missionId);
    if (mission === undefined) {
      throw new EntityNotFoundError("Mission", permit.missionId);
    }
    assertPermitMatchesMission(permit, mission);
    assertMissionCanAcceptPermit(mission, permit.expiresAt, this.#clock());

    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO permits (id, mission_id, created_at, expires_at, data_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(permit.id, permit.missionId, permit.createdAt, permit.expiresAt, JSON.stringify(permit));
      this.#appendAudit({
        id: options.auditEventId ?? this.#idFactory(),
        timestamp: this.#clock(),
        type: "PERMIT_CREATED",
        missionId: permit.missionId,
        metadata: {
          permitId: permit.id,
          purpose: permit.purpose,
          expiresAt: permit.expiresAt,
          spending: permit.spending,
        },
      });
    });
    return permit;
  }

  public getPermitForMission(missionId: string): Permit | undefined {
    return this.#getJson(
      "SELECT data_json FROM permits WHERE mission_id = ?",
      missionId,
      parsePermit,
    );
  }

  public createAttempt(missionId: string, id: string = this.#idFactory()): BookingAttempt {
    if (this.getMission(missionId) === undefined) {
      throw new EntityNotFoundError("Mission", missionId);
    }
    const timestamp = this.#clock();
    const attempt = parseBookingAttempt({
      id,
      missionId,
      state: "WAITING",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO booking_attempts
            (id, mission_id, state, created_at, updated_at, data_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, missionId, attempt.state, timestamp, timestamp, JSON.stringify(attempt));
      this.#appendAudit({
        id: this.#idFactory(),
        timestamp,
        type: "ATTEMPT_CREATED",
        missionId,
        attemptId: id,
        newState: "WAITING",
        metadata: {},
      });
    });
    return attempt;
  }

  public getAttempt(id: string): BookingAttempt | undefined {
    return this.#getJson(
      "SELECT data_json FROM booking_attempts WHERE id = ?",
      id,
      parseBookingAttempt,
    );
  }

  public transitionAttempt(
    attemptId: string,
    requestedState: WorkflowState,
    options: AuditOptions = {},
  ): WorkflowTransitionResult {
    const attempt = this.getAttempt(attemptId);
    if (attempt === undefined) {
      throw new EntityNotFoundError("BookingAttempt", attemptId);
    }
    const result = transitionWorkflow(attempt.state, requestedState);
    const timestamp = this.#clock();

    this.#transaction(() => {
      if (result.outcome === "transitioned") {
        const updatedAttempt: BookingAttempt = {
          ...attempt,
          state: result.newState,
          updatedAt: timestamp,
        };
        const update = this.#database
          .prepare(
            `UPDATE booking_attempts
             SET state = ?, updated_at = ?, data_json = ?
             WHERE id = ? AND state = ?`,
          )
          .run(
            result.newState,
            timestamp,
            JSON.stringify(updatedAttempt),
            attemptId,
            result.previousState,
          );
        if (update.changes !== 1) {
          throw new Error(`Concurrent workflow update detected for BookingAttempt ${attemptId}`);
        }
        this.#appendAudit({
          id: options.auditEventId ?? this.#idFactory(),
          timestamp,
          type: "WORKFLOW_TRANSITIONED",
          missionId: attempt.missionId,
          attemptId,
          previousState: result.previousState,
          newState: result.newState,
          metadata: {},
        });
        return;
      }

      if (result.outcome === "idempotent") {
        this.#appendAudit({
          id: options.auditEventId ?? this.#idFactory(),
          timestamp,
          type: "WORKFLOW_TRANSITION_DUPLICATE",
          missionId: attempt.missionId,
          attemptId,
          previousState: result.previousState,
          newState: result.newState,
          metadata: { reason: result.reason },
        });
        return;
      }

      this.#appendAudit({
        id: options.auditEventId ?? this.#idFactory(),
        timestamp,
        type: "WORKFLOW_TRANSITION_REJECTED",
        missionId: attempt.missionId,
        attemptId,
        previousState: result.previousState,
        newState: result.requestedState,
        metadata: { code: result.code, reason: result.reason },
      });
    });

    return result;
  }

  public createPurchaseIntent(input: unknown): PurchaseIntent {
    const intent = parsePurchaseIntent(input);
    this.#assertAttemptRelationship(intent.attemptId, intent.missionId);
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO purchase_intents
            (id, mission_id, attempt_id, status, created_at, data_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intent.id,
          intent.missionId,
          intent.attemptId,
          intent.status,
          intent.createdAt,
          JSON.stringify(intent),
        );
      this.#appendAudit({
        id: this.#idFactory(),
        timestamp: this.#clock(),
        type: "PURCHASE_INTENT_CREATED",
        missionId: intent.missionId,
        attemptId: intent.attemptId,
        metadata: {
          purchaseIntentId: intent.id,
          merchant: intent.merchant,
          product: intent.product,
          requestedUsdCents: intent.requestedUsdCents,
          expectedSats: intent.expectedSats,
          expectedFeeSats: intent.expectedFeeSats,
          status: intent.status,
        },
      });
    });
    return intent;
  }

  public getPurchaseIntent(id: string): PurchaseIntent | undefined {
    return this.#getJson(
      "SELECT data_json FROM purchase_intents WHERE id = ?",
      id,
      parsePurchaseIntent,
    );
  }

  public countApprovedPurchaseIntents(missionId: string): number {
    const row = this.#database
      .prepare(
        "SELECT COUNT(*) AS count FROM purchase_intents WHERE mission_id = ? AND status = 'APPROVED'",
      )
      .get(missionId) as { readonly count: number };
    return row.count;
  }

  public createPayment(input: unknown): Payment {
    const payment = parsePayment(input);
    this.#assertAttemptRelationship(payment.attemptId, payment.missionId);
    const intent = this.getPurchaseIntent(payment.purchaseIntentId);
    if (intent === undefined) {
      throw new EntityNotFoundError("PurchaseIntent", payment.purchaseIntentId);
    }
    if (intent.missionId !== payment.missionId || intent.attemptId !== payment.attemptId) {
      throw new Error("Payment must reference a PurchaseIntent from the same Mission and BookingAttempt");
    }
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO payments
            (id, mission_id, attempt_id, purchase_intent_id, status, created_at, updated_at, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payment.id,
          payment.missionId,
          payment.attemptId,
          payment.purchaseIntentId,
          payment.status,
          payment.createdAt,
          payment.updatedAt,
          JSON.stringify(payment),
        );
      this.#appendAudit({
        id: this.#idFactory(),
        timestamp: this.#clock(),
        type: "PAYMENT_CREATED",
        missionId: payment.missionId,
        attemptId: payment.attemptId,
        metadata: {
          paymentId: payment.id,
          purchaseIntentId: payment.purchaseIntentId,
          status: payment.status,
        },
      });
    });
    return payment;
  }

  public getPayment(id: string): Payment | undefined {
    return this.#getJson("SELECT data_json FROM payments WHERE id = ?", id, parsePayment);
  }

  public createReservation(input: unknown): Reservation {
    const reservation = parseReservation(input);
    this.#assertAttemptRelationship(reservation.attemptId, reservation.missionId);
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO reservations
            (id, mission_id, attempt_id, provider, external_confirmation_id, status, created_at, updated_at, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reservation.id,
          reservation.missionId,
          reservation.attemptId,
          reservation.provider,
          reservation.externalConfirmationId ?? null,
          reservation.status,
          reservation.createdAt,
          reservation.updatedAt,
          JSON.stringify(reservation),
        );
      this.#appendAudit({
        id: this.#idFactory(),
        timestamp: this.#clock(),
        type: "RESERVATION_CREATED",
        missionId: reservation.missionId,
        attemptId: reservation.attemptId,
        metadata: {
          reservationId: reservation.id,
          provider: reservation.provider,
          status: reservation.status,
        },
      });
    });
    return reservation;
  }

  public getReservation(id: string): Reservation | undefined {
    return this.#getJson(
      "SELECT data_json FROM reservations WHERE id = ?",
      id,
      parseReservation,
    );
  }

  public recordAuditEvent(input: {
    readonly type: AuditEventType;
    readonly missionId: string;
    readonly attemptId?: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): void {
    if (this.getMission(input.missionId) === undefined) {
      throw new EntityNotFoundError("Mission", input.missionId);
    }
    if (input.attemptId !== undefined) {
      this.#assertAttemptRelationship(input.attemptId, input.missionId);
    }

    this.#transaction(() => {
      this.#appendAudit({
        id: this.#idFactory(),
        timestamp: this.#clock(),
        type: input.type,
        missionId: input.missionId,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        metadata: input.metadata,
      });
    });
  }

  public getAuditEvents(missionId: string): readonly AuditEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, id, timestamp, type, mission_id, attempt_id,
                previous_state, new_state, metadata_json
         FROM audit_events
         WHERE mission_id = ?
         ORDER BY sequence ASC`,
      )
      .all(missionId) as unknown as readonly AuditRow[];

    return rows.map((row) =>
      parseAuditEvent({
        sequence: row.sequence,
        id: row.id,
        timestamp: row.timestamp,
        type: row.type,
        missionId: row.mission_id,
        ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
        ...(row.previous_state === null ? {} : { previousState: row.previous_state }),
        ...(row.new_state === null ? {} : { newState: row.new_state }),
        metadata: JSON.parse(row.metadata_json) as unknown,
      }),
    );
  }

  #assertAttemptRelationship(attemptId: string, missionId: string): BookingAttempt {
    const attempt = this.getAttempt(attemptId);
    if (attempt === undefined) {
      throw new EntityNotFoundError("BookingAttempt", attemptId);
    }
    if (attempt.missionId !== missionId) {
      throw new Error(`BookingAttempt ${attemptId} does not belong to Mission ${missionId}`);
    }
    return attempt;
  }

  #appendAudit(input: {
    readonly id: string;
    readonly timestamp: string;
    readonly type: AuditEventType;
    readonly missionId: string;
    readonly attemptId?: string;
    readonly previousState?: string;
    readonly newState?: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): void {
    const sanitized = redactSensitive(input.metadata);
    this.#database
      .prepare(
        `INSERT INTO audit_events
          (id, timestamp, type, mission_id, attempt_id, previous_state, new_state, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.timestamp,
        input.type,
        input.missionId,
        input.attemptId ?? null,
        input.previousState ?? null,
        input.newState ?? null,
        JSON.stringify(sanitized),
      );
  }

  #getJson<T>(query: string, id: string, parser: (input: unknown) => T): T | undefined {
    const row = this.#database.prepare(query).get(id) as JsonRow | undefined;
    return row === undefined ? undefined : parser(JSON.parse(row.data_json) as unknown);
  }

  #allJson<T>(query: string, parser: (input: unknown) => T): readonly T[] {
    const rows = this.#database.prepare(query).all() as unknown as readonly JsonRow[];
    return rows.map((row) => parser(JSON.parse(row.data_json) as unknown));
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
}
