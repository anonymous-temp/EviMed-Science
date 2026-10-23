import { Link } from "react-router";
import { PROJECT_CARD_SLOT_LABELS_ZH } from "@evimed/domain";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { DataTable, InlineBar, type DataColumn } from "@/components/ui/DataTable";
import { FactList, type Fact } from "@/components/ui/FactList";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import { fetchProjectOverview, type ProjectOverview } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import type { MapOpen } from "@/lib/memoryMapClient";
import { MarkRows, OverviewCard, Recipe, RecipeButton, type CardState } from "./OverviewCard";
import {
  OTHER_PROJECT_ID, partAddress, type AboutYouCard, type KnowledgeCard, type MethodsCard, type ProjectRow, type ProjectsCard,
} from "./memoryOverviewModel";

type Open = (open: MapOpen) => void;

/** What each aspect of the person opens in the map: the radar's own axis, so a bar narrows the picture to what it counts. 「其他」 has no axis. */
const ASPECT_OF: Readonly<Record<string, string>> = { background: "aspect:background", preference: "aspect:preference", habit: "aspect:habit", correction: "aspect:correction" };

/** One bar of a ranked list: a name, a bar as long as its count is of the largest, and the count. A row that opens the map on what it counts. */
function BarRow({ label, count, max, to, name }: { label: string; count: number; max: number; to?: string; name: string }) {
  return (
    <ListRow
      title={label} to={to} titleProps={{ "data-overview-row": "" }}
      meta={<InlineBar value={count} max={max} tone="own" label={`${name} ${count}`} />}
      trailing={<span className="tabular-nums text-text-2">{count}</span>}
    />
  );
}

// ------------------------------------------------------------------------------------------------ 关于你

/**
 * 关于你: what the capsule holds about the person. Nothing yet is a recipe whose button writes the first line — 「记住这一条」 for an account
 * whose memory takes words typed on the page, 「去对话」 for the other kind; one to five are the statements themselves, six to thirty ranked
 * bars of the aspects the memory page files them under, more the same bars and the newest three. Never a radar here (the map's 维度 view has
 * it): few points are shown as themselves.
 */
export function AboutYouCardView({ state, card, native, onRetry, onOpen, onRemember, onChat, errorMessage }: {
  state: CardState; card: AboutYouCard | null; native: boolean; onRetry: () => void; onOpen: Open; onRemember: () => void; onChat: () => void; errorMessage?: string;
}) {
  const content = card && card.count > 0 ? card : null;
  const biggest = Math.max(1, ...(card?.bars.map((bar) => bar.count) ?? [1]));
  return (
    <OverviewCard
      part="you" title={content ? `关于你 · ${content.count} 件` : "关于你"} count={content?.count ?? null} shape={content?.shape} state={state === "content" && !content ? "recipe" : state}
      drill={{ to: partAddress("you"), label: "在地图里看" }} errorMessage={errorMessage} onRetry={onRetry}
    >
      {!content && (
        <Recipe action={native ? <RecipeButton onPress={onRemember}>记住这一条</RecipeButton> : <RecipeButton onPress={onChat}>去对话</RecipeButton>}>
          你说过的偏好、背景和写作习惯会记在这里，下次对话自动带上。
        </Recipe>
      )}
      {content && content.shape === "rows" && <MarkRows label="关于你的记忆" rows={content.rows} ask="memory" onOpen={(open) => onOpen(open)} />}
      {content && content.shape === "bars" && (
        <>
          <List label="关于你的各个方面">
            {content.bars.map((bar) => (
              <BarRow key={bar.key} label={bar.label} name={bar.label} count={bar.count} max={biggest}
                to={ASPECT_OF[bar.key] ? `${partAddress("you")}&dimension=${encodeURIComponent(ASPECT_OF[bar.key]!)}` : partAddress("you")} />
            ))}
          </List>
          {content.newest.length > 0 && <div className="mt-3"><MarkRows label="最近记下的" rows={content.newest} ask="memory" onOpen={(open) => onOpen(open)} /></div>}
        </>
      )}
    </OverviewCard>
  );
}

// ------------------------------------------------------------------------------------------------ 项目

