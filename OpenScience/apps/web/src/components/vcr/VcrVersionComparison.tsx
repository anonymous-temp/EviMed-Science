import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Select } from "@/components/ui/Input";
import { Note } from "@/components/ui/Note";
import type { VcrObjectSelection } from "@/lib/runtimeUiNavigation";
import { useStudyFrame } from "./studyFrameContext";
export type VcrSavedVersion = { objectId: string; version: number | string; label: string; resultId?: string; resultVersion?: number };

/** A comparison always names two explicit saved versions. */
export function VcrVersionComparison({ studyId, kind, versions, onClose }: { studyId: string; kind: VcrObjectSelection["kind"]; versions: VcrSavedVersion[]; onClose: () => void }) {
  const frame = useStudyFrame();
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const first = versions.find(row => `${row.objectId}:${row.version}` === left);
  const second = versions.find(row => `${row.objectId}:${row.version}` === right);
  const valid = first && second && left !== right;
  return <Drawer title="在对话中比较版本" onClose={onClose} footer={<Button disabled={!valid} onClick={() => {
    if (!valid) return;
    frame?.openChat(`请比较“${first.label}”与“${second.label}”，检查输入、假设和结果变化，保留两个原版本。`, { studyId, kind, ...first, compareTo: second });
    onClose();
  }}>将比较请求放入研究对话</Button>}>
    {versions.length < 2 ? <Note action={null}>还没有两个可明确定位的保存版本。请先在研究对话中补齐版本，再进行比较。</Note> : <div className="flex flex-col gap-4">
      <Select label="第一个保存版本" value={left} onChange={event => setLeft(event.target.value)}><option value="">选择版本</option>{versions.map(row => <option key={`${row.objectId}:${row.version}`} value={`${row.objectId}:${row.version}`}>{row.label}</option>)}</Select>
      <Select label="第二个保存版本" value={right} onChange={event => setRight(event.target.value)}><option value="">选择版本</option>{versions.map(row => <option key={`${row.objectId}:${row.version}`} value={`${row.objectId}:${row.version}`}>{row.label}</option>)}</Select>
    </div>}
  </Drawer>;
}
