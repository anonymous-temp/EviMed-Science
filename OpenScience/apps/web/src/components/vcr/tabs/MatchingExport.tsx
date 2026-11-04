import { useState } from "react";
import { Download } from "lucide-react";
import { downloadVcrMatching, type VcrMatchExport } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";

type Where = { direction: "patient_to_trial"; subjectKey: string } | { direction: "trial_to_patient"; protocolVersionId?: string | null };

const CHOICES: ReadonlyArray<{ label: string; format: "csv" | "json"; kind: "pairs" | "clauses" }> = [
  { label: "每对一行（CSV）", format: "csv", kind: "pairs" },
  { label: "逐条款（CSV）", format: "csv", kind: "clauses" },
  { label: "每对一行（JSON）", format: "json", kind: "pairs" },
  { label: "逐条款（JSON）", format: "json", kind: "clauses" },
];

/**
 * 「导出」: the judged rows of what the page shows as a file — all of them, not the page in view. A row for each pair of patient and trial, or a row
 * for each clause of each pair with the sentences it rests on; CSV opens in Excel, JSON is for a script.
 *
 * Hidden knowledge:
 *  - The page offers it only to a reader who may export and may read patient-level data: the file holds the sentences of the record that the
 *    judgments cite, and the server asks for both again.
 *  - The file is fetched and handed over when it has come; a refusal is said in words and nothing is saved under the file's name.
 */
export function MatchingExport({ studyId, where, abilities }: { studyId: string; where: Where; abilities: readonly string[] }) {
  const [busy, setBusy] = useState(false);
  if (!abilities.includes("export") || !abilities.includes("read_patient_level")) return null;
  const save = (choice: (typeof CHOICES)[number]) => {
    if (busy) return;
    setBusy(true);
    const request: VcrMatchExport = { ...where, format: choice.format, kind: choice.kind };
    void downloadVcrMatching(studyId, request)
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "文件暂时无法导出，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  return (
    <Menu label="导出" items={CHOICES.map((choice) => ({ label: choice.label, disabled: busy, onSelect: () => save(choice) }))}>
      <Button variant="secondary" size="sm" actionKind="set" loading={busy}>
        <Download size={16} aria-hidden="true" />
        导出
      </Button>
    </Menu>
  );
}
