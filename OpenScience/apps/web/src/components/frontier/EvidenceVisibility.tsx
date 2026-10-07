import { useState } from "react";
import { EVIDENCE_ZONE_VISIBILITY_LABELS_ZH } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { evidenceErrorMessage, setEvidenceZoneVisibility, type EvidenceZone } from "@/lib/evidenceZoneClient";

/**
 * Who may read a published zone, as its owner's own choice (plan §5.2): signed-in accounts (平台内可见) or anyone on the
 * internet. It is a different act from 发布, which the line says once; a zone that is not published cannot be opened to the
 * internet, and the button says why instead of failing.
 */
export function EvidenceVisibility({ zone, onChanged }: { zone: EvidenceZone; onChanged: (zone: EvidenceZone) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = zone.visibility === "internet";
  const change = async (visibility: "platform" | "internet") => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await setEvidenceZoneVisibility(zone, visibility));
      setConfirming(false);
    } catch (reason) {
      setError(evidenceErrorMessage(reason));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="公开范围" className="space-y-2">
      <p className="text-ui text-text-2">
        <span className="text-text-3">公开范围 · </span>
        {EVIDENCE_ZONE_VISIBILITY_LABELS_ZH[open ? "internet" : "platform"]}
      </p>
      <p className="max-w-measure text-caption text-text-3">
        公开到互联网，是让没有登录的人也能看到这个专区里已发布的证据；它和“发布”是分开的两步，发布只让平台内的用户看到。
      </p>
      {open ? (
        <Button variant="secondary" loading={busy} onClick={() => void change("platform")}>取消公开</Button>
      ) : (
        <Button variant="secondary" disabled={zone.state !== "published" || busy} onClick={() => setConfirming(true)}>公开到互联网</Button>
      )}
      {!open && zone.state !== "published" && <p className="text-caption text-text-3">先发布专区，才能公开到互联网。</p>}
      {error && <p role="alert" className="text-ui text-error">{error}</p>}
      {confirming && (
        <ConfirmDialog
          title="公开到互联网"
          body="公开后，任何人都能在不登录的情况下看到这个专区和其中已发布的证据。随时可以取消公开。"
          confirmLabel="公开"
          tone="primary"
          busy={busy}
          onConfirm={() => void change("internet")}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
