import { useCallback, useEffect, useState, type FormEvent } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { addGeoMember, getGeoMembers, removeGeoMember, type GeoMember, type GeoMemberRole, type GeoMembers } from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { FilterChips } from "@/components/ui/FilterChips";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input } from "@/components/ui/Input";

/** The three roles a member may be given, in the words a team uses. The owner is the account that made the project. */
const ROLE_OPTIONS: ReadonlyArray<{ value: GeoMemberRole; label: string }> = [
  { value: "editor", label: "编辑" },
  { value: "medical_reviewer", label: "医学审核" },
  { value: "viewer", label: "只读" },
];

/** What each role may do, said once under the form. */
const ROLE_NOTE: Readonly<Record<GeoMemberRole, string>> = Object.freeze({
  editor: "编辑可以写结论库和稿件、让 AI 做、导出，但不能动预算和订单。",
  medical_reviewer: "医学审核可以放行安全待复核的稿件，并作为证据卡上署名的审核医生。",
  viewer: "只读只能看，不能改。",
});

/**
 * 「成员」 — who else is in this project: colleagues and an outside agency, by role. The owner adds and removes them; anyone may take
 * themselves off. A medical reviewer is named on the product cards as the reviewing doctor, so the dialog asks for the hospital and
 * department that name them. The list is the server's; what each role may do is judged there per operation.
 */
export function MembersDialog({ geoId, onClose }: { geoId: string; onClose: () => void }) {
  const [data, setData] = useState<GeoMembers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<GeoMemberRole>("editor");
  const [hospital, setHospital] = useState("");
  const [department, setDepartment] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    void getGeoMembers(geoId).then(setData, (caught: unknown) => setError(webErrorMessage(caught, { fallback: "成员暂时无法读取。" })));
  }, [geoId]);
  useEffect(load, [load]);

  const manage = Boolean(data?.you.abilities.includes("manage_members"));

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (!userId.trim()) { setError("请填成员的账号。"); return; }
    setSaving(true);
    setError(null);
    const detail = role === "medical_reviewer" ? { ...(hospital.trim() ? { hospital: hospital.trim() } : {}), ...(department.trim() ? { department: department.trim() } : {}) } : undefined;
    void addGeoMember(geoId, { userId: userId.trim(), role, ...(detail && Object.keys(detail).length ? { detail } : {}) })
      .then(() => { setUserId(""); setHospital(""); setDepartment(""); load(); })
      .catch((caught: unknown) => setError(webErrorMessage(caught, { fallback: "成员无法添加，请稍后重试。" })))
      .finally(() => setSaving(false));
  };

  const remove = (member: GeoMember) => {
    void removeGeoMember(geoId, member.userId)
      .then(() => load())
      .catch((caught: unknown) => setError(webErrorMessage(caught, { fallback: "成员无法移除，请稍后重试。" })));
  };

  return (
    <FormDialog title="成员" onClose={onClose} busy={saving}>
      <ul aria-label="成员列表" className="flex flex-col divide-y divide-faint">
        {(data?.members ?? []).map((member) => (
          <li key={member.userId} className="flex items-center gap-3 py-2 text-ui">
            <span className="min-w-0 flex-1 truncate text-text">{member.name || member.userId}</span>
            <span className="shrink-0 text-caption text-text-3">{member.roleLabels.join("、")}</span>
            {!member.owner && manage && (
              <Button variant="text" size="sm" onClick={() => remove(member)}>移除</Button>
            )}
          </li>
        ))}
      </ul>
      {manage && (
        <form className="mt-4 flex flex-col gap-3" onSubmit={add} noValidate>
          <Input label="成员的账号" autoComplete="off" value={userId} onChange={(event) => setUserId(event.target.value)} />
          <FilterChips<GeoMemberRole> label="角色" options={ROLE_OPTIONS} value={role} onChange={(next) => { if (next) setRole(next); }} />
          {role === "medical_reviewer" && (
            <>
              <Input label="医院" autoComplete="off" value={hospital} onChange={(event) => setHospital(event.target.value)} />
              <Input label="科室" autoComplete="off" value={department} onChange={(event) => setDepartment(event.target.value)} />
            </>
          )}
          <p className="text-caption text-text-3">{ROLE_NOTE[role]}</p>
          <div className="flex justify-end"><Button type="submit" loading={saving}>添加</Button></div>
        </form>
      )}
      {error && <p role="alert" className="mt-3 text-ui text-danger">{error}</p>}
    </FormDialog>
  );
}
