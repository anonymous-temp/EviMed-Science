import { useState } from "react";
import { ShareDrawer, type ShareTab } from "@/app/routes/CapsuleTransferPanel";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { Drawer } from "@/components/ui/Drawer";
import { fetchMemoryProfile } from "@/lib/apiClient";
import { fetchMyCapsule } from "@/lib/memoryClient";
import { useProjectLabels } from "@/lib/projectNames";
import { ForgottenDrawer } from "./ForgottenDrawer";
import { MemoryControls } from "./MemoryControls";
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

/** The drawers the header's actions open: sharing and importing (on the tab named), the forgotten list, and the one-line 「记住这一条」. */
export type HeaderDrawer = { kind: "share"; tab: ShareTab } | { kind: "forgotten" } | { kind: "remember" };

/**
 * The capsule's header actions on a page that is not the memory lists — the overview and the map (T0.7): the 记忆 switch, the one 「⋯」
 * (分享与导入 · 已忘记的内容 · 本项目不使用记忆 · 重置记忆) and, for an account whose memory takes words typed on the page, 「记住这一条」.
 * They are the lists' own `MemoryControls` and drawers, so the verbs that make a capsule a capsule are the same wherever the researcher
 * lands; what the page does not read for itself (the forgotten list) is read when its drawer opens.
 *
 * `onChanged` is what the page does when a switch, a reset, an import or a restore changed what it draws: it reads again. A page whose own
 * card opens one of the drawers (the overview's 收到的: 「导入一个胶囊」) holds which is open (`drawer`, `onDrawer`); the others leave it to this.
 */
export function MemoryHeaderActions({ native, projectId, onChanged, drawer: held, onDrawer }: {
  /** Whether the account's memory is the engine's own: only then can the person add a memory by hand. */
  native: boolean;
  /** The project 「本项目不使用记忆」 acts on, and where 「记住这一条」 files a memory; see `MemoryControls`. */
  projectId?: string | null;
  onChanged: () => void;
  drawer?: HeaderDrawer | null;
  onDrawer?: (next: HeaderDrawer | null) => void;
}) {
  const [own, setOwn] = useState<HeaderDrawer | null>(null);
  const drawer = onDrawer ? held ?? null : own;
  const setDrawer = onDrawer ?? setOwn;
  return (
    <>
      <MemoryControls
        projectId={projectId}
        onReset={onChanged}
        onSettingsChanged={onChanged}
        onShare={() => setDrawer({ kind: "share", tab: "export" })}
        onForgotten={() => setDrawer({ kind: "forgotten" })}
        onRemember={native ? () => setDrawer({ kind: "remember" }) : undefined}
      />
      {drawer?.kind === "remember" && <RememberDialog projectId={projectId ?? null} onClose={() => setDrawer(null)} onAsked={onChanged} />}
      {drawer?.kind === "share" && <ShareDrawer initialTab={drawer.tab} onClose={() => setDrawer(null)} onImported={onChanged} />}
      {drawer?.kind === "forgotten" && <ForgottenHost onClose={() => setDrawer(null)} onChanged={onChanged} />}
    </>
  );
}
