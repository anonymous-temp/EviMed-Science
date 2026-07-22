package mysql

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/pkg/errors"
	"google.golang.org/protobuf/encoding/protojson"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

const mysqlMemoryRecordFields = `
	id, uid, creator_id, namespace, scope_type, scope_id, kind, memory_key,
	value, summary, origin, status, confidence, importance, sensitive,
	evidence_count, version, created_ts, updated_ts, last_confirmed_ts,
	expires_ts, payload`

func (d *DB) CreateMemoryRecord(ctx context.Context, create *store.MemoryRecord) (*store.MemoryRecord, error) {
	payload, err := protojson.Marshal(create.Payload)
	if err != nil {
		return nil, errors.Wrap(err, "marshal memory payload")
	}
	now := time.Now().Unix()
	if create.CreatedTs == 0 {
		create.CreatedTs = now
	}
	if create.UpdatedTs == 0 {
		create.UpdatedTs = create.CreatedTs
	}
	result, err := d.db.ExecContext(ctx, `INSERT INTO memory_record (
		uid, creator_id, namespace, scope_type, scope_id, kind, memory_key,
		value, summary, origin, status, confidence, importance, sensitive,
		evidence_count, version, created_ts, updated_ts, last_confirmed_ts,
		expires_ts, payload
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		create.UID, create.CreatorID, create.Namespace, create.ScopeType, create.ScopeID,
		create.Kind, create.MemoryKey, create.Value, create.Summary, create.Origin,
		create.Status, create.Confidence, create.Importance, create.Sensitive,
		create.EvidenceCount, create.Version, create.CreatedTs, create.UpdatedTs,
		create.LastConfirmedTs, create.ExpiresTs, payload,
	)
	if err != nil {
		return nil, errors.Wrap(err, "create memory record")
	}
	id, err := result.LastInsertId()
	if err != nil {
		return nil, errors.Wrap(err, "read memory record id")
	}
	create.ID = int32(id)
	return create, nil
}

func (d *DB) ListMemoryRecords(ctx context.Context, find *store.FindMemoryRecord) ([]*store.MemoryRecord, error) {
	where := []string{"1 = 1"}
	args := []any{}
	add := func(condition string, value any) {
		where = append(where, condition)
		args = append(args, value)
	}
	if find.ID != nil {
		add("id = ?", *find.ID)
	}
	if find.UID != nil {
		add("uid = ?", *find.UID)
	}
	if find.CreatorID != nil {
		add("creator_id = ?", *find.CreatorID)
	}
	if find.Namespace != nil {
		add("namespace = ?", *find.Namespace)
	}
	appendMySQLMemoryIn(&where, &args, "scope_type", find.ScopeTypes)
	if find.ScopeID != nil {
		add("scope_id = ?", *find.ScopeID)
	}
	appendMySQLMemoryIn(&where, &args, "kind", find.Kinds)
	appendMySQLMemoryIn(&where, &args, "status", find.Statuses)
	if find.MemoryKey != nil {
		add("memory_key = ?", *find.MemoryKey)
	}
	if find.Query != nil && strings.TrimSpace(*find.Query) != "" {
		term := "%" + strings.ToLower(strings.TrimSpace(*find.Query)) + "%"
		where = append(where, "(lower(memory_key) LIKE ? OR lower(summary) LIKE ? OR lower(value) LIKE ?)")
		args = append(args, term, term, term)
	}

	query := "SELECT " + mysqlMemoryRecordFields + " FROM memory_record WHERE " + strings.Join(where, " AND ") +
		" ORDER BY importance DESC, confidence DESC, updated_ts DESC, id DESC"
	if find.Limit != nil {
		query += fmt.Sprintf(" LIMIT %d", *find.Limit)
		if find.Offset != nil {
			query += fmt.Sprintf(" OFFSET %d", *find.Offset)
		}
	}
	rows, err := d.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, errors.Wrap(err, "list memory records")
	}
	defer rows.Close()
	records := []*store.MemoryRecord{}
	for rows.Next() {
		record, err := scanMySQLMemoryRecord(rows.Scan)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func appendMySQLMemoryIn(where *[]string, args *[]any, field string, values []string) {
	if len(values) == 0 {
		return
	}
	placeholders := make([]string, 0, len(values))
	for _, value := range values {
		placeholders = append(placeholders, "?")
		*args = append(*args, value)
	}
	*where = append(*where, field+" IN ("+strings.Join(placeholders, ",")+")")
}

type mysqlMemoryScanner func(dest ...any) error

func scanMySQLMemoryRecord(scan mysqlMemoryScanner) (*store.MemoryRecord, error) {
	record := &store.MemoryRecord{}
	var payload []byte
	if err := scan(
		&record.ID, &record.UID, &record.CreatorID, &record.Namespace,
		&record.ScopeType, &record.ScopeID, &record.Kind, &record.MemoryKey,
		&record.Value, &record.Summary, &record.Origin, &record.Status,
		&record.Confidence, &record.Importance, &record.Sensitive,
		&record.EvidenceCount, &record.Version, &record.CreatedTs, &record.UpdatedTs,
		&record.LastConfirmedTs, &record.ExpiresTs, &payload,
	); err != nil {
		return nil, errors.Wrap(err, "scan memory record")
	}
	record.Payload = &storepb.MemoryRecordPayload{}
	if err := protojson.Unmarshal(payload, record.Payload); err != nil {
		return nil, errors.Wrap(err, "unmarshal memory payload")
	}
	return record, nil
}

func (d *DB) UpdateMemoryRecord(ctx context.Context, update *store.UpdateMemoryRecord) error {
	payload, err := protojson.Marshal(update.Payload)
	if err != nil {
		return errors.Wrap(err, "marshal memory payload")
	}
	result, err := d.db.ExecContext(ctx, `UPDATE memory_record SET
		value = ?, summary = ?, origin = ?, status = ?, confidence = ?,
		importance = ?, sensitive = ?, evidence_count = ?, version = ?,
		updated_ts = ?, last_confirmed_ts = ?, expires_ts = ?, payload = ?
		WHERE id = ? AND version = ?`,
		update.Value, update.Summary, update.Origin, update.Status, update.Confidence,
		update.Importance, update.Sensitive, update.EvidenceCount, update.Version,
		update.UpdatedTs, update.LastConfirmedTs, update.ExpiresTs, payload,
		update.ID, update.ExpectedVersion,
	)
	if err != nil {
		return errors.Wrap(err, "update memory record")
	}
	count, err := result.RowsAffected()
	if err != nil {
		return errors.Wrap(err, "read updated memory row count")
	}
	if count != 1 {
		return store.ErrMemoryVersionConflict
	}
	return nil
}

func (d *DB) DeleteMemoryRecords(ctx context.Context, delete *store.DeleteMemoryRecord) (int64, error) {
	where := []string{"creator_id = ?"}
	args := []any{delete.CreatorID}
	if delete.ID != nil {
		where = append(where, "id = ?")
		args = append(args, *delete.ID)
	}
	if delete.UID != nil {
		where = append(where, "uid = ?")
		args = append(args, *delete.UID)
	}
	if delete.Namespace != nil {
		where = append(where, "namespace = ?")
		args = append(args, *delete.Namespace)
	}
	result, err := d.db.ExecContext(ctx, "DELETE FROM memory_record WHERE "+strings.Join(where, " AND "), args...)
	if err != nil {
		return 0, errors.Wrap(err, "delete memory records")
	}
	return result.RowsAffected()
}
