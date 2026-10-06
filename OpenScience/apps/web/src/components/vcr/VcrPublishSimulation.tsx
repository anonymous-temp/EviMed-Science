import { useId, useRef, useState } from "react";
import { VCR_SIMULATION_NOT_EVIDENCE_ZH } from "@evimed/domain";
import { publishVcrSimulation, withdrawVcrSimulation } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input, Textarea } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";

/**
 * 发布到模拟研究: the study's lead may put one of the study's reports in the public column. The page sends words only — a title and a
 * summary; every number in the public form is read from the report by the server, carries its value source, and passes the same
 * small-cell floor a run's reads do. The fixed sentence is said before the act and is the one the public page carries: a simulated
 * result is not evidence.
 */
export function VcrPublishSimulation({ studyId, exportId, defaultTitle, publication, onChanged }: {
  studyId: string;
  exportId: string;
  defaultTitle: string;
  publication: { canPublish: boolean; live: { id: string; publishedAt: string } | null };
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const titleId = useId();
  const summaryId = useId();
  if (!publication.canPublish && !publication.live) return null;

  const run = (work: () => Promise<unknown>, done: string, failure: string) => {
    if (holding.current) return;
    holding.current = true;
    setBusy(true);
    void work()
      .then(() => { toast.success(done); setOpen(false); onChanged(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <div data-vcr-publish="" className="mt-3 flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-2">
        {publication.live ? <Tag tone="accent">已发布到模拟研究</Tag> : null}
        {publication.canPublish && !publication.live && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>发布到模拟研究</Button>}
        {publication.canPublish && publication.live && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => withdrawVcrSimulation(studyId, publication.live?.id ?? ""), "已撤回。", "暂时无法撤回，请稍后重试。")}>撤回</Button>
        )}
      </p>
      <p className="text-caption text-text-3">{VCR_SIMULATION_NOT_EVIDENCE_ZH}</p>
      {open && (
        <FormDialog title="发布到模拟研究" onClose={() => setOpen(false)} busy={busy}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => publishVcrSimulation(studyId, { exportId, title: title.trim(), summary: summary.trim() }), "已发布到模拟研究。", "暂时无法发布，请稍后重试。");
            }}
          >
            <p className="text-ui text-text-2">{`报告里的数字会带着各自的来源标签公开，样本很小的格子照常被隐藏；公开页上写着：“${VCR_SIMULATION_NOT_EVIDENCE_ZH}”`}</p>
            <Input id={titleId} label="标题" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
            <Textarea id={summaryId} label="一句话说明" value={summary} maxLength={600} rows={3} onChange={(event) => setSummary(event.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="text" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
              <Button type="submit" loading={busy} disabled={!title.trim()}>发布</Button>
            </div>
          </form>
        </FormDialog>
      )}
    </div>
  );
}
