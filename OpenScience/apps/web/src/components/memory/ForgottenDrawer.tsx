import { useState } from "react";
import { Archive, RotateCcw } from "lucide-react";
import { updateStructuredMemory, type WebStructuredMemory } from "@/lib/apiClient";
import { listAllHandbooks, rollbackHandbook, type WebHandbook } from "@/lib/handbooksClient";
import { announceMemoryChanged, restoreCapsuleEntry, type OwnCapsuleEntry } from "@/lib/memoryClient";
import { kindTitle, recordGroup, entryGroup } from "@/lib/memoryGroups";
import { memoryExcerpt } from "@/lib/memoryText";
import { listAllMethods, methodTitle, rollbackMethod, type WebMethod } from "@/lib/methodsClient";
import { capabilityTitle } from "@/lib/researchAgentUi";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";

/** One thing the researcher forgot, whichever store holds it, with the way back. */
interface ForgottenRow {
  key: string;
  text: string;
  /** What it was: where it sat on the page. */
  kind: string;
  restore: () => Promise<unknown>;
}

/**
 * 「已忘记的内容」: everything the researcher stopped or forgot — memories,
 * notes of their own capsule, learned methods and capability handbooks — each
 * with 恢复 (2026-10-07 plan §3.2 item 6). Four kinds, four stores, one list,
 * and 恢复 works for each: the notes of the researcher's own capsule were never
 * in it before, because the read that fed it listed only what was in force.
 *
 * The memories and notes come with the page's own reads. The stopped methods
 * and handbooks are read when the drawer opens: they are only wanted here, and
 * a page that read them every time would pay for what almost nobody opens. A
 * read that fails says so in the drawer, with 重试, and never reads as 「没有」.
 *
 * Rows do not open: the drawer is already the second layer, and the one thing
 * to do with a forgotten row is bring it back.
 */
export function ForgottenDrawer({ records, entries, projectName, onClose, onChanged }: {
  records: readonly WebStructuredMemory[];
  entries: readonly OwnCapsuleEntry[];
  projectName: (id: string | null) => string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, failed, reload } = useCapsuleData(async () => {
    const [methods, handbooks] = await Promise.all([listAllMethods("retired"), listAllHandbooks("retired")]);
    return { methods, handbooks };
  });
  const [busy, setBusy] = useState<string | null>(null);

  const recordRows = records
    .filter((record) => record.status === "archived" && record.kind !== "run_summary")
    .map((record): ForgottenRow => ({
      key: `record:${record.id}`, text: memoryExcerpt(record.summary || record.value),
      kind: recordGroup(record) === "project" ? projectName(record.scope === "project" ? record.scopeId : null) ?? kindTitle(record.kind) : kindTitle(record.kind),
      restore: () => updateStructuredMemory(record, { status: "active" }),
    }));
  const entryRows = entries.map((entry): ForgottenRow => ({
    key: `entry:${entry.id}`, text: memoryExcerpt(entry.payload.content),
    kind: entryGroup(entry) === "project" ? projectName(entry.projectId ?? null) ?? kindTitle(entry.payload.factKind) : kindTitle(entry.payload.factKind),
    restore: () => restoreCapsuleEntry(entry.payload.capsuleId, entry),
  }));
  const methodRows = (data?.methods ?? []).map((method: WebMethod): ForgottenRow => ({
    key: `method:${method.id}`, text: methodTitle(method), kind: "做法", restore: () => rollbackMethod(method, method.revision - 1),
  }));
  const handbookRows = (data?.handbooks ?? []).map((handbook: WebHandbook): ForgottenRow => ({
    key: `handbook:${handbook.id}`, text: handbook.title,
    kind: `用在${(handbook.capabilityId ? capabilityTitle(handbook.capabilityId) : null) ?? "科研工具"}`, restore: () => rollbackHandbook(handbook, handbook.revision - 1),
  }));
  const rows = [...recordRows, ...entryRows, ...methodRows, ...handbookRows];

  const restore = async (row: ForgottenRow) => {
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
    <Drawer title="已忘记的内容" onClose={onClose}>
      {failed && <LoadError className="mb-4" message="暂时读不到已停用的做法和经验。" onRetry={reload} />}
      {data === null && !failed ? <RunsSkeleton filter={false} />
        : rows.length === 0 ? (failed ? null : <EmptyState icon={Archive} title="没有已忘记的内容" />)
          : (
            <List label="已忘记的内容">
              {rows.map((row) => (
                <ListRow
                  key={row.key}
                  muted
                  title={<span className="line-clamp-2 max-w-measure">{row.text}</span>}
                  meta={row.kind}
                  actions={<IconButton icon={RotateCcw} label="恢复" size="sm" disabled={busy !== null} onClick={() => void restore(row)} />}
                />
              ))}
            </List>
          )}
    </Drawer>
  );
}
