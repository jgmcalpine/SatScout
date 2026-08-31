import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AuditEvent, AuditEventType } from "../audit/audit-event.js";
import { parseAuditEvent } from "../audit/audit-event.js";
import type { BookingAttempt, CartCaptureTarget } from "../domain/booking/booking-attempt.js";
import {
  CartCaptureTargetSchema,
  parseBookingAttempt,
} from "../domain/booking/booking-attempt.js";
import type { Authorization } from "../domain/economy/authorization.js";
import { parseAuthorization } from "../domain/economy/authorization.js";
import type { FundingExecutionRecord } from "../domain/economy/execution-record.js";
import { parseFundingExecutionRecord } from "../domain/economy/execution-record.js";
import type { InstrumentExecutionRecord } from "../domain/economy/instrument-execution.js";
import { parseInstrumentExecutionRecord } from "../domain/economy/instrument-execution.js";
import type { GiftCardAcquisitionRecord } from "../domain/economy/gift-card-acquisition.js";
import { parseGiftCardAcquisitionRecord } from "../domain/economy/gift-card-acquisition.js";
import type { InstrumentPrepaymentBinding } from "../domain/economy/instrument-prepayment.js";
import { parseInstrumentPrepaymentBinding } from "../domain/economy/instrument-prepayment.js";
import type { PermitDecision } from "../domain/economy/evaluate.js";
import { evaluateResolvedAction, reservedEconomicsFor } from "../domain/economy/evaluate.js";
import { AuthorizationLifecycleError, transitionAuthorization } from "../domain/economy/lifecycle.js";
import type { AuthorizationTransition } from "../domain/economy/lifecycle.js";
import { PermitDecisionOutcome, PermitReasonCode } from "../domain/economy/reason-codes.js";
import { digestResolvedAction, parseResolvedAction } from "../domain/economy/resolved-action.js";
import { computePermitUsage } from "../domain/economy/usage.js";
import type { Mission } from "../domain/mission/mission.js";
import {
  assertActiveMissionIsNotExpired,
  assertMissionCanAcceptPermit,
  parseMission,
} from "../domain/mission/mission.js";
import type { Payment } from "../domain/payment/payment.js";
import { parsePayment } from "../domain/payment/payment.js";
import type { Permit } from "../domain/permit/permit.js";
import { parsePermit } from "../domain/permit/permit.js";
import { assertPermitMatchesMission } from "../domain/permit/permit-v1.js";
import type { StoredPermit } from "../domain/permit/stored-permit.js";
import {
  isPermitV2,
  parseStoredPermit,
  storedPermitCreatedAt,
  storedPermitExpiresAt,
  storedPermitMissionId,
  storedPermitSchemaVersion,
  storedPermitStatus,
} from "../domain/permit/stored-permit.js";
import type { PurchaseIntent } from "../domain/purchase/purchase-intent.js";
import { parsePurchaseIntent } from "../domain/purchase/purchase-intent.js";
import type { Reservation } from "../domain/reservation/reservation.js";
import { parseReservation } from "../domain/reservation/reservation.js";
import { DomainValidationError } from "../domain/validation.js";
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
  readonly readOnly?: boolean;
}

export interface AuditOptions {
  readonly auditEventId?: string;
}

export interface CartTransitionAuditOptions {
  readonly workflowAuditEventId?: string;
  readonly cartAuditEventId?: string;
  readonly verifiedAuditEventId?: string;
}

export interface PermitRecord {
  readonly permit: StoredPermit;
  readonly schemaVersion: 1 | 2;
  readonly status: "DRAFT" | "ACTIVE" | "REVOKED";
}

export interface AuthorizeOptions {
  readonly acceptSimulation: boolean;
  readonly idempotencyKey?: string;
  readonly authorizationId?: string;
  readonly auditEventId?: string;
}

export interface AuthorizeResult {
  readonly decision: PermitDecision;
  readonly authorization?: Authorization;
}

export interface BeginFundingExecutionInput {
  readonly adapterId: string;
  readonly preparedOperationDigest: string;
  readonly externalIdentity: string;
}

export interface BeginInstrumentExecutionInput {
  readonly adapterId: string;
  readonly productId: string;
  readonly authorizedFaceValue: number;
}

export interface BeginGiftCardAcquisitionInput {
  readonly id: string;
  readonly missionId: string;
  readonly permitId: string;
  readonly acquireGrantId: string;
  readonly transferGrantId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly productId: string;
  readonly currency: "USD";
  readonly faceValueMinor: number;
  readonly denominationKind: "package" | "range";
  readonly packageId?: string;
}

export interface BeginInstrumentPrepaymentInput {
  readonly id: string;
  readonly missionId: string;
  readonly permitId: string;
  readonly grantId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly productId: string;
  readonly currency: "USD";
  readonly faceValueMinor: number;
}

interface PermitRow {
  readonly data_json: string;
  readonly schema_version: number;
  readonly status: string;
}

