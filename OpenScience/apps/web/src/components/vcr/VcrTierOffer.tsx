import { useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { patchVcrStudy, type VcrTierOffer as Offer } from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";

/**
 * The one move the study's frozen data offers: up to the tier the sources
 * support, with what that opens, and a single button.
 *
 * Nothing here decides a tier. The server derives the offer from the analysis
 * tables the data plane registered and offers it only to the lead who may make
 * it (`manage_study`); the same route refuses a rise the data do not support, so
 * a stale page cannot claim more than the data hold. It only offers a rise — a
 * tier is lowered by the lead on purpose, never from here.
 */
export function VcrTierOffer({ studyId, offer, onMoved }: { studyId: string; offer: Offer; onMoved: () => void }) {
  const [moving, setMoving] = useState(false);

  const move = () => {
    if (moving) return;
    setMoving(true);
    void patchVcrStudy(studyId, { dataTier: offer.tier })
      .then(() => { toast.success(`已升到 ${offer.tier}。`); onMoved(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "档位暂时无法修改，请稍后重试。" })))
      .finally(() => setMoving(false));
  };

  return (
    <section
      data-vcr-tier-offer={offer.tier}
      aria-label="数据档位"
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-border bg-surface px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-ui text-text">
        {`你接入的数据已够 ${offer.tier}：${offer.unlocks.join("；")}。`}
      </p>
      <Button size="sm" loading={moving} onClick={move}>{`升到 ${offer.tier}`}</Button>
    </section>
  );
}
