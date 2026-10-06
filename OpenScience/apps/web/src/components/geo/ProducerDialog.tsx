import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { patchGeoProject, type GeoProducer } from "@/lib/geoClient";
import { trapTab } from "@/lib/focusTrap";
import { Button } from "@/components/ui/Button";
import { FilterChips } from "@/components/ui/FilterChips";
import { Input } from "@/components/ui/Input";

const KIND_OPTIONS: ReadonlyArray<{ value: "enterprise" | "doctor"; label: string }> = [
  { value: "enterprise", label: "企业" },
  { value: "doctor", label: "医生" },
];

/**
 * 「出品方」 — who speaks for the product. It is written at the top of every card the project makes, with how the producer stands to the
 * product, so a reader always knows whose words they are reading. A company names itself (or, left empty, is the marketing-authorization
 * holder the run verified); a doctor gives their name and the hospital, department and specialty their byline shows.
 */
export function ProducerDialog({ geoId, initial, onSaved, onCancel }: { geoId: string; initial: GeoProducer | null; onSaved: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<"enterprise" | "doctor">(initial?.kind ?? "enterprise");
  const [name, setName] = useState(initial?.name ?? "");
  const [hospital, setHospital] = useState(initial?.hospital ?? "");
  const [department, setDepartment] = useState(initial?.department ?? "");
  const [specialty, setSpecialty] = useState(initial?.specialty ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel.current();
      if (event.key === "Tab") trapTab(dialogRef.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); trigger?.focus(); };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (kind === "doctor" && !name.trim()) { setError("请填医生的姓名。"); return; }
    setSaving(true);
    setError(null);
    const producer: GeoProducer = {
      kind,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(kind === "doctor" ? {
        ...(hospital.trim() ? { hospital: hospital.trim() } : {}),
        ...(department.trim() ? { department: department.trim() } : {}),
        ...(specialty.trim() ? { specialty: specialty.trim() } : {}),
      } : {}),
    };
    void patchGeoProject(geoId, { producer })
      .then(() => onSaved())
      .catch((caught: unknown) => { setSaving(false); setError(webErrorMessage(caught, { fallback: "出品方无法保存，请稍后重试。" })); });
  };

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-sm rounded-card border border-border bg-surface p-6 shadow-modal">
        <h2 id={titleId} className="text-ui font-semibold text-text">出品方</h2>
        <form className="mt-4 flex flex-col gap-4" onSubmit={submit} noValidate>
          <FilterChips<"enterprise" | "doctor"> label="出品方类型" options={KIND_OPTIONS} value={kind} onChange={(next) => { if (next) setKind(next); }} />
          <Input label={kind === "doctor" ? "医生姓名" : "企业名称（可留空，用说明书上的持证商）"} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
          {kind === "doctor" && (
            <>
              <Input label="医院" autoComplete="off" value={hospital} onChange={(event) => setHospital(event.target.value)} />
              <Input label="科室" autoComplete="off" value={department} onChange={(event) => setDepartment(event.target.value)} />
              <Input label="专业" autoComplete="off" value={specialty} onChange={(event) => setSpecialty(event.target.value)} />
            </>
          )}
          {error && <p role="alert" className="text-ui text-danger">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" onClick={onCancel}>取消</Button>
            <Button type="submit" loading={saving}>保存</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
