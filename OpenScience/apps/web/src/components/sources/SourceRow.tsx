import { Button } from "@/components/ui/Button";
import { ListRow } from "@/components/ui/ListRow";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import { sourceFailureMessage, type SourceRecord } from "@/lib/sourceClient";
import { useOperator } from "@/lib/useOperator";
import { RETRYABLE, isReading, isUsable, kindIcon, metaLine, stateLabel } from "./sourceView";

/**
 * What one can do to a document, in the order a menu offers it: read it again, make it available to every project
 * (or only this one), settle a suspected duplicate, delete. The row's 「⋯」 and the drawer's carry the same four, so
 * they cannot disagree.
 */
export function sourceMenuItems(source: SourceRecord, {
  duplicate, busy, onRetry, onShare, onDuplicates, onDelete,
}: {
  duplicate: boolean; busy: boolean;
  onRetry: () => void; onShare: () => void; onDuplicates: () => void; onDelete: () => void;
}): MenuEntry[] {
  const link = source.display.origin === "link";
  const items: MenuEntry[] = [
    ...(link || RETRYABLE.includes(source.payload.status) ? [{ label: "重新读取", onSelect: onRetry }] : []),
    ...(source.display.shared === true ? [{ label: "改为仅本项目", onSelect: onShare }] : []),
    ...(source.display.shared === false && isUsable(source) ? [{ label: "设为所有项目可用", onSelect: onShare }] : []),
    ...(duplicate ? [{ label: "处理疑似重复", onSelect: onDuplicates }] : []),
    "separator",
    { label: "删除", onSelect: onDelete, destructive: true },
  ];
  return items.map((item) => item === "separator" || "heading" in item ? item : { ...item, disabled: busy });
}

/**
 * One document, as a list row: what it is called, one line of what it says, and under it what it is, how long, and
 * where it came from; the day it arrived at the end. The whole row opens the drawer. A state is said only while the
 * document cannot be used yet (「正在读取」, a few seconds) or could not be read (「没能读取 · 重试」), in the line where
 * what it says would be.
 */
export function SourceRow({ source, busy, duplicate, showShared, projectName, onOpen, onRetry, onShare, onDuplicates, onDelete }: {
  source: SourceRecord;
  busy: boolean;
  duplicate: boolean;
  /** Whether the row says 「所有项目可用」: not in the shared scope, where every row is. */
  showShared: boolean;
  /** The project a document of the shared scope belongs to. */
  projectName: string | null;
  onOpen: () => void;
  onRetry: () => void;
  onShare: () => void;
  onDuplicates: () => void;
  onDelete: () => void;
}) {
  const { display } = source;
  const Icon = kindIcon(display.kind);
  const menu = sourceMenuItems(source, { duplicate, busy, onRetry, onShare, onDuplicates, onDelete });
  return (
    <ListRow
      leading={<span className="grid h-8 w-8 place-items-center rounded bg-surface-2 text-text-3"><Icon size={16} aria-hidden="true" /></span>}
      title={<Tooltip content={display.title} kind="label" whenTruncated><span className="block truncate">{display.title}</span></Tooltip>}
      onOpen={onOpen}
      meta={<>
        <SourceLine source={source} busy={busy} onRetry={onRetry} />
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{[metaLine(source, { showShared }), projectName].filter(Boolean).join(" · ")}</span>
          {duplicate && <Tag>疑似重复</Tag>}
        </span>
      </>}
      trailing={<span className="tabular-nums">{formatDay(source.createdAt)}</span>}
      menu={<Menu label={`“${display.title}”的操作`} items={menu} />}
    />
  );
}

/**
 * The row's second line: where a state is said, or one line of what the document says once it has been understood.
 * Nothing at all for a usable document that has no understanding (an image, a document still being understood).
 */
function SourceLine({ source, busy, onRetry }: { source: SourceRecord; busy: boolean; onRetry: () => void }) {
  // `/api/me` is read once and shared, so a row asking costs nothing more.
  const operator = useOperator();
  const label = stateLabel(source);
  if (isReading(source)) return <span className="block text-text-3">正在读取</span>;
  if (label === "没能读取" || label === "部分无法读取") {
    const failed = label === "没能读取";
    const failure = source.payload.error;
    // The code is the handle support searches on: an operator gets it after the sentence, a researcher only the sentence.
    const reason = failed ? sourceFailureMessage(failure) : null;
    const tooltip = reason && operator && failure ? `${reason}（${failure.code}）` : reason ?? undefined;
    return (
      <span className={cn("flex items-center gap-1", failed ? "text-danger" : "text-warn")}>
        {tooltip ? <Tooltip content={tooltip}><span>{label}</span></Tooltip> : <span>{label}</span>}
        <span aria-hidden="true">·</span>
        <Button variant="text" size="sm" destructive={failed} disabled={busy} aria-label={`重新读取“${source.display.title}”`} onClick={onRetry} className="px-1">重试</Button>
      </span>
    );
  }
  if (label) return <span className="block">{label}</span>;
  if (source.display.gist) return <span className="block truncate text-text-2">{source.display.gist}</span>;
  return null;
}
