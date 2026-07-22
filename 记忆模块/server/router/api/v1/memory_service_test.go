package v1

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

func TestMemoryServiceEvidenceVersioningAndIsolation(t *testing.T) {
	ctx := context.Background()
	service := newIntegrationService(t)
	owner, err := service.Store.CreateUser(ctx, &store.User{
		Username: "memory-owner", Role: store.RoleAdmin, Email: "owner@example.com",
	})
	require.NoError(t, err)
	other, err := service.Store.CreateUser(ctx, &store.User{
		Username: "memory-other", Role: store.RoleUser, Email: "other@example.com",
	})
	require.NoError(t, err)
	ownerCtx := userCtx(ctx, owner.ID)
	otherCtx := userCtx(ctx, other.ID)

	firstEvidence := memoryEvidence("messages/1", "Please remember that I prefer concise answers.")
	created, err := service.UpsertMemoryRecord(ownerCtx, &v1pb.UpsertMemoryRecordRequest{
		MemoryRecord: preferenceMemory("Concise answers", "User explicitly prefers concise answers."),
		Evidence:     firstEvidence,
		Reason:       "explicit user preference",
	})
	require.NoError(t, err)
	require.Equal(t, int32(1), created.Version)
	require.Equal(t, int32(1), created.EvidenceCount)
	require.Len(t, created.Evidence, 1)
	require.Empty(t, created.Revisions)

	// Replaying the same extraction is a true no-op: no duplicate evidence and
	// no artificial version growth.
	replayed, err := service.UpsertMemoryRecord(ownerCtx, &v1pb.UpsertMemoryRecordRequest{
		MemoryRecord: preferenceMemory("Concise answers", "User explicitly prefers concise answers."),
		Evidence:     firstEvidence,
	})
	require.NoError(t, err)
	require.Equal(t, int32(1), replayed.Version)
	require.Equal(t, int32(1), replayed.EvidenceCount)

	corroborated, err := service.UpsertMemoryRecord(ownerCtx, &v1pb.UpsertMemoryRecordRequest{
		MemoryRecord:    preferenceMemory("Concise answers", "User explicitly prefers concise answers."),
		Evidence:        memoryEvidence("messages/2", "Keep future responses concise."),
		ExpectedVersion: replayed.Version,
	})
	require.NoError(t, err)
	require.Equal(t, int32(2), corroborated.Version)
	require.Equal(t, int32(2), corroborated.EvidenceCount)
	require.Empty(t, corroborated.Revisions, "new evidence alone must not rewrite current-state history")

	updatedRecord := preferenceMemory("Concise answers with technical detail", "Concise, but preserve necessary technical detail.")
	updated, err := service.UpsertMemoryRecord(ownerCtx, &v1pb.UpsertMemoryRecordRequest{
		MemoryRecord:    updatedRecord,
		Evidence:        memoryEvidence("messages/3", "Be concise, but keep the technical details I need."),
		ExpectedVersion: corroborated.Version,
		Reason:          "user refined the preference",
	})
	require.NoError(t, err)
	require.Equal(t, int32(3), updated.Version)
	require.Equal(t, int32(3), updated.EvidenceCount)
	require.Len(t, updated.Revisions, 1)
	require.Equal(t, int32(2), updated.Revisions[0].Version)
	require.Equal(t, "Concise answers", updated.Revisions[0].Value)

	_, err = service.UpsertMemoryRecord(ownerCtx, &v1pb.UpsertMemoryRecordRequest{
		MemoryRecord:    updatedRecord,
		ExpectedVersion: 1,
	})
	require.Equal(t, codes.Aborted, status.Code(err))

	otherList, err := service.ListMemoryRecords(otherCtx, &v1pb.ListMemoryRecordsRequest{
		Namespace: "evimed-science",
		PageSize:  100,
	})
	require.NoError(t, err)
	require.Empty(t, otherList.MemoryRecords)

	_, err = service.GetMemoryRecord(otherCtx, &v1pb.GetMemoryRecordRequest{Name: updated.Name})
	require.Equal(t, codes.NotFound, status.Code(err))
	_, err = service.DeleteMemoryRecord(otherCtx, &v1pb.DeleteMemoryRecordRequest{Name: updated.Name})
	require.Equal(t, codes.NotFound, status.Code(err))

	purged, err := service.PurgeMemoryRecords(ownerCtx, &v1pb.PurgeMemoryRecordsRequest{Namespace: "evimed-science"})
	require.NoError(t, err)
	require.Equal(t, int32(1), purged.DeletedCount)
	ownerList, err := service.ListMemoryRecords(ownerCtx, &v1pb.ListMemoryRecordsRequest{
		Namespace: "evimed-science",
		PageSize:  100,
	})
	require.NoError(t, err)
	require.Empty(t, ownerList.MemoryRecords)
}

