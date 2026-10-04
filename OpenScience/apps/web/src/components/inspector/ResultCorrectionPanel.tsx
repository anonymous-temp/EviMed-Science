import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { parseFailureMessage } from "@/lib/errorText";
import { correctionEffectLines, correctionKindLabel, getResultCorrections, type ResultCorrectionEntry } from "@/lib/resultProvenance";

/**
 * What the researcher's corrections of one version were and left: which version it was changed into (or came from), what
 * moved between the two, which calculations were recomputed. A label, never a verdict: the original is preserved and
 * nothing here asks for anything. Absent when the version was never corrected.
 */
export function ResultCorrectionPanel({ versionId, onOpen }: { versionId: string; onOpen: (versionId: string) => void }) {
  const [entries, setEntries] = useState<ResultCorrectionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setEntries(null); setError(null);
    void getResultCorrections(versionId).then((value) => {
      if (disposed) return;
      if (value.versionId !== versionId) throw new Error("返回的修改记录与所选版本不一致");
      setEntries(value.items);
    }).catch((caught) => { if (!disposed) setError(parseFailureMessage(caught, "修改记录")); });
    return () => { disposed = true; };
  }, [versionId, attempt]);
  if (error) return <div role="status" className="space-y-2"><p className="text-verify-pending">{error}</p><Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>重试读取修改记录</Button></div>;
  if (!entries?.length) return null;
  return <Disclosure summary="修改记录" defaultOpen>
    <div className="space-y-3 py-2">
      {entries.map((entry) => {
        const { correction, outcome } = entry;
        const other = entry.role === "original" ? correction.successor : correction.original;
        const lines = correctionEffectLines(correction);
        const renderings = outcome?.outputs.filter((item) => item.role === "rendering") ?? [];
        return <section key={entry.id} aria-label="一次修改" className="space-y-1 rounded-card border border-border p-3">
          <p>{entry.role === "original" ? "此版本被修改过" : "此版本由一次修改得到"}：{correctionKindLabel(correction.kind)}（{new Date(entry.occurredAt).toLocaleString("zh-CN")}）</p>
          {correction.instruction && <blockquote className="whitespace-pre-wrap text-caption text-muted">你的要求：“{correction.instruction}”</blockquote>}
          {correction.anchor.selectedText && <p className="text-caption text-muted">所选内容：“{correction.anchor.selectedText}”</p>}
          {lines.length > 0 && <ul className="list-disc space-y-1 pl-5 text-caption text-muted">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
          {outcome?.calculations.map((item) => <p key={`${item.before.versionId}:${item.after.versionId}:${item.key}`} className="break-all text-caption text-muted">重新计算：{item.key}（{item.before.value} → {item.after.value}{item.unit ? ` ${item.unit}` : ""}）</p>)}
          {renderings.length > 0 && <p className="text-caption text-verify-pending">随这次修改生成的 {renderings.map((item) => item.format?.toUpperCase() ?? "文件").join("、")} 没有逐项核对数值是否与修改后的版本一致；可在修改后的版本里直接导出 Word 或 PDF。</p>}
          <Button size="sm" variant="text" onClick={() => onOpen(other.versionId)}>{entry.role === "original" ? "查看修改后的版本" : "查看原版本"}</Button>
        </section>;
      })}
    </div>
  </Disclosure>;
}
