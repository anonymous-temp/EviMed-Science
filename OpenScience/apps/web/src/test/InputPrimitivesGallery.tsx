import { useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Radio } from "@/components/ui/Radio";
import { Combobox } from "@/components/ui/Combobox";
import { DateRange } from "@/components/ui/DateField";
import { FileDrop } from "@/components/ui/FileDrop";
export function InputPrimitivesGallery() {
 const [selected, setSelected] = useState<string | null>("a"); const [range, setRange] = useState(["2028-02-29", ""]);
 return <section aria-label="Input primitives" className="flex max-w-xl flex-col gap-4"><Checkbox label="部分选择" mixed /><Checkbox label="选择已停用" disabled hint="没有编辑权限" /><fieldset><legend>导出内容</legend><Radio name="gallery-export" label="报告" defaultChecked /><Radio name="gallery-export" label="证据矩阵" /></fieldset><Combobox label="项目" value={selected} onChange={setSelected} options={[{ id: "a", label: "同名项目 · A" }, { id: "b", label: "同名项目 · B" }]} /><DateRange label="日期范围" start={range[0]} end={range[1]} onChange={(start, end) => setRange([start, end])} /><FileDrop label="添加文件" onFiles={() => undefined} items={[{ id: "1", name: "preserved-evidence-with-a-long-file-name.pdf", state: "transferred" }, { id: "2", name: "source.docx", state: "processing" }, { id: "3", name: "table.xlsx", state: "searchable" }, { id: "4", name: "failed.pdf", state: "failed", error: "连接中断" }]} /></section>;
}
