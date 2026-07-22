package v1

import (
	"context"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

var (
	memoryNamespacePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{2,127}$`)
	memoryKeyPattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]{0,254}$`)
)

// UpsertMemoryRecord creates or atomically updates an evidence-backed memory.
func (s *APIV1Service) UpsertMemoryRecord(ctx context.Context, request *v1pb.UpsertMemoryRecordRequest) (*v1pb.MemoryRecord, error) {
	user, err := s.requireMemoryUser(ctx)
	if err != nil {
		return nil, err
	}
	if request.MemoryRecord == nil {
		return nil, status.Errorf(codes.InvalidArgument, "memory_record is required")
	}
	if request.ExpectedVersion < 0 {
		return nil, status.Errorf(codes.InvalidArgument, "expected_version must not be negative")
	}
	record, err := validateMemoryRecordInput(request.MemoryRecord, user.ID)
	if err != nil {
		return nil, err
	}
	evidence, err := validateMemoryEvidenceInput(request.Evidence)
	if err != nil {
		return nil, err
	}
	if len(request.Reason) > 500 {
		return nil, status.Errorf(codes.InvalidArgument, "reason is too long")
	}
	result, err := s.Store.UpsertMemoryRecord(ctx, &store.UpsertMemoryRecord{
		Record:          record,
		Evidence:        evidence,
		ExpectedVersion: request.ExpectedVersion,
		Reason:          strings.TrimSpace(request.Reason),
	})
	if errors.Is(err, store.ErrMemoryVersionConflict) {
		return nil, status.Errorf(codes.Aborted, "memory record version conflict")
	}
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to upsert memory record")
	}
	return convertMemoryRecordFromStore(result), nil
}

// GetMemoryRecord returns an owned structured memory.
func (s *APIV1Service) GetMemoryRecord(ctx context.Context, request *v1pb.GetMemoryRecordRequest) (*v1pb.MemoryRecord, error) {
	user, err := s.requireMemoryUser(ctx)
	if err != nil {
		return nil, err
	}
	uid, err := ExtractMemoryRecordUIDFromName(request.Name)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid memory record name")
	}
	record, err := s.Store.GetMemoryRecord(ctx, &store.FindMemoryRecord{UID: &uid, CreatorID: &user.ID})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get memory record")
	}
	if record == nil {
		return nil, status.Errorf(codes.NotFound, "memory record not found")
	}
	return convertMemoryRecordFromStore(record), nil
}

// ListMemoryRecords returns namespace-scoped memories owned by the caller.
func (s *APIV1Service) ListMemoryRecords(ctx context.Context, request *v1pb.ListMemoryRecordsRequest) (*v1pb.ListMemoryRecordsResponse, error) {
	user, err := s.requireMemoryUser(ctx)
	if err != nil {
		return nil, err
	}
	namespace := strings.TrimSpace(request.Namespace)
	if !memoryNamespacePattern.MatchString(namespace) {
		return nil, status.Errorf(codes.InvalidArgument, "namespace is invalid")
	}
	if !validMemoryScopes(request.Scopes) || !validMemoryKinds(request.Kinds) || !validMemoryStatuses(request.Statuses) {
		return nil, status.Errorf(codes.InvalidArgument, "memory filter enum is invalid")
	}
	pageToken := &v1pb.PageToken{}
	if request.PageToken != "" {
		if err := unmarshalPageToken(request.PageToken, pageToken); err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "page_token is invalid")
		}
		if pageToken.Offset < 0 {
			return nil, status.Errorf(codes.InvalidArgument, "page_token is invalid")
		}
	}
	limit := normalizePageSize(request.PageSize)
	offset := int(pageToken.Offset)
	find := &store.FindMemoryRecord{
		CreatorID:  &user.ID,
		Namespace:  &namespace,
		ScopeTypes: memoryScopeStrings(request.Scopes),
		Kinds:      memoryKindStrings(request.Kinds),
		Statuses:   memoryStatusStrings(request.Statuses),
		Limit:      &limit,
		Offset:     &offset,
	}
	if request.ScopeId != "" {
		scopeID := strings.TrimSpace(request.ScopeId)
		find.ScopeID = &scopeID
	}
	if request.Query != "" {
		query := strings.TrimSpace(request.Query)
		if len(query) > 500 {
			return nil, status.Errorf(codes.InvalidArgument, "query is too long")
		}
		find.Query = &query
	}
	records, err := s.Store.ListMemoryRecords(ctx, find)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list memory records")
	}
	response := &v1pb.ListMemoryRecordsResponse{}
	for _, record := range records {
		response.MemoryRecords = append(response.MemoryRecords, convertMemoryRecordFromStore(record))
	}
	if len(records) == limit {
		response.NextPageToken, err = getPageToken(limit, offset+limit)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to create page token")
		}
	}
	return response, nil
}

