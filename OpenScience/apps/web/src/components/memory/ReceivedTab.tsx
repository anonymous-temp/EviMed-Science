import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { AsyncSwitch } from "@/components/ui/AsyncSwitch";
import { Drawer } from "@/components/ui/Drawer";
import { FactList, type Fact } from "@/components/ui/FactList";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { CAPSULE_ENTRY_TYPES, fromSender, providedBy } from "@/lib/capsuleText";
import { formatDay } from "@/lib/format";
import { announceMemoryChanged, disableCapsule, enableReceivedCapsule, fetchReceivedCapsules, type ReceivedCapsule } from "@/lib/memoryClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { DrawerSection } from "./DrawerSection";
import { handoverSentence, type WorkStyle } from "./handover";

/** What a pack brings, counted by kind, in the reader's words: 「研究方法 3 · 写作偏好 2」. */
export function packContents(pack: Pick<ReceivedCapsule, "counts">): string {
  const parts = CAPSULE_ENTRY_TYPES.filter((type) => (pack.counts[type.value] ?? 0) > 0).map((type) => `${type.label} ${pack.counts[type.value]}`);
  const other = Object.entries(pack.counts)
    .filter(([kind]) => !CAPSULE_ENTRY_TYPES.some((type) => type.value === kind))
    .reduce((sum, [, count]) => sum + count, 0);
  if (other > 0) parts.push(`其他 ${other}`);
  return parts.join(" · ");
}

/** Who a pack is from: the platform's own starter packs say who provides them, a person's share says who sent it. */
function sourceOf(pack: ReceivedCapsule): string | null {
  const author = pack.card?.author;
  if (!author) return null;
  return pack.official ? providedBy(author) : fromSender(author);
}

/** The people's own packs before the platform's starter packs, each newest first: a starter pack never pushes a taken-in one down. */
export function orderedPacks(packs: readonly ReceivedCapsule[]): ReceivedCapsule[] {
  return [...packs].sort((left, right) => Number(Boolean(left.official)) - Number(Boolean(right.official))
    || String(right.importedAt ?? "").localeCompare(String(left.importedAt ?? "")) || left.id.localeCompare(right.id));
}

/** How many packs are in force: the number on the tab and on the dashboard's tile. */
export function enabledPackCount(packs: readonly ReceivedCapsule[]): number {
  return packs.filter((pack) => pack.enabled && !pack.takenDown).length;
}

/**
 * What is in a pack, in a drawer: who it is from and what it says it holds (the card its sender signed), what it brings by kind, the
 * first methods in their own words and, when a newer snapshot replaced it, what changed. A pack taken down says so. The drawer reads
 * what the shelf already holds; it has no switch of its own, because the row's switch is the one place a pack is turned on or off.
 */
export function PackDrawer({ pack, onClose }: { pack: ReceivedCapsule; onClose: () => void }) {
  const facts: Fact[] = [
    ...(sourceOf(pack) ? [{ label: "来源", value: sourceOf(pack) }] : []),
    ...(pack.card?.summary ? [{ label: "内容", value: pack.card.summary }] : []),
    ...(packContents(pack) ? [{ label: "包含", value: packContents(pack) }] : []),
    ...(pack.importedAt ? [{ label: "收下", value: formatDay(pack.importedAt) }] : []),
    ...(pack.upgradedAt && pack.card?.changelog ? [{ label: `${formatDay(pack.upgradedAt)}更新`, value: pack.card.changelog }] : []),
  ];
  return (
    <Drawer title={pack.title} onClose={onClose}>
      <div className="space-y-6">
        {pack.takenDown && (
          <p role="status" className="text-ui text-danger-strong">
            {pack.takenDown.by === "operator" ? "已被平台下架并停用" : "作者已撤回，这份已停用"}{pack.takenDown.reason ? `：${pack.takenDown.reason}` : ""}
          </p>
        )}
        {facts.length > 0 && <FactList rows={facts} />}
        {pack.methods.length > 0 && (
          <DrawerSection label="里面的做法">
            <ul className="space-y-1.5">
              {pack.methods.map((method) => <li key={method} className="max-w-measure text-ui text-text">{method}</li>)}
            </ul>
          </DrawerSection>
        )}
      </div>
    </Drawer>
  );
}

/**
 * 「收到的」 (a tab of 记忆胶囊 since 2026-10-27): the packs other people shared and the platform's own starter packs, one row each. The
 * row's press opens what is in the pack (`PackDrawer`); the switch at its end puts it in force for the account, in every project, as a
 * reference — a switch and a row are two targets and do not trigger each other. A pack taken down by its author or the platform is shown
 * as such and cannot be switched on.
 *
 * Above the list, one sentence says what this account could hand over (the 工作方式卡's counts), with the way to do it; nothing when
 * there is nothing to hand over. The sentence's action opens 分享与导入 on 导出, the toolbar's on 导入.
 */
export function ReceivedTab({ packs, handover, onShare, onChanged }: {
  packs: readonly ReceivedCapsule[];
  /** What the account could hand over: absent while it is read or when it could not be (the sentence is then not drawn). */
  handover: WorkStyle | null;
  /** Opens 分享与导入 on 导出. */
  onShare: () => void;
  /** A switch was changed: the page reads the packs again. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  // A pack's switch says what went wrong in its own line, so a failure is thrown to it and not toasted.
  const act = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    try {
      await operation();
      announceMemoryChanged();
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  const enable = (pack: ReceivedCapsule) => act(`enable:${pack.id}`, async () => {
    await enableReceivedCapsule(pack.id);
    toast.success(`已启用“${pack.title}”`, { action: { label: "撤销", onClick: () => void disableCapsule(pack.id).then(() => { announceMemoryChanged(); onChanged(); }) } });
  });
  const disable = (pack: ReceivedCapsule) => act(`disable:${pack.id}`, async () => {
    await disableCapsule(pack.id);
    toast.success(`已停用“${pack.title}”`);
  });

  const sentence = handover ? handoverSentence(handover) : null;
  const ordered = orderedPacks(packs);
  const pack = opened ? ordered.find((item) => item.id === opened) ?? null : null;
  return (
    <div className="space-y-4">
      {sentence && <Note action={<Button size="sm" variant="secondary" onClick={onShare}>分享与导入</Button>}>{sentence}</Note>}
      <List label="收到的胶囊">
        {ordered.map((item) => (
          <ListRow
            key={item.id}
            title={item.title}
            onOpen={() => setOpened(item.id)}
            meta={item.takenDown
              ? <span>{item.takenDown.by === "operator" ? "已被平台下架并停用" : "作者已撤回，这份已停用"}</span>
              : <span>{[sourceOf(item), item.card?.summary || packContents(item)].filter(Boolean).join(" · ")}</span>}
            trailing={(
              <AsyncSwitch
                readChecked={async () => { const fresh = await fetchReceivedCapsules(); return fresh.find((entry) => entry.id === item.id)?.enabled ?? false; }}
                label={`启用“${item.title}”`} errorMessage={productErrorMessage} checked={item.enabled} pending={busy !== null} disabled={Boolean(item.takenDown)}
                onChange={(next) => (next ? enable(item) : disable(item))}
              />
            )}
          />
        ))}
      </List>
      {pack && <PackDrawer pack={pack} onClose={() => setOpened(null)} />}
    </div>
  );
}
