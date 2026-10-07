import { useState, type FormEvent } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { patchGeoProject } from "@/lib/geoClient";
import { PROJECT_NAME_MAX, projectNameProblem } from "@/lib/projectNames";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input } from "@/components/ui/Input";

/**
 * 「重命名」 — what the project is called in the sidebar, the project list and this page's title. A GEO project is named by its brand
 * when it is made; the name is the researcher's to change at any time, and it is the name only: the brand the project measures is
 * not touched. An editor of the project may rename it (the name is written as the project's owner).
 */
export function RenameDialog({ geoId, initial, onSaved, onCancel }: { geoId: string; initial: string; onSaved: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const problem = projectNameProblem(name);
    if (problem) { setError(problem); return; }
    const next = name.trim();
    if (next === initial) { onCancel(); return; }
    setSaving(true);
    setError(null);
    void patchGeoProject(geoId, { name: next })
      .then(() => onSaved(next))
      .catch((caught: unknown) => { setSaving(false); setError(webErrorMessage(caught, { fallback: "项目名没有改成功，请稍后重试。" })); });
  };

  return (
    <FormDialog title="重命名" onClose={onCancel} busy={saving}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Input label="项目名" autoComplete="off" maxLength={PROJECT_NAME_MAX} value={name} disabled={saving} onChange={(event) => { setName(event.target.value); setError(null); }} />
        {error && <p role="alert" className="text-ui text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={saving} onClick={onCancel}>取消</Button>
          <Button type="submit" loading={saving}>保存</Button>
        </div>
      </form>
    </FormDialog>
  );
}
