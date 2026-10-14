import { useRef, useState, type ReactElement } from "react";
import { Link, MemoryRouter } from "react-router";
import { ArrowLeft, Library, UsersRound } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { ChartGrid } from "@/components/ui/ChartGrid";
import { DataTable } from "@/components/ui/DataTable";
import { FactList } from "@/components/ui/FactList";
import { List, ListRow } from "@/components/ui/ListRow";
import { MasterDetail } from "@/components/ui/MasterDetail";
import { Note } from "@/components/ui/Note";
import { Outline, useOutline } from "@/components/ui/Outline";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import { Switch } from "@/components/ui/Switch";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";

/**
 * One representative page per template of the page framework (R19, plan §2.1; audit D §3.1), built from the real components with
 * fixture data — the pages `pageComposition.test.tsx` renders and reads. They are not the product's pages: a page package that
 * moves a real page onto the framework adds it to `PAGES` below (or renders it and calls `compositionFacts` itself) and the same
 * assertions hold it.
 *
 *  - T1 list · T2 master-detail · T3 module with steps · T4 data · T5 reader · T6 settings.
 *
 * Fixtures live in tests: the component gallery's reference images are re-diffed in CI on another environment and are not
 * touched by this.
 */

export type TemplateId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6";

/* ------------------------------------------------------------------- facts */

export interface CompositionFacts {
  /** The page's header line. */
  header: HTMLElement | null;
  /** The sticky band, when the page has one. */
  chrome: HTMLElement | null;
  /** Where the page's content starts. */
  body: HTMLElement | null;
  toolbars: HTMLElement[];
  tablists: HTMLElement[];
  stepRails: HTMLElement[];
  /** The solid accent buttons and links in the header. */
  headerPrimaryActions: HTMLElement[];
  /** Tags that are, or sit inside, a control. */
  clickableTags: HTMLElement[];
  /** Toolbars in the body that come after content they control, at the body's own level. */
  controlsBelowContent: HTMLElement[];
}

const CONTROL = "a, button, [role=button], [role=tab], [role=link], [role=menuitem]";
const CONTENT_BLOCK = "ul, ol, table, [data-chart-grid], canvas, article, [data-fact-list], [data-step-state]";

/** Whether `a` comes before `b` in the document. */
export function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/**
 * What a page is made of, read off the markers the framework's components carry — and the order they stand in. jsdom has no
 * layout, so position is the walk's; the document order is what a unit test can say.
 */
export function compositionFacts(root: ParentNode): CompositionFacts {
  const all = <T extends HTMLElement = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)];
  const body = root.querySelector<HTMLElement>("[data-page-body]");
  const header = root.querySelector<HTMLElement>("[data-page-header]");
  const toolbars = all("[data-toolbar]");
  const clickableTags = all("[data-tag]").filter((tag) => tag.closest(CONTROL) !== null || tag.hasAttribute("role") || tag.hasAttribute("tabindex") || tag.hasAttribute("onclick"));
  const controlsBelowContent = toolbars.filter((toolbar) => {
    if (!body?.contains(toolbar)) return false;
    // A toolbar inside a section is that section's own, and is judged against that section's content.
    const holder = toolbar.closest("section") ?? body;
    return [...holder.querySelectorAll(CONTENT_BLOCK)].some((block) => !toolbar.contains(block) && precedes(block, toolbar) && !block.closest("[data-toolbar]"));
  });
  return {
    header,
    chrome: root.querySelector<HTMLElement>("[data-page-chrome]"),
    body,
    toolbars,
    tablists: all("[role=tablist]"),
    stepRails: all("[data-step-rail]"),
    headerPrimaryActions: header ? [...header.querySelectorAll<HTMLElement>(".bg-accent")] : [],
    clickableTags,
    controlsBelowContent,
  };
}

/* ----------------------------------------------------------------- samples */

