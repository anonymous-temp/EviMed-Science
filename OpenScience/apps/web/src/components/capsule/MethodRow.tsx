import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { methodTitle, retireMethod, rollbackMethod, type WebMethod } from "@/lib/methodsClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";

/** How long a method wears 「新」. Long enough to be noticed on a weekly visit,
 *  short enough that the badge still means something. */
const NEW_FOR_DAYS = 14;

function day(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatDateTime(date, { month: "long", day: "numeric" });
}

/**
 * What a learned method rests on, said as an observation rather than a rule.
 *
 * 「从你改过的 3 份报告学到」 — the count is the successful deliveries it was
 * distilled from, which is the only thing about it a reader can check. A method
 * the researcher stated is labelled as theirs and claims no evidence it does
 * not have.
 */
export function methodEvidence(method: WebMethod): string {
  if (method.origin === "explicit") return "你在对话里说过";
  const trajectories = method.trajectories ?? method.counts?.succeeded ?? 0;
  return trajectories > 0 ? `从你的 ${trajectories} 次研究学到` : "从你的研究里学到";
}

/** Whether this method started being used recently enough to say so. */
export function isNewMethod(method: WebMethod, now = Date.now()): boolean {
  if (method.status !== "approved") return false;
  const at = Date.parse(method.statusChangedAt ?? method.createdAt ?? "");
  return Number.isFinite(at) && now - at <= NEW_FOR_DAYS * 86_400_000;
}

/**
 * One learned method as a line of 我的做法.
 *
 * It takes effect the night it is learned (`promotionVerdict`), so the row says
 * what it does and since when rather than what it is still waiting for — the
 * old page listed 「还差：成功用到它的任务还不够…」 under every one of them,
 * which described a gate that under stock configuration never opened. The
 * paired evaluation still runs; what it can do now is retire one, and that
 * shows up in 最近变化.
 */
export function MethodRow({ method, onChanged }: { method: WebMethod; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
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
    await retireMethod(method, "在记忆页里停用");
    toast.success(`已停用「${methodTitle(method)}」，之后的研究不会再用它。`);
  });
  const rollback = () => run(async () => {
    await rollbackMethod(method, method.revision - 1);
    toast.success(`「${methodTitle(method)}」已回到上一版。`);
  });

  return (
    <li className="px-4 py-3" data-method-id={method.id}>
      <p className="text-ui text-text">
        {/* The researcher's own line when it exists; the model's name and
            description otherwise, which are English and written for routing. */}
        {method.title && method.summary
          ? `${method.title}：${method.summary}`
          : method.description ? `${method.name}：${memoryExcerpt(method.description, 120)}` : method.name}
        <span className="text-muted">（{methodEvidence(method)}）</span>
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-text">我的做法</span>
        {isNewMethod(method) && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">新</span>}
        {retired && <span>已停用</span>}
        {method.statusChangedAt && !retired && <span>{day(method.statusChangedAt)} 起生效</span>}
        {method.counts ? <span>用过 {method.counts.loaded} 次</span> : null}
      </p>
      {method.body && (
        <Disclosure summary="看看具体怎么做" className="mt-2" summaryClassName="text-caption">
          <div className="border-l border-border pl-3">
            <MarkdownViewer className="text-ui">{method.body}</MarkdownViewer>
          </div>
        </Disclosure>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {!retired && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void stop()}>停用</Button>}
        {method.revision > 1 && (
          <Button size="sm" variant="ghost" loading={busy} disabled={busy} onClick={() => void rollback()}>
            {!busy && <RotateCcw size={16} aria-hidden="true" />}回到上一版
          </Button>
        )}
      </div>
    </li>
  );
}
