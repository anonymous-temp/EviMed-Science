import { ShareDrawer, type ShareTab } from "@/app/routes/CapsuleTransferPanel";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { Drawer } from "@/components/ui/Drawer";
import { fetchMemoryProfile } from "@/lib/apiClient";
import { fetchMyCapsule } from "@/lib/memoryClient";
import { useProjectLabels } from "@/lib/projectNames";
import { ForgottenDrawer } from "./ForgottenDrawer";
import { ImportDialog } from "./ImportDialog";
import type { MemoryFrameControls } from "./MemoryFrame";
import { RememberDialog } from "./RememberDialog";

/**
 * 已忘记的内容 on a page that does not hold the memory lists: the memories and the notes are read when the drawer opens (the page that
 * draws a picture of the capsule has not read them), and a read that fails says so in the drawer, with 重试 — never 「没有」.
 */
function ForgottenHost({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const labels = useProjectLabels();
  const { data, failed, reload } = useCapsuleData(async () => {
    const [profile, mine] = await Promise.all([fetchMemoryProfile(), fetchMyCapsule()]);
    return { records: profile.records, entries: mine.forgotten };
  });
  if (data) {
    return <ForgottenDrawer records={data.records} entries={data.entries} projectName={(id) => (id ? labels.get(id) ?? null : null)} onClose={onClose} onChanged={onChanged} />;
  }
  return (
    <Drawer title="已忘记的内容" onClose={onClose}>
      {failed ? <LoadError message="暂时读不到已忘记的内容。" onRetry={reload} /> : <RunsSkeleton filter={false} />}
    </Drawer>
  );
}

/** The drawers the capsule's controls open: sharing and importing (on the tab named), the forgotten list, the one-line 「记住这一条」 and 「从其他 AI 导入」. */
export type HeaderDrawer = { kind: "share"; tab: ShareTab } | { kind: "forgotten" } | { kind: "remember" } | { kind: "import" };

/**
 * The capsule's controls on a page that does not hold the memory lists — the overview: what each of the switch's, the 「⋯」's and the
 * button's actions does is open one of `HeaderDrawer`'s drawers (or, for the reset, read the page again). They are the lists' own
 * `MemoryControls` and drawers (`MemoryFrame` draws the controls, `MemoryHeaderDrawers` the drawers), so the verbs that make a capsule a
 * capsule are the same wherever the researcher lands; what the page does not read for itself (the forgotten list) is read when its drawer opens.
 *
 * `onChanged` is what the page does when a reset, an import or a restore changed what it draws: it reads again.
 */
export function headerControls({ onChanged, onDrawer }: { onChanged: () => void; onDrawer: (next: HeaderDrawer | null) => void }): MemoryFrameControls {
  return {
    onReset: onChanged,
    onShare: () => onDrawer({ kind: "share", tab: "export" }),
    onForgotten: () => onDrawer({ kind: "forgotten" }),
    onRemember: () => onDrawer({ kind: "remember" }),
    onImport: () => onDrawer({ kind: "import" }),
  };
}

/** The drawer the page's controls (or one of its own cards: the overview's 收到的 「导入一个胶囊」) opened, if any. */
export function MemoryHeaderDrawers({ drawer, onDrawer, onChanged }: {
  drawer: HeaderDrawer | null;
  onDrawer: (next: HeaderDrawer | null) => void;
  onChanged: () => void;
}) {
  return (
    <>
      {drawer?.kind === "remember" && <RememberDialog onClose={() => onDrawer(null)} onAsked={onChanged} />}
      {drawer?.kind === "import" && <ImportDialog onClose={() => onDrawer(null)} onSaved={onChanged} />}
      {drawer?.kind === "share" && <ShareDrawer initialTab={drawer.tab} onClose={() => onDrawer(null)} onImported={onChanged} />}
      {drawer?.kind === "forgotten" && <ForgottenHost onClose={() => onDrawer(null)} onChanged={onChanged} />}
    </>
  );
}