// DeleteMemoryRecord deletes one owned structured memory.
func (s *APIV1Service) DeleteMemoryRecord(ctx context.Context, request *v1pb.DeleteMemoryRecordRequest) (*emptypb.Empty, error) {
	user, err := s.requireMemoryUser(ctx)
	if err != nil {
		return nil, err
	}
	uid, err := ExtractMemoryRecordUIDFromName(request.Name)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid memory record name")
	}
	count, err := s.Store.DeleteMemoryRecords(ctx, &store.DeleteMemoryRecord{UID: &uid, CreatorID: user.ID})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to delete memory record")
	}
	if count == 0 {
		return nil, status.Errorf(codes.NotFound, "memory record not found")
	}
	return &emptypb.Empty{}, nil
}

// PurgeMemoryRecords removes every memory in an integration namespace.
func (s *APIV1Service) PurgeMemoryRecords(ctx context.Context, request *v1pb.PurgeMemoryRecordsRequest) (*v1pb.PurgeMemoryRecordsResponse, error) {
	user, err := s.requireMemoryUser(ctx)
	if err != nil {
		return nil, err
	}
	namespace := strings.TrimSpace(request.Namespace)
	if !memoryNamespacePattern.MatchString(namespace) {
		return nil, status.Errorf(codes.InvalidArgument, "namespace is invalid")
	}
	count, err := s.Store.DeleteMemoryRecords(ctx, &store.DeleteMemoryRecord{CreatorID: user.ID, Namespace: &namespace})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to purge memory records")
	}
	if count > math.MaxInt32 {
		return nil, status.Errorf(codes.Internal, "deleted memory record count exceeds the response limit")
	}
	return &v1pb.PurgeMemoryRecordsResponse{DeletedCount: int32(count)}, nil
}

func (s *APIV1Service) requireMemoryUser(ctx context.Context) (*store.User, error) {
	user, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get user")
	}
	if user == nil {
		return nil, status.Errorf(codes.Unauthenticated, "user not authenticated")
	}
	return user, nil
}

func validateMemoryRecordInput(input *v1pb.MemoryRecord, creatorID int32) (*store.MemoryRecord, error) {
	namespace := strings.TrimSpace(input.Namespace)
	if !memoryNamespacePattern.MatchString(namespace) {
		return nil, status.Errorf(codes.InvalidArgument, "namespace is invalid")
	}
	if !validMemoryScope(input.Scope) || !validMemoryKind(input.Kind) {
		return nil, status.Errorf(codes.InvalidArgument, "scope and kind are required")
	}
	if !validMemoryOrigin(input.Origin) || !validMemoryStatus(input.Status) {
		return nil, status.Errorf(codes.InvalidArgument, "origin and status are required")
	}
	scopeID := strings.TrimSpace(input.ScopeId)
	if input.Scope == v1pb.MemoryScope_MEMORY_SCOPE_USER {
		scopeID = ""
	} else if scopeID == "" {
		return nil, status.Errorf(codes.InvalidArgument, "scope_id is required for non-user memory")
	}
	if len(scopeID) > 255 {
		return nil, status.Errorf(codes.InvalidArgument, "scope_id is too long")
	}
	key := strings.ToLower(strings.TrimSpace(input.Key))
	if !memoryKeyPattern.MatchString(key) {
		return nil, status.Errorf(codes.InvalidArgument, "key is invalid")
	}
	value := strings.TrimSpace(input.Value)
	if value == "" || len(value) > 100_000 {
		return nil, status.Errorf(codes.InvalidArgument, "value is empty or too long")
	}
	summary := strings.TrimSpace(input.Summary)
	if len(summary) > 2_000 {
		return nil, status.Errorf(codes.InvalidArgument, "summary is too long")
	}
	if !validMemoryScore(input.Confidence) || !validMemoryScore(input.Importance) {
		return nil, status.Errorf(codes.InvalidArgument, "confidence and importance must be between zero and one")
	}
	uid := ""
	if input.Name != "" {
		var err error
		uid, err = ExtractMemoryRecordUIDFromName(input.Name)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid memory record name")
		}
	}
	uid, err := ValidateAndGenerateUID(uid)
	if err != nil {
		return nil, err
	}
	record := &store.MemoryRecord{
		UID:        uid,
		CreatorID:  creatorID,
		Namespace:  namespace,
		ScopeType:  input.Scope.String(),
		ScopeID:    scopeID,
		Kind:       input.Kind.String(),
		MemoryKey:  key,
		Value:      value,
		Summary:    summary,
		Origin:     input.Origin.String(),
		Status:     input.Status.String(),
		Confidence: input.Confidence,
		Importance: input.Importance,
		Sensitive:  input.Sensitive,
		Version:    1,
	}
	if input.LastConfirmedTime != nil {
		if err := input.LastConfirmedTime.CheckValid(); err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "last_confirmed_time is invalid")
		}
		value := input.LastConfirmedTime.AsTime().Unix()
		record.LastConfirmedTs = &value
	}
	if input.ExpireTime != nil {
		if err := input.ExpireTime.CheckValid(); err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "expire_time is invalid")
		}
		value := input.ExpireTime.AsTime().Unix()
		record.ExpiresTs = &value
	}
	return record, nil
}

