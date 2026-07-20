import { useQueryClient } from "@tanstack/react-query";
import copy from "copy-to-clipboard";
import { useCallback } from "react";
import toast from "react-hot-toast";
import { useLocation } from "react-router-dom";
import { useInstance } from "@/contexts/InstanceContext";
import { memoKeys, removeMemoFromCollectionQueries, useDeleteMemo, useUpdateMemo } from "@/hooks/useMemoQueries";
import useNavigateTo from "@/hooks/useNavigateTo";
import { userKeys } from "@/hooks/useUserQueries";
import { handleError } from "@/lib/error";
import { ROUTES } from "@/router/routes";
import { State } from "@/types/proto/api/v1/common_pb";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import { checkAllTasks, uncheckAllTasks } from "@/utils/markdown-task-actions";

interface UseMemoActionHandlersOptions {
  memo: Memo;
  onEdit?: () => void;
}

// Delete-with-undo: the memo leaves the list caches immediately, but the server
// delete only fires when the undo window closes. Module-level so a pending
// delete survives the menu (or its memo card) unmounting.
const DELETE_UNDO_WINDOW_MS = 6000;
const pendingMemoDeletes = new Map<string, ReturnType<typeof setTimeout>>();

export const useMemoActionHandlers = ({ memo, onEdit }: UseMemoActionHandlersOptions) => {
  const t = useTranslate();
  const location = useLocation();
  const navigateTo = useNavigateTo();
  const queryClient = useQueryClient();
  const { profile } = useInstance();
  const { mutateAsync: updateMemo } = useUpdateMemo();
  const { mutateAsync: deleteMemo } = useDeleteMemo();
  const isInMemoDetailPage = location.pathname.startsWith(`/${memo.name}`);

  const memoUpdatedCallback = useCallback(() => {
    // Invalidate user stats to trigger refetch
    queryClient.invalidateQueries({ queryKey: userKeys.stats() });
  }, [queryClient]);

  const updateMemoContent = useCallback(
    async (nextContent: string, context: string) => {
      if (nextContent === memo.content) {
        return;
      }

      try {
        await updateMemo({
          update: {
            name: memo.name,
            content: nextContent,
          },
          updateMask: ["content", "update_time"],
        });
        toast.success(t("memo.task-actions.updated"));
      } catch (error: unknown) {
        handleError(error, toast.error, {
          context,
          fallbackMessage: "An error occurred",
        });
      }
    },
    [memo.content, memo.name, t, updateMemo],
  );

  const handleTogglePinMemoBtnClick = useCallback(async () => {
    try {
      await updateMemo({
        update: {
          name: memo.name,
          pinned: !memo.pinned,
        },
        updateMask: ["pinned"],
      });
    } catch {
      // do nothing
    }
  }, [memo.name, memo.pinned, updateMemo]);

  const handleEditMemoClick = useCallback(() => {
    onEdit?.();
  }, [onEdit]);

  const handleToggleMemoStatusClick = useCallback(async () => {
    const isArchiving = memo.state !== State.ARCHIVED;
    const state = memo.state === State.ARCHIVED ? State.NORMAL : State.ARCHIVED;
    const message = memo.state === State.ARCHIVED ? t("message.restored-successfully") : t("message.archived-successfully");

    try {
      await updateMemo({
        update: {
          name: memo.name,
          state,
        },
        updateMask: ["state"],
      });
      toast.success(message);
    } catch (error: unknown) {
      handleError(error, toast.error, {
        context: `${isArchiving ? "Archive" : "Restore"} memo`,
        fallbackMessage: "An error occurred",
      });
      return;
    }

    if (isInMemoDetailPage) {
      navigateTo(memo.state === State.ARCHIVED ? ROUTES.HOME : ROUTES.ARCHIVED);
    }
    memoUpdatedCallback();
  }, [memo.name, memo.state, t, isInMemoDetailPage, navigateTo, memoUpdatedCallback, updateMemo]);

  const handleCopyLink = useCallback(() => {
    let host = profile.instanceUrl;
    if (host === "") {
      host = window.location.origin;
    }
    copy(`${host}/${memo.name}`);
    toast.success(t("message.succeed-copy-link"));
  }, [memo.name, t, profile.instanceUrl]);

  const handleCopyContent = useCallback(() => {
    copy(memo.content);
    toast.success(t("message.succeed-copy-content"));
  }, [memo.content, t]);

  const handleCheckAllTaskListItemsClick = useCallback(async () => {
    await updateMemoContent(checkAllTasks(memo.content), "Check memo task list items");
  }, [memo.content, updateMemoContent]);

  const handleUncheckAllTaskListItemsClick = useCallback(async () => {
    await updateMemoContent(uncheckAllTasks(memo.content), "Uncheck memo task list items");
  }, [memo.content, updateMemoContent]);

  const handleDeleteMemoClick = useCallback(() => {
    // Defensive: a stale pending delete for the same memo should not fire twice.
    const existingTimer = pendingMemoDeletes.get(memo.name);
    if (existingTimer) {
      clearTimeout(existingTimer);
      pendingMemoDeletes.delete(memo.name);
    }

    // Optimistically hide the memo; the list is only refetched on undo or after the
    // real delete lands, so no server round-trip happens inside the undo window.
    removeMemoFromCollectionQueries(queryClient, memo.name);
    if (isInMemoDetailPage) {
      navigateTo(ROUTES.HOME);
    }

    const finalizeDelete = async () => {
      pendingMemoDeletes.delete(memo.name);
      try {
        await deleteMemo(memo.name);
      } catch (error: unknown) {
        handleError(error, toast.error, { context: "Delete memo", fallbackMessage: "An error occurred" });
        // The delete failed: bring the memo back into the lists.
        queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
        return;
      }
      if (memo.parent) {
        queryClient.invalidateQueries({ queryKey: memoKeys.comments(memo.parent) });
      }
      memoUpdatedCallback();
    };

    pendingMemoDeletes.set(
      memo.name,
      setTimeout(() => void finalizeDelete(), DELETE_UNDO_WINDOW_MS),
    );

    const handleUndo = (toastId: string) => {
      const timer = pendingMemoDeletes.get(memo.name);
      if (timer) {
        clearTimeout(timer);
        pendingMemoDeletes.delete(memo.name);
      }
      toast.dismiss(toastId);
      // The memo still exists server-side; refetching the lists restores it.
      queryClient.invalidateQueries({ queryKey: memoKeys.lists() });
    };

    toast(
      (toastInstance) => (
        <span className="flex items-center gap-3">
          <span>{t("message.deleted-successfully")}</span>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => handleUndo(toastInstance.id)}>
            {t("common.undo")}
          </button>
        </span>
      ),
      { duration: DELETE_UNDO_WINDOW_MS },
    );
  }, [memo.name, memo.parent, t, isInMemoDetailPage, navigateTo, memoUpdatedCallback, deleteMemo, queryClient]);

  return {
    handleTogglePinMemoBtnClick,
    handleEditMemoClick,
    handleToggleMemoStatusClick,
    handleCopyLink,
    handleCopyContent,
    handleCheckAllTaskListItemsClick,
    handleUncheckAllTaskListItemsClick,
    handleDeleteMemoClick,
  };
};
