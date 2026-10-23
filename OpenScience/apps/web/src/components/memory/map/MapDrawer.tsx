import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMemoryProfile, type WebMemoryProfile } from "@/lib/apiClient";
import { listAllMethods } from "@/lib/methodsClient";
import type { WebMethod } from "@/lib/methodsClient";
import { fetchMyCapsule, type MyCapsule } from "@/lib/memoryClient";
import { FactDrawer } from "@/components/memory/FactDrawer";
import { factItems } from "@/components/memory/memoryItems";
import { MethodDrawer } from "@/components/memory/PracticeDrawer";

/**
 * The drawer a mark of the map opens: the memory page's own `FactDrawer` for a memory (edit, confirm, 以这条为准, 以前的版本, 忘记,
 * and the 关联 section), and its `MethodDrawer` for a learned method — not a lookalike. The map's document carries only a line of
 * each memory, so the whole record is read when the drawer opens, the way the memory page reads it, and a memory that is gone by
 * then is said so in a sentence rather than shown as an empty drawer.
 *
 * `open` is the address's own key: `record:<id>`, `entry:<id>` or `method:<id>`, the same keys the memory page uses. An `entry` is a note of
 * the researcher's own capsule (the 「项目笔记」 a conversation wrote): the page reads the capsule's notes when it opens, and `FactDrawer` edits,
 * forgets and undoes it through the capsule's own routes, as it does on the memory page.
 */
export function MapDrawer({ open, projectName, onClose, onChanged, onOpenRecord, canOpenRecord }: {
  open: string;
  projectName: (id: string | null) => string | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenRecord: (recordId: string) => void;
  canOpenRecord: (recordId: string) => boolean;
}) {
  const [profile, setProfile] = useState<WebMemoryProfile | null | "failed">(null);
  const [methods, setMethods] = useState<WebMethod[] | null | "failed">(null);
  const [mine, setMine] = useState<MyCapsule | null | "failed">(null);
  const [attempt, setAttempt] = useState(0);
  const kind = open.startsWith("method:") ? "method" : open.startsWith("record:") ? "record" : open.startsWith("entry:") ? "entry" : null;

  useEffect(() => {
    if (kind !== "record") return undefined;
    let cancelled = false;
    fetchMemoryProfile().then((found) => { if (!cancelled) setProfile(found); }, () => { if (!cancelled) setProfile("failed"); });
    return () => { cancelled = true; };
  }, [kind, attempt]);
  useEffect(() => {
    if (kind !== "entry") return undefined;
    let cancelled = false;
    fetchMyCapsule().then((found) => { if (!cancelled) setMine(found); }, () => { if (!cancelled) setMine("failed"); });
    return () => { cancelled = true; };
  }, [kind, attempt]);
  useEffect(() => {
    if (kind !== "method") return undefined;
    let cancelled = false;
    listAllMethods("approved").then((found) => { if (!cancelled) setMethods(found); }, () => { if (!cancelled) setMethods("failed"); });
    return () => { cancelled = true; };
  }, [kind, attempt]);

  const reload = useCallback(() => { setAttempt((count) => count + 1); onChanged(); }, [onChanged]);

  const records = profile && profile !== "failed" ? profile.records : null;
  const items = useMemo(() => (records ? factItems(records, []) : []), [records]);
  const knownIds = useMemo(() => new Set((records ?? []).map((record) => record.id)), [records]);
  const item = useMemo(() => {
    if (kind !== "record" || !records) return null;
    const found = items.find((entry) => entry.key === open);
    if (found) return found;
    // A memory that was replaced is listed under what replaced it, not on its own; the map opens it on its own all the same.
    const record = records.find((entry) => `record:${entry.id}` === open);
    return record ? factItems([record], [])[0] ?? null : null;
  }, [kind, records, items, open]);

  if (kind === "record") {
    if (profile === null) return null;
    if (!item) {
      return (
        <p role="status" className="mt-4 text-ui text-text-2">
          {profile === "failed" ? "暂时读不到这条记忆，请重试。" : "这条记忆已经不在了。"}
          <button type="button" onClick={profile === "failed" ? reload : onClose} className="ml-2 text-accent hover:underline">{profile === "failed" ? "重试" : "知道了"}</button>
        </p>
      );
    }
    return (
      <FactDrawer
        key={item.key} item={item}
        projectName={item.group === "project" ? projectName(item.projectId) : null}
        conversations={profile && profile !== "failed" ? profile.conversations : undefined}
        siblings={records ?? []}
        onClose={onClose} onChanged={reload}
        onOpenRecord={onOpenRecord} canOpenRecord={(id) => knownIds.has(id) && canOpenRecord(id)}
      />
    );
  }
  if (kind === "entry") {
    if (mine === null) return null;
    // A note the researcher forgot is under 已忘记的内容 and is no mark of the map: it is not found here, and the sentence says so.
    const found = mine !== "failed" ? factItems([], mine.entries).find((entry) => entry.key === open) ?? null : null;
    if (!found) {
      return (
        <p role="status" className="mt-4 text-ui text-text-2">
          {mine === "failed" ? "暂时读不到这条笔记，请重试。" : "这条笔记已经不在了。"}
          <button type="button" onClick={mine === "failed" ? reload : onClose} className="ml-2 text-accent hover:underline">{mine === "failed" ? "重试" : "知道了"}</button>
        </p>
      );
    }
    return (
      <FactDrawer
        key={found.key} item={found}
        projectName={found.group === "project" ? projectName(found.projectId) : null}
        siblings={[]} onClose={onClose} onChanged={reload}
        onOpenRecord={onOpenRecord} canOpenRecord={() => false}
      />
    );
  }
  if (kind === "method") {
    const method = Array.isArray(methods) ? methods.find((entry) => `method:${entry.id}` === open) : null;
    if (methods === null) return null;
    if (!method) return <p role="status" className="mt-4 text-ui text-text-2">这条做法已经不在了。<button type="button" onClick={onClose} className="ml-2 text-accent hover:underline">知道了</button></p>;
    return <MethodDrawer key={method.id} method={method} onClose={onClose} onChanged={reload} />;
  }
  return null;
}