/** A project's card slots, read when the capsule has exactly one project with anything: the same card the 项目 tab draws, as facts. */
function SingleProject({ row }: { row: ProjectRow }) {
  const { data } = useCapsuleData<ProjectOverview | null>(() => (row.id === OTHER_PROJECT_ID ? Promise.resolve(null) : fetchProjectOverview(row.id)));
  const tab = `/app/memory?tab=project&project=${encodeURIComponent(row.id)}`;
  const facts: Fact[] = [
    { label: "项目", value: <Link to={tab} data-overview-row="" className="rounded text-link hover:underline hover:underline-offset-4">{row.name}</Link> },
    ...(row.memories > 0 ? [{ label: "记忆", value: `${row.memories} 件` }] : []),
    ...(row.documents > 0 ? [{ label: "资料", value: `${row.documents} 份` }] : []),
    // The slots the researcher stated, in their own words; a slot nobody stated is not drawn, and a card that could not be read leaves the counts.
    ...(data?.card ?? []).map((slot): Fact => ({
      label: slot.label ?? (PROJECT_CARD_SLOT_LABELS_ZH as Record<string, string>)[slot.slot] ?? "其他", value: memoryExcerpt(slot.text, 120),
    })),
  ];
  return <FactList rows={facts} />;
}

/**
 * 项目: each project that holds something, with a bar as long as what it holds. One project is its card slots as facts; several are a table
 * with a bar in each row — the eight most recently active, and 「全部 N 个」 for the rest. A row opens the 项目 tab on that project.
 */
export function ProjectsCardView({ state, card, onRetry, onChat, errorMessage }: {
  state: CardState; card: ProjectsCard | null; onRetry: () => void; onChat: () => void; errorMessage?: string;
}) {
  const content = card && card.count > 0 ? card : null;
  const biggest = Math.max(1, ...(content?.rows.map((row) => row.memories + row.documents) ?? [1]));
  const withLooks = Boolean(content?.rows.some((row) => row.needsLook > 0));
  const columns: DataColumn<ProjectRow>[] = [
    { key: "name", header: "项目", rowHeader: true, cell: (row) => (
      <Link to={row.id === OTHER_PROJECT_ID ? "/app/memory?tab=project" : `/app/memory?tab=project&project=${encodeURIComponent(row.id)}`} data-overview-row="" className="rounded text-link hover:underline hover:underline-offset-4">{row.name}</Link>
    ) },
    { key: "bar", header: <span className="sr-only">占比</span>, width: "w-28", cell: (row) => <InlineBar value={row.memories + row.documents} max={biggest} tone="own" label={`${row.name}：记忆 ${row.memories}，资料 ${row.documents}`} /> },
    { key: "memories", header: "记忆", align: "right", width: "w-14", cell: (row) => row.memories },
    { key: "documents", header: "资料", align: "right", width: "w-14", cell: (row) => row.documents },
    ...(withLooks ? [{ key: "look", header: "要看一眼", align: "right" as const, width: "w-20", cell: (row: ProjectRow) => (row.needsLook > 0 ? row.needsLook : "") }] : []),
  ];
  return (
    <OverviewCard
      part="projects" title={content ? `项目 · ${content.count} 个` : "项目"} count={content?.count ?? null} memories={content?.memories ?? null}
      shape={content?.shape} more={content?.more ?? 0} state={state === "content" && !content ? "recipe" : state}
      drill={{ to: partAddress("project"), label: "在地图里看" }} errorMessage={errorMessage} onRetry={onRetry}
    >
      {!content && <Recipe action={<RecipeButton onPress={onChat}>去对话</RecipeButton>}>有了项目，记忆和资料会按项目放在一起，各自看得到。</Recipe>}
      {content && content.shape === "single" && content.single && <SingleProject key={content.single.id} row={content.single} />}
      {content && content.shape === "table" && (
        <div>
          <DataTable label="各个项目" columns={columns} rows={content.rows} rowKey={(row) => row.id} minWidth="min-w-96" ground="surface" />
          {content.more > 0 && (
            <p className="mt-2 text-caption text-text-3">
              <Link to="/app/memory?tab=project" className="rounded text-link hover:underline hover:underline-offset-4">全部 {content.count} 个</Link>
            </p>
          )}
        </div>
      )}
    </OverviewCard>
  );
}

// ------------------------------------------------------------------------------------------------ 我的做法

