import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Input, inputClasses } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import {
  evidenceErrorMessage,
  listOwnUserZones,
  publishResultAsEvidenceCard,
  type EvidenceZone,
} from "@/lib/evidenceZoneClient";
import { resultCardClaims, type ResultCardClaim } from "@/lib/resultCardClaims";
import type { ResultVersion } from "@/lib/resultProvenance";

const NEW_ZONE = "__new__";

/** Whether a result is a clinical package: the capture recorded its evidence matrix. */
export function isClinicalPackage(version: Pick<ResultVersion, "review">): boolean {
  return typeof version.review?.matrixVersionId === "string";
}

/** What the dialog starts with: the claims whose quotation the run found, and nothing else. */
export function defaultClaimSelection(claims: readonly ResultCardClaim[]): string[] {
  return claims.filter((claim) => claim.status === "verified").map((claim) => claim.claimId);
}

const MARK: Record<string, { mark: string; className: string; label: string }> = {
  verified: { mark: "✓", className: "text-verify-ok", label: "已核验" },
  derived: { mark: "", className: "text-text-3", label: "推导结果" },
};

/**
 * 「发布为证据卡」: the claims of a clinical result with ✓ ones selected and ⚠ ones not, the researcher's own zone (or a new
 * one), and a draft card opened in the card editor. The card is a draft: publishing it is the researcher's own click there.
 */
export function PublishAsEvidenceCard({ version, onClose }: { version: ResultVersion; onClose: () => void }) {
  const navigate = useNavigate();
  const claims = useMemo(() => resultCardClaims(version), [version]);
  const [selected, setSelected] = useState<string[]>(() => defaultClaimSelection(claims));
  const [zones, setZones] = useState<EvidenceZone[] | null>(null);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [zoneChoice, setZoneChoice] = useState<string>(NEW_ZONE);
  const [title, setTitle] = useState("我的证据卡");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const zoneLabelId = useId();
  useEffect(() => {
    let active = true;
    setZonesError(null);
    listOwnUserZones()
      .then((list) => {
        if (!active) return;
        setZones(list);
        setZoneChoice(list[0]?.id ?? NEW_ZONE);
      })
      .catch((reason) => { if (active) setZonesError(evidenceErrorMessage(reason)); });
    return () => { active = false; };
  }, [attempt]);
  // A result whose claims cannot be listed (a source the project can no longer read) is published as the server selects it: its verified claims.
  const listed = claims.length > 0;
  const ready = zones !== null && (zoneChoice !== NEW_ZONE || title.trim().length > 0) && (!listed || selected.length > 0);
  const toggle = (claimId: string) => setSelected((current) => (current.includes(claimId) ? current.filter((id) => id !== claimId) : [...current, claimId]));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await publishResultAsEvidenceCard(version.versionId, {
        projectId: version.projectId,
        ...(zoneChoice === NEW_ZONE ? { newZone: { title: title.trim() } } : { zoneId: zoneChoice }),
        ...(listed ? { claimIds: selected } : {}),
      });
      navigate(`/app/frontier/zones/${encodeURIComponent(answer.evidence.zoneId)}/evidence/${encodeURIComponent(answer.evidence.id)}?edit=1`);
    } catch (reason) {
      setError(evidenceErrorMessage(reason));
      setBusy(false);
    }
  };
  return (
    <FormDialog title="发布为证据卡" onClose={onClose} busy={busy}>
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); if (ready) void submit(); }}>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-ui font-medium text-text">结论</legend>
          {listed ? (
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {claims.map((claim) => {
                const style = MARK[claim.status] ?? { mark: "⚠", className: "text-verify-pending", label: "未能核验" };
                return (
                  <li key={claim.claimId}>
                    <label className="flex items-start gap-2 text-ui text-text-2">
                      <input type="checkbox" className="mt-1" checked={selected.includes(claim.claimId)} onChange={() => toggle(claim.claimId)} disabled={busy} />
                      <span className="min-w-0">
                        <span className={`mr-1 ${style.className}`} aria-label={style.label}>{style.mark}</span>
                        {claim.text}
                        {claim.claimType === "derived" && <Tag className="ml-2">推导结果</Tag>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-ui text-text-2">这个结果的结论列表暂时读不到，将发布其中已核验的结论。</p>
          )}
        </fieldset>
        <div className="space-y-2">
          <p id={zoneLabelId} className="text-ui font-medium text-text">专区</p>
          {zonesError ? (
            <p role="alert" className="text-ui text-error">
              {zonesError}
              <Button variant="text" size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
            </p>
          ) : zones === null ? (
            <p role="status" className="text-ui text-text-3">正在读取你的专区</p>
          ) : (
            <select aria-labelledby={zoneLabelId} className={inputClasses({})} value={zoneChoice} onChange={(event) => setZoneChoice(event.target.value)} disabled={busy}>
              {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.title}</option>)}
              <option value={NEW_ZONE}>新建专区</option>
            </select>
          )}
          {zones !== null && zoneChoice === NEW_ZONE && (
            <Input label="新专区的名称" maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
          )}
        </div>
        {error && <p role="alert" className="text-ui text-error">{error}</p>}
        <p className="text-caption text-text-3">生成的是草稿，发布由你自己决定。</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="submit" loading={busy} disabled={!ready}>生成证据卡草稿</Button>
        </div>
      </form>
    </FormDialog>
  );
}
