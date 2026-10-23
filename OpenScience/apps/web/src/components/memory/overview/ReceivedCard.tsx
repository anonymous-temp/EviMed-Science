import { useState } from "react";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Switch } from "@/components/ui/Switch";
import { CAPSULE_ENTRY_TYPES, fromSender } from "@/lib/capsuleText";
import { announceMemoryChanged, disableCapsule, enableReceivedCapsule, type ReceivedCapsule } from "@/lib/memoryClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { OverviewCard, Recipe, RecipeButton, type CardState } from "./OverviewCard";
import { WorkStyleCard } from "./WorkStyleCard";
import type { ReceivedCard, WorkStyle } from "./memoryOverviewModel";

/** What a pack brings, counted by kind, when its sender signed no summary. */
function contents(pack: ReceivedCapsule): string {
  const parts = CAPSULE_ENTRY_TYPES.filter((type) => (pack.counts[type.value] ?? 0) > 0).map((type) => `${type.label} ${pack.counts[type.value]}`);
  return parts.join(" · ");
}

/** What the card's right half says of what the account could hand over: its own read, with its own states. */
export type WorkStyleRead = { state: "loading" } | { state: "error" } | { state: "content"; style: WorkStyle };

/**
 * 收到的: the packs other people shared and this account took in, each with the switch that puts it in force as a reference — and, beside
 * them, the 工作方式卡 of what this account could hand over. Nothing received is a recipe whose button opens 分享与导入 on its import tab;
 * the card's one link opens it on its export tab. The two halves read independently: a card of packs that could not be read says so and
 * leaves the work-style card as it is, and the other way round.
 *
 * The switch is the shelf's own (`ReceivedShelf`: enable, with 撤销 in the toast, or disable); a pack taken down by its author or the
 * platform is shown as such and cannot be switched on.
 */
export function ReceivedCardView({ state, card, workStyle, onRetry, onRetryWorkStyle, onImport, onShare, onChanged, errorMessage }: {
  state: CardState;
  card: ReceivedCard | null;
  workStyle: WorkStyleRead;
  onRetry: () => void;
  onRetryWorkStyle: () => void;
  /** Opens 分享与导入 on 导入. */
  onImport: () => void;
  /** Opens 分享与导入 on 导出. */
  onShare: () => void;
  /** A switch was changed: the page reads the packs again. */
  onChanged: () => void;
  errorMessage?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const content = card && card.count > 0 ? card : null;

  const act = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    try {
      await operation();
      announceMemoryChanged();
      onChanged();
    } catch (error) {
      toast.error(`没有完成：${productErrorMessage(error)}`);
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

  return (
    <OverviewCard
      part="received" title={content ? `收到的 · ${content.count} 个` : "收到的"} count={content?.count ?? null} shape="rows" more={content?.more ?? 0} state={state === "content" && !content ? "recipe" : state}
      errorMessage={errorMessage} onRetry={onRetry}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="min-w-0">
          {!content && <Recipe action={<RecipeButton onPress={onImport}>导入一个胶囊</RecipeButton>}>别人分享给你的做法收下后，一键就能启用，不会混进你自己的记忆。</Recipe>}
          {content && (
            <>
              <List label="收到的胶囊">
                {content.rows.map((pack) => (
                  <ListRow
                    key={pack.id} title={pack.title} titleProps={{ "data-overview-row": "" }}
                    meta={pack.takenDown
                      ? <span>{pack.takenDown.by === "operator" ? "已被平台下架并停用" : "已被作者下架并停用"}</span>
                      : <span>{[pack.card?.author ? fromSender(pack.card.author) : null, pack.card?.summary || contents(pack)].filter(Boolean).join(" · ")}</span>}
                    trailing={(
                      <Switch
                        label={`启用“${pack.title}”`} checked={pack.enabled} disabled={busy !== null || Boolean(pack.takenDown)}
                        onChange={(next) => void (next ? enable(pack) : disable(pack))}
                      />
                    )}
                  />
                ))}
              </List>
              {content.more > 0 && (
                <div className="mt-2"><Button size="sm" variant="text" onClick={onImport}>{`全部 ${content.count} 个`}</Button></div>
              )}
            </>
          )}
        </div>
        <div className="min-w-0" data-overview-handover="">
          <p className="mb-2 text-ui text-text-2">我能交出去的</p>
          {workStyle.state === "loading" && <div aria-hidden="true" className="h-10 animate-pulse rounded bg-surface-1" />}
          {workStyle.state === "error" && <LoadError message="暂时读不到你能交出去的内容。" onRetry={onRetryWorkStyle} />}
          {workStyle.state === "content" && workStyle.style.total > 0 && (
            <>
              <WorkStyleCard style={workStyle.style} label="我能交出去的" />
              <div className="mt-2"><Button size="sm" variant="text" onClick={onShare}>分享与导入</Button></div>
            </>
          )}
          {workStyle.state === "content" && workStyle.style.total === 0 && (
            <Note action={<Button size="sm" variant="text" onClick={onShare}>分享与导入</Button>}>你的做法、标准和背景积累起来，就能交给别人。</Note>
          )}
        </div>
      </div>
    </OverviewCard>
  );
}
