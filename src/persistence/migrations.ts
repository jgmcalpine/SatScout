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
];