/** The months a method was learned in, on an axis: a dot for each method up to thirty, a bar for each month after. Words and numbers say the same. */
export function MonthStrip({ months, marks, label }: { months: ReadonlyArray<{ month: string; count: number }>; marks: "dots" | "bars"; label: string }) {
  const tallest = Math.max(1, ...months.map((entry) => entry.count));
  return (
    <ol aria-label={label} className="flex items-end gap-1 overflow-x-auto pb-1">
      {months.map((entry) => (
        <li key={entry.month} className="flex min-w-8 flex-1 flex-col items-center gap-1">
          <span className="flex min-h-12 flex-col-reverse items-center justify-start gap-0.5">
            {marks === "dots"
              ? Array.from({ length: entry.count }, (_unused, index) => <span key={index} aria-hidden="true" className="text-ui leading-none text-accent">▲</span>)
              : entry.count > 0 && <span aria-hidden="true" className="w-3 rounded-tag bg-accent" style={{ height: `${Math.max(4, Math.round((entry.count / tallest) * 44))}px` }} />}
          </span>
          <span className="text-caption tabular-nums text-text-3">{`${Number(entry.month.slice(5))}月`}</span>
          <span className="sr-only">{`${entry.month}：${entry.count} 种`}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * 我的做法: what the platform learned to do for this person — a title and the day it was learned, never a count of use. Nothing yet is a recipe
 * (what it uses, what it gives); one to five are rows; six to thirty are ▲ on a month axis with the newest three below; more are monthly bars.
 */
export function MethodsCardView({ state, card, onRetry, onOpen, onChat, errorMessage }: {
  state: CardState; card: MethodsCard | null; onRetry: () => void; onOpen: Open; onChat: () => void; errorMessage?: string;
}) {
  const content = card && card.count > 0 ? card : null;
  return (
    <OverviewCard
      part="methods" title={content ? `我的做法 · ${content.count} 种` : "我的做法"} count={content?.count ?? null} shape={content?.shape} state={state === "content" && !content ? "recipe" : state}
      drill={{ to: partAddress("method"), label: "在地图里看" }} errorMessage={errorMessage} onRetry={onRetry}
    >
      {!content && <Recipe action={<RecipeButton onPress={onChat}>去做一件事</RecipeButton>}>用你交付的文件和你的纠正学出做法，下次做同类的事自动带上。</Recipe>}
      {content && content.shape === "rows" && <MarkRows label="我的做法" rows={content.rows} ask="method" onOpen={(open) => onOpen(open)} />}
      {content && content.shape === "months" && content.marks && (
        <div className="space-y-3">
          <MonthStrip months={content.months} marks={content.marks} label="每个月学会的做法" />
          <MarkRows label="最近学会的做法" rows={content.rows} ask="method" onOpen={(open) => onOpen(open)} />
        </div>
      )}
    </OverviewCard>
  );
}

// ------------------------------------------------------------------------------------------------ 知识

/**
 * 知识: the documents the capsule rests on, counted by the knowledge base. Nothing yet is a recipe whose button goes to upload; one to five
 * are the documents as rows; more are a composition by kind (five bars at most, the rest 其他). In amber, how many memories rest on a
 * document that changed — the one thing on the page that asks for a look at the sources.
 */
export function KnowledgeCardView({ state, card, onRetry, onUpload, errorMessage }: {
  state: CardState; card: KnowledgeCard | null; onRetry: () => void; onUpload: () => void; errorMessage?: string;
}) {
  const content = card && card.count > 0 ? card : null;
  const biggest = Math.max(1, ...(card?.types.map((type) => type.count) ?? [1]));
  return (
    <OverviewCard
      part="knowledge" title={content ? `知识 · ${content.count} 份资料` : "知识"} count={content?.count ?? null} shape={content?.shape} state={state === "content" && !content ? "recipe" : state}
      drill={{ to: partAddress("knowledge"), label: "在地图里看" }} errorMessage={errorMessage} onRetry={onRetry}
    >
      {!content && <Recipe action={<RecipeButton onPress={onUpload}>上传一份资料</RecipeButton>}>放进文献、方案和数据，记忆就能说出依据的是哪一份。</Recipe>}
      {content && content.shape === "rows" && (
        <List label="资料">
          {content.rows.map((row) => (
            <ListRow
              key={row.id} title={<span className="line-clamp-2 max-w-measure">{memoryExcerpt(row.title, 120)}</span>} to={row.open?.kind === "page" ? row.open.href : undefined}
              meta={[formatDay(row.at)].filter(Boolean).join(" · ")} titleProps={{ "data-overview-row": "" }}
            />
          ))}
        </List>
      )}
      {content && content.shape === "types" && (
        <List label="资料的种类">
          {content.types.map((type) => (
            <BarRow key={type.id} label={type.label} name={type.label} count={type.count} max={biggest} to={type.id === "other" ? "/app/files" : `/app/files?kind=${encodeURIComponent(type.id)}`} />
          ))}
        </List>
      )}
      {content && content.changed > 0 && (
        <div className={cn(content.shape === "recipe" ? "" : "mt-3")}>
          <Note tone="warn" result={[{ n: content.changed, to: partAddress("look"), label: `${content.changed} 条记忆依据的资料变了，只看这些` }, " 条记忆依据的资料变了"]} />
        </div>
      )}
    </OverviewCard>
  );
}
