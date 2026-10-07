import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { productErrorMessage } from "@/lib/productClient";
import { copyPlatformSkill, readPlatformSkill, type PersonalSkill, type PlatformSkill } from "@/lib/skillLibraryClient";
import { useLoad } from "./useLoad";

/** A drawer section: a small grey label over the text it names. */
export function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="flex flex-col gap-1.5"><h3 className="text-caption text-text-3">{title}</h3>{children}</section>;
}

/**
 * One of the skills the platform ships, opened from the list: what it does, when it is used, its full text where the
 * control plane carries the file, and 「复制为我的技能」 where it can be copied.
 *
 * The list row already carries the words, so the drawer opens on them at once and reads the full text behind them: a
 * slow or failed read costs the text, never the drawer.
 */
export function PlatformSkillDrawer({ skill, onClose, onCopied }: { skill: PlatformSkill; onClose: () => void; onCopied: (created: PersonalSkill) => void }) {
  const read = useCallback(() => readPlatformSkill(skill.id), [skill.id]);
  const { state, reload } = useLoad(read);
  const detail = state.status === "ready" ? state.data : null;
  // One request key per drawer: a retry after a lost answer is the same copy, not a second one.
  const key = useRef(crypto.randomUUID());
  const [copying, setCopying] = useState(false), [error, setError] = useState<string | null>(null);
  const copy = async () => {
    if (copying) return;
    setCopying(true); setError(null);
    try { onCopied(await copyPlatformSkill(skill.id, { title: skill.title, idempotencyKey: key.current })); }
    catch (caught) { setError(productErrorMessage(caught)); setCopying(false); }
  };
  return (
    <Drawer title={skill.title} description={`${skill.source === "community" ? "社区" : "平台内置"} · ${skill.group}`} onClose={onClose}>
      <div className="flex min-h-full flex-col gap-6">
        <DrawerSection title="它会做什么"><p className="text-ui text-text">{skill.use}</p></DrawerSection>
        {detail?.when && <DrawerSection title="什么时候会用到"><p className="text-ui text-text">{detail.when}</p></DrawerSection>}
        {state.status === "loading" && <FilesSkeleton />}
        {state.status === "error" && <LoadError message={state.message} onRetry={() => reload()} />}
        {detail?.instructions && (
          <DrawerSection title="全文">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-card bg-surface-1 p-4 text-ui text-text">{detail.instructions}</pre>
          </DrawerSection>
        )}
        {error && <p role="alert" className="text-ui text-error">{error}</p>}
        {skill.canCopy && <div className="mt-auto pt-2"><Button variant="secondary" loading={copying} onClick={() => void copy()}>复制为我的技能</Button></div>}
      </div>
    </Drawer>
  );
}
