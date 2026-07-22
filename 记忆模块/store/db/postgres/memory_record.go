package postgres

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

const postgresMemoryRecordFields = `
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
	err = d.db.QueryRowContext(ctx, `INSERT INTO memory_record (
		uid, creator_id, namespace, scope_type, scope_id, kind, memory_key,
		value, summary, origin, status, confidence, importance, sensitive,
		evidence_count, version, created_ts, updated_ts, last_confirmed_ts,
		expires_ts, payload
	) VALUES (
		$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
		$14, $15, $16, $17, $18, $19, $20, $21
	) RETURNING id, created_ts, updated_ts, version`,
		create.UID, create.CreatorID, create.Namespace, create.ScopeType, create.ScopeID,
		create.Kind, create.MemoryKey, create.Value, create.Summary, create.Origin,
		create.Status, create.Confidence, create.Importance, create.Sensitive,
		create.EvidenceCount, create.Version, create.CreatedTs, create.UpdatedTs,
		create.LastConfirmedTs, create.ExpiresTs, payload,
	).Scan(&create.ID, &create.CreatedTs, &create.UpdatedTs, &create.Version)
	if err != nil {
		return nil, errors.Wrap(err, "create memory record")
	}
	return create, nil
}

func (d *DB) ListMemoryRecords(ctx context.Context, find *store.FindMemoryRecord) ([]*store.MemoryRecord, error) {
	where := []string{"1 = 1"}
	args := []any{}
	bind := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if find.ID != nil {
		where = append(where, "id = "+bind(*find.ID))
	}
	if find.UID != nil {
		where = append(where, "uid = "+bind(*find.UID))
	}
	if find.CreatorID != nil {
		where = append(where, "creator_id = "+bind(*find.CreatorID))
	}
	if find.Namespace != nil {
		where = append(where, "namespace = "+bind(*find.Namespace))
	}
	appendPostgresMemoryIn(&where, "scope_type", find.ScopeTypes, bind)
	if find.ScopeID != nil {
		where = append(where, "scope_id = "+bind(*find.ScopeID))
	}
	appendPostgresMemoryIn(&where, "kind", find.Kinds, bind)
	appendPostgresMemoryIn(&where, "status", find.Statuses, bind)
	if find.MemoryKey != nil {
		where = append(where, "memory_key = "+bind(*find.MemoryKey))
	}
	if find.Query != nil && strings.TrimSpace(*find.Query) != "" {
		term := "%" + strings.TrimSpace(*find.Query) + "%"
		placeholder := bind(term)
		where = append(where, "(memory_key ILIKE "+placeholder+" OR summary ILIKE "+placeholder+" OR value ILIKE "+placeholder+")")
	}

	query := "SELECT " + postgresMemoryRecordFields + " FROM memory_record WHERE " + strings.Join(where, " AND ") +
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
		record, err := scanPostgresMemoryRecord(rows.Scan)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func appendPostgresMemoryIn(where *[]string, field string, values []string, bind func(any) string) {
	if len(values) == 0 {
		return
	}
	placeholders := make([]string, 0, len(values))
	for _, value := range values {
		placeholders = append(placeholders, bind(value))
	}
	*where = append(*where, field+" IN ("+strings.Join(placeholders, ",")+")")
}

type postgresMemoryScanner func(dest ...any) error

func scanPostgresMemoryRecord(scan postgresMemoryScanner) (*store.MemoryRecord, error) {
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
		value = $1, summary = $2, origin = $3, status = $4, confidence = $5,
		importance = $6, sensitive = $7, evidence_count = $8, version = $9,
		updated_ts = $10, last_confirmed_ts = $11, expires_ts = $12, payload = $13
		WHERE id = $14 AND version = $15`,
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
	where := []string{"creator_id = $1"}
	args := []any{delete.CreatorID}
	bind := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if delete.ID != nil {
		where = append(where, "id = "+bind(*delete.ID))
	}
	if delete.UID != nil {
		where = append(where, "uid = "+bind(*delete.UID))
	}
	if delete.Namespace != nil {
		where = append(where, "namespace = "+bind(*delete.Namespace))
	}
	result, err := d.db.ExecContext(ctx, "DELETE FROM memory_record WHERE "+strings.Join(where, " AND "), args...)
	if err != nil {
		return 0, errors.Wrap(err, "delete memory records")
	}
	return result.RowsAffected()
}
