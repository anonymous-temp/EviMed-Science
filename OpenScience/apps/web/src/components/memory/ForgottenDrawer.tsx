import { useState } from "react";
import { Archive, RefreshCw, RotateCcw } from "lucide-react";
import { updateStructuredMemory, type WebForgetRequest, type WebForgetStatus, type WebStructuredMemory } from "@/lib/apiClient";
import { announceMemoryChanged, restoreCapsuleEntry, type OwnCapsuleEntry } from "@/lib/memoryClient";
import { displayMemoryKind, kindTitle, recordGroup, entryGroup } from "@/lib/memoryGroups";
import { memoryExcerpt } from "@/lib/memoryText";
import { listAllMethods, methodTitle, rollbackMethod, type WebMethod } from "@/lib/methodsClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { memorySource } from "./FactDrawer";
import { SourceConversationDelete } from "./SourceConversationDelete";

const statusLabel: Record<WebForgetStatus, string> = {
  requested: "已请求",
  executed: "已执行",
  pending_verification: "待核对",
  not_executed: "未执行",
};

/** One thing the researcher forgot, whichever store holds it, with the way back. */
interface ForgottenRow {
  key: string;
  text: string;
  /** What it was: where it sat on the page. */
  kind: string;
  status: WebForgetStatus;
  source?: { projectId: string; sessionId: string };
  restore?: () => Promise<unknown>;
}

/**
 * 「已忘记的内容」: everything the researcher stopped or forgot — memories,
 * notes of their own capsule and learned methods — each with 恢复 (2026-10-07
 * plan §3.2 item 6). Three kinds, three stores, one list, and 恢复 works for
 * each: the notes of the researcher's own capsule were never in it before,
 * because the read that fed it listed only what was in force.
 *
 * The memories and notes come with the page's own reads. The stopped methods
 * are read when the drawer opens: they are only wanted here, and a page that
 * read them every time would pay for what almost nobody opens. A read that
 * fails says so in the drawer, with 重试, and never reads as 「没有」.
 *
 * Requests carry their reviewed execution status. A restored item and a source
 * conversation use their own operations.
 */
export function ForgottenDrawer({ records, entries, requests = [], projectName, onClose, onChanged }: {
  records: readonly WebStructuredMemory[];
  entries: readonly OwnCapsuleEntry[];
  requests?: readonly WebForgetRequest[];
  projectName: (id: string | null) => string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data: methods, failed, reload } = useCapsuleData(() => listAllMethods("retired"));
  const [busy, setBusy] = useState<string | null>(null);

  const recordRows = records
    .filter((record) => record.status === "archived" && record.kind !== "run_summary")
    .map((record): ForgottenRow => {
      const statement = memoryExcerpt(record.value || record.summary);
      const forgetIntent = record.nativeType === "notes" && record.summary.startsWith("forget-");
      const source = memorySource(record);
      return {
        key: `record:${record.id}`, text: forgetIntent ? `${statement}（未存为记忆，已阻止以后记住）` : statement,
        kind: recordGroup(record) === "project" ? projectName(record.scope === "project" ? record.scopeId : null) ?? kindTitle(displayMemoryKind(record)) : kindTitle(displayMemoryKind(record)),
        status: record.forgetStatus ?? "executed",
        ...(source?.projectId ? { source: { projectId: source.projectId, sessionId: source.sessionId } } : {}),
        restore: () => updateStructuredMemory(record, { status: "active" }),
      };
    });
  const entryRows = entries.map((entry): ForgottenRow => ({
    key: `entry:${entry.id}`, text: memoryExcerpt(entry.payload.content),
    kind: entryGroup(entry) === "project" ? projectName(entry.projectId ?? null) ?? kindTitle(entry.payload.factKind) : kindTitle(entry.payload.factKind),
    status: "executed",
    restore: () => restoreCapsuleEntry(entry.payload.capsuleId, entry),
  }));
  const methodRows = (methods ?? []).map((method: WebMethod): ForgottenRow => ({
    key: `method:${method.id}`, text: methodTitle(method), kind: "做法", status: "executed", restore: () => rollbackMethod(method, method.revision - 1),
  }));
  const requestRows = requests.map((request): ForgottenRow => ({
    key: `request:${request.id}`, text: memoryExcerpt(request.text), kind: "遗忘请求", status: request.status,
  }));
  const rows = [...requestRows, ...recordRows, ...entryRows, ...methodRows];
  const canRefresh = rows.some((row) => row.status === "requested" || row.status === "pending_verification");

  const restore = async (row: ForgottenRow) => {
    if (!row.restore) return;
    setBusy(row.key);
    try {
      await row.restore();
      toast.success("已恢复");
      announceMemoryChanged();
      onChanged();
    } catch (error) {
      toast.error(productErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer title="已忘记的内容" onClose={onClose}
      actions={canRefresh ? <IconButton icon={RefreshCw} label="刷新遗忘状态" onClick={onChanged} /> : undefined}>
      {failed && <LoadError className="mb-4" message="暂时读不到已停用的做法。" onRetry={reload} />}
      {methods === null && !failed ? <RunsSkeleton filter={false} />
        : rows.length === 0 ? (failed ? null : <EmptyState icon={Archive} title="没有已忘记的内容" reason="你忘记的记忆会列在这里，随时可以恢复。" />)
          : (
            <List label="已忘记的内容">
              {rows.map((row) => (
                <ListRow
                  key={row.key}
                  muted
                  title={<span className="line-clamp-2 max-w-measure">{row.text}</span>}
                  meta={`${row.kind} · ${statusLabel[row.status]}`}
                  actions={row.restore || row.source ? <div className="flex flex-wrap items-center justify-end gap-2">
                    {row.source && <SourceConversationDelete {...row.source} onChanged={onChanged} afterForget />}
                    {row.restore && <IconButton icon={RotateCcw} label="恢复" size="sm" disabled={busy !== null} onClick={() => void restore(row)} />}
                  </div> : undefined}
                />
              ))}
            </List>
          )}
    </Drawer>
  );
}
