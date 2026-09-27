import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { methodTitle, methodVersions, retireMethod, rollbackMethod, type MethodVersion, type WebMethod } from "@/lib/methodsClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { IconButton } from "@/components/ui/IconButton";
import { ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { RowDetail, RowOrigin, RowSentence } from "./rowParts";

function day(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatDateTime(date, { month: "long", day: "numeric" });
}

/** The line a researcher reads for a method: its own title and sentence when
 *  it has them; the name and description, written for the model, otherwise. */
export function methodLine(method: WebMethod): string {
  if (method.title && method.summary) return `${method.title}：${method.summary}`;
  return method.description ? `${method.name}：${memoryExcerpt(method.description, 120)}` : method.name;
}

/**
 * A method's 「历史版本」: the bodies it has held, newest first, each as 「第 N
 * 版」 on the day it was written (`GET /api/methods/:id/history`). Counter
 * writes and status changes are not versions: on 2026-09-26 one method read
 * 「更新为第 77 版」 over two bodies (audit, M-5).
 */
export function methodHistory(versions: readonly MethodVersion[]): string[] {
  return versions.map((entry) => {
    const when = day(entry.at);
    return `${when ? `${when} ` : ""}第 ${entry.version} 版${entry.current ? "（当前）" : ""}`;
  });
}

/**
 * One learned method as a row of 做法: the line it is known by, 「推断」 when
 * EviMed learned it rather than the researcher saying it, and nothing else on
 * the row — no 「新」, no 「起生效」, no 「用过 N 次」 (2026-09-23 plan §5.6).
 * Opening the row shows its full steps; its 「⋯」 holds 历史版本, 回到上一版
 * and 停用. A stopped method lives under 已忘记的内容, with 恢复.
 *
 * There is nothing to edit: a method is what the model learned from the work,
 * never a form the researcher fills in (owner ruling 2026-09-20).
 */
export function MethodRow({ method, onChanged }: { method: WebMethod; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<"steps" | "history" | null>(null);
  /** The bodies it has held, read when 历史版本 is opened; "failed" when it could not be. */
  const [versions, setVersions] = useState<MethodVersion[] | "failed" | null>(null);
  const retired = method.status === "retired";
  const version = method.version ?? 1;

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
      announceMemoryChanged();
      onChanged();
    } catch (error) {
      toast.error(productErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const stop = () => run(async () => {
    const stopped = await retireMethod(method, "在记忆页里停用");
    toast.success(`已停用“${methodTitle(method)}”`, {
      action: {
        label: "撤销",
        onClick: () => void rollbackMethod(stopped, stopped.revision - 1)
          .then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(productErrorMessage(error))),
      },
    });
  });
  const rollback = () => run(async () => {
    await rollbackMethod(method, method.revision - 1);
    toast.success(retired ? `已恢复“${methodTitle(method)}”` : `“${methodTitle(method)}”已回到上一版`);
  });

  const openHistory = () => {
    setDetail("history");
    setVersions(null);
    void methodVersions(method).then((page) => setVersions(page.items), () => setVersions("failed"));
  };
  // The steps in the researcher's language when there are any; the SKILL.md
  // written for the model otherwise.
  const steps = method.steps ?? method.body;
  const firstView = steps ? "steps" : "history";

  return (
    <ListRow
      leading={<RowOrigin label="做法" />}
      title={<RowSentence text={methodLine(method)} inferred={method.origin !== "explicit"} clamp={!retired && detail === null} />}
      onOpen={retired ? undefined : () => (detail ? setDetail(null) : firstView === "history" ? openHistory() : setDetail("steps"))}
      expanded={retired ? undefined : detail !== null}
      muted={retired}
      meta={detail ? (
        <RowDetail>
          {detail === "steps" ? (
            <>
              <p>第 {version} 版{method.bodyUpdatedAt && day(method.bodyUpdatedAt) ? ` · ${day(method.bodyUpdatedAt)}` : ""}</p>
              <MarkdownViewer className="text-ui text-text-2">{steps}</MarkdownViewer>
            </>
          ) : versions === null ? <p role="status">正在读取历史版本</p>
            : versions === "failed" ? <p>无法读取历史版本</p>
              : <ul className="space-y-1">{methodHistory(versions).map((line) => <li key={line}>{line}</li>)}</ul>}
        </RowDetail>
      ) : undefined}
      actions={retired && method.revision > 1
        ? <IconButton icon={RotateCcw} label="恢复" size="sm" disabled={busy} onClick={() => void rollback()} />
        : undefined}
      menu={retired ? undefined : (
        <Menu
          label="更多"
          items={[
            { label: "历史版本", onSelect: openHistory },
            // Only a method with an earlier body can go back to it; the server
            // answers any other with 409 `method_no_earlier_version`.
            ...(version > 1 ? [{ label: "回到上一版", disabled: busy, onSelect: () => void rollback() }] : []),
            { label: "停用", disabled: busy, onSelect: () => void stop() },
          ]}
        />
      )}
    />
  );
}
