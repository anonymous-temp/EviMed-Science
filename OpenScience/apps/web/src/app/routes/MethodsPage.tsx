import { useCallback, useEffect, useRef, useState } from "react";
import { GraduationCap, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Textarea } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { createMethod, listMethods, retireMethod, rollbackMethod, type MethodPromotionDetail, type WebMethod } from "@/lib/methodsClient";
import { productErrorMessage } from "@/lib/productClient";
import { labelFor } from "@/lib/statusLabel";
import { toast } from "@/lib/toast";

type StatusFilter = "all" | "candidate" | "approved" | "retired";

const STATUS_LABEL: Record<string, string> = { candidate: "待验证", approved: "已采用", retired: "已停用" };
const VERDICT_LABEL: Record<string, string> = { better: "更好", non_inferior: "不劣于基线", inconclusive: "无定论", worse: "更差" };

/**
 * What a candidate still lacks, in the reader's words. The domain gives each
 * line as a code with its numbers (`promotionVerdict`'s `missingDetails`); a
 * code this table does not know is shown as its sentence rather than hidden.
 */
function missingLine(detail: MethodPromotionDetail | undefined, sentence: string): string {
  switch (detail?.code) {
    case "trajectories_needed": return `成功用到它的任务还不够：已有 ${detail.have} 次，需要 ${detail.need} 次。`;
    case "runs_needed": return `这些成功只来自 ${detail.have} 次运行，需要 ${detail.need} 次独立运行。`;
    case "counters_reset": return "方法内容改过，之前的使用记录已清零，需要重新积累。";
    case "no_evaluation": return "还没有和固定基线做过配对评测。";
    case "evaluation_not_passing": return `最近一次评测结论为「${labelFor(VERDICT_LABEL, String(detail.verdict), "未登记的结论")}」，没有达到采用标准。`;
    case "evaluation_stale_revision": return "最近一次评测测的是旧版本，当前版本需要重新评测。";
    case "evaluation_unnamed_text": return "最近一次评测没有记下所测的版本，需要重新评测。";
    case "baseline_unavailable": return "当前基线暂时不可用，需要重新对比。";
    case "baseline_moved": return "评测时的基线已经变化，需要重新对比。";
    case "conflicts": return `与 ${Array.isArray(detail.targets) ? detail.targets.join("、") : detail.targets} 存在 ${detail.count} 处未解决的冲突。`;
    default: return sentence;
  }
}

const SKILL_TEMPLATE = `---
name: 方法名称
description: 一句话说明这个方法做什么
---

## 什么时候用

## 步骤

1.
`;

/**
 * The learning loop, made visible (2026-09-16 review, P2 #15 and §2.4).
 *
 * Every method the system distilled — and every one the researcher wrote —
 * with its status and, for a candidate, exactly what it is still waiting for.
 * Before this page `/api/methods` had no reader: candidates, trials,
 * promotions, retirements and rollbacks all happened out of sight, and
 * "nothing has been learned" looked the same as "two of the three runs it
 * needs". There is deliberately no approve button: promotion is decided by
 * evidence in the nightly job. What a person can do is read, stop, undo, and
 * write one themselves, which takes effect at once.
 */
