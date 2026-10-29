import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import {
  ZONE_MODULE_LABELS,
  type ZoneDrugRow,
  type ZoneEventRow,
  type ZoneModule,
  type ZoneProgress,
  type ZoneRole,
  type ZoneItemsWindow,
} from "@/lib/evidenceTopicClient";
import type { FrontierItem } from "@/lib/frontierClient";
import { DataTable } from "@/components/ui/DataTable";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { overviewParts } from "@/app/routes/FrontierTopicPage";
import { INLINE_ACTION, feedDay } from "../frontierText";
import { ZoneCardBlock } from "./ZoneCardBlock";
import { articlePath, eventPath, itemMeta, itemsHref } from "./zoneText";

export interface ZoneModulesProps {
  modules: readonly ZoneModule[];
  /** The zone's own address, which a 「查看全部」 narrows to a tab of. */
  path: string;
  /** Where an item or a card opened from here returns to. */
  from: { to: string; label: string };
}

/**
 * The modules of a zone's 概览, in the order the server sent them (the zone type decides the order there, from one table in the
 * domain): each one kind of thing under its own heading, the heading's far end the way to all of it. A module the server sent empty is
 * not drawn.
 */
export function ZoneModules({ modules, path, from }: ZoneModulesProps) {
  return (
    <div className="space-y-8">
      {modules.map((module) => <ModuleView key={module.key} module={module} path={path} from={from} />)}
    </div>
  );
}

/** 「查看全部 ›」: the heading's far end, a text link to the 动态 tab narrowed to what the module holds. */
function SeeAll({ path, role, window, label = "查看全部 ›" }: { path: string; role: ZoneRole | null; window: ZoneItemsWindow; label?: string }) {
  return <Link to={itemsHref(path, { role, window })} className={cn(INLINE_ACTION, "-mr-1.5 px-1.5 text-text-3 hover:text-text")}>{label}</Link>;
}

function ModuleView({ module, path, from }: { module: ZoneModule; path: string; from: ZoneModulesProps["from"] }): ReactNode {
  const title = ZONE_MODULE_LABELS[module.key];
  switch (module.key) {
    case "progress":
      return <ProgressModule title={title} progress={module.progress} from={from} />;
    case "cards":
      return module.cards.length === 0 ? null : (
        <Section title={title} toolbar={module.total > module.cards.length ? <Link to={`${path}?tab=cards`} className={cn(INLINE_ACTION, "-mr-1.5 px-1.5 text-text-3 hover:text-text")}>查看全部 ›</Link> : undefined}>
          <ul aria-label={title} className="space-y-3">{module.cards.map((card) => <ZoneCardBlock key={`${card.provider}:${card.id}`} card={card} from={from} />)}</ul>
        </Section>
      );
    case "approved-drugs":
      return module.rows.length === 0 ? null : <Section title={title}><ApprovedDrugs rows={module.rows} path={path} from={from} /></Section>;
    case "multi-source":
      return module.events.length === 0 ? null : <Section title={title}><MultiSource events={module.events} from={from} /></Section>;
    default:
      return module.items.length === 0 ? null : (
        <Section title={title} toolbar={module.more ? <SeeAll path={path} role={module.more.role} window={module.more.window} label={module.key === "latest" ? "查看全部动态 ›" : undefined} /> : undefined}>
          <ItemRows label={title} items={module.items} dated={module.key === "key-updates"} from={from} />
        </Section>
      );
  }
}

/* ------------------------------------------------------------------ progress */

/** 「截至 10月29日」: when the 最新进展 was written, in Beijing time. */
function writtenOn(progress: Pick<ZoneProgress, "at">): string {
  const day = feedDay(progress.at);
  return day ? `截至 ${day}` : "";
}

/**
 * 「最新进展」: three to five sentences of what is new, written only from the zone's own items, each fact marked with the item it came
 * from — the mark a small link to that item's reading page, named by the item's title for a screen reader. No "AI" in the heading: its
 * credit is the marks, not a label (plan 6.3).
 */
