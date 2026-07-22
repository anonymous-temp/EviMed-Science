package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"

	storepb "github.com/usememos/memos/proto/gen/store"
)

const (
	maxMemoryEvidence  = 64
	maxMemoryRevisions = 32
)

// ErrMemoryVersionConflict indicates an optimistic concurrency conflict.
var ErrMemoryVersionConflict = errors.New("memory record version conflict")

// MemoryRecord is an atomic structured long-term memory with bounded evidence
// and revision history.
type MemoryRecord struct {
	ID              int32
	UID             string
	CreatorID       int32
	Namespace       string
	ScopeType       string
	ScopeID         string
	Kind            string
	MemoryKey       string
	Value           string
	Summary         string
	Origin          string
	Status          string
	Confidence      float64
	Importance      float64
	Sensitive       bool
	EvidenceCount   int32
	Version         int32
	CreatedTs       int64
	UpdatedTs       int64
	LastConfirmedTs *int64
	ExpiresTs       *int64
	Payload         *storepb.MemoryRecordPayload
}

// FindMemoryRecord filters structured memory queries.
type FindMemoryRecord struct {
	ID         *int32
	UID        *string
	CreatorID  *int32
	Namespace  *string
	ScopeTypes []string
	ScopeID    *string
	Kinds      []string
	Statuses   []string
	MemoryKey  *string
	Query      *string
	Limit      *int
	Offset     *int
}

// UpdateMemoryRecord replaces the current state when ExpectedVersion matches.
type UpdateMemoryRecord struct {
	ID              int32
	Value           string
	Summary         string
	Origin          string
	Status          string
	Confidence      float64
	Importance      float64
	Sensitive       bool
	EvidenceCount   int32
	Version         int32
	ExpectedVersion int32
	UpdatedTs       int64
	LastConfirmedTs *int64
	ExpiresTs       *int64
	Payload         *storepb.MemoryRecordPayload
}

// DeleteMemoryRecord filters records to remove. CreatorID is always required by
// the API layer; Namespace is used for account-wide purge.
type DeleteMemoryRecord struct {
	ID        *int32
	UID       *string
	CreatorID int32
	Namespace *string
}

// MemoryEvidence is a normalized evidence item supplied during an upsert.
type MemoryEvidence struct {
	SourceType string
	SourceRef  string
	Quote      string
	ObservedTs int64
	Weight     float64
}

// UpsertMemoryRecord contains the canonical current state and optional evidence.
type UpsertMemoryRecord struct {
	Record          *MemoryRecord
	Evidence        *MemoryEvidence
	ExpectedVersion int32
	Reason          string
}

// UpsertMemoryRecord creates or updates an atomic memory under a canonical key.
// The store mutex prevents duplicate creation in the supported single-process
// deployment, while version-checked SQL prevents lost updates.
func (s *Store) UpsertMemoryRecord(ctx context.Context, upsert *UpsertMemoryRecord) (*MemoryRecord, error) {
	s.memoryRecordMu.Lock()
	defer s.memoryRecordMu.Unlock()

	record := upsert.Record
	existing, err := s.GetMemoryRecord(ctx, &FindMemoryRecord{
		CreatorID:  &record.CreatorID,
		Namespace:  &record.Namespace,
		ScopeTypes: []string{record.ScopeType},
		ScopeID:    &record.ScopeID,
		Kinds:      []string{record.Kind},
		MemoryKey:  &record.MemoryKey,
	})
	if err != nil {
		return nil, err
	}
	if existing == nil {
		record.Payload = &storepb.MemoryRecordPayload{}
		appendMemoryEvidence(record, upsert.Evidence)
		return s.driver.CreateMemoryRecord(ctx, record)
	}
	if upsert.ExpectedVersion > 0 && upsert.ExpectedVersion != existing.Version {
		return nil, ErrMemoryVersionConflict
	}

	payload := cloneMemoryPayload(existing.Payload)
	changed := appendMemoryEvidencePayload(payload, upsert.Evidence)
	if record.Value != existing.Value || record.Summary != existing.Summary || record.Status != existing.Status {
		payload.Revisions = append(payload.Revisions, &storepb.MemoryRecordPayload_Revision{
			Version:   existing.Version,
			Value:     existing.Value,
			Summary:   existing.Summary,
			Status:    existing.Status,
			ChangedTs: time.Now().Unix(),
			Reason:    strings.TrimSpace(upsert.Reason),
		})
		if len(payload.Revisions) > maxMemoryRevisions {
			payload.Revisions = payload.Revisions[len(payload.Revisions)-maxMemoryRevisions:]
		}
		changed = true
	}
	if !changed && memoryCurrentStateEqual(existing, record) {
		return existing, nil
	}

	updatedTs := time.Now().Unix()
	update := &UpdateMemoryRecord{
		ID:              existing.ID,
		Value:           record.Value,
		Summary:         record.Summary,
		Origin:          record.Origin,
		Status:          record.Status,
		Confidence:      record.Confidence,
		Importance:      record.Importance,
		Sensitive:       record.Sensitive,
		EvidenceCount:   int32(len(payload.Evidence)),
		Version:         existing.Version + 1,
		ExpectedVersion: existing.Version,
		UpdatedTs:       updatedTs,
		LastConfirmedTs: record.LastConfirmedTs,
		ExpiresTs:       record.ExpiresTs,
		Payload:         payload,
	}
	if err := s.driver.UpdateMemoryRecord(ctx, update); err != nil {
		return nil, err
	}
	return s.GetMemoryRecord(ctx, &FindMemoryRecord{ID: &existing.ID, CreatorID: &record.CreatorID})
}

