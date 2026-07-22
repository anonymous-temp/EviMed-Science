CREATE TABLE memory_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  value TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)) DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  last_confirmed_ts BIGINT,
  expires_ts BIGINT,
  payload TEXT NOT NULL DEFAULT '{}',
  UNIQUE(creator_id, namespace, scope_type, scope_id, kind, memory_key)
);

CREATE INDEX idx_memory_record_namespace_status
  ON memory_record(creator_id, namespace, status, updated_ts DESC);
CREATE INDEX idx_memory_record_scope
  ON memory_record(creator_id, namespace, scope_type, scope_id, kind);
