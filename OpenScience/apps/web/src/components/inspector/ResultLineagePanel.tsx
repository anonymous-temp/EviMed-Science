import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { parseFailureMessage } from "@/lib/errorText";
import { bindingFormatLabel, bindingLocatorLabel, bindingStatusLabel, bindingsForSelection, getResultLineage, lineageChangeLabel, reproductionLabel,
  snapshotKindLabel, snapshotUnknownLabel, unboundReasonLabel, type LineageChangeRow, type ResultLineage, type ResultVersion } from "@/lib/resultProvenance";

/**
 * The numerical chain of one version: how its bytes were produced and what was not observed, which calculation each
 * printed number came from (and with what formatting), and, from a calculation, which printed values depend on it and
 * what a newer calculation would move in them. A label, never a verdict: nothing here withholds the report.
 */
export function ResultLineagePanel({ version, selectedText = null, onOpen }: {
  version: ResultVersion; selectedText?: string | null; onOpen: (target: { versionId: string; path: string; runId: string | null }) => void;
}) {
  const [lineage, setLineage] = useState<ResultLineage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setLineage(null); setError(null);
    void getResultLineage(version.versionId).then((value) => {
      if (disposed) return;
      if (value.versionId !== version.versionId) throw new Error("返回的数值来源与所选版本不一致");
      setLineage(value);
    }).catch((caught) => { if (!disposed) setError(parseFailureMessage(caught, "数值来源")); });
    return () => { disposed = true; };
  }, [version.versionId, attempt]);

  const { snapshot, bindings } = version;
  const calculationPath = (versionId: string) => bindings?.calculations.find((item) => item.versionId === versionId)?.path
    ?? lineage?.calculations.find((item) => item.versionId === versionId)?.path ?? "计算结果";
  const selected = selectedText && bindings ? bindingsForSelection(version, selectedText) : null;
  const reproduction = snapshot ? reproductionLabel(snapshot.reproduction) : null;
  return <Disclosure summary="数值与计算来源" defaultOpen>
    <div className="space-y-4 py-2">
      {snapshot && <section aria-label="生成方式" className="space-y-1">
        <p>生成方式：{snapshotKindLabel(snapshot.kind)}{snapshot.method ? ` · ${snapshot.method.id}${snapshot.method.version ? ` 第 ${snapshot.method.version} 版` : ""}` : ""}</p>
        {snapshot.method?.executed && <p className="text-caption text-muted">实际执行：{Object.entries(snapshot.method.executed).map(([key, value]) => `${key}=${String(value)}`).join("，")}</p>}
        {snapshot.method?.seed != null && <p className="text-caption text-muted">随机种子 {snapshot.method.seed}</p>}
        {snapshot.script && <p className="break-all text-caption text-muted">代码：{snapshot.script.path ?? snapshot.method?.id ?? "计算引擎"}{snapshot.script.digest ? ` · 摘要 ${snapshot.script.digest.slice(0, 12)}` : ""} · {snapshot.script.verified ? "已核对" : "未核对"}</p>}
        {snapshot.inputs.map((input) => <p key={`${input.id}:${input.versionId ?? input.digest}`} className="break-all text-caption text-muted">输入：{input.path ?? input.id}{input.digest ? ` · 摘要 ${input.digest.slice(0, 12)}` : " · 摘要未记录"}{input.versionId && ["available", "captured"].includes(input.availability) ? " · 已保存此版本" : " · 未保存此版本"}</p>)}
        {snapshot.transformations.map((item) => <p key={`${item.datasetId}:${item.name}`} className="text-caption text-muted">数据变换：{item.name} 第 {item.version} 版（数据集 {item.datasetId}）</p>)}
        {snapshot.environment.facts && <p className="text-caption text-muted">运行环境：{snapshot.environment.facts.interpreter ?? "已记录"}{snapshot.environment.facts.packages ? ` · ${Object.keys(snapshot.environment.facts.packages).length} 个软件包的版本` : ""}</p>}
        {snapshot.process && <p className="text-caption text-muted">运行结果：{snapshot.process.exitCode === 0 ? "正常结束" : snapshot.process.exitCode == null ? "未记录" : `退出码 ${snapshot.process.exitCode}`}{snapshot.process.sourcesUnchanged === false ? "，运行中输入文件发生了变化" : ""}</p>}
        {reproduction && <p className={snapshot.reproduction === "observed_execution" ? "text-caption text-muted" : "text-caption text-verify-pending"}>{reproduction}</p>}
        {!snapshot.recorded && <p className="text-caption text-verify-pending">此版本保存时没有记录生成过程。</p>}
        {snapshot.unknown.length > 0 && <ul aria-label="未被观察的部分" className="list-disc space-y-1 pl-5 text-caption text-verify-pending">{snapshot.unknown.map((code) => <li key={code}>{snapshotUnknownLabel(code)}</li>)}</ul>}
      </section>}

      {bindings && <section aria-label="数值核对" className="space-y-2">
        <p className={["bound", "no_numbers"].includes(bindings.status) ? undefined : "text-verify-pending"}>{bindingStatusLabel(bindings)}</p>
        {selected && (selected.bound.length > 0 || selected.unbound.length > 0) && <div role="status" className="space-y-1 rounded-card border border-border p-3">
          {selected.bound.map((item, index) => <p key={index}>“{item.printed}”来自 {calculationPath(item.calculation.versionId)} 的 {item.calculation.key}（{item.calculation.value}{item.calculation.unit ? ` ${item.calculation.unit}` : ""}），{bindingFormatLabel(item.format)}。</p>)}
          {selected.unbound.map((item, index) => <p key={`u${index}`} className="text-verify-pending">“{item.printed}”：{unboundReasonLabel(item)}。</p>)}
        </div>}
        {bindings.items.length > 0 && <div className="max-h-64 overflow-auto"><table className="w-full text-left text-ui"><caption className="py-2 text-left">文中数值与计算值的对应</caption>
          <thead><tr><th>文中</th><th>计算值</th><th>格式</th><th>位置</th><th /></tr></thead>
          <tbody>{bindings.items.map((item, index) => <tr key={index}>
            <td className="font-mono">{item.printed}</td>
            <td className="break-all">{item.calculation.key} = <span className="font-mono">{item.calculation.value}</span>{item.calculation.unit ? ` ${item.calculation.unit}` : ""}</td>
            <td>{item.basis === "rendered" ? "平台渲染，" : ""}{bindingFormatLabel(item.format)}</td>
            <td>{bindingLocatorLabel(item.locator)}</td>
            <td><Button size="sm" variant="text" onClick={() => onOpen({ versionId: item.calculation.versionId, path: calculationPath(item.calculation.versionId), runId: lineage?.calculations.find((entry) => entry.versionId === item.calculation.versionId)?.runId ?? version.producer.runId ?? null })}>查看计算</Button></td>
          </tr>)}</tbody></table></div>}
        {bindings.unbound.length > 0 && <ul aria-label="没有对应计算值的数值" className="list-disc space-y-1 pl-5 text-caption text-verify-pending">
          {bindings.unbound.map((item, index) => <li key={index}>“{item.printed}”（{bindingLocatorLabel(item.locator)}）：{unboundReasonLabel(item)}</li>)}
        </ul>}
        {bindings.unresolved.length > 0 && <p className="text-caption text-verify-pending">渲染时有 {bindings.unresolved.length} 处引用没有找到对应的计算值，报告里写的是“未计算”。</p>}
        {bindings.truncated && <p className="text-caption text-muted">数值较多，只列出了前面的一部分。</p>}
      </section>}

      <section aria-label="计算与依赖" className="space-y-2">
        {error && <div role="status" className="space-y-2"><p className="text-verify-pending">{error}</p><Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>重试读取数值来源</Button></div>}
        {!lineage && !error && <p role="status" className="text-muted">正在读取数值来源</p>}
        {lineage && lineage.calculations.length > 0 && lineage.role !== "calculation" && <div className="space-y-1">
          <p>引用的计算</p>
          {lineage.calculations.map((item) => <p key={item.versionId} className="break-all text-caption text-muted">{item.path}{item.method ? ` · ${item.method}` : ""} <Button size="sm" variant="text" onClick={() => onOpen({ versionId: item.versionId, path: item.path, runId: item.runId })}>查看计算</Button></p>)}
        </div>}
        {lineage && lineage.dependents.length > 0 && <div className="space-y-1">
          <p>依赖这次计算的数值</p>
          {lineage.dependents.map((item) => <p key={item.versionId} className="break-all text-caption text-muted">{item.path} · {item.boundValues} 个数值 <Button size="sm" variant="text" onClick={() => onOpen({ versionId: item.versionId, path: item.path, runId: item.runId })}>查看</Button></p>)}
        </div>}
        {lineage && lineage.role === "calculation" && lineage.dependents.length === 0 && <p className="text-caption text-muted">目前没有报告、表格或图的数值对应到这次计算。</p>}
        {lineage?.changes.map((change) => <div key={change.successorVersionId} className="space-y-1 rounded-card border border-border p-3">
          <p className={change.summary.affectedValues > 0 ? "text-verify-pending" : undefined}>
            {change.calculationVersionId === version.versionId ? "这次计算已有新版本" : "所引用的计算已有新版本"}（{new Date(change.successorCapturedAt).toLocaleString("zh-CN")}）：
            {change.summary.affectedValues > 0 ? `${change.summary.affectedValues} 处数值会变化` : "已对应的数值都不会变化"}，{change.summary.unaffectedValues} 处保持不变
          </p>
          {change.dependents.filter((row) => row.affected.length > 0).map((row: LineageChangeRow) => <div key={row.versionId} className="text-caption text-muted">
            <p className="break-all">{row.path}</p>
            <ul className="list-disc pl-5">{row.affected.map((item, index) => <li key={index}>{bindingLocatorLabel(item.locator)}：{lineageChangeLabel(item)}</li>)}</ul>
          </div>)}
          <Button size="sm" variant="text" onClick={() => onOpen({ versionId: change.successorVersionId, path: change.successorPath, runId: change.successorRunId })}>查看新版本</Button>
        </div>)}
      </section>
    </div>
  </Disclosure>;
}