const ROWS = [
  { id: "r1", title: "阿司匹林一级预防在老年人群中的获益与出血风险", meta: "NEJM · 3 小时前", tag: "指南" },
  { id: "r2", title: "SGLT2 抑制剂在射血分数保留心衰中的新证据", meta: "Lancet · 昨天", tag: "RCT" },
  { id: "r3", title: "他汀类药物肝酶监测的最新共识更新", meta: "JAMA · 2 天前", tag: "共识" },
];

/** T1: a list — the page's views and filters in one toolbar above it. */
export function ListPageSample() {
  const [view, setView] = useState("all");
  const [lane, setLane] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  return (
    <PageShell
      title="前沿动态"
      meta="38 条"
      actions={<Button>管理关注</Button>}
      toolbar={{
        views: { label: "动态视图", items: [{ value: "all", label: "全部" }, { value: "hot", label: "热榜" }, { value: "daily", label: "简报" }], value: view, onChange: setView, panelId: "feed" },
        filters: [{ kind: "select", label: "全部栏目", allLabel: "全部栏目", options: [{ value: "evidence", label: "临床证据" }, { value: "safety", label: "药物安全" }], value: lane, onChange: setLane }],
        onClear: () => { setLane(null); setQuery(""); },
        search: { label: "搜索动态", value: query, onChange: setQuery, onClear: () => setQuery("") },
        summary: "38 条",
      }}
    >
      <List label="动态">
        {ROWS.map((row) => (
          <ListRow key={row.id} title={row.title} meta={row.meta} trailing={<Tag>{row.tag}</Tag>} to={`/app/frontier/events/${row.id}`} />
        ))}
      </List>
    </PageShell>
  );
}

/** T2: a list on the left, one record on the right. */
export function MasterDetailSample() {
  return (
    <PageShell
      title="假设卡"
      width="full"
      scope={{
        label: "范围",
        groups: [{ heading: "虚拟临床研究", choices: [{ id: "s1", label: "阿司匹林虚拟研究", icon: UsersRound }] }, { choices: [{ id: "shared", label: "所有项目共享", icon: Library }] }],
        value: "s1",
        onChange: () => {},
      }}
      actions={<Button>新建假设</Button>}
    >
      <div className="h-96">
        <MasterDetail
          listLabel="假设列表"
          detailLabel="假设"
          selected
          detailTitle="假设"
          onCloseDetail={() => {}}
          list={<List label="假设">{ROWS.map((row) => <ListRow key={row.id} title={row.title} selected={row.id === "r1"} onOpen={() => {}} />)}</List>}
          detail={(
            <div className="p-4">
              <Section title="假设 A">
                <FactList rows={[{ label: "人群", value: "≥70 岁，无心血管病史" }, { label: "终点", value: "主要心血管事件" }]} />
              </Section>
            </div>
          )}
        />
      </div>
    </PageShell>
  );
}

/** The module sample's tabs; `null` toolbars are the tabs that have none. */
export const MODULE_TABS = [
  { value: "overview", label: "总览" },
  { value: "visibility", label: "可见度" },
  { value: "accuracy", label: "准确与安全" },
  { value: "actions", label: "行动" },
  { value: "plan", label: "方案" },
] as const;

export type ModuleTab = (typeof MODULE_TABS)[number]["value"];

const MODULE_STEPS = [
  { id: "evidence", label: "证据", state: "done" as const, summary: "86 条结论", href: "/app/geo/g1/plan" },
  { id: "journey", label: "旅程", state: "done" as const, href: "/app/geo/g1/questions" },
  { id: "questions", label: "问题", state: "done" as const, href: "/app/geo/g1/questions" },
  { id: "diagnosis", label: "诊断", state: "active" as const, href: "/app/geo/g1/accuracy" },
  { id: "sources", label: "信源", state: "attention" as const, href: "/app/geo/g1/sources" },
  { id: "content", label: "内容", state: "waiting" as const, href: "/app/geo/g1/actions" },
  { id: "delivery", label: "投放", state: "todo" as const, href: "/app/geo/g1/actions" },
  { id: "monitor", label: "监测", state: "todo" as const, href: "/app/geo/g1/visibility" },
];