export class EntityNotFoundError extends Error {
  public constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`);
    this.name = "EntityNotFoundError";
  }
}

export class GiftCardInvoiceAlreadyClaimedError extends Error {
  public constructor(acquisitionId: string) {
    super(`gift-card invoice dispatch already claimed for ${acquisitionId}`);
    this.name = "GiftCardInvoiceAlreadyClaimedError";
  }
}

export class SatScoutStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => string;
  readonly #idFactory: () => string;

  public constructor(databasePath: string, options: StoreOptions = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly && databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new DatabaseSync(databasePath, { readOnly });
    if (!readOnly) {
      this.#database.exec("PRAGMA foreign_keys = ON;");
      this.#database.exec("PRAGMA busy_timeout = 5000;");
    }
    if (!readOnly && databasePath !== ":memory:") {
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

    const pending = migrations.filter((migration) => migration.version > current.version);
    if (pending.length === 0) {
      return;
    }

    // SQLite cannot enable/disable foreign keys inside a transaction. Version 7
    // rebuilds `missions` while other tables still reference it.
    this.#database.exec("PRAGMA foreign_keys = OFF;");
    for (const migration of pending) {
      this.#transaction(() => {
        this.#database.exec(migration.sql);
        this.#database
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, this.#clock());
      });
    }
    const violations = this.#database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error("SQLite foreign key check failed after migrations");
    }
    this.#database.exec("PRAGMA foreign_keys = ON;");
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

  public createPermit(input: unknown, options: AuditOptions = {}): StoredPermit {
    const permit = parseStoredPermit(input);
    const missionId = storedPermitMissionId(permit);
    const mission = this.getMission(missionId);
    if (mission === undefined) {
      throw new EntityNotFoundError("Mission", missionId);
    }
    const expiresAt = storedPermitExpiresAt(permit);
    assertMissionCanAcceptPermit(mission, expiresAt, this.#clock());
    if (!isPermitV2(permit)) {
      assertPermitMatchesMission(permit, mission);
    } else if (permit.status !== "DRAFT") {
      throw new DomainValidationError("Permit", [
        { path: "status", message: "new Permits must be created as DRAFT and explicitly activated" },
      ]);
    }

    const schemaVersion = storedPermitSchemaVersion(permit);
    const status = storedPermitStatus(permit);
    const createdAt = storedPermitCreatedAt(permit);
    const activatedAt = isPermitV2(permit) ? (permit.activatedAt ?? null) : createdAt;
    const revokedAt = isPermitV2(permit) ? (permit.revokedAt ?? null) : null;

    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO permits
            (id, mission_id, schema_version, status, created_at, activated_at, revoked_at, expires_at, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          permit.id,
          missionId,
          schemaVersion,
          status,
          createdAt,
          activatedAt,
          revokedAt,
          expiresAt,
          JSON.stringify(permit),
        );
      this.#appendAudit({
        id: options.auditEventId ?? this.#idFactory(),
        timestamp: this.#clock(),
        type: "PERMIT_CREATED",
        missionId,
        metadata: {
          permitId: permit.id,
          schemaVersion,
          status,
          expiresAt,
          ...(isPermitV2(permit)
            ? { grantKinds: permit.grants.map((grant) => grant.kind) }
            : { purpose: permit.purpose, spending: permit.spending }),
        },
      });
    });
    return permit;
  }

  public getPermit(id: string): StoredPermit | undefined {
    return this.getPermitRecord(id)?.permit;
  }

  public getPermitRecord(id: string): PermitRecord | undefined {
    const row = this.#database
      .prepare("SELECT data_json, schema_version, status FROM permits WHERE id = ?")
      .get(id) as PermitRow | undefined;
    return row === undefined ? undefined : this.#permitRecordFromRow(row);
  }

  public getPermitForMission(missionId: string): StoredPermit | undefined {
    return this.getActivePermitForMission(missionId);
  }

  public getActivePermitForMission(missionId: string): StoredPermit | undefined {
    return this.#getJson(
      "SELECT data_json FROM permits WHERE mission_id = ? AND status = 'ACTIVE'",
      missionId,
      parseStoredPermit,
    );
  }

  public listPermitsForMission(missionId: string): readonly PermitRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT data_json, schema_version, status FROM permits
         WHERE mission_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(missionId) as unknown as readonly PermitRow[];
    return rows.map((row) => this.#permitRecordFromRow(row));
  }

  public replaceDraftPermit(input: unknown, options: AuditOptions = {}): Permit {
    const replacement = parsePermit(input);
    if (replacement.status !== "DRAFT") {
      throw new DomainValidationError("Permit", [
        { path: "status", message: "only DRAFT Permits can be replaced" },
      ]);
    }
    const existing = this.getPermitRecord(replacement.id);
    if (existing === undefined) {
      throw new EntityNotFoundError("Permit", replacement.id);
    }
    if (!isPermitV2(existing.permit) || existing.status !== "DRAFT") {
      throw new DomainValidationError("Permit", [
        { path: "status", message: "an ACTIVE or REVOKED Permit cannot be modified; revoke and replace it" },
      ]);
    }
    if (existing.permit.missionId !== replacement.missionId) {
      throw new DomainValidationError("Permit", [
        { path: "missionId", message: "cannot move a Permit to a different Mission" },
      ]);
    }
    const mission = this.getMission(replacement.missionId);
    if (mission === undefined) {
      throw new EntityNotFoundError("Mission", replacement.missionId);
    }
    assertMissionCanAcceptPermit(mission, replacement.validity.expiresAt, this.#clock());

    this.#transaction(() => {
      const update = this.#database
        .prepare(
          `UPDATE permits
           SET expires_at = ?, data_json = ?
           WHERE id = ? AND status = 'DRAFT'`,
        )
        .run(replacement.validity.expiresAt, JSON.stringify(replacement), replacement.id);
      if (update.changes !== 1) {
        throw new Error(`Concurrent Permit update detected for ${replacement.id}`);
      }
      this.#appendAudit({
        id: options.auditEventId ?? this.#idFactory(),
        timestamp: this.#clock(),
        type: "PERMIT_REPLACED",
        missionId: replacement.missionId,
        metadata: { permitId: replacement.id, schemaVersion: 2, status: "DRAFT" },
      });
    });
    return replacement;
  }

  public activatePermit(permitId: string, options: AuditOptions = {}): Permit {
    const existing = this.getPermitRecord(permitId);
    if (existing === undefined) {
      throw new EntityNotFoundError("Permit", permitId);
    }
    if (!isPermitV2(existing.permit)) {
      throw new DomainValidationError("Permit", [
        { path: "schemaVersion", message: "legacy Permit v1 cannot be activated under the v2 engine" },
      ]);
    }
    if (existing.status !== "DRAFT") {
      throw new DomainValidationError("Permit", [
        { path: "status", message: `Permit ${permitId} cannot be activated from ${existing.status}` },
      ]);
    }
    const active = this.getActivePermitForMission(existing.permit.missionId);
    if (active !== undefined) {
      throw new DomainValidationError("Permit", [
        {
          path: "status",
          message: `Mission ${existing.permit.missionId} already has ACTIVE Permit ${active.id}`,
        },
      ]);
    }
    const timestamp = this.#clock();
    const activated: Permit = parsePermit({
      ...existing.permit,
      status: "ACTIVE",
      activatedAt: timestamp,
    });
    assertMissionCanAcceptPermit(
      this.#requireMission(activated.missionId),
      activated.validity.expiresAt,
      timestamp,
    );

    this.#transaction(() => {
      const update = this.#database
        .prepare(
          `UPDATE permits
           SET status = 'ACTIVE', activated_at = ?, data_json = ?
           WHERE id = ? AND status = 'DRAFT'`,
        )
        .run(timestamp, JSON.stringify(activated), permitId);
      if (update.changes !== 1) {
        throw new Error(`Concurrent Permit update detected for ${permitId}`);
      }
      this.#appendAudit({
        id: options.auditEventId ?? this.#idFactory(),
        timestamp,
        type: "PERMIT_ACTIVATED",
        missionId: activated.missionId,
        metadata: { permitId, schemaVersion: 2, status: "ACTIVE" },
      });
    });
    return activated;
  }

  public revokePermit(permitId: string, options: AuditOptions = {}): PermitRecord {
    const existing = this.getPermitRecord(permitId);
    if (existing === undefined) {
      throw new EntityNotFoundError("Permit", permitId);
    }
    if (existing.status === "REVOKED") {
      throw new DomainValidationError("Permit", [
        { path: "status", message: `Permit ${permitId} is already REVOKED` },
      ]);
    }
    const timestamp = this.#clock();
    const revokedPermit = isPermitV2(existing.permit)
      ? parsePermit({
          ...existing.permit,
          status: "REVOKED",
          revokedAt: timestamp,
          ...(existing.permit.activatedAt === undefined ? {} : { activatedAt: existing.permit.activatedAt }),
        })
      : existing.permit;

    this.#transaction(() => {
      const update = this.#database
        .prepare(
          `UPDATE permits
           SET status = 'REVOKED', revoked_at = ?, data_json = ?
           WHERE id = ? AND status = ?`,
        )
        .run(timestamp, JSON.stringify(revokedPermit), permitId, existing.status);
      if (update.changes !== 1) {
        throw new Error(`Concurrent Permit update detected for ${permitId}`);
      }
      this.#appendAudit({
        id: options.auditEventId ?? this.#idFactory(),
        timestamp,
        type: "PERMIT_REVOKED",
        missionId: storedPermitMissionId(existing.permit),
        metadata: {
          permitId,
          schemaVersion: existing.schemaVersion,
          previousStatus: existing.status,
          status: "REVOKED",
        },
      });
    });
    return {
      permit: revokedPermit,
      schemaVersion: existing.schemaVersion,
      status: "REVOKED",
    };
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

  /**
   * Atomically records the exact recovery target, moves AVAILABLE to CARTING,
   * and appends both ordering-critical audit events. The caller may invoke the
   * external Add-to-Cart action only after this method returns successfully.
   */
  public beginCartCapture(
    attemptId: string,
    targetInput: CartCaptureTarget,
    metadata: Readonly<Record<string, unknown>>,
    options: CartTransitionAuditOptions = {},
  ): BookingAttempt {
    const attempt = this.getAttempt(attemptId);
    if (attempt === undefined) {
      throw new EntityNotFoundError("BookingAttempt", attemptId);
    }
    const target = CartCaptureTargetSchema.parse(targetInput);
    const transition = transitionWorkflow(attempt.state, "CARTING");
    if (transition.outcome !== "transitioned") {
      throw new Error(`BookingAttempt ${attemptId} is not AVAILABLE for cart capture`);
    }
    const timestamp = this.#clock();
    const updatedAttempt = parseBookingAttempt({
      ...attempt,
      state: "CARTING",
      cartTarget: target,
      updatedAt: timestamp,
    });

    this.#transaction(() => {
      const update = this.#database
        .prepare(
          `UPDATE booking_attempts
           SET state = ?, updated_at = ?, data_json = ?
           WHERE id = ? AND state = ?`,
        )
        .run(
          updatedAttempt.state,
          timestamp,
          JSON.stringify(updatedAttempt),
          attemptId,
          transition.previousState,
        );
      if (update.changes !== 1) {
        throw new Error(`Concurrent workflow update detected for BookingAttempt ${attemptId}`);
      }
      this.#appendAudit({
        id: options.workflowAuditEventId ?? this.#idFactory(),
        timestamp,
        type: "WORKFLOW_TRANSITIONED",
        missionId: attempt.missionId,
        attemptId,
        previousState: transition.previousState,
        newState: transition.newState,
        metadata: {},
      });
      this.#appendAudit({
        id: options.cartAuditEventId ?? this.#idFactory(),
        timestamp,
        type: "RECREATION_CART_ACTION_STARTED",
        missionId: attempt.missionId,
        attemptId,
        metadata,
      });
    });

    return updatedAttempt;
  }

  /** Atomically records exact external verification and moves CARTING to CART_HELD. */
  public completeCartCapture(
    attemptId: string,
    metadata: Readonly<Record<string, unknown>>,
    reconciled: boolean = false,
    options: CartTransitionAuditOptions = {},
  ): BookingAttempt {
    const attempt = this.getAttempt(attemptId);
    if (attempt === undefined) {
      throw new EntityNotFoundError("BookingAttempt", attemptId);
    }
    const transition = transitionWorkflow(attempt.state, "CART_HELD");
    if (transition.outcome !== "transitioned") {
      throw new Error(`BookingAttempt ${attemptId} is not CARTING for hold verification`);
    }
    const timestamp = this.#clock();
    const updatedAttempt = parseBookingAttempt({
      ...attempt,
      state: "CART_HELD",
      updatedAt: timestamp,
    });

    this.#transaction(() => {
      const update = this.#database
        .prepare(
          `UPDATE booking_attempts
           SET state = ?, updated_at = ?, data_json = ?
           WHERE id = ? AND state = ?`,
        )
        .run(
          updatedAttempt.state,
          timestamp,
          JSON.stringify(updatedAttempt),
          attemptId,
          transition.previousState,
        );
      if (update.changes !== 1) {
        throw new Error(`Concurrent workflow update detected for BookingAttempt ${attemptId}`);
      }
      if (reconciled) {
        this.#appendAudit({
          id: options.cartAuditEventId ?? this.#idFactory(),
          timestamp,
          type: "RECREATION_CART_RECONCILED",
          missionId: attempt.missionId,
          attemptId,
          metadata,
        });
      }
      this.#appendAudit({
        id: options.verifiedAuditEventId ?? this.#idFactory(),
        timestamp,
        type: "RECREATION_CART_HOLD_VERIFIED",
        missionId: attempt.missionId,
        attemptId,
        metadata,
      });
      this.#appendAudit({
        id: options.workflowAuditEventId ?? this.#idFactory(),
        timestamp,
        type: "WORKFLOW_TRANSITIONED",
        missionId: attempt.missionId,
        attemptId,
        previousState: transition.previousState,
        newState: transition.newState,
        metadata: {},
      });
    });

    return updatedAttempt;
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

  public authorizeResolvedAction(input: unknown, options: AuthorizeOptions): AuthorizeResult {
    return this.#transaction(() => this.#authorizeResolvedActionLocked(input, options));
  }

  public previewResolvedAction(
    input: unknown,
    options: { readonly acceptSimulation: boolean },
  ): PermitDecision {
    const action = parseResolvedAction(input);
    const permit = this.#permitForAction(action.missionId);
    const authorizations = isPermitV2(permit) ? this.listAuthorizationsForPermit(permit.id) : [];
    const parent =
      action.parentAuthorizationId === undefined
        ? undefined
        : this.getAuthorization(action.parentAuthorizationId);
    return evaluateResolvedAction(permit, action, {
      now: this.#clock(),
      acceptSimulation: options.acceptSimulation,
      usage: isPermitV2(permit) ? computePermitUsage(permit, authorizations) : { permitId: permit.id, grants: [] },
      ...(parent === undefined ? {} : { parentAuthorization: parent }),
    });
  }

  public getAuthorization(id: string): Authorization | undefined {
    return this.#getJson(
      "SELECT data_json FROM authorizations WHERE id = ?",
      id,
      parseAuthorization,
    );
  }

  public listAuthorizationsForMission(missionId: string): readonly Authorization[] {
    return this.#allJsonWithArg(
      `SELECT data_json FROM authorizations WHERE mission_id = ? ORDER BY created_at ASC, id ASC`,
      missionId,
      parseAuthorization,
    );
  }

  public listAuthorizationsForPermit(permitId: string): readonly Authorization[] {
    return this.#allJsonWithArg(
      `SELECT data_json FROM authorizations WHERE permit_id = ? ORDER BY created_at ASC, id ASC`,
      permitId,
      parseAuthorization,
    );
  }

  public transitionAuthorizationStatus(
    authorizationId: string,
    requestedStatus: Authorization["status"],
    options: AuditOptions = {},
  ): Authorization {
    const existing = this.getAuthorization(authorizationId);
    if (existing === undefined) {
      throw new EntityNotFoundError("Authorization", authorizationId);
    }
    return this.#transaction(() =>
      this.#transitionAuthorizationStatusLocked(existing, requestedStatus, options),
    );
  }

  public beginFundingExecution(
    authorizationId: string,
    input: BeginFundingExecutionInput,
    extraAudits: readonly {
      readonly type: AuditEventType;
      readonly metadata: Readonly<Record<string, unknown>>;
    }[] = [],
  ): { readonly authorization: Authorization; readonly execution: FundingExecutionRecord } {
    return this.#transaction(() => {
      const existing = this.getAuthorization(authorizationId);
      if (existing === undefined) {
        throw new EntityNotFoundError("Authorization", authorizationId);
      }
      const authorization = this.#transitionAuthorizationStatusLocked(existing, "EXECUTING");
      const timestamp = this.#clock();
      const execution = parseFundingExecutionRecord({
        authorizationId,
        adapterId: input.adapterId,
        preparedOperationDigest: input.preparedOperationDigest,
        externalIdentity: input.externalIdentity,
        executionStartedAt: timestamp,
        sanitizedState: "EXECUTING",
      });
      this.#database
        .prepare(
          `INSERT INTO funding_executions
            (authorization_id, adapter_id, prepared_operation_digest, external_identity,
             execution_started_at, send_dispatched_at, last_reconciled_at, sanitized_state, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          execution.authorizationId,
          execution.adapterId,
          execution.preparedOperationDigest,
          execution.externalIdentity,
          execution.executionStartedAt,
          null,
          null,
          execution.sanitizedState,
          JSON.stringify(execution),
        );
      for (const extra of extraAudits) {
        this.#appendAudit({
          id: this.#idFactory(),
          timestamp,
          type: extra.type,
          missionId: authorization.missionId,
          metadata: extra.metadata,
        });
      }
      return { authorization, execution };
    });
  }

  public markSendDispatched(
    authorizationId: string,
    extraAudits: readonly {
      readonly type: AuditEventType;
      readonly metadata: Readonly<Record<string, unknown>>;
    }[] = [],
  ): FundingExecutionRecord {
    return this.#transaction(() => {
      const existing = this.getFundingExecution(authorizationId);
      if (existing === undefined) {
        throw new EntityNotFoundError("FundingExecution", authorizationId);
      }
      if (existing.sendDispatchedAt !== undefined) {
        throw new Error(`Send already dispatched for Authorization ${authorizationId}`);
      }
      const timestamp = this.#clock();
      const updated = parseFundingExecutionRecord({
        ...existing,
        sendDispatchedAt: timestamp,
        sanitizedState: "SEND_DISPATCHED",
      });
      this.#replaceFundingExecution(updated);
      const authorization = this.getAuthorization(authorizationId);
      if (authorization === undefined) {
        throw new EntityNotFoundError("Authorization", authorizationId);
      }
      for (const extra of extraAudits) {
        this.#appendAudit({
          id: this.#idFactory(),
          timestamp,
          type: extra.type,
          missionId: authorization.missionId,
          metadata: extra.metadata,
        });
      }
      return updated;
    });
  }

  public updateFundingExecution(
    authorizationId: string,
    patch: Partial<
      Pick<
        FundingExecutionRecord,
        "externalActivityId" | "lastReconciledAt" | "sanitizedState" | "sanitizedFailureCode"
      >
    >,
  ): FundingExecutionRecord {
    return this.#transaction(() => {
      const existing = this.getFundingExecution(authorizationId);
      if (existing === undefined) {
        throw new EntityNotFoundError("FundingExecution", authorizationId);
      }
      const updated = parseFundingExecutionRecord({
        ...existing,
        ...patch,
      });
      this.#replaceFundingExecution(updated);
      return updated;
    });
  }

  public getFundingExecution(authorizationId: string): FundingExecutionRecord | undefined {
    return this.#getJson(
      "SELECT data_json FROM funding_executions WHERE authorization_id = ?",
      authorizationId,
      parseFundingExecutionRecord,
    );
  }

  public beginInstrumentExecution(
    authorizationId: string,
    input: BeginInstrumentExecutionInput,
    extraAudits: readonly {
      readonly type: AuditEventType;
      readonly metadata: Readonly<Record<string, unknown>>;
    }[] = [],
  ): { readonly authorization: Authorization; readonly execution: InstrumentExecutionRecord } {
    return this.#transaction(() => {
      const existing = this.getAuthorization(authorizationId);
      if (existing === undefined) {
        throw new EntityNotFoundError("Authorization", authorizationId);
      }
      if (this.getInstrumentExecution(authorizationId) !== undefined) {
        throw new Error(`Instrument execution already exists for Authorization ${authorizationId}`);
      }
      const authorization = this.#transitionAuthorizationStatusLocked(existing, "EXECUTING");
      const timestamp = this.#clock();
      const execution = parseInstrumentExecutionRecord({
        authorizationId,
        adapterId: input.adapterId,
        productId: input.productId,
        authorizedFaceValue: input.authorizedFaceValue,
        paymentMethod: "lightning",
        executionStartedAt: timestamp,
        sanitizedState: "EXECUTING",
      });
      this.#database
        .prepare(
          `INSERT INTO instrument_executions
            (authorization_id, adapter_id, product_id, authorized_face_value, payment_method,
             execution_started_at, invoice_posted_at, invoice_id, last_reconciled_at, sanitized_state, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          execution.authorizationId,
          execution.adapterId,
          execution.productId,
          execution.authorizedFaceValue,
          execution.paymentMethod,
          execution.executionStartedAt,
          null,
          null,
          null,
          execution.sanitizedState,
          JSON.stringify(execution),
        );
      for (const extra of extraAudits) {
        this.#appendAudit({
          id: this.#idFactory(),
          timestamp,
          type: extra.type,
          missionId: authorization.missionId,
          metadata: extra.metadata,
        });
      }
      return { authorization, execution };
    });
  }

  public markInstrumentInvoicePosted(
    authorizationId: string,
    extraAudits: readonly {
      readonly type: AuditEventType;
      readonly metadata: Readonly<Record<string, unknown>>;
    }[] = [],
  ): InstrumentExecutionRecord {
    return this.#transaction(() => {
      const existing = this.getInstrumentExecution(authorizationId);
      if (existing === undefined) {
        throw new EntityNotFoundError("InstrumentExecution", authorizationId);
      }
      if (existing.invoicePostedAt !== undefined) {
        throw new Error(`Bitrefill invoice already posted for Authorization ${authorizationId}`);
      }
      const timestamp = this.#clock();
      const updated = parseInstrumentExecutionRecord({
        ...existing,
        invoicePostedAt: timestamp,
        sanitizedState: "INVOICE_POSTED",
      });
      this.#replaceInstrumentExecution(updated);
      const authorization = this.getAuthorization(authorizationId);
      if (authorization === undefined) {
        throw new EntityNotFoundError("Authorization", authorizationId);
      }
      for (const extra of extraAudits) {
        this.#appendAudit({
          id: this.#idFactory(),
          timestamp,
          type: extra.type,
          missionId: authorization.missionId,
          metadata: extra.metadata,
        });
      }
      return updated;
    });
  }

  public updateInstrumentExecution(
    authorizationId: string,
    patch: Partial<
      Pick<
        InstrumentExecutionRecord,
        | "invoiceId"
        | "orderIds"
        | "paymentCurrency"
        | "paymentAmountMinor"
        | "paymentRequestDigest"
        | "invoiceExpiresAt"
        | "lastReconciledAt"
        | "sanitizedState"
        | "remoteStatus"
      >
    >,
  ): InstrumentExecutionRecord {
    return this.#transaction(() => {
      const existing = this.getInstrumentExecution(authorizationId);
      if (existing === undefined) {
        throw new EntityNotFoundError("InstrumentExecution", authorizationId);
      }
      const updated = parseInstrumentExecutionRecord({
        ...existing,
        ...patch,
      });
      this.#replaceInstrumentExecution(updated);
      return updated;
    });
  }

  public getInstrumentExecution(authorizationId: string): InstrumentExecutionRecord | undefined {
    return this.#getJson(
      "SELECT data_json FROM instrument_executions WHERE authorization_id = ?",
      authorizationId,
      parseInstrumentExecutionRecord,
    );
  }

  public beginInstrumentPrepayment(input: BeginInstrumentPrepaymentInput): InstrumentPrepaymentBinding {
    return this.#transaction(() => {
      const existing = this.findActiveInstrumentPrepayment(
        input.missionId,
        input.provider,
        input.productId,
        input.currency,
        input.faceValueMinor,
      );
      if (existing !== undefined) {
        return existing;
      }
      const timestamp = this.#clock();
      const binding = parseInstrumentPrepaymentBinding({
        id: input.id,
        adapterId: input.adapterId,
        provider: input.provider,
        missionId: input.missionId,
        permitId: input.permitId,
        grantId: input.grantId,
        productId: input.productId,
        currency: input.currency,
        faceValueMinor: input.faceValueMinor,
        quantity: 1,
        status: "PREPARING",
        createdAt: timestamp,
        updatedAt: timestamp,
        mutationDispatched: false,
      });
      try {
        this.#insertInstrumentPrepayment(binding);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const raced = this.findActiveInstrumentPrepayment(
            input.missionId,
            input.provider,
            input.productId,
            input.currency,
            input.faceValueMinor,
          );
          if (raced !== undefined) {
            return raced;
          }
        }
        throw error;
      }
      return binding;
    });
  }

  public getInstrumentPrepayment(id: string): InstrumentPrepaymentBinding | undefined {
    return this.#getJson(
      "SELECT data_json FROM instrument_prepayments WHERE id = ?",
      id,
      parseInstrumentPrepaymentBinding,
    );
  }

  public findActiveInstrumentPrepayment(
    missionId: string,
    provider: string,
    productId: string,
    currency: string,
    faceValueMinor: number,
  ): InstrumentPrepaymentBinding | undefined {
    const row = this.#database
      .prepare(
        `SELECT data_json FROM instrument_prepayments
         WHERE mission_id = ? AND provider = ? AND product_id = ? AND currency = ? AND face_value_minor = ?
           AND status IN ('PREPARING', 'READY', 'AMBIGUOUS')
         LIMIT 1`,
      )
      .get(missionId, provider, productId, currency, faceValueMinor) as { readonly data_json: string } | undefined;
    return row === undefined ? undefined : parseInstrumentPrepaymentBinding(JSON.parse(row.data_json) as unknown);
  }

  public updateInstrumentPrepayment(
    id: string,
    patch: Partial<
      Pick<
        InstrumentPrepaymentBinding,
        | "status"
        | "mutationDispatched"
        | "lastStep"
        | "billPaymentIdDigest"
        | "toolSchemaDigest"
      >
    >,
  ): InstrumentPrepaymentBinding {
    return this.#transaction(() => this.#updateInstrumentPrepaymentLocked(id, patch));
  }

  public markPrepaymentMutationDispatched(id: string, step: number): InstrumentPrepaymentBinding {
    return this.#transaction(() => {
      const existing = this.getInstrumentPrepayment(id);
      if (existing === undefined) {
        throw new EntityNotFoundError("InstrumentPrepayment", id);
      }
      return this.#updateInstrumentPrepaymentLocked(id, {
        mutationDispatched: true,
        lastStep: step,
      });
    });
  }

  #updateInstrumentPrepaymentLocked(
    id: string,
    patch: Partial<
      Pick<
        InstrumentPrepaymentBinding,
        | "status"
        | "mutationDispatched"
        | "lastStep"
        | "billPaymentIdDigest"
        | "toolSchemaDigest"
      >
    >,
  ): InstrumentPrepaymentBinding {
    const existing = this.getInstrumentPrepayment(id);
    if (existing === undefined) {
      throw new EntityNotFoundError("InstrumentPrepayment", id);
    }
    const updated = parseInstrumentPrepaymentBinding({
      ...existing,
      ...patch,
      updatedAt: this.#clock(),
    });
    this.#replaceInstrumentPrepayment(updated);
    return updated;
  }

  #insertInstrumentPrepayment(binding: InstrumentPrepaymentBinding): void {
    this.#database
      .prepare(
        `INSERT INTO instrument_prepayments
          (id, mission_id, permit_id, grant_id, adapter_id, provider, product_id, currency,
           face_value_minor, quantity, bill_payment_id_digest, status, created_at, updated_at,
           mutation_dispatched, last_step, tool_schema_digest, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.id,
        binding.missionId,
        binding.permitId,
        binding.grantId,
        binding.adapterId,
        binding.provider,
        binding.productId,
        binding.currency,
        binding.faceValueMinor,
        binding.quantity,
        binding.billPaymentIdDigest ?? null,
        binding.status,
        binding.createdAt,
        binding.updatedAt,
        binding.mutationDispatched ? 1 : 0,
        binding.lastStep ?? null,
        binding.toolSchemaDigest ?? null,
        JSON.stringify(binding),
      );
  }

  #replaceInstrumentPrepayment(binding: InstrumentPrepaymentBinding): void {
    const update = this.#database
      .prepare(
        `UPDATE instrument_prepayments
         SET bill_payment_id_digest = ?, status = ?, updated_at = ?, mutation_dispatched = ?,
             last_step = ?, tool_schema_digest = ?, data_json = ?
         WHERE id = ?`,
      )
      .run(
        binding.billPaymentIdDigest ?? null,
        binding.status,
        binding.updatedAt,
        binding.mutationDispatched ? 1 : 0,
        binding.lastStep ?? null,
        binding.toolSchemaDigest ?? null,
        JSON.stringify(binding),
        binding.id,
      );
    if (update.changes !== 1) {
      throw new Error(`Concurrent prepayment update detected for ${binding.id}`);
    }
  }

  public beginGiftCardAcquisition(input: BeginGiftCardAcquisitionInput): GiftCardAcquisitionRecord {
    return this.#transaction(() => {
      const existing = this.findActiveGiftCardAcquisition(
        input.permitId,
        input.acquireGrantId,
        input.productId,
        input.currency,
        input.faceValueMinor,
      );
      if (existing !== undefined) {
        return existing;
      }
      const timestamp = this.#clock();
      const record = parseGiftCardAcquisitionRecord({
        id: input.id,
        adapterId: input.adapterId,
        provider: input.provider,
        missionId: input.missionId,
        permitId: input.permitId,
        acquireGrantId: input.acquireGrantId,
        transferGrantId: input.transferGrantId,
        productId: input.productId,
        currency: input.currency,
        faceValueMinor: input.faceValueMinor,
        quantity: 1,
        denominationKind: input.denominationKind,
        ...(input.packageId === undefined ? {} : { packageId: input.packageId }),
        status: "CREATED",
        createdAt: timestamp,
        updatedAt: timestamp,
        invoicePosted: false,
        redemptionSecretPresent: false,
      });
      try {
        this.#insertGiftCardAcquisition(record);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const raced = this.findActiveGiftCardAcquisition(
            input.permitId,
            input.acquireGrantId,
            input.productId,
            input.currency,
            input.faceValueMinor,
          );
          if (raced !== undefined) {
            return raced;
          }
        }
        throw error;
      }
      return record;
    });
  }

  public getGiftCardAcquisition(id: string): GiftCardAcquisitionRecord | undefined {
    return this.#getJson(
      "SELECT data_json FROM gift_card_acquisitions WHERE id = ?",
      id,
      parseGiftCardAcquisitionRecord,
    );
  }

  public findActiveGiftCardAcquisition(
    permitId: string,
    acquireGrantId: string,
    productId: string,
    currency: string,
    faceValueMinor: number,
  ): GiftCardAcquisitionRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT data_json FROM gift_card_acquisitions
         WHERE permit_id = ? AND acquire_grant_id = ? AND product_id = ? AND currency = ? AND face_value_minor = ?
           AND status != 'FAILED_SAFE'
         LIMIT 1`,
      )
      .get(permitId, acquireGrantId, productId, currency, faceValueMinor) as
      | { readonly data_json: string }
      | undefined;
    return row === undefined ? undefined : parseGiftCardAcquisitionRecord(JSON.parse(row.data_json) as unknown);
  }

  public claimGiftCardInvoiceDispatch(id: string): GiftCardAcquisitionRecord {
    return this.#transaction(() => {
      const existing = this.getGiftCardAcquisition(id);
      if (existing === undefined) {
        throw new EntityNotFoundError("GiftCardAcquisition", id);
      }
      if (existing.invoicePosted || existing.status !== "CREATED") {
        throw new GiftCardInvoiceAlreadyClaimedError(id);
      }
      return this.#updateGiftCardAcquisitionLocked(id, {
        status: "INVOICE_DISPATCHED",
        invoicePosted: true,
      });
    });
  }

  public updateGiftCardAcquisition(
    id: string,
    patch: Partial<
      Pick<
        GiftCardAcquisitionRecord,
        | "status"
        | "invoicePosted"
        | "invoiceId"
        | "orderId"
        | "paymentRequestDigest"
        | "paymentHash"
        | "principalSat"
        | "feeSat"
        | "totalOutflowSat"
        | "operationDigest"
        | "bindingDigest"
        | "invoiceExpiresAt"
        | "acquireAuthorizationId"
        | "transferAuthorizationId"
        | "redemptionSecretDigest"
        | "redemptionSecretPresent"
        | "deliveryStatus"
      >
    >,
  ): GiftCardAcquisitionRecord {
    return this.#transaction(() => this.#updateGiftCardAcquisitionLocked(id, patch));
  }

  #updateGiftCardAcquisitionLocked(
    id: string,
    patch: Partial<GiftCardAcquisitionRecord>,
  ): GiftCardAcquisitionRecord {
    const existing = this.getGiftCardAcquisition(id);
    if (existing === undefined) {
      throw new EntityNotFoundError("GiftCardAcquisition", id);
    }
    const updated = parseGiftCardAcquisitionRecord({
      ...existing,
      ...patch,
      updatedAt: this.#clock(),
    });
    this.#replaceGiftCardAcquisition(updated);
    return updated;
  }

  #insertGiftCardAcquisition(record: GiftCardAcquisitionRecord): void {
    this.#database
      .prepare(
        `INSERT INTO gift_card_acquisitions
          (id, mission_id, permit_id, acquire_grant_id, transfer_grant_id, adapter_id, provider,
           product_id, currency, face_value_minor, quantity, status, created_at, updated_at,
           invoice_posted, invoice_id, order_id, payment_request_digest, payment_hash,
           acquire_authorization_id, transfer_authorization_id, redemption_secret_digest,
           redemption_secret_present, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.missionId,
        record.permitId,
        record.acquireGrantId,
        record.transferGrantId,
        record.adapterId,
        record.provider,
        record.productId,
        record.currency,
        record.faceValueMinor,
        record.quantity,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.invoicePosted ? 1 : 0,
        record.invoiceId ?? null,
        record.orderId ?? null,
        record.paymentRequestDigest ?? null,
        record.paymentHash ?? null,
        record.acquireAuthorizationId ?? null,
        record.transferAuthorizationId ?? null,
        record.redemptionSecretDigest ?? null,
        record.redemptionSecretPresent ? 1 : 0,
        JSON.stringify(record),
      );
  }

  #replaceGiftCardAcquisition(record: GiftCardAcquisitionRecord): void {
    const update = this.#database
      .prepare(
        `UPDATE gift_card_acquisitions
         SET status = ?, updated_at = ?, invoice_posted = ?, invoice_id = ?, order_id = ?,
             payment_request_digest = ?, payment_hash = ?, acquire_authorization_id = ?,
             transfer_authorization_id = ?, redemption_secret_digest = ?,
             redemption_secret_present = ?, data_json = ?
         WHERE id = ?`,
      )
      .run(
        record.status,
        record.updatedAt,
        record.invoicePosted ? 1 : 0,
        record.invoiceId ?? null,
        record.orderId ?? null,
        record.paymentRequestDigest ?? null,
        record.paymentHash ?? null,
        record.acquireAuthorizationId ?? null,
        record.transferAuthorizationId ?? null,
        record.redemptionSecretDigest ?? null,
        record.redemptionSecretPresent ? 1 : 0,
        JSON.stringify(record),
        record.id,
      );
    if (update.changes !== 1) {
      throw new Error(`Concurrent gift-card acquisition update detected for ${record.id}`);
    }
  }

  public findActivePaymentIdentity(
    adapterId: string,
    paymentIdentity: string,
  ): Authorization | undefined {
    return this.#getJson(
      `SELECT data_json FROM authorizations
       WHERE adapter_id = ? AND payment_identity = ?
         AND status IN ('AUTHORIZED', 'EXECUTING', 'AMBIGUOUS', 'SUCCEEDED', 'FAILED_SAFE')
       LIMIT 1`,
      [adapterId, paymentIdentity],
      parseAuthorization,
    );
  }

  public permitUsage(permitId: string) {
    const permit = this.getPermit(permitId);
    if (permit === undefined) {
      throw new EntityNotFoundError("Permit", permitId);
    }
    if (!isPermitV2(permit)) {
      return { permitId, grants: [] as const, legacy: true as const };
    }
    return computePermitUsage(permit, this.listAuthorizationsForPermit(permitId));
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

  #permitForAction(missionId: string): StoredPermit {
    const active = this.getActivePermitForMission(missionId);
    if (active !== undefined) {
      return active;
    }
    const records = this.listPermitsForMission(missionId);
    const drafts = records.filter((record) => record.status === "DRAFT");
    if (drafts.length === 1 && drafts[0] !== undefined) {
      return drafts[0].permit;
    }
    throw new EntityNotFoundError("Permit", `active:${missionId}`);
  }

  #requireMission(missionId: string): Mission {
    const mission = this.getMission(missionId);
    if (mission === undefined) {
      throw new EntityNotFoundError("Mission", missionId);
    }
    return mission;
  }

  #permitRecordFromRow(row: PermitRow): PermitRecord {
    const permit = parseStoredPermit(JSON.parse(row.data_json) as unknown);
    const schemaVersion = row.schema_version === 2 ? 2 : 1;
    const status =
      row.status === "DRAFT" || row.status === "ACTIVE" || row.status === "REVOKED"
        ? row.status
        : storedPermitStatus(permit);
    return { permit, schemaVersion, status };
  }

  #authorizationAuditType(
    status: Authorization["status"],
  ): Extract<
    AuditEventType,
    | "AUTHORIZATION_EXECUTING"
    | "AUTHORIZATION_SUCCEEDED"
    | "AUTHORIZATION_FAILED_SAFE"
    | "AUTHORIZATION_AMBIGUOUS"
    | "AUTHORIZATION_RELEASED"
  > {
    switch (status) {
      case "EXECUTING":
        return "AUTHORIZATION_EXECUTING";
      case "SUCCEEDED":
        return "AUTHORIZATION_SUCCEEDED";
      case "FAILED_SAFE":
        return "AUTHORIZATION_FAILED_SAFE";
      case "AMBIGUOUS":
        return "AUTHORIZATION_AMBIGUOUS";
      case "RELEASED":
        return "AUTHORIZATION_RELEASED";
      default:
        throw new Error(`No audit type for Authorization status ${status}`);
    }
  }

  #authorizeResolvedActionLocked(input: unknown, options: AuthorizeOptions): AuthorizeResult {
    const action = parseResolvedAction(input);
    const permit = this.#permitForAction(action.missionId);

    if (options.idempotencyKey !== undefined && isPermitV2(permit)) {
      const existing = this.#getJson(
        "SELECT data_json FROM authorizations WHERE permit_id = ? AND idempotency_key = ?",
        [permit.id, options.idempotencyKey],
        parseAuthorization,
      );
      if (existing !== undefined) {
        if (existing.resolvedActionDigest === digestResolvedAction(action)) {
          return {
            decision: {
              outcome: PermitDecisionOutcome.allow,
              permitId: permit.id,
              grantId: existing.grantId,
              reasons: [],
            },
            authorization: existing,
          };
        }
        return {
          decision: {
            outcome: PermitDecisionOutcome.deny,
            permitId: permit.id,
            reasons: [
              {
                code: PermitReasonCode.idempotencyConflict,
                message: "idempotency key is already bound to a different resolved action",
              },
            ],
          },
        };
      }
    }

    const authorizations = isPermitV2(permit) ? this.listAuthorizationsForPermit(permit.id) : [];
    const parent =
      action.parentAuthorizationId === undefined
        ? undefined
        : this.getAuthorization(action.parentAuthorizationId);
    const decision = evaluateResolvedAction(permit, action, {
      now: this.#clock(),
      acceptSimulation: options.acceptSimulation,
      usage: isPermitV2(permit)
        ? computePermitUsage(permit, authorizations)
        : { permitId: permit.id, grants: [] },
      ...(parent === undefined ? {} : { parentAuthorization: parent }),
    });

    if (decision.outcome !== PermitDecisionOutcome.allow || decision.grantId === undefined) {
      return { decision };
    }
    if (!isPermitV2(permit)) {
      return { decision };
    }

    const paymentIdentity = this.#paymentIdentityFromAction(action);
    if (paymentIdentity !== undefined) {
      const duplicate = this.findActivePaymentIdentity(
        paymentIdentity.adapterId,
        paymentIdentity.externalIdentity,
      );
      if (duplicate !== undefined) {
        return {
          decision: {
            outcome: PermitDecisionOutcome.deny,
            permitId: permit.id,
            reasons: [
              {
                code: PermitReasonCode.duplicatePaymentIdentity,
                message: `payment identity ${paymentIdentity.externalIdentity} is already reserved`,
              },
            ],
          },
        };
      }
    }

    const timestamp = this.#clock();
    const authorization = parseAuthorization({
      id: options.authorizationId ?? this.#idFactory(),
      permitId: permit.id,
      missionId: permit.missionId,
      grantId: decision.grantId,
      actionKind: action.kind,
      resolvedAction: action,
      resolvedActionDigest: digestResolvedAction(action),
      reserved: reservedEconomicsFor(action),
      status: "AUTHORIZED",
      createdAt: timestamp,
      expiresAt: permit.validity.expiresAt,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      ...(action.parentAuthorizationId === undefined
        ? {}
        : { parentAuthorizationId: action.parentAuthorizationId }),
      externalActionAttempted: false,
      environment: action.provenance.environment,
    });

    try {
      this.#database
        .prepare(
          `INSERT INTO authorizations
            (id, permit_id, mission_id, grant_id, action_kind, status, created_at, expires_at,
             idempotency_key, resolved_action_digest, adapter_id, payment_identity, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          authorization.id,
          authorization.permitId,
          authorization.missionId,
          authorization.grantId,
          authorization.actionKind,
          authorization.status,
          authorization.createdAt,
          authorization.expiresAt,
          authorization.idempotencyKey ?? null,
          authorization.resolvedActionDigest,
          paymentIdentity?.adapterId ?? null,
          paymentIdentity?.externalIdentity ?? null,
          JSON.stringify(authorization),
        );
    } catch (error) {
      if (this.#isUniqueConstraint(error)) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("payment_identity") || message.includes("active_payment_identity")) {
          return {
            decision: {
              outcome: PermitDecisionOutcome.deny,
              permitId: permit.id,
              reasons: [
                {
                  code: PermitReasonCode.duplicatePaymentIdentity,
                  message: "payment identity is already reserved",
                },
              ],
            },
          };
        }
        return {
          decision: {
            outcome: PermitDecisionOutcome.deny,
            permitId: permit.id,
            reasons: [
              {
                code: PermitReasonCode.idempotencyConflict,
                message: "idempotency key is already bound to a different resolved action",
              },
            ],
          },
        };
      }
      throw error;
    }
    this.#appendAudit({
      id: options.auditEventId ?? this.#idFactory(),
      timestamp,
      type: "AUTHORIZATION_CREATED",
      missionId: authorization.missionId,
      metadata: {
        authorizationId: authorization.id,
        permitId: authorization.permitId,
        grantId: authorization.grantId,
        actionKind: authorization.actionKind,
        resolvedActionDigest: authorization.resolvedActionDigest,
        reserved: authorization.reserved,
        environment: authorization.environment,
        externalActionAttempted: false,
      },
    });
    return { decision, authorization };
  }

  #paymentIdentityFromAction(
    action: ReturnType<typeof parseResolvedAction>,
  ): { readonly adapterId: string; readonly externalIdentity: string } | undefined {
    if (action.kind !== "value.transfer" || action.preparedOperation === undefined) {
      return undefined;
    }
    return {
      adapterId: action.preparedOperation.adapterId,
      externalIdentity: action.preparedOperation.externalIdentity,
    };
  }

  #isUniqueConstraint(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const code = "code" in error ? String(error.code) : "";
    return (
      code.includes("CONSTRAINT") ||
      error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("SQLITE_CONSTRAINT")
    );
  }

  #transitionAuthorizationStatusLocked(
    existing: Authorization,
    requestedStatus: Authorization["status"],
    options: AuditOptions = {},
  ): Authorization {
    let transition: AuthorizationTransition;
    try {
      transition = transitionAuthorization(existing, requestedStatus);
    } catch (error) {
      if (error instanceof AuthorizationLifecycleError) {
        this.#appendAudit({
          id: options.auditEventId ?? this.#idFactory(),
          timestamp: this.#clock(),
          type: "AUTHORIZATION_TRANSITION_REJECTED",
          missionId: existing.missionId,
          metadata: {
            authorizationId: existing.id,
            code: error.code,
            from: existing.status,
            requested: requestedStatus,
          },
        });
      }
      throw error;
    }
    if (transition.status === existing.status) {
      return existing;
    }
    return this.#persistAuthorizationTransition(existing, transition, this.#clock(), options);
  }

  #persistAuthorizationTransition(
    existing: Authorization,
    transition: AuthorizationTransition,
    timestamp: string,
    options: AuditOptions,
  ): Authorization {
    const updated = parseAuthorization({
      ...existing,
      status: transition.status,
      externalActionAttempted: transition.externalActionAttempted,
    });
    const paymentIdentity = this.#paymentIdentityFromAction(updated.resolvedAction);
    const update = this.#database
      .prepare(
        `UPDATE authorizations
         SET status = ?, adapter_id = ?, payment_identity = ?, data_json = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        updated.status,
        paymentIdentity?.adapterId ?? null,
        paymentIdentity?.externalIdentity ?? null,
        JSON.stringify(updated),
        existing.id,
        existing.status,
      );
    if (update.changes !== 1) {
      throw new Error(`Concurrent Authorization update detected for ${existing.id}`);
    }
    this.#appendAudit({
      id: options.auditEventId ?? this.#idFactory(),
      timestamp,
      type: this.#authorizationAuditType(transition.status),
      missionId: existing.missionId,
      previousState: existing.status,
      newState: updated.status,
      metadata: {
        authorizationId: existing.id,
        permitId: existing.permitId,
        externalActionAttempted: updated.externalActionAttempted,
      },
    });
    return updated;
  }

  #replaceFundingExecution(record: FundingExecutionRecord): void {
    const update = this.#database
      .prepare(
        `UPDATE funding_executions
         SET adapter_id = ?, prepared_operation_digest = ?, external_identity = ?,
             execution_started_at = ?, send_dispatched_at = ?, last_reconciled_at = ?,
             sanitized_state = ?, data_json = ?
         WHERE authorization_id = ?`,
      )
      .run(
        record.adapterId,
        record.preparedOperationDigest,
        record.externalIdentity,
        record.executionStartedAt,
        record.sendDispatchedAt ?? null,
        record.lastReconciledAt ?? null,
        record.sanitizedState,
        JSON.stringify(record),
        record.authorizationId,
      );
    if (update.changes !== 1) {
      throw new Error(`Concurrent funding execution update detected for ${record.authorizationId}`);
    }
  }

  #replaceInstrumentExecution(record: InstrumentExecutionRecord): void {
    const update = this.#database
      .prepare(
        `UPDATE instrument_executions
         SET adapter_id = ?, product_id = ?, authorized_face_value = ?, payment_method = ?,
             execution_started_at = ?, invoice_posted_at = ?, invoice_id = ?, last_reconciled_at = ?,
             sanitized_state = ?, data_json = ?
         WHERE authorization_id = ?`,
      )
      .run(
        record.adapterId,
        record.productId,
        record.authorizedFaceValue,
        record.paymentMethod,
        record.executionStartedAt,
        record.invoicePostedAt ?? null,
        record.invoiceId ?? null,
        record.lastReconciledAt ?? null,
        record.sanitizedState,
        JSON.stringify(record),
        record.authorizationId,
      );
    if (update.changes !== 1) {
      throw new Error(`Concurrent instrument execution update detected for ${record.authorizationId}`);
    }
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

  #getJson<T>(
    query: string,
    params: string | readonly string[],
    parser: (input: unknown) => T,
  ): T | undefined {
    const args = typeof params === "string" ? [params] : params;
    const row = this.#database.prepare(query).get(...args) as JsonRow | undefined;
    return row === undefined ? undefined : parser(JSON.parse(row.data_json) as unknown);
  }

  #allJson<T>(query: string, parser: (input: unknown) => T): readonly T[] {
    const rows = this.#database.prepare(query).all() as unknown as readonly JsonRow[];
    return rows.map((row) => parser(JSON.parse(row.data_json) as unknown));
  }

  #allJsonWithArg<T>(query: string, id: string, parser: (input: unknown) => T): readonly T[] {
    const rows = this.#database.prepare(query).all(id) as unknown as readonly JsonRow[];
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

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}