func validateMemoryEvidenceInput(input *v1pb.MemoryEvidence) (*store.MemoryEvidence, error) {
	if input == nil {
		return nil, nil
	}
	sourceType := strings.TrimSpace(input.SourceType)
	sourceRef := strings.TrimSpace(input.SourceRef)
	quote := strings.TrimSpace(input.Quote)
	if sourceType == "" || len(sourceType) > 64 || sourceRef == "" || len(sourceRef) > 500 || quote == "" || len(quote) > 4_000 {
		return nil, status.Errorf(codes.InvalidArgument, "memory evidence is invalid")
	}
	if input.ObservedTime == nil || input.ObservedTime.CheckValid() != nil {
		return nil, status.Errorf(codes.InvalidArgument, "evidence observed_time is invalid")
	}
	if !validMemoryScore(input.Weight) {
		return nil, status.Errorf(codes.InvalidArgument, "evidence weight must be between zero and one")
	}
	return &store.MemoryEvidence{
		SourceType: sourceType,
		SourceRef:  sourceRef,
		Quote:      quote,
		ObservedTs: input.ObservedTime.AsTime().Unix(),
		Weight:     input.Weight,
	}, nil
}

func validMemoryScore(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}

func validMemoryScope(value v1pb.MemoryScope) bool {
	switch value {
	case v1pb.MemoryScope_MEMORY_SCOPE_USER,
		v1pb.MemoryScope_MEMORY_SCOPE_PROJECT,
		v1pb.MemoryScope_MEMORY_SCOPE_SESSION,
		v1pb.MemoryScope_MEMORY_SCOPE_ORGANIZATION:
		return true
	default:
		return false
	}
}

func validMemoryKind(value v1pb.MemoryKind) bool {
	switch value {
	case v1pb.MemoryKind_MEMORY_KIND_PROFILE,
		v1pb.MemoryKind_MEMORY_KIND_PREFERENCE,
		v1pb.MemoryKind_MEMORY_KIND_BEHAVIOR,
		v1pb.MemoryKind_MEMORY_KIND_PROJECT_FACT,
		v1pb.MemoryKind_MEMORY_KIND_ANALYSIS,
		v1pb.MemoryKind_MEMORY_KIND_DECISION,
		v1pb.MemoryKind_MEMORY_KIND_CORRECTION,
		v1pb.MemoryKind_MEMORY_KIND_FOLLOW_UP,
		v1pb.MemoryKind_MEMORY_KIND_RUN_SUMMARY:
		return true
	default:
		return false
	}
}

func validMemoryOrigin(value v1pb.MemoryOrigin) bool {
	switch value {
	case v1pb.MemoryOrigin_MEMORY_ORIGIN_EXPLICIT,
		v1pb.MemoryOrigin_MEMORY_ORIGIN_INFERRED,
		v1pb.MemoryOrigin_MEMORY_ORIGIN_SYSTEM,
		v1pb.MemoryOrigin_MEMORY_ORIGIN_MANUAL:
		return true
	default:
		return false
	}
}

