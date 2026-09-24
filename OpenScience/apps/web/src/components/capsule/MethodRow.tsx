import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { methodTitle, retireMethod, rollbackMethod, type WebMethod } from "@/lib/methodsClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { IconButton } from "@/components/ui/IconButton";
import { ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { InferredMark, RowDetail, RowOrigin } from "./rowParts";

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
 * A method's history, newest first: when it was learned (or said), when it
 * was last revised, when it was stopped and why. This is what 「最近变化」
 * used to show for every method at once, above the list; it is now each
 * row's own 「历史版本」 (2026-09-23 plan §5.6). Learning and taking effect are
 * one event since 2026-09-20 — the old block said both, for every method.
 */
export function methodHistory(method: WebMethod): string[] {
  const lines: string[] = [];
  const learned = day(method.createdAt);
  if (learned) lines.push(`${learned} ${method.origin === "explicit" ? "记下" : "学到"}`);
  const revised = day(method.updatedAt);
  if (method.revision > 1 && revised && method.updatedAt !== method.createdAt && method.status !== "retired") {
    lines.push(`${revised} 更新为第 ${method.revision} 版`);
  }
  if (method.status === "retired") {
    const stopped = day(method.statusChangedAt ?? method.updatedAt);
    const reason = method.statusReason ? `：${memoryExcerpt(method.statusReason, 80)}` : "";
    if (stopped) lines.push(`${stopped} 停用${reason}`);
  }
  return lines.reverse();
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
  const retired = method.status === "retired";

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
    toast.success(`已停用「${methodTitle(method)}」`, {
      action: {
        label: "撤销",
        onClick: () => void rollbackMethod(stopped, stopped.revision - 1)
          .then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(productErrorMessage(error))),
      },
    });
  });
  const rollback = () => run(async () => {
    await rollbackMethod(method, method.revision - 1);
    toast.success(retired ? `已恢复「${methodTitle(method)}」` : `「${methodTitle(method)}」已回到上一版`);
  });

  const history = methodHistory(method);
  const firstView = method.body ? "steps" : "history";

  return (
    <ListRow
      leading={<RowOrigin label="做法" />}
      title={<>{methodLine(method)}{method.origin !== "explicit" && <InferredMark />}</>}
      onOpen={retired ? undefined : () => setDetail((current) => (current ? null : firstView))}
      expanded={retired ? undefined : detail !== null}
      muted={retired}
      meta={detail ? (
        <RowDetail>
          {detail === "steps"
            ? <MarkdownViewer className="text-ui text-text-2">{method.body}</MarkdownViewer>
            : <ul className="space-y-1">{history.map((line) => <li key={line}>{line}</li>)}</ul>}
        </RowDetail>
      ) : undefined}
      actions={retired && method.revision > 1
        ? <IconButton icon={RotateCcw} label="恢复" size="sm" disabled={busy} onClick={() => void rollback()} />
        : undefined}
      menu={retired ? undefined : (
        <Menu
          label="更多"
          items={[
            { label: "历史版本", onSelect: () => setDetail("history") },
            ...(method.revision > 1 ? [{ label: "回到上一版", disabled: busy, onSelect: () => void rollback() }] : []),
            { label: "停用", disabled: busy, onSelect: () => void stop() },
          ]}
        />
      )}
    />
  );
}