function ProgressModule({ title, progress, from }: { title: string; progress: ZoneProgress; from: ZoneModulesProps["from"] }) {
  const parts = overviewParts(progress.text, progress.refs);
  const written = writtenOn(progress);
  return (
    <Section title={title} toolbar={written ? <span className="text-caption tabular-nums text-text-3">{written}</span> : undefined}>
      <p data-prose="" className="max-w-measure-body whitespace-pre-line break-words text-reading text-text">
        {parts.map((part, index) => (typeof part === "string" ? part : (
          <sup key={index} className="text-caption leading-none">
            <Link to={articlePath(part.itemId)} state={{ evidenceFrom: from }} aria-label={part.title}
              className="rounded px-px leading-none tabular-nums text-link hover:underline">[{part.n}]</Link>
          </sup>
        )))}
      </p>
    </Section>
  );
}

/* --------------------------------------------------------------------- items */

/**
 * Compact rows, not the feed's cards (the overview has to stay scannable): the title is the reader's link, the one line under it says
 * who, when and what kind. A key update leads with its day, which is the point of that module.
 */
function ItemRows({ label, items, dated, from }: { label: string; items: readonly FrontierItem[]; dated: boolean; from: ZoneModulesProps["from"] }) {
  return (
    <List label={label}>
      {items.map((item) => (
        <ListRow key={item.id} to={articlePath(item.id)} state={{ evidenceFrom: from }} title={<span data-prose="">{item.title}</span>}
          leading={dated ? <span className="w-14 pt-0.5 text-caption tabular-nums text-text-3">{feedDay(item.timelineAt)}</span> : undefined}
          meta={dated ? [item.source.name, item.genreLabel].filter(Boolean).join(" · ") : itemMeta(item)} />
      ))}
    </List>
  );
}

/* --------------------------------------------------------------------- drugs */

/**
 * 已获批药物: a drug, its latest approval (the agency, the day and the kind, the cell a link to the approval's item) and how many
 * items of the last 30 days name it, the number a link to those items.
 */
function ApprovedDrugs({ rows, path, from }: { rows: readonly ZoneDrugRow[]; path: string; from: ZoneModulesProps["from"] }) {
  return (
    <DataTable<ZoneDrugRow>
      label="已获批药物"
      minWidth="min-w-[26rem]"
      rows={rows}
      rowKey={(row) => row.key ?? row.label}
      columns={[
        { key: "drug", header: "药物", rowHeader: true, cell: (row) => row.label },
        {
          key: "approval", header: "最近获批", isEmpty: (row) => row.approval === null,
          cell: (row) => {
            if (!row.approval) return <span className="text-text-3">—</span>;
            const text = [row.approval.agency, row.approval.date ? feedDay(row.approval.date) : null, row.approval.kind].filter(Boolean).join(" · ");
            return row.approval.itemId
              ? <Link to={articlePath(row.approval.itemId)} state={{ evidenceFrom: from }} className="rounded text-link hover:underline">{text}</Link>
              : text;
          },
        },
        {
          key: "count30", header: "近 30 天", align: "right", width: "w-24",
          cell: (row) => row.count30 > 0
            ? <Link to={itemsHref(path, { q: row.label, window: "30d" })} className="rounded text-link hover:underline">{row.count30} 条</Link>
            : <span className="text-text-3">0</span>,
        },
      ]}
    />
  );
}

/* -------------------------------------------------------------- multi-source */

/** 「3 家机构报道 · 含一手材料」: the same thing reported by several institutions; a row opens the event with all of them. */
function MultiSource({ events, from }: { events: readonly ZoneEventRow[]; from: ZoneModulesProps["from"] }) {
  return (
    <List label="多方报道">
      {events.map((event) => (
        <ListRow key={event.eventId} to={eventPath(event.eventId)} state={{ evidenceFrom: from }} title={<span data-prose="">{event.title}</span>}
          meta={[`${event.reports} 家机构报道`, event.hasPrimary ? "含一手材料" : null].filter(Boolean).join(" · ")} />
      ))}
    </List>
  );
}