func validMemoryStatus(value v1pb.MemoryStatus) bool {
	switch value {
	case v1pb.MemoryStatus_MEMORY_STATUS_ACTIVE,
		v1pb.MemoryStatus_MEMORY_STATUS_PENDING,
		v1pb.MemoryStatus_MEMORY_STATUS_SUPERSEDED,
		v1pb.MemoryStatus_MEMORY_STATUS_ARCHIVED:
		return true
	default:
		return false
	}
}

func validMemoryScopes(values []v1pb.MemoryScope) bool {
	for _, value := range values {
		if !validMemoryScope(value) {
			return false
		}
	}
	return true
}

func validMemoryKinds(values []v1pb.MemoryKind) bool {
	for _, value := range values {
		if !validMemoryKind(value) {
			return false
		}
	}
	return true
}

func validMemoryStatuses(values []v1pb.MemoryStatus) bool {
	for _, value := range values {
		if !validMemoryStatus(value) {
			return false
		}
	}
	return true
}

func memoryScopeStrings(values []v1pb.MemoryScope) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != v1pb.MemoryScope_MEMORY_SCOPE_UNSPECIFIED {
			result = append(result, value.String())
		}
	}
	return result
}

func memoryKindStrings(values []v1pb.MemoryKind) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != v1pb.MemoryKind_MEMORY_KIND_UNSPECIFIED {
			result = append(result, value.String())
		}
	}
	return result
}

func memoryStatusStrings(values []v1pb.MemoryStatus) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != v1pb.MemoryStatus_MEMORY_STATUS_UNSPECIFIED {
			result = append(result, value.String())
		}
	}
	return result
}

func convertMemoryRecordFromStore(record *store.MemoryRecord) *v1pb.MemoryRecord {
	result := &v1pb.MemoryRecord{
		Name:          MemoryRecordNamePrefix + record.UID,
		Namespace:     record.Namespace,
		Scope:         v1pb.MemoryScope(v1pb.MemoryScope_value[record.ScopeType]),
		ScopeId:       record.ScopeID,
		Kind:          v1pb.MemoryKind(v1pb.MemoryKind_value[record.Kind]),
		Key:           record.MemoryKey,
		Value:         record.Value,
		Summary:       record.Summary,
		Origin:        v1pb.MemoryOrigin(v1pb.MemoryOrigin_value[record.Origin]),
		Status:        v1pb.MemoryStatus(v1pb.MemoryStatus_value[record.Status]),
		Confidence:    record.Confidence,
		Importance:    record.Importance,
		Sensitive:     record.Sensitive,
		EvidenceCount: record.EvidenceCount,
		Version:       record.Version,
		CreateTime:    timestamppb.New(time.Unix(record.CreatedTs, 0)),
		UpdateTime:    timestamppb.New(time.Unix(record.UpdatedTs, 0)),
	}
	if record.LastConfirmedTs != nil {
		result.LastConfirmedTime = timestamppb.New(time.Unix(*record.LastConfirmedTs, 0))
	}
	if record.ExpiresTs != nil {
		result.ExpireTime = timestamppb.New(time.Unix(*record.ExpiresTs, 0))
	}
	payload := record.Payload
	if payload == nil {
		payload = &storepb.MemoryRecordPayload{}
	}
	for _, item := range payload.Evidence {
		result.Evidence = append(result.Evidence, &v1pb.MemoryEvidence{
			SourceType:   item.SourceType,
			SourceRef:    item.SourceRef,
			Quote:        item.Quote,
			ObservedTime: timestamppb.New(time.Unix(item.ObservedTs, 0)),
			Weight:       item.Weight,
			Fingerprint:  item.Fingerprint,
		})
	}
	for _, item := range payload.Revisions {
		result.Revisions = append(result.Revisions, &v1pb.MemoryRevision{
			Version:     item.Version,
			Value:       item.Value,
			Summary:     item.Summary,
			Status:      v1pb.MemoryStatus(v1pb.MemoryStatus_value[item.Status]),
			ChangedTime: timestamppb.New(time.Unix(item.ChangedTs, 0)),
			Reason:      item.Reason,
		})
	}
	return result
}
