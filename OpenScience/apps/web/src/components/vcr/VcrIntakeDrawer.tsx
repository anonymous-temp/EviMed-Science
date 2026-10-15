import { getVcrData, readVcrIntake } from "@/lib/vcrClient";
import { LoadError } from "@/components/cards/LoadError";
import { Drawer } from "@/components/ui/Drawer";
import { IntakePanel } from "./data/IntakePanel";
import { VcrTabSkeleton } from "./VcrStates";
import { useVcrLoad } from "./vcrTabKit";

/**
 * 「数据接入」: the study's data sources, their files, field maps, snapshots and grants — one entry of the header's 「⋯」 on every tier
 * (R19, 2026-10-14). It was the last block of 定义与证据, folded under a line on a tier that takes no real data, and the first block of
 * a tier that does — a second job for a tab whose own is what the study rests on. A drawer holds a record, and this is the record of
 * where the study's data came from: it opens over whichever tab the reader is on and goes back to it.
 *
 * Reads the data tab's payload for its `intake` block (there is no route for the block alone); a change re-reads it here and asks
 * the page to read the study again, because freezing a snapshot can move what the data support and the header's offer to move up.
 */
export function VcrIntakeDrawer({ studyId, onClose, onChanged }: { studyId: string; onClose: () => void; onChanged: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:intake`, () => getVcrData(studyId));
  return (
    <Drawer title="数据接入" onClose={onClose} widthClassName="max-w-2xl">
      {state.kind === "loading" ? <VcrTabSkeleton rows={3} />
        : state.kind === "error" ? <LoadError message={state.message} onRetry={reload} />
          : <IntakePanel bare studyId={studyId} intake={readVcrIntake(state.data.intake)} onChanged={() => { reload(); onChanged(); }} />}
    </Drawer>
  );
}
