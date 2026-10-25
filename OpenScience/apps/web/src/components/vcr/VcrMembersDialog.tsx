import { useId, useState } from "react";
import { X } from "lucide-react";
import { VCR_MEMBER_ROLES } from "@evimed/domain";
import { webErrorMessage } from "@/lib/apiClient";
import {
  getVcrMembers,
  removeVcrMember,
  setVcrMembers,
  type VcrMemberRole,
} from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { Input, inputClasses } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import { VcrTabSkeleton } from "./VcrStates";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { memberRoleLabel, NO_VALUE } from "./vcrText";

/** The account ids a route takes: the same pattern the server checks a path segment against. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A member is shown by name; the account id is for the remove call and is never printed in a person's place. */
const memberName = (member: { name?: string | null }) => member.name ?? NO_VALUE;

/**
 * 成员与角色: who is on this study and what each of them may do (plan §11.2).
 *
 * The lead's, because managing members is itself an ability (`manage_members`):
 * a clinical reviewer who could add a data manager would be a way round every
 * field-level grant in the module.
 *
 * Hidden knowledge:
 *  - **One account, several roles.** Review and data permissions are granted and removed independently.
 *  - **The owner is the lead without a row.** It is listed first and its role
 *    has no way out: the study must never end up with nobody who can manage it.
 *  - One request at a time: every control is disabled while one is in flight.
 */
export function VcrMembersDialog({ studyId, onClose }: { studyId: string; onClose: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:members`, () => getVcrMembers(studyId));
  const [busy, setBusy] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<VcrMemberRole>("clinical_reviewer");
  const roleId = useId();

  const account = userId.trim();
  const valid = ACCOUNT_ID.test(account);

  const work = (key: string, request: () => Promise<unknown>, done: string, failure: string) => {
    if (busy) return;
    setBusy(key);
    void request()
      .then(() => { toast.success(done); reload(); return true; })
      .catch((error: unknown) => { toast.error(webErrorMessage(error, { fallback: failure })); return false; })
      .then((ok) => { if (ok && key === "add") setUserId(""); })
      .finally(() => setBusy(null));
  };

  return (
    <Drawer title="成员与角色" onClose={onClose} widthClassName="max-w-md">
      <div data-vcr-members="" className="flex flex-col gap-6">
        {state.kind === "loading" ? <VcrTabSkeleton rows={3} />
          : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} />
            : (
              <ul className="divide-y divide-faint">
                {state.data.map((member) => (
                  <li key={member.userId} data-vcr-member={member.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
                    <span className="min-w-0 flex-1 truncate text-ui text-text">{memberName(member)}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {member.roles.map((each) => (
                        <span key={each} className="inline-flex items-center gap-0.5">
                          <Tag>{memberRoleLabel(each)}</Tag>
                          {!member.owner && (
                            <IconButton
                              icon={X}
                              size="sm"
                              label={`移除 ${memberName(member)} 的“${memberRoleLabel(each)}”`}
                              disabled={busy !== null}
                              onClick={() => work(`remove:${member.userId}:${each}`, () => removeVcrMember(studyId, member.userId, each),
                                "已移除。", "成员角色暂时无法移除，请稍后重试。")}
                            />
                          )}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            work("add", () => setVcrMembers(studyId, {
              userId: account, role,
            }), "已添加。", "成员暂时无法添加，请稍后重试。");
          }}
        >
          <Input label="成员账号 ID" value={userId} onChange={(event) => setUserId(event.target.value)} autoComplete="off" />
          <div>
            <label htmlFor={roleId} className="mb-2 block text-ui text-text">角色</label>
            <select id={roleId} value={role} onChange={(event) => setRole(event.target.value as VcrMemberRole)} className={inputClasses()}>
              {VCR_MEMBER_ROLES.map((each) => <option key={each} value={each}>{memberRoleLabel(each as VcrMemberRole)}</option>)}
            </select>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={busy === "add"} disabled={!valid || busy !== null}>添加</Button>
          </div>
        </form>
      </div>
    </Drawer>
  );
}