/** Which steps each tab is built from. */
const TAB_STEPS: Record<ModuleTab, string[]> = {
  overview: [],
  visibility: ["monitor"],
  accuracy: ["diagnosis"],
  actions: ["content", "delivery"],
  plan: ["evidence"],
};

/** T3: a module — the program on every tab, tabs, a toolbar where the tab has one, and a body of one kind. */
export function ModulePageSample({ tab = "visibility", running = false }: { tab?: ModuleTab; running?: boolean }) {
  const [open, setOpen] = useState<string>(tab);
  const [only, setOnly] = useState(false);
  const current = open as ModuleTab;
  const withToolbar = current === "visibility" || current === "accuracy" || current === "actions";
  return (
    <PageShell
      title="信尔美"
      meta={<Tag>第 3 周</Tag>}
      width="wide"
      actions={<><Button variant="secondary">周报</Button><Button>下一步：为 4 个问题群写稿</Button></>}
      steps={{ label: "进度", steps: MODULE_STEPS, activeSteps: TAB_STEPS[current], trailing: "第 3 轮复测中" }}
      activity={running ? { label: "复测", phase: "检索", counts: { done: 120, total: 300 }, startedAt: "2026-10-14T08:00:00Z", to: "/app/runs?run=r1" } : undefined}
      tabs={{ label: "项目视图", items: MODULE_TABS.map((item) => ({ value: item.value, label: item.label })), value: current, onChange: setOpen, panelId: "geo-tab-panel" }}
      toolbar={withToolbar ? {
        filters: [{ kind: "toggle", label: "只看待处理", pressed: only, onChange: setOnly }],
        summary: current === "accuracy" ? "18 条讲错" : "6 个引擎",
      } : null}
    >
      <List label={MODULE_TABS.find((item) => item.value === current)?.label}>
        {ROWS.map((row) => <ListRow key={row.id} title={row.title} meta={row.meta} onOpen={() => {}} />)}
      </List>
    </PageShell>
  );
}

/** T4: a data page — one sentence, the numbers that exist, a grid of charts whose rows are full, and the table behind them. */
export function DataPageSample() {
  const [view, setView] = useState("overview");
  return (
    <PageShell
      title="记忆地图"
      width="wide"
      toolbar={{
        views: { label: "地图视图", items: [{ value: "overview", label: "总览" }, { value: "time", label: "时间" }], value: view, onChange: setView },
        filters: [{ kind: "select", label: "项目", allLabel: "全部项目", options: [{ value: "p1", label: "高血压随访" }], value: null, onChange: () => {} }],
        summary: "48 件",
      }}
      headline={{ parts: ["EviMed 记住了你的 ", { n: 48, to: "/app/memory" }, " 件事，其中 ", { n: 4, onOpen: () => {} }, " 件需要看一眼。"] }}
    >
      <StatBand label="数量" columns={4}>
        <StatTile label="记忆" value={48} to="/app/memory" />
        <StatTile label="资料" value={12} to="/app/files" />
        <StatTile label="需要看一眼" value={4} onOpen={() => {}} tone="safety" />
        <StatTile label="做法" value={24} to="/app/memory?tab=methods" />
      </StatBand>
      <ChartGrid
        className="mt-6"
        rows={[
          [{ key: "trend", span: 2, node: <ChartCard title="本月记下的事比上月多">图</ChartCard> }],
          [{ key: "kinds", node: <ChartCard title="偏好和背景最多">图</ChartCard> }, { key: "projects", node: <ChartCard title="高血压随访最活跃">图</ChartCard> }],
        ]}
      />
      <Section title="记下的事" count={3}>
        <DataTable
          label="记下的事"
          rowKey={(row) => row.id}
          rows={ROWS}
          columns={[{ key: "title", header: "内容", rowHeader: true, cell: (row) => row.title }, { key: "meta", header: "来源", cell: (row) => row.meta }]}
        />
      </Section>
    </PageShell>
  );
}

const READER_SECTIONS = ["摘要", "方法", "结果", "局限性", "参考来源"];

