import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import { VCR_MEMBER_ROLES } from "@evimed/domain";
import { webErrorMessage } from "@/lib/apiClient";
import {
  getVcrMatching,
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
import { memberRoleLabel } from "./vcrText";

/** The account ids a route takes: the same pattern the server checks a path segment against. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 成员与角色: who is on this study and what each of them may do (plan §11.2).
 *
 * The lead's, because managing members is itself an ability (`manage_members`):
 * a clinical reviewer who could add a data manager would be a way round every
 * field-level grant in the module.
 *
 * Hidden knowledge:
 *  - **One account, several roles.** The single physician at a small site is
 *    the coordinator and the clinical reviewer, so a role is added and removed
 *    one at a time — the removal names its role, and the account keeps the
 *    others.
 *  - **The owner is the lead without a row.** It is listed first and its role
 *    has no way out: the study must never end up with nobody who can manage it.
 *  - **A `site` member names its site**, because a site reads and moves only
 *    its own referrals and a site role without one would do nothing. The sites
 *    are the study's own (the matching tab's 中心).
 *  - One request at a time: every control is disabled while one is in flight.
 */
export function VcrMembersDialog({ studyId, onClose }: { studyId: string; onClose: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:members`, () => getVcrMembers(studyId));
  const [busy, setBusy] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<VcrMemberRole>("clinical_reviewer");
  const [siteId, setSiteId] = useState("");
  const [sites, setSites] = useState<Array<{ id: string; name: string }> | null>(null);
  const roleId = useId();
  const siteFieldId = useId();

  // The sites are read once, when the role that needs one is first picked.
  useEffect(() => {
    if (role !== "site" || sites !== null) return undefined;
    let live = true;
    void getVcrMatching(studyId, { view: "sites" }).then(
      (data) => { if (live) setSites((data.sites ?? []).map((site) => ({ id: site.id, name: site.name }))); },
      () => { if (live) setSites([]); },
    );
    return () => { live = false; };
  }, [role, sites, studyId]);

  const account = userId.trim();
  const needsSite = role === "site";
  const valid = ACCOUNT_ID.test(account) && (!needsSite || siteId !== "");

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
                    <span className="min-w-0 flex-1 truncate text-ui text-text">{member.userId}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {member.roles.map((each) => (
                        <span key={each} className="inline-flex items-center gap-0.5">
                          <Tag>{memberRoleLabel(each)}</Tag>
                          {!member.owner && (
                            <IconButton
                              icon={X}
                              size="sm"
                              label={`移除 ${member.userId} 的“${memberRoleLabel(each)}”`}
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
              userId: account, role, ...(needsSite ? { detail: { siteId } } : {}),
            }), "已添加。", "成员暂时无法添加，请稍后重试。");
          }}
        >
          <Input label="成员账号 ID" value={userId} onChange={(event) => setUserId(event.target.value)} autoComplete="off" />
          <div>
            <label htmlFor={roleId} className="mb-2 block text-ui font-medium text-text">角色</label>
            <select id={roleId} value={role} onChange={(event) => setRole(event.target.value as VcrMemberRole)} className={inputClasses()}>
              {VCR_MEMBER_ROLES.map((each) => <option key={each} value={each}>{memberRoleLabel(each as VcrMemberRole)}</option>)}
            </select>
          </div>
          {needsSite && (
            <div>
              <label htmlFor={siteFieldId} className="mb-2 block text-ui font-medium text-text">所属中心</label>
              <select id={siteFieldId} value={siteId} onChange={(event) => setSiteId(event.target.value)} className={inputClasses()}>
                <option value="">选择中心</option>
                {(sites ?? []).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex justify-end">
            <Button type="submit" loading={busy === "add"} disabled={!valid || busy !== null}>添加</Button>
          </div>
        </form>
      </div>
    </Drawer>
  );
}