// GetMemoryRecord returns the first matching record.
func (s *Store) GetMemoryRecord(ctx context.Context, find *FindMemoryRecord) (*MemoryRecord, error) {
	limit := 1
	copyFind := *find
	copyFind.Limit = &limit
	records, err := s.driver.ListMemoryRecords(ctx, &copyFind)
	if err != nil || len(records) == 0 {
		return nil, err
	}
	return records[0], nil
}

// ListMemoryRecords returns matching records ordered by relevance-friendly
// current state (importance, confidence, recency).
func (s *Store) ListMemoryRecords(ctx context.Context, find *FindMemoryRecord) ([]*MemoryRecord, error) {
	return s.driver.ListMemoryRecords(ctx, find)
}

// DeleteMemoryRecords deletes all matching records and returns the row count.
func (s *Store) DeleteMemoryRecords(ctx context.Context, delete *DeleteMemoryRecord) (int64, error) {
	return s.driver.DeleteMemoryRecords(ctx, delete)
}

func cloneMemoryPayload(payload *storepb.MemoryRecordPayload) *storepb.MemoryRecordPayload {
	if payload == nil {
		return &storepb.MemoryRecordPayload{}
	}
	return proto.Clone(payload).(*storepb.MemoryRecordPayload)
}

func memoryEvidenceFingerprint(evidence *MemoryEvidence) string {
	if evidence == nil {
		return ""
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(evidence.SourceType),
		strings.TrimSpace(evidence.SourceRef),
		strings.TrimSpace(evidence.Quote),
	}, "\x00")))
	return hex.EncodeToString(sum[:16])
}

func appendMemoryEvidence(record *MemoryRecord, evidence *MemoryEvidence) {
	if record.Payload == nil {
		record.Payload = &storepb.MemoryRecordPayload{}
	}
	appendMemoryEvidencePayload(record.Payload, evidence)
	record.EvidenceCount = int32(len(record.Payload.Evidence))
}

func appendMemoryEvidencePayload(payload *storepb.MemoryRecordPayload, evidence *MemoryEvidence) bool {
	if evidence == nil {
		return false
	}
	fingerprint := memoryEvidenceFingerprint(evidence)
	for _, item := range payload.Evidence {
		if item.Fingerprint == fingerprint {
			return false
		}
	}
	payload.Evidence = append(payload.Evidence, &storepb.MemoryRecordPayload_Evidence{
		SourceType:  strings.TrimSpace(evidence.SourceType),
		SourceRef:   strings.TrimSpace(evidence.SourceRef),
		Quote:       strings.TrimSpace(evidence.Quote),
		ObservedTs:  evidence.ObservedTs,
		Weight:      evidence.Weight,
		Fingerprint: fingerprint,
	})
	if len(payload.Evidence) > maxMemoryEvidence {
		payload.Evidence = payload.Evidence[len(payload.Evidence)-maxMemoryEvidence:]
	}
	return true
}

func memoryCurrentStateEqual(left, right *MemoryRecord) bool {
	return left.Value == right.Value &&
		left.Summary == right.Summary &&
		left.Origin == right.Origin &&
		left.Status == right.Status &&
		left.Confidence == right.Confidence &&
		left.Importance == right.Importance &&
		left.Sensitive == right.Sensitive &&
		equalInt64Pointer(left.LastConfirmedTs, right.LastConfirmedTs) &&
		equalInt64Pointer(left.ExpiresTs, right.ExpiresTs)
}

func equalInt64Pointer(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}