func TestMemoryServiceRequiresAuthentication(t *testing.T) {
	service := newIntegrationService(t)
	_, err := service.ListMemoryRecords(context.Background(), &v1pb.ListMemoryRecordsRequest{
		Namespace: "evimed-science",
	})
	require.Equal(t, codes.Unauthenticated, status.Code(err))
}

func TestMemoryServiceRejectsUnknownEnumValues(t *testing.T) {
	ctx := context.Background()
	service := newIntegrationService(t)
	owner, err := service.Store.CreateUser(ctx, &store.User{
		Username: "memory-enum-owner", Role: store.RoleAdmin, Email: "enum-owner@example.com",
	})
	require.NoError(t, err)
	ownerCtx := userCtx(ctx, owner.ID)

	invalid := preferenceMemory("Concise answers", "User explicitly prefers concise answers.")
	invalid.Scope = v1pb.MemoryScope(99)
	_, err = service.UpsertMemoryRecord(ownerCtx, &v1pb.UpsertMemoryRecordRequest{MemoryRecord: invalid})
	require.Equal(t, codes.InvalidArgument, status.Code(err))

	_, err = service.ListMemoryRecords(ownerCtx, &v1pb.ListMemoryRecordsRequest{
		Namespace: "evimed-science",
		Statuses:  []v1pb.MemoryStatus{v1pb.MemoryStatus(99)},
	})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestDeleteUserPurgesStructuredMemory(t *testing.T) {
	ctx := context.Background()
	service := newIntegrationService(t)
	owner, err := service.Store.CreateUser(ctx, &store.User{
		Username: "memory-delete-owner", Role: store.RoleAdmin, Email: "delete-owner@example.com",
	})
	require.NoError(t, err)
	ownerCtx := userCtx(ctx, owner.ID)
	created, err := service.UpsertMemoryRecord(ownerCtx, &v1pb.UpsertMemoryRecordRequest{
		MemoryRecord: preferenceMemory("Concise answers", "User explicitly prefers concise answers."),
		Evidence:     memoryEvidence("messages/delete", "Please remember that I prefer concise answers."),
	})
	require.NoError(t, err)

	_, err = service.DeleteUser(ownerCtx, &v1pb.DeleteUserRequest{Name: "users/memory-delete-owner"})
	require.NoError(t, err)
	uid, err := ExtractMemoryRecordUIDFromName(created.Name)
	require.NoError(t, err)
	record, err := service.Store.GetMemoryRecord(ctx, &store.FindMemoryRecord{UID: &uid, CreatorID: &owner.ID})
	require.NoError(t, err)
	require.Nil(t, record)
}

func preferenceMemory(value, summary string) *v1pb.MemoryRecord {
	return &v1pb.MemoryRecord{
		Namespace:  "evimed-science",
		Scope:      v1pb.MemoryScope_MEMORY_SCOPE_USER,
		Kind:       v1pb.MemoryKind_MEMORY_KIND_PREFERENCE,
		Key:        "response.conciseness",
		Value:      value,
		Summary:    summary,
		Origin:     v1pb.MemoryOrigin_MEMORY_ORIGIN_EXPLICIT,
		Status:     v1pb.MemoryStatus_MEMORY_STATUS_ACTIVE,
		Confidence: 1,
		Importance: 0.8,
	}
}

func memoryEvidence(sourceRef, quote string) *v1pb.MemoryEvidence {
	return &v1pb.MemoryEvidence{
		SourceType:   "conversation_message",
		SourceRef:    sourceRef,
		Quote:        quote,
		ObservedTime: timestamppb.New(time.Now()),
		Weight:       1,
	}
}
