export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_domain_and_audit_schema",
    sql: `
      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type = 'book-campsite'),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        expires_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      CREATE TABLE permits (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL UNIQUE REFERENCES missions(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      CREATE TABLE booking_attempts (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        UNIQUE (id, mission_id)
      ) STRICT;

      CREATE TABLE purchase_intents (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES booking_attempts(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES booking_attempts(id) ON DELETE RESTRICT,
        purchase_intent_id TEXT NOT NULL REFERENCES purchase_intents(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      CREATE TABLE reservations (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES booking_attempts(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        external_confirmation_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
        attempt_id TEXT REFERENCES booking_attempts(id) ON DELETE RESTRICT,
        previous_state TEXT,
        new_state TEXT,
        metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
      ) STRICT;

      CREATE INDEX audit_events_mission_sequence
        ON audit_events (mission_id, sequence);
      CREATE INDEX purchase_intents_attempt
        ON purchase_intents (attempt_id);

      CREATE TRIGGER audit_events_are_append_only_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;

      CREATE TRIGGER audit_events_are_append_only_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;
    `,
  },
  {
    version: 2,
    name: "permit_v2_and_authorization_ledger",
    sql: `
      CREATE TABLE permits_v2 (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
        schema_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'REVOKED')),
        created_at TEXT NOT NULL,
        activated_at TEXT,
        revoked_at TEXT,
        expires_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      INSERT INTO permits_v2 (
        id, mission_id, schema_version, status, created_at, activated_at, revoked_at, expires_at, data_json
      )
      SELECT
        id,
        mission_id,
        1,
        'ACTIVE',
        created_at,
        created_at,
        NULL,
        expires_at,
        data_json
      FROM permits;

      DROP TABLE permits;
      ALTER TABLE permits_v2 RENAME TO permits;

      CREATE INDEX permits_mission_id ON permits (mission_id);
      CREATE UNIQUE INDEX permits_one_active_per_mission
        ON permits (mission_id) WHERE status = 'ACTIVE';

      CREATE TABLE authorizations (
        id TEXT PRIMARY KEY,
        permit_id TEXT NOT NULL REFERENCES permits(id) ON DELETE RESTRICT,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
        grant_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        idempotency_key TEXT,
        resolved_action_digest TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      CREATE INDEX authorizations_permit ON authorizations (permit_id);
      CREATE INDEX authorizations_mission ON authorizations (mission_id);
      CREATE UNIQUE INDEX authorizations_idempotency
        ON authorizations (permit_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: "funding_executions_and_payment_identity",
    sql: `
      ALTER TABLE authorizations ADD COLUMN adapter_id TEXT;
      ALTER TABLE authorizations ADD COLUMN payment_identity TEXT;

      CREATE UNIQUE INDEX authorizations_active_payment_identity
        ON authorizations (adapter_id, payment_identity)
        WHERE adapter_id IS NOT NULL
          AND payment_identity IS NOT NULL
          AND status IN ('AUTHORIZED', 'EXECUTING', 'AMBIGUOUS', 'SUCCEEDED', 'FAILED_SAFE');

      CREATE TABLE funding_executions (
        authorization_id TEXT PRIMARY KEY REFERENCES authorizations(id) ON DELETE RESTRICT,
        adapter_id TEXT NOT NULL,
        prepared_operation_digest TEXT NOT NULL,
        external_identity TEXT NOT NULL,
        execution_started_at TEXT NOT NULL,
        send_dispatched_at TEXT,
        last_reconciled_at TEXT,
        sanitized_state TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      CREATE UNIQUE INDEX funding_executions_payment_identity
        ON funding_executions (adapter_id, external_identity);

      CREATE INDEX funding_executions_adapter_identity
        ON funding_executions (adapter_id, external_identity);
    `,
  },
];
