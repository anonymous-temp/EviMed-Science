import type { ReactNode } from "react";
import { PROJECT_CARD_SLOT_LABELS_ZH } from "@evimed/domain";
import type { ProjectOverview as ProjectOverviewData } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { DataTable, InlineBar, type DataColumn } from "@/components/ui/DataTable";
import { List, ListRow } from "@/components/ui/ListRow";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import { GroupHeader } from "./MemoryRows";

/**
 * The top of the 项目 tab (2026-10-12; the owner's choice A): what the project is, what was done in it and what it delivered,
 * above the project's own list of memories. Nothing here is a page of its own and nothing is the account's — it is the selected
 * project's, and it changes with the dropdown.
 *
 *  - **the card** — one row per thing the researcher said about the work (领域, 目标, 范围或对象, 材料与数据, 阶段, 约束; and for a
 *    clinical study the elements they stated, 人群, 干预或暴露 …), only the ones they said; a row opens the memory it was written
 *    from, in the drawer, like every row on this page. Nothing is asked of the researcher to fill a slot: an empty slot is never
 *    drawn, and a project that has memories but no card yet says so in one quiet line instead of a grid of empty labels.
 *  - **这个项目做过** — the capabilities that answered its conversations, the most used first: a ranking is a table with a bar
 *    in the row, never a pie (design reference, appendix E §4.1).
 *  - **作品** — the files its conversations delivered, by month, each a link to the file.
 *
 * Each block is drawn only when it has something to say, and the whole is drawn only for a project with a ledger to read;
 * a read that failed draws nothing here, and the memories below stand (the page's own reads say when they could not be made).
 * No block says how it was worked out.
 */

/** The month heading of a list of works: 「10月」 this year, 「2025年12月」 before it. */
export function monthHeading(month: string, now: Date = new Date()): string {
  const [year, number] = month.split("-").map(Number);
  if (!year || !number) return month;
  return year === now.getFullYear() ? `${number}月` : `${year}年${number}月`;
}

/** The day of a work, 「9月12日」, in the zone the overview was grouped in. */
function dayOfWork(at: string, timeZone: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, month: "numeric", day: "numeric" }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.month}月${parts.day}日`;
  } catch {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
}

/** The address of a delivered file: its own page, which finds the project the run belongs to. */
export function workPath(runId: string, path: string): string {
  return `/app/runs/${encodeURIComponent(runId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

const WORKS_FIRST = 6;

/** The researcher's word for a card row: the one the control plane sent, else the slot's own; an extra with none states itself. */
function cardLabel(slot: ProjectOverviewData["card"][number]): string {
  return slot.label ?? (PROJECT_CARD_SLOT_LABELS_ZH as Record<string, string>)[slot.slot] ?? "";
}

function Works({ works, timeZone }: { works: ProjectOverviewData["works"]; timeZone: string }) {
  const rows = works.flatMap((group) => group.items.map((item) => ({ ...item, month: group.month })));
  const { visible, remaining, more } = useShowMore(rows, { first: WORKS_FIRST, step: 12, resetKey: rows.map((row) => `${row.runId}:${row.path}`).join("|").slice(0, 200) });
  const months = [...new Set(visible.map((row) => row.month))];
  return (
    <section>
      <GroupHeader>作品</GroupHeader>
      <div className="space-y-3">
        {months.map((month) => (
          <div key={month}>
            <h3 className="px-2 pb-1 text-caption text-text-3">{monthHeading(month)}</h3>
            <List label={`${monthHeading(month)}的作品`}>
              {visible.filter((row) => row.month === month).map((row) => (
                <ListRow
                  key={`${row.runId}:${row.path}`}
                  to={workPath(row.runId, row.path)}
                  title={<span className="line-clamp-2 max-w-measure">{memoryExcerpt(row.title, 120)}</span>}
                  meta={<span className="max-w-measure break-all">{row.name}</span>}
                  trailing={<span>{dayOfWork(row.at, timeZone)}</span>}
                />
              ))}
            </List>
          </div>
        ))}
      </div>
      <ShowMore remaining={remaining} unit="项" onMore={more} />
    </section>
  );
}

export function ProjectOverview({ overview, canOpen, onOpen, hasMemories = false }: {
  overview: ProjectOverviewData;
  /** Whether the memory a slot was written from is on the page, so the row can open its drawer. */
  canOpen: (recordId: string) => boolean;
  onOpen: (recordId: string) => void;
  /** Whether the project has memories of its own below; without any, the page's own empty state speaks and no card line is added. */
  hasMemories?: boolean;
}) {
  const capabilities = overview.capabilities;
  const top = capabilities.reduce((most, row) => Math.max(most, row.count), 0);
  const columns: DataColumn<ProjectOverviewData["capabilities"][number]>[] = [
    { key: "name", header: "能力", rowHeader: true, cell: (row) => row.title },
    { key: "bar", header: <span className="sr-only">占比</span>, width: "w-40", cell: (row) => <InlineBar value={row.count} max={top} tone="rival" label={`${row.title} ${row.count}`} /> },
    { key: "count", header: "对话", align: "right", width: "w-16", cell: (row) => row.count },
  ];
  const blocks: ReactNode[] = [];
  if (overview.paused) {
    blocks.push(<p key="paused" role="status" className="px-2 text-ui text-text-2">本项目已暂停记忆</p>);
  }
  if (overview.card.length > 0) {
    blocks.push(
      <section key="card">
        <GroupHeader>项目卡</GroupHeader>
        <List label="项目卡">
          {overview.card.map((slot) => (
            <ListRow
              key={slot.slot}
              leading={<span className="w-24 text-caption text-text-3">{cardLabel(slot)}</span>}
              title={<span className="line-clamp-2 max-w-measure">{memoryExcerpt(slot.text, 200)}</span>}
              onOpen={canOpen(slot.recordId) ? () => onOpen(slot.recordId) : undefined}
            />
          ))}
        </List>
      </section>,
    );
  }
  if (overview.card.length === 0 && hasMemories && !overview.paused) {
    blocks.push(
      <section key="card">
        <GroupHeader>项目卡</GroupHeader>
        <p className="px-2 text-ui text-text-3">还没有记下这个项目的目标、资料和进展。</p>
      </section>,
    );
  }
  if (capabilities.length > 0) {
    blocks.push(
      <section key="capabilities">
        <GroupHeader>这个项目做过</GroupHeader>
        <DataTable label="这个项目做过" columns={columns} rows={capabilities} rowKey={(row) => row.id} minWidth="min-w-0" />
      </section>,
    );
  }
  if (overview.works.length > 0) blocks.push(<Works key="works" works={overview.works} timeZone={overview.timeZone} />);
  if (blocks.length === 0) return null;
  return <div className="space-y-6">{blocks}</div>;
}
