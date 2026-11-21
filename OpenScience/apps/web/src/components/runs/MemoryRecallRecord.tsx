import type { WebAgentRun } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { runTitle } from "@/lib/runPresentation";

const states = { not_searched: "没有检索", empty: "检索未命中", hit: "检索有返回", incomplete: "检索记录不完整", unknown: "检索情况未知" };
const sources: Record<string, string> = { "memory-file": "记忆文件", profile: "画像", history: "原始对话", capsule: "胶囊笔记" };

export function MemoryRecallRecord({ runs, onClose }: { runs: readonly WebAgentRun[]; onClose: () => void }) {
  const data = runs.map(run => ({ runId: run.id, question: run.question, receipt: run.memoryRecall ?? null }));
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "memory-recall.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Drawer title="记忆查找记录" onClose={onClose} actions={<Button variant="text" onClick={download}>导出记录</Button>}>
    {runs.map(run => <section key={run.id} className="mb-4 space-y-2">
      <h3 className="text-ui font-semibold">{run.question || runTitle(run)}</h3>
      <p>{run.memoryRecall ? states[run.memoryRecall.state] : "这次运行没有查找记录"}</p>
      {run.memoryRecall?.operations.map(op => <details key={op.id}>
        <summary>{op.at} · {op.entry.endsWith(".search") ? "检索返回" : op.entry.endsWith(".read") ? "显式读取" : "开场送达"} {op.refs.length} 项</summary>
        <ul>{op.refs.map(index => {
          const ref = run.memoryRecall?.references[index];
          const laterRead = op.entry.endsWith(".search") && run.memoryRecall?.operations.some(read => read.entry.endsWith(".read") &&
            read.at >= op.at && read.refs.some(i => run.memoryRecall?.references[i]?.uri === ref?.uri));
          return ref && <li key={index} className="break-all">{sources[ref.source] ?? ref.source} · {ref.uri}{op.entry.endsWith(".search") && (laterRead ? " · 后续显式读取" : " · 未记录后续显式读取")}<br />SHA-256 {ref.contentHash}</li>;
        })}</ul>
      </details>)}
      {run.memoryRecall?.turn?.answer && <p className="break-all text-caption">回答记录 #{run.memoryRecall.turn.answer.seq} · SHA-256 {run.memoryRecall.turn.answer.contentHash}</p>}
    </section>)}
  </Drawer>;
}
