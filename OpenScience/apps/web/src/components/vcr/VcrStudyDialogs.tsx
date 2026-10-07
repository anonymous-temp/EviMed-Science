import { useRef, useState } from "react";
import { VCR_EXPORT_KIND_LABELS_ZH } from "@evimed/domain";
import { renameVcrStudy, type VcrExportKind } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input } from "@/components/ui/Input";

/** A study's name is one line of 1 to 40 characters: the project that carries it has the same limit. */
export const VCR_STUDY_NAME_MAX = 40;

/**
 * 「重命名」: the AI named the study from what it was asked, and the researcher may name it as they like — here and from the
 * project's own menu. The title above the page is the answer, so there is nothing else to confirm.
 */
export function VcrRenameDialog({ studyId, name, onClose, onRenamed }: {
  studyId: string;
  name: string;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const holding = useRef(false);
  const next = value.replace(/\s+/g, " ").trim();
  const valid = next.length > 0 && [...next].length <= VCR_STUDY_NAME_MAX;

  const save = () => {
    if (!valid || holding.current) return;
    if (next === name) { onClose(); return; }
    holding.current = true;
    setBusy(true);
    setError(null);
    void renameVcrStudy(studyId, next)
      .then(() => onRenamed(next))
      .catch((failure: unknown) => setError(webErrorMessage(failure, { fallback: "名称暂时无法保存，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <FormDialog title="重命名研究" onClose={onClose} busy={busy}>
      <form data-vcr-rename="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <Input
          label="研究名称"
          value={value}
          maxLength={VCR_STUDY_NAME_MAX}
          onChange={(event) => setValue(event.target.value)}
          error={error ?? undefined}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!valid || busy}>保存</Button>
        </div>
      </form>
    </FormDialog>
  );
}

/** What can be exported, in the order a reader looks for it. */
export const VCR_EXPORT_CHOICES: ReadonlyArray<{ kind: VcrExportKind; label: string }> = Object.freeze(
  (["study_package", "simulation_report", "cde_communication_pack", "validation_pack", "model_analysis_plan", "model_analysis_report"] as const)
    .map((kind) => ({ kind, label: (VCR_EXPORT_KIND_LABELS_ZH as Record<string, string>)[kind] })),
);

/**
 * 「导出…」: one entry in the menu instead of six, and the choice here. Exporting starts the document's run in the study's own
 * conversation, which is where the reader lands once it has started.
 */
export function VcrExportDialog({ busy, onClose, onExport }: {
  busy: boolean;
  onClose: () => void;
  onExport: (kind: VcrExportKind) => void;
}) {
  const [kind, setKind] = useState<VcrExportKind>("study_package");
  return (
    <FormDialog title="导出" onClose={onClose} busy={busy}>
      <form data-vcr-export="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!busy) onExport(kind); }}>
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">导出什么</legend>
          {VCR_EXPORT_CHOICES.map((choice) => (
            <label
              key={choice.kind}
              className={cn("flex cursor-pointer items-center gap-2.5 rounded px-3 py-2 text-ui", kind === choice.kind ? "bg-accent-soft text-accent-strong" : "text-text hover:bg-surface-1")}
            >
              <input type="radio" name="vcr-export-kind" value={choice.kind} checked={kind === choice.kind} onChange={() => setKind(choice.kind)} className="h-3.5 w-3.5 accent-accent" />
              {choice.label}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy}>导出</Button>
        </div>
      </form>
    </FormDialog>
  );
}
