import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Note } from "@/components/ui/Note";
import { Tag } from "@/components/ui/Tag";
import type { VcrHome } from "@/lib/vcrClient";
import { VCR_TASKS } from "./frameVcrOptions";

/** Input status and minimum requirements answer different questions. */
export function VcrTaskRequirements({ task, inputs, onInspect }: { task: typeof VCR_TASKS[number]; inputs?: VcrHome["taskInputs"]; onInspect: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <span id={`vcr-input-${task.id}`} data-vcr-data-requirement={task.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-caption text-text-2"><Tag>{task.inputLabel}</Tag><span className="max-w-measure">{task.requirement}</span></span>
    <span className="flex flex-wrap gap-2">{task.indicators.map(indicator => {
      const state = inputs?.[indicator.key];
      return <span key={indicator.key} className="text-caption text-text-2">{indicator.label} · {state?.status === "available" ? "已有授权输入" : state?.status === "missing" ? "待提供" : "待检查"}</span>;
    })}</span>
    <Button size="sm" variant="text" onClick={() => setOpen(true)} aria-haspopup="dialog">查看最低字段与材料形式</Button>
    {open && <Drawer title={`${task.label}需要的材料`} onClose={() => setOpen(false)}>
      <dl className="space-y-4 text-ui text-text-2"><div><dt className="font-semibold text-text">最低字段</dt><dd>{task.minimumFields}</dd></div><div><dt className="font-semibold text-text">材料形式</dt><dd>可上传表格、去标识化病例或连接已有数据源；方案与参考文献可附文件或链接。</dd></div><div><dt className="font-semibold text-text">已有授权输入</dt><dd>{task.indicators.flatMap(indicator => inputs?.[indicator.key]?.sources ?? []).map(source => source.label).join("、") || "尚未确认；可在对话中检查当前授权与字段。"}</dd></div></dl>
      <Note className="mt-4" action={<Button variant="text" size="sm" onClick={onInspect}>在对话中检查或添加资料</Button>}>已有授权输入仍需核对本次研究要求。参考文献和记忆胶囊只提供证据与上下文，不能替代患者数据，也不能授予数据访问权限。</Note>
    </Drawer>}
  </>;
}
