import { useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { FormDialog } from "@/components/ui/FormDialog";
import { Button } from "@/components/ui/Button";
import { copySourceToProject, type SourceRecord } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { canCopyToProject } from "./sourceView";

/** A selected version is copied only after an explicit destination choice. */
export function SourceProjectDialog({ sources, options, conversation = false, onClose, onDone }: {
 sources: SourceRecord[]; options: ComboboxOption[]; conversation?: boolean;
 onClose(): void; onDone(projectId: string, sources: SourceRecord[]): void;
}) {
 const [target, setTarget] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const copied = (source: SourceRecord) => source.projectId !== target && !(conversation && source.display.shared);
 const needsCopy = sources.some(copied);
 // Checked before anything is copied: a selection that holds a document with nothing to copy (a compiled page, a drive document
 // that was only read) would otherwise stop halfway, with the documents before it already copied.
 const uncopyable = target ? sources.filter(source => copied(source) && !canCopyToProject(source)) : [];
 const save = async () => {
  if (!target || uncopyable.length) return;
  setBusy(true); setError(null);
  try {
   const resolved: SourceRecord[] = [];
   for (const source of sources) resolved.push(source.projectId === target || conversation && source.display.shared ? source : (await copySourceToProject(source, target)).source);
   onDone(target, resolved);
  } catch (failure) { setError(productErrorMessage(failure)); }
  finally { setBusy(false); }
 };
 return <FormDialog title={conversation ? "选择对话项目" : "添加到项目"} busy={busy} onClose={onClose}>
  <div className="space-y-4">
   <Combobox label="目标项目" hint="添加后在目标项目保存独立版本，后续修改不会自动同步。" value={target} onChange={setTarget} options={options} clearable={false} disabled={busy} />
   {uncopyable.length > 0 && <div role="alert" className="text-ui text-danger">{`${uncopyable.map(source => `“${source.display.title}”`).join("、")}没有可复制的原件，取消选择后再添加。`}</div>}
   {error && <div role="alert" className="text-ui text-danger">{error}</div>}
   <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button disabled={!target || uncopyable.length > 0} loading={busy} onClick={() => void save()}>{conversation ? needsCopy ? "添加到项目并在对话中使用" : "在对话中使用" : "添加到项目"}</Button></div>
  </div>
 </FormDialog>;
}