export function MethodsPage() {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [methods, setMethods] = useState<WebMethod[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<WebMethod | null>(null);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(SKILL_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (next: StatusFilter, append: string | null = null) => {
    const current = ++generation.current;
    setError(null);
    if (!append) setMethods(null);
    try {
      const page = await listMethods(next === "all" ? undefined : next, append);
      if (current !== generation.current) return;
      setMethods((previous) => append && previous ? [...previous, ...page.items] : page.items);
      setCursor(page.nextCursor);
    } catch (caught) {
      if (current === generation.current) setError(productErrorMessage(caught));
    }
  }, []);

  useEffect(() => { void load(filter); }, [filter, load]);

  const replace = (updated: WebMethod) =>
    setMethods((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? current);

  const retire = async () => {
    const method = retiring;
    setRetiring(null);
    if (!method) return;
    setBusyId(method.id);
    try {
      replace(await retireMethod(method));
      toast.success(`已停用「${method.name}」，之后的任务不会再用它。`);
    } catch (caught) {
      toast.error(`没有停用：${productErrorMessage(caught)}`);
    } finally {
      setBusyId(null);
    }
  };

  const rollback = async (method: WebMethod) => {
    setBusyId(method.id);
    try {
      replace(await rollbackMethod(method, method.revision - 1));
      toast.success(`「${method.name}」已回到上一版。`);
    } catch (caught) {
      toast.error(`没有回退：${productErrorMessage(caught)}`);
    } finally {
      setBusyId(null);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const created = await createMethod(draft);
      setWriting(false);
      setDraft(SKILL_TEMPLATE);
      toast.success(`已保存「${created.name}」。你写下的方法立即生效。`);
      await load(filter);
    } catch (caught) {
      toast.error(`没有保存：${productErrorMessage(caught)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-content-full px-6 py-8 lg:px-10">
        {/* What actually starts the loop, since 2026-09-20 (learningTriggers.mjs):
            no clicks. This paragraph used to describe a trigger that needed
            「采纳」 and 「我改过」 on the same deliverable. */}
        <p className="max-w-2xl text-body text-muted">
          EviMed 会自己从你的任务里学方法：每次交付完成、你在对话里纠正它、或同一类任务成功重复三次，它都会在北京时间 22:00–09:00 的夜里提炼。学到的方法先在评测账号里和现有做法配对比较，比下来不差才对你生效，不需要你点确认。你自己写下的方法立即生效。任何方法都可以随时停用或回到上一版。
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            aria-label="按状态筛选方法"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部" },
              { value: "candidate", label: "待验证" },
              { value: "approved", label: "已采用" },
              { value: "retired", label: "已停用" },
            ]}
          />
          <Button variant="ghost" onClick={() => setWriting((open) => !open)} aria-expanded={writing}>
            <Plus size={14} aria-hidden="true" /> 写一个方法
          </Button>
        </div>

        {writing && (
          <section aria-label="写一个方法" className="mt-4 rounded-card border border-border bg-surface p-4">
            <Textarea
              aria-label="方法内容（SKILL.md）"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-56 font-mono text-ui"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-ui text-muted">开头两行 name 与 description 必填；正文写清什么时候用、怎么做。</span>
              <Button onClick={() => void save()} loading={saving} disabled={!draft.trim()}>保存并生效</Button>
            </div>
          </section>
        )}

        {error ? (
          <div role="alert" className="mt-6 rounded-card border border-border bg-surface p-5 text-ui text-error">
            <p>方法列表没有读到：{error}</p>
            <Button className="mt-3" variant="ghost" onClick={() => void load(filter)}>重试</Button>
          </div>
        ) : methods === null ? (
          <div className="mt-6"><MemorySkeleton /></div>
        ) : methods.length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title={filter === "all" ? "还没有学到的方法" : `没有${STATUS_LABEL[filter]}的方法`}
            description={filter === "all"
              ? "交付完成、你在对话里纠正、或同类任务重复出现后，EviMed 会在当天夜里提炼；你也可以现在写一个。"
              : "换一个状态看看。"}
            className="mt-6 rounded-card border border-dashed border-border"
          />
        ) : (
          <ul className="mt-6 space-y-4" aria-label="方法列表">
            {methods.map((method) => (
              <li key={method.id} className="rounded-card border border-border bg-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-body font-medium text-text">{method.name || "未命名方法"}</h3>
                    {method.description && <p className="mt-1 text-ui text-muted">{method.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-caption">
                    <span className={cn("rounded-full px-2 py-0.5",
                      method.status === "approved" ? "bg-ok-soft text-ok" : method.status === "retired" ? "bg-surface-2 text-muted" : "bg-warn-soft text-warn")}>
                      {labelFor(STATUS_LABEL, method.status)}
                    </span>
                    <span className="text-muted">{method.origin === "explicit" ? "你写下的" : "从任务中提炼"}</span>
                  </div>
                </div>

                {method.status === "candidate" && method.promotion.missing.length > 0 && (
                  <div className="mt-3 rounded-input bg-surface-2 px-3 py-2 text-ui text-text">
                    <p className="font-medium">还差：</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {method.promotion.missing.map((sentence, index) => (
                        <li key={index}>{missingLine(method.promotion.missingDetails?.[index], sentence)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="mt-3 text-caption text-muted">
                  第 {method.revision} 版 · 更新于 {formatDateTime(method.updatedAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  {method.counts ? ` · 成功使用 ${method.counts.succeeded} 次` : ""}
                  {method.evaluations.length > 0
                    ? ` · 最近评测：${VERDICT_LABEL[String(method.evaluations[method.evaluations.length - 1]?.verdict)] ?? "已记录"}`
                    : ""}
                </p>

                <details className="mt-3 text-ui">
                  <summary className="cursor-pointer select-none text-ui text-muted hover:text-text">查看方法内容</summary>
                  <div className="mt-2 border-l border-border pl-3">
                    <MarkdownViewer className="text-ui">{method.body}</MarkdownViewer>
                  </div>
                </details>

                <div className="mt-3 flex flex-wrap gap-2">
                  {method.status !== "retired" && (
                    <Button size="sm" variant="ghost" disabled={busyId === method.id} onClick={() => setRetiring(method)}>停用</Button>
                  )}
                  {method.revision > 1 && (
                    <Button size="sm" variant="ghost" loading={busyId === method.id} disabled={busyId === method.id} onClick={() => void rollback(method)}>
                      {busyId !== method.id && <RotateCcw size={13} aria-hidden="true" />}
                      回到上一版
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {cursor && methods && (
          <div className="mt-4 flex justify-center">
            <Button variant="ghost" onClick={() => void load(filter, cursor)}>加载更多</Button>
          </div>
        )}
      </div>

      {retiring && (
        <ConfirmDialog
          title={`停用「${retiring.name}」？`}
          body="停用后，之后的任务不会再用这个方法。方法内容和历史版本都保留，用「回到上一版」可以恢复停用前的状态。"
          confirmLabel="停用"
          onConfirm={() => void retire()}
          onCancel={() => setRetiring(null)}
        />
      )}
    </div>
  );
}