/** T5: a document — title, the one action, a contents column, and the text. */
export function ReaderPageSample() {
  const body = useRef<HTMLDivElement>(null);
  const { entries, active, select } = useOutline(body, { idPrefix: "reader" });
  return (
    <PageShell
      title="阿司匹林一级预防的获益与风险"
      titleVariant="document"
      width="read"
      back={<Link to="/app/frontier" className="inline-flex items-center gap-1 text-ui text-text-3"><ArrowLeft size={16} aria-hidden="true" />前沿动态</Link>}
      actions={<Button>问这条证据</Button>}
    >
      <div className="flex gap-8">
        <div ref={body} className="min-w-0 flex-1">
          {READER_SECTIONS.map((name) => (
            <section key={name} className="mt-8 first:mt-0">
              <h2 className="text-section font-semibold text-text">{name}</h2>
              <p className="mt-2 text-body text-text">在 ≥70 岁人群中，阿司匹林不降低主要心血管事件，大出血风险增加。</p>
            </section>
          ))}
        </div>
        <Outline layout="column" entries={entries} active={active} onSelect={select} />
      </div>
    </PageShell>
  );
}

/** T6: settings — panels of settings, and nothing that is another page's. */
export function SettingsPageSample() {
  const [on, setOn] = useState(true);
  return (
    <PageShell title="设置" width="page">
      <div className="grid gap-6 md:grid-cols-[12rem_1fr]">
        <nav aria-label="设置分区">
          <ul>
            <li><button type="button">账户</button></li>
            <li><button type="button">外观</button></li>
            <li><button type="button">通知</button></li>
          </ul>
        </nav>
        <div className="flex flex-col gap-6">
          <Panel title="通知">
            <PanelRow label="任务完成时推送" control={<Switch checked={on} onChange={setOn} label="任务完成时推送" />} />
          </Panel>
          <Note action={<Button variant="secondary" size="sm">去充值</Button>}>本月的额度还剩 12 灵豆。</Note>
        </div>
      </div>
    </PageShell>
  );
}

/** A hand-composed page that breaks the rule on purpose: a toolbar written under the list it filters. */
export function ControlBelowContentSample() {
  return (
    <PageShell title="有问题的页面">
      <List label="行"><ListRow title="第一行" /><ListRow title="第二行" /></List>
      <div className="mt-6"><Toolbar filters={[{ kind: "toggle", label: "只看待处理", pressed: false, onChange: () => {} }]} /></div>
    </PageShell>
  );
}

/** A page whose tag is dressed as a control. */
export function TagInControlSample() {
  return (
    <PageShell title="有问题的页面">
      <button type="button"><Tag tone="warn">研究设计支持 → 探索</Tag></button>
    </PageShell>
  );
}

/* --------------------------------------------------------------- registry */

export interface CompositionSample {
  id: TemplateId;
  name: string;
  /** The page, in a router. */
  element: () => ReactElement;
}

const inRouter = (page: ReactElement) => <MemoryRouter>{page}</MemoryRouter>;

/** The six templates' representative pages. A page package adds its real pages beside these. */
export const PAGES: readonly CompositionSample[] = [
  { id: "T1", name: "列表页", element: () => inRouter(<ListPageSample />) },
  { id: "T2", name: "主从页", element: () => inRouter(<MasterDetailSample />) },
  { id: "T3", name: "模块页", element: () => inRouter(<ModulePageSample />) },
  { id: "T4", name: "数据页", element: () => inRouter(<DataPageSample />) },
  { id: "T5", name: "阅读页", element: () => inRouter(<ReaderPageSample />) },
  { id: "T6", name: "设置页", element: () => inRouter(<SettingsPageSample />) },
];

/** The module sample open at `tab`, in a router. */
export function modulePageAt(tab: ModuleTab, running = false): ReactElement {
  return inRouter(<ModulePageSample tab={tab} running={running} />);
}

/** A page of the deliberately broken kind, in a router: what the assertions must be able to see. */
export function brokenPage(kind: "control-below-content" | "tag-in-control"): ReactElement {
  return inRouter(kind === "control-below-content" ? <ControlBelowContentSample /> : <TagInControlSample />);
}
